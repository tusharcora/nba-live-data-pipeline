# Search Structured Result Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the NL stats search feature (`/search`) so that, alongside the existing prose answer, it also renders the real structured row-level data behind that answer — a player's box-score line(s), a game's matchup card + box score, a team's list of games, or a league-leaders ranking — depending on which of the four query tools actually answered the question.

**Architecture:** The raw row-level data already exists at every layer of the pipeline up through `search-loop.ts`'s internal `lastToolResult` variable — it is discarded at exactly one point, `finalize()`, which currently keeps only `table`/`dateRange` for the citation and drops `.data` entirely. This plan threads a new, properly-typed `resultData` field alongside the existing `citation`/`noData`/`candidates` fields through every layer that already carries those (`ToolResultEnvelope` → `SearchResult` → the SSE `done` payload → `SearchDonePayload` → React state), then adds one new dispatcher component that renders the right table for the tool that ran. Two rendering paths reuse the existing `BoxScoreTable` component and its `PlayerStatRow`/`GameRow` types verbatim (`get_player_stats`, most of `get_game_result`); `get_team_games`'s team-centric rows get reshaped into `GameRow` server-side so they can reuse the same rendering primitives; `get_leaders` gets one small new table component since nothing in the app renders a ranked list today.

**Tech Stack:** Next.js 16 App Router, TypeScript, Vitest + Testing Library, existing shadcn `Table`/`Card`/`Badge` primitives (`web/components/ui/*`), the existing `web/lib/box-score.tsx`/`web/lib/team-names.ts` helpers.

**Spec:** `_bmad-output/specs/spec-nl-stats-search/SPEC.md` (this worktree) — this plan implements a new capability on top of that spec's CAP-1/CAP-3/CAP-4 (structured data was always fetched to *answer* the question; it just never reached the client). No FastAPI/Python changes are needed — all four `/tools/*` endpoints already return full row-level data (verified directly against `api/src/api/routers/query_tools.py` on `origin/main`).

## Global Constraints

- No RAG/vector approach; this only extends the existing typed tool-calling architecture (SPEC.md Constraints).
- Never fabricate: `resultData` must only ever be populated from a genuine successful (`status: "ok"`) tool result, exactly matching how `citation` is already handled — never guessed, never present alongside `noData`/`candidates`.
- Testing follows this repo's offline-verification convention: every test in this plan mocks its immediate dependency (FastAPI calls, the LLM client, the route's own `runSearchLoop`) — no real network, database, or LLM call anywhere.
- Reuse existing components/types over inventing new ones: `BoxScoreTable`, `PlayerStatRow`, `GameRow`, `TeamLink`, `TeamLogo`, `scoreColorClass`, `displayScore`, `formatGameDate`, `TEAM_NAME_TO_ABBREVIATION` (all from `web/lib/box-score.tsx` / `web/lib/team-names.ts`) are reused as-is, with zero changes to those files.
- All new/modified TypeScript files must pass `npx tsc --noEmit` and `npm run lint` with zero errors (existing repo convention, checked in Task 7's final step).
- Build this on a branch off current `origin/main` (where the feature actually lives — verified directly, not off this worktree's own branch, which only has spec/story docs).

---

## File Structure

| File | Responsibility |
|---|---|
| `web/lib/search-result-types.ts` (new) | Pure types: `SearchResultType`, one payload interface per tool, and the `SearchResultData` discriminated union. No React — safe to import from both server (`search-tools.ts`, `search-loop.ts`) and client (`search-section.tsx`, the new table components) code. |
| `web/lib/search-tools.ts` (modify) | `ToolResultEnvelope` gains `resultData`; a new `deriveResultData()` (mirroring the existing `deriveDateRange()`) builds it per tool, including the `get_team_games` → `GameRow` reshape and the `get_game_result` box-score enrichment. |
| `web/lib/search-loop.ts` (modify) | `SearchResult` gains `resultData`; `finalize()` threads it through on the success path, `null` everywhere else (including `FALLBACK_RESULT`). |
| `web/app/api/search/route.ts` (modify) | `sseDone()`'s payload includes `resultData`. |
| `web/lib/search-stream.ts` (modify) | `SearchDonePayload` gains `resultData`; `parseDonePayload()` validates it defensively, same drift-tolerant style as `citation`. |
| `web/app/components/sections/search-result-tables.tsx` (new) | `GameMatchupCard`, `LeadersTable`, and the `SearchResultDataView` dispatcher that switches on `resultData.type`. |
| `web/app/components/sections/search-section.tsx` (modify) | `SearchState`'s `answer` variant gains `resultData`; renders `<SearchResultDataView>` in the answer card. |

---

### Task 1: Shared result-data types

**Files:**
- Create: `web/lib/search-result-types.ts`
- Test: none (pure type declarations — verified by `tsc`, see Step 2)

**Interfaces:**
- Consumes: `GameRow`, `PlayerStatRow` from `web/lib/team-names.ts` (existing, unchanged)
- Produces: `SearchResultType`, `LeaderRow`, `PlayerStatsResultData`, `TeamGamesResultData`, `LeadersResultData`, `GameResultResultData`, `SearchResultData` — every later task in this plan imports from here.

- [ ] **Step 1: Write the types file**

```typescript
// web/lib/search-result-types.ts
//
// Structured, per-tool result data that rides alongside the NL search
// feature's prose answer. Pure types only (no React, no "use client") so
// this is safely importable from both server code (search-tools.ts,
// search-loop.ts, route.ts) and client code (search-section.tsx, the new
// result-table components) -- same reasoning as web/lib/team-names.ts's
// own split from web/lib/box-score.tsx.
//
// One variant per query tool (search-tools.ts's ToolName) -- deliberately
// not a generic "any tabular data" shape, matching this project's existing
// small-fixed-tool-set philosophy (SPEC.md Constraints).

import type { GameRow, PlayerStatRow } from "@/lib/team-names";

export type SearchResultType = "player_stats" | "team_games" | "leaders" | "game_result";

export interface LeaderRow {
  player_id: number;
  player_name: string;
  value: number;
}

export interface PlayerStatsResultData {
  playerName: string;
  games: PlayerStatRow[];
}

export interface TeamGamesResultData {
  team: string;
  games: GameRow[];
}

export interface LeadersResultData {
  stat: string;
  gameCount: number;
  leaders: LeaderRow[];
}

export interface GameResultResultData {
  game: GameRow;
  boxScore: PlayerStatRow[];
}

export type SearchResultData =
  | { type: "player_stats"; payload: PlayerStatsResultData }
  | { type: "team_games"; payload: TeamGamesResultData }
  | { type: "leaders"; payload: LeadersResultData }
  | { type: "game_result"; payload: GameResultResultData };
```

- [ ] **Step 2: Verify it compiles**

Run: `cd web && npx tsc --noEmit`
Expected: no errors (this file has no runtime behavior yet, nothing imports it yet — this just catches a typo in the type declarations themselves).

- [ ] **Step 3: Commit**

```bash
git add web/lib/search-result-types.ts
git commit -m "feat: add shared types for search result data"
```

---

### Task 2: Derive `resultData` in `search-tools.ts`

**Files:**
- Modify: `web/lib/search-tools.ts`
- Test: `web/lib/search-tools.test.ts`

**Interfaces:**
- Consumes: `SearchResultData`, `LeaderRow` from Task 1's `@/lib/search-result-types`; `GameRow`, `PlayerStatRow` from `@/lib/team-names`.
- Produces: `ToolResultEnvelope.resultData: SearchResultData | null` — Task 3 (`search-loop.ts`) reads this off `lastToolResult`.

**Key finding this task encodes** (verified directly against `api/src/api/routers/query_tools.py` on `origin/main`, not assumed): `get_game_result`'s `box_score` rows come from a plain `select(player_game_stats)` with **no join to `games`** (`SQLAlchemyGameResultToolReader.get_box_score`), so they lack `game_date`/`home_team`/`away_team`/`home_score`/`away_score` — the exact fields `BoxScoreTable`'s `showGameContext` path would need. Since the same response's `data.game` already has all five values, `deriveResultData` enriches each box-score row with them rather than requiring a backend change.

- [ ] **Step 1: Write the failing tests**

Add to `web/lib/search-tools.test.ts` (new `describe` block, alongside the existing `describe("callTool", ...)`):

```typescript
describe("callTool -- resultData", () => {
  beforeEach(() => {
    fetchFromApiMock.mockReset();
  });

  it("derives player_stats resultData verbatim from data.games", async () => {
    fetchFromApiMock.mockResolvedValueOnce({
      status: "ok",
      data: {
        player_name: "Luka Dončić",
        games: [
          { stat_id: "1", game_id: 1, player_id: 1629029, player_first_name: "Luka", player_last_name: "Dončić", team: "DAL", points: 41, rebounds: 6, assists: 5, steals: 1, blocks: 0, turnovers: 4, minutes_played: "31", game_date: "2024-01-03", home_team: "Dallas Mavericks", away_team: "Portland Trail Blazers", home_score: 126, away_score: 97 },
        ],
      },
      candidates: null,
      message: null,
    });

    const result = await callTool("get_player_stats", { player_name: "Luka Doncic" });

    expect(result.resultData).toEqual({
      type: "player_stats",
      payload: {
        playerName: "Luka Dončić",
        games: [
          { stat_id: "1", game_id: 1, player_id: 1629029, player_first_name: "Luka", player_last_name: "Dončić", team: "DAL", points: 41, rebounds: 6, assists: 5, steals: 1, blocks: 0, turnovers: 4, minutes_played: "31", game_date: "2024-01-03", home_team: "Dallas Mavericks", away_team: "Portland Trail Blazers", home_score: 126, away_score: 97 },
        ],
      },
    });
  });

  it("reshapes get_team_games's team-centric rows into GameRow shape", async () => {
    // Real shape from api/src/api/routers/query_tools.py's _team_game_view().
    fetchFromApiMock.mockResolvedValueOnce({
      status: "ok",
      data: {
        team: "Boston Celtics",
        games: [
          {
            game_id: 1, game_date: "2024-01-03", team: "Boston Celtics", opponent: "New York Knicks",
            team_score: 110, opponent_score: 104, is_home: true, status: "Final", postseason: false, season: 2023,
          },
          {
            game_id: 2, game_date: "2024-01-07", team: "Boston Celtics", opponent: "Miami Heat",
            team_score: 98, opponent_score: 101, is_home: false, status: "Final", postseason: false, season: 2023,
          },
        ],
      },
      candidates: null,
      message: null,
    });

    const result = await callTool("get_team_games", { team: "Boston Celtics" });

    expect(result.resultData).toEqual({
      type: "team_games",
      payload: {
        team: "Boston Celtics",
        games: [
          {
            game_id: 1, game_date: "2024-01-03", season: 2023, status: "Final", postseason: false,
            home_team: "Boston Celtics", away_team: "New York Knicks", home_score: 110, away_score: 104,
            source_pulled_at: "",
          },
          {
            game_id: 2, game_date: "2024-01-07", season: 2023, status: "Final", postseason: false,
            home_team: "Miami Heat", away_team: "Boston Celtics", home_score: 101, away_score: 98,
            source_pulled_at: "",
          },
        ],
      },
    });
  });

  it("derives leaders resultData with player_id/player_name/value rows", async () => {
    fetchFromApiMock.mockResolvedValueOnce({
      status: "ok",
      data: {
        stat: "points",
        date_range: { start_date: "2024-01-01", end_date: "2024-01-03" },
        game_count: 26,
        leaders: [
          { player_id: 203944, player_name: "Julius Randle", value: 74 },
          { player_id: 1630162, player_name: "Anthony Edwards", value: 70 },
        ],
      },
      candidates: null,
      message: null,
    });

    const result = await callTool("get_leaders", {
      stat: "points",
      date_range: { start: "2024-01-01", end: "2024-01-03" },
    });

    expect(result.resultData).toEqual({
      type: "leaders",
      payload: {
        stat: "points",
        gameCount: 26,
        leaders: [
          { player_id: 203944, player_name: "Julius Randle", value: 74 },
          { player_id: 1630162, player_name: "Anthony Edwards", value: 70 },
        ],
      },
    });
  });

  it("enriches get_game_result's box_score rows with the game's own date/team/score fields", async () => {
    // Real shape: query_tools.py's get_box_score() selects plain
    // player_game_stats with NO join to games -- box_score rows have no
    // game_date/home_team/away_team/home_score/away_score of their own.
    fetchFromApiMock.mockResolvedValueOnce({
      status: "ok",
      data: {
        game: {
          game_id: 1, game_date: "2024-01-03", season: 2023, status: "Final", postseason: false,
          home_team: "Dallas Mavericks", away_team: "Portland Trail Blazers", home_score: 126, away_score: 97,
          source_pulled_at: "2026-01-01T00:00:00Z",
        },
        box_score: [
          { stat_id: "1", game_id: 1, player_id: 1629029, player_first_name: "Luka", player_last_name: "Dončić", team: "DAL", points: 41, rebounds: 6, assists: 5, steals: 1, blocks: 0, turnovers: 4, minutes_played: "31" },
        ],
      },
      candidates: null,
      message: null,
    });

    const result = await callTool("get_game_result", {
      team_a: "Dallas Mavericks",
      team_b: "Portland Trail Blazers",
      date: "2024-01-03",
    });

    expect(result.resultData).toEqual({
      type: "game_result",
      payload: {
        game: {
          game_id: 1, game_date: "2024-01-03", season: 2023, status: "Final", postseason: false,
          home_team: "Dallas Mavericks", away_team: "Portland Trail Blazers", home_score: 126, away_score: 97,
          source_pulled_at: "2026-01-01T00:00:00Z",
        },
        boxScore: [
          {
            stat_id: "1", game_id: 1, player_id: 1629029, player_first_name: "Luka", player_last_name: "Dončić",
            team: "DAL", points: 41, rebounds: 6, assists: 5, steals: 1, blocks: 0, turnovers: 4, minutes_played: "31",
            game_date: "2024-01-03", home_team: "Dallas Mavericks", away_team: "Portland Trail Blazers",
            home_score: 126, away_score: 97,
          },
        ],
      },
    });
  });

  it("is null for a no_match result, same as citation", async () => {
    fetchFromApiMock.mockResolvedValueOnce({
      status: "no_match",
      data: null,
      candidates: null,
      message: "No player found matching 'Zzz'.",
    });

    const result = await callTool("get_player_stats", { player_name: "Zzz" });

    expect(result.resultData).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run lib/search-tools.test.ts`
Expected: FAIL — `result.resultData` is `undefined` (property doesn't exist yet), 5 new failing assertions.

- [ ] **Step 3: Implement `deriveResultData` and wire it into `normalizeEnvelope`**

In `web/lib/search-tools.ts`:

1. Add the import (below the existing `ToolDefinition` import):

```typescript
import type { SearchResultData, LeaderRow } from "@/lib/search-result-types";
import type { GameRow, PlayerStatRow } from "@/lib/team-names";
```

2. Add `resultData: SearchResultData | null;` to the `ToolResultEnvelope` interface, and `resultData: null,` to `ERROR_ENVELOPE`.

3. Add these two functions directly below `deriveDateRange` (same file section, same per-tool-branching style):

```typescript
// Reshapes get_team_games's team-centric row (query_tools.py's
// _team_game_view -- team/opponent/team_score/opponent_score/is_home) back
// into GameRow's home/away shape, so it can reuse the same rendering as
// get_game_result's `game` and the games/[id] page's own GameRow. There is
// no `source_pulled_at` on the team-games view -- it's set to "" rather
// than omitted (GameRow requires it) since nothing that renders a GameRow
// (BoxScoreTable, the new GameMatchupCard in Task 6) ever reads it.
function teamGameViewToGameRow(row: Record<string, unknown>): GameRow {
  const isHome = row.is_home === true;
  const team = String(row.team ?? "");
  const opponent = String(row.opponent ?? "");
  const teamScore = typeof row.team_score === "number" ? row.team_score : null;
  const opponentScore = typeof row.opponent_score === "number" ? row.opponent_score : null;
  return {
    game_id: Number(row.game_id),
    game_date: String(row.game_date ?? ""),
    season: Number(row.season),
    status: String(row.status ?? ""),
    postseason: row.postseason === true,
    home_team: isHome ? team : opponent,
    away_team: isHome ? opponent : team,
    home_score: isHome ? teamScore : opponentScore,
    away_score: isHome ? opponentScore : teamScore,
    source_pulled_at: "",
  };
}

// Derives the structured, per-tool-typed result data an "ok" response
// carries, for the NL search page to render alongside its prose answer.
// Mirrors deriveDateRange()'s per-tool branching -- each tool's real shape
// (api/tests/test_query_tools.py's fixtures) is handled explicitly.
function deriveResultData(name: ToolName, data: unknown): SearchResultData | null {
  if (!data || typeof data !== "object") return null;
  const payload = data as Record<string, unknown>;

  switch (name) {
    case "get_player_stats": {
      const games = payload.games;
      if (!Array.isArray(games)) return null;
      return {
        type: "player_stats",
        payload: {
          playerName: String(payload.player_name ?? ""),
          games: games as PlayerStatRow[],
        },
      };
    }
    case "get_team_games": {
      const rawGames = payload.games;
      if (!Array.isArray(rawGames)) return null;
      return {
        type: "team_games",
        payload: {
          team: String(payload.team ?? ""),
          games: rawGames.map((row) => teamGameViewToGameRow(row as Record<string, unknown>)),
        },
      };
    }
    case "get_leaders": {
      const leaders = payload.leaders;
      const gameCount = payload.game_count;
      if (!Array.isArray(leaders) || typeof gameCount !== "number") return null;
      return {
        type: "leaders",
        payload: {
          stat: String(payload.stat ?? ""),
          gameCount,
          leaders: leaders as LeaderRow[],
        },
      };
    }
    case "get_game_result": {
      const game = payload.game;
      const boxScore = payload.box_score;
      if (!game || typeof game !== "object" || !Array.isArray(boxScore)) return null;
      const gameRow = game as GameRow;
      // query_tools.py's get_box_score() selects plain player_game_stats
      // with no join to games -- enrich each row with the game-context
      // fields BoxScoreTable expects, using the values already present on
      // `game` in this same response (no second lookup needed).
      const enrichedBoxScore = (boxScore as Record<string, unknown>[]).map((row) => ({
        ...row,
        game_date: gameRow.game_date,
        home_team: gameRow.home_team,
        away_team: gameRow.away_team,
        home_score: gameRow.home_score,
        away_score: gameRow.away_score,
      })) as PlayerStatRow[];
      return {
        type: "game_result",
        payload: { game: gameRow, boxScore: enrichedBoxScore },
      };
    }
  }
}
```

4. In `normalizeEnvelope()`, add `resultData` to the returned object, right after `date_range`:

```typescript
    date_range: isOk ? deriveDateRange(name, data) : null,
    resultData: isOk ? deriveResultData(name, data) : null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run lib/search-tools.test.ts`
Expected: PASS, all tests including the 5 new ones and every pre-existing test (the pre-existing tests don't assert on `resultData`, so an additive field doesn't break them via `toEqual` — confirm by running the full file, not just the new block).

- [ ] **Step 5: Commit**

```bash
git add web/lib/search-tools.ts web/lib/search-tools.test.ts
git commit -m "feat: derive structured resultData per tool in search-tools.ts"
```

---

### Task 3: Thread `resultData` through `search-loop.ts`'s `SearchResult`

**Files:**
- Modify: `web/lib/search-loop.ts`
- Test: `web/lib/search-loop.test.ts`

**Interfaces:**
- Consumes: `ToolResultEnvelope.resultData` (Task 2).
- Produces: `SearchResult.resultData: SearchResultData | null` — Task 4 (`route.ts`) reads this.

- [ ] **Step 1: Write the failing tests**

Add to `web/lib/search-loop.test.ts`:

```typescript
import type { SearchResultData } from "@/lib/search-result-types";
```

Add a `resultData` field to the existing `OK_RESULT` fixture (and leave the other three fixtures — `NO_MATCH_RESULT`, `AMBIGUOUS_RESULT`, `ERROR_RESULT` — with `resultData: null`, since `ToolResultEnvelope` now requires the field on every fixture object):

```typescript
const SAMPLE_RESULT_DATA: SearchResultData = {
  type: "player_stats",
  payload: { playerName: "LeBron James", games: [] },
};

const OK_RESULT: ToolResultEnvelope = {
  status: "ok",
  table: "player_game_stats",
  date_range: "2024-10-22 to 2024-10-22",
  data: [{ points: 30 }],
  resultData: SAMPLE_RESULT_DATA,
  candidates: null,
  message: null,
};
```

(Add `resultData: null,` to `NO_MATCH_RESULT`, `AMBIGUOUS_RESULT`, `ERROR_RESULT` too — a required-field type error otherwise, not a behavioral test.)

New test cases (add to the `describe("runSearchLoop", ...)` block):

```typescript
  it("happy path: resultData is populated alongside the citation", async () => {
    const llmClient = fakeLlmClient(
      toolCallResponse("get_player_stats", { player_name: "LeBron James" }),
      finalResponse("LeBron James scored 30 points on 2024-10-22."),
    );
    const callTool = vi.fn().mockResolvedValueOnce(OK_RESULT);

    const result = await runSearchLoop({ question: "How many points did LeBron score?", llmClient, callTool });

    expect(result.resultData).toEqual(SAMPLE_RESULT_DATA);
  });

  it("resultData is null on a no_match result, same as citation", async () => {
    const llmClient = fakeLlmClient(
      toolCallResponse("get_game_result", { team_a: "Lakers", team_b: "Celtics", date: "2099-01-01" }),
      finalResponse("I couldn't find a game between those teams on that date."),
    );
    const callTool = vi.fn().mockResolvedValueOnce(NO_MATCH_RESULT);

    const result = await runSearchLoop({ question: "Lakers vs Celtics on 2099-01-01?", llmClient, callTool });

    expect(result.resultData).toBeNull();
  });

  it("resultData is null on FALLBACK_RESULT (no tool call ever succeeded)", async () => {
    const llmClient = fakeLlmClient(finalResponse("I don't know."));
    const callTool = vi.fn();

    const result = await runSearchLoop({ question: "asdf", llmClient, callTool });

    expect(result).toEqual(FALLBACK_RESULT);
    expect(result.resultData).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run lib/search-loop.test.ts`
Expected: FAIL to compile (`resultData` doesn't exist on `SearchResult`/`ToolResultEnvelope` yet) — a TypeScript error is the expected "fail" here, same as a runtime assertion failure would be.

- [ ] **Step 3: Implement**

In `web/lib/search-loop.ts`:

1. Add the import: `import type { SearchResultData } from "@/lib/search-result-types";`

2. Add `resultData: SearchResultData | null;` to the `SearchResult` interface.

3. Add `resultData: null,` to `FALLBACK_RESULT`.

4. In `finalize()`, add `resultData: null,` to the `no_match` return and to the `ambiguous`-with-no-candidates fallback (both already `return`-ing object literals — add the field to each). In the `ambiguous`-with-candidates return, also add `resultData: null,` (an ambiguous result never carries table/date_range either, per the existing code — resultData follows the same rule). In the final `status === "ok"` return (the success path), add:

```typescript
  return {
    answerText,
    citation: { table: lastToolResult.table, dateRange: lastToolResult.date_range },
    noData: false,
    candidates: null,
    resultData: lastToolResult.resultData,
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run lib/search-loop.test.ts`
Expected: PASS, all tests including the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add web/lib/search-loop.ts web/lib/search-loop.test.ts
git commit -m "feat: thread resultData through search-loop's SearchResult"
```

---

### Task 4: Include `resultData` in the SSE `done` payload

**Files:**
- Modify: `web/app/api/search/route.ts`
- Test: `web/app/api/search/route.test.ts`

**Interfaces:**
- Consumes: `SearchResult.resultData` (Task 3).
- Produces: the `event: done` frame's JSON now includes `resultData` — Task 5 (`search-stream.ts`) parses this.

- [ ] **Step 1: Write the failing test**

Add to `web/app/api/search/route.test.ts` (extend the existing "streams the answer as data: chunks..." test, or add a new one — add a new one to keep each test focused on one behavior):

```typescript
  it("includes resultData in the done event when the search loop returns it", async () => {
    const resultData = {
      type: "player_stats" as const,
      payload: { playerName: "LeBron James", games: [] },
    };
    runSearchLoopMock.mockResolvedValueOnce({
      answerText: "LeBron James scored 30 points.",
      citation: { table: "player_game_stats", dateRange: "2024-10-22" },
      noData: false,
      candidates: null,
      resultData,
    });

    const response = await POST(postRequest({ question: "How many points did LeBron score?" }));
    const body = await readBody(response);
    const doneFrame = body.split("\n\n").filter(Boolean).pop()!;
    const doneJson = JSON.parse(doneFrame.split("data: ")[1]);

    expect(doneJson.resultData).toEqual(resultData);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run app/api/search/route.test.ts`
Expected: FAIL — `doneJson.resultData` is `undefined`.

- [ ] **Step 3: Implement**

In `web/app/api/search/route.ts`, the `sseDone()` call site (inside `start(controller)`) already destructures fields off `result`:

```typescript
      safeEnqueue(
        sseDone({
          citation: result.citation,
          noData: result.noData,
          candidates: result.candidates,
          resultData: result.resultData,
        }),
      );
```

(`sseDone`'s parameter type is `Omit<SearchResult, "answerText">`, which already includes `resultData` automatically once Task 3 adds it to `SearchResult` — no separate type change needed here.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run app/api/search/route.test.ts`
Expected: PASS, all tests including the new one.

- [ ] **Step 5: Commit**

```bash
git add web/app/api/search/route.ts web/app/api/search/route.test.ts
git commit -m "feat: include resultData in the /api/search done event"
```

---

### Task 5: Parse `resultData` in `search-stream.ts`

**Files:**
- Modify: `web/lib/search-stream.ts`
- Test: `web/lib/search-stream.test.ts`

**Interfaces:**
- Consumes: the `done` frame's JSON (Task 4).
- Produces: `SearchDonePayload.resultData: SearchResultData | null` — Task 7 (`search-section.tsx`) reads this.

- [ ] **Step 1: Write the failing tests**

Add to `web/lib/search-stream.test.ts`:

```typescript
import type { SearchResultData } from "@/lib/search-result-types";
```

```typescript
  it("parses resultData from a done payload when present", async () => {
    const resultData: SearchResultData = {
      type: "leaders",
      payload: { stat: "points", gameCount: 26, leaders: [{ player_id: 1, player_name: "A", value: 10 }] },
    };
    const response = doneOnlyResponse({ citation: null, noData: false, candidates: null, resultData });

    const events = await collectEvents(readSearchStream(response));

    expect(events[events.length - 1]).toEqual({
      kind: "done",
      payload: { citation: null, noData: false, candidates: null, resultData },
    });
  });

  it("drops a malformed resultData (wrong type discriminant) rather than failing the whole done parse", async () => {
    const response = doneOnlyResponse({
      citation: null,
      noData: false,
      candidates: null,
      resultData: { type: "not_a_real_type", payload: {} },
    });

    const events = await collectEvents(readSearchStream(response));

    expect(events[events.length - 1]).toEqual({
      kind: "done",
      payload: { citation: null, noData: false, candidates: null, resultData: null },
    });
  });

  it("defaults resultData to null when absent (backward-compatible with an older payload)", async () => {
    const response = doneOnlyResponse({ citation: null, noData: true, candidates: null });

    const events = await collectEvents(readSearchStream(response));

    expect(events[events.length - 1]).toEqual({
      kind: "done",
      payload: { citation: null, noData: true, candidates: null, resultData: null },
    });
  });
```

(These three tests assume `doneOnlyResponse` and `collectEvents` test helpers already exist in this file, matching whatever names the existing `done`-payload tests already use — if the existing helper names differ, use those instead; the assertions' shape is what matters, not the helper name.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run lib/search-stream.test.ts`
Expected: FAIL — `payload.resultData` is `undefined` in the actual result (not present in `SearchDonePayload` yet), so `toEqual` mismatches.

- [ ] **Step 3: Implement**

In `web/lib/search-stream.ts`:

1. Add the import: `import type { SearchResultData } from "@/lib/search-result-types";`

2. Add `resultData: SearchResultData | null;` to the `SearchDonePayload` type.

3. Add a validator function right below `parseDonePayload`'s existing `citation` block:

```typescript
// Defensive, drift-tolerant, same style as the citation block above: only
// checks the discriminant `type` is one of the four known values and
// `payload` is present as an object -- does not deep-validate every nested
// field (that's the FastAPI/search-tools.ts layer's job; a payload that
// reaches this far already passed through deriveResultData()). An unknown
// `type` (or a missing/non-object `payload`) is dropped to null rather
// than thrown on, consistent with every other field in this function.
function parseResultData(raw: unknown): SearchResultData | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const validTypes = ["player_stats", "team_games", "leaders", "game_result"];
  if (typeof obj.type !== "string" || !validTypes.includes(obj.type)) {
    console.warn("/api/search done payload: unrecognized resultData.type, dropped", obj.type);
    return null;
  }
  if (typeof obj.payload !== "object" || obj.payload === null) {
    console.warn("/api/search done payload: resultData missing a payload object, dropped", obj);
    return null;
  }
  return raw as SearchResultData;
}
```

4. In `parseDonePayload()`, right before the final `return { citation, noData, candidates };` line, add:

```typescript
  const resultData = parseResultData(obj.resultData);
```

and change the return to:

```typescript
  return { citation, noData, candidates, resultData };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run lib/search-stream.test.ts`
Expected: PASS, all tests including the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add web/lib/search-stream.ts web/lib/search-stream.test.ts
git commit -m "feat: parse resultData from the /api/search done payload"
```

---

### Task 6: New result-table components

**Files:**
- Create: `web/app/components/sections/search-result-tables.tsx`
- Test: `web/app/components/sections/search-result-tables.test.tsx`

**Interfaces:**
- Consumes: `SearchResultData` (Task 1); `BoxScoreTable`, `TeamLink`, `TeamLogo`, `scoreColorClass`, `displayScore`, `formatGameDate`, `TEAM_NAME_TO_ABBREVIATION`, `type GameRow` from `@/lib/box-score` (existing, unchanged); shadcn `Table`/`Card`/`Badge` primitives.
- Produces: `SearchResultDataView({ resultData })` — Task 7 renders this in `search-section.tsx`.

**Design note:** `GameMatchupCard` here is a new, search-feature-scoped component built from the same primitives `web/app/games/[id]/page.tsx`'s inline `GameDetail` header already uses — it is *not* extracted from that file (which stays untouched, zero regression risk to already-shipped code). Sharing one component between the two pages is a reasonable future cleanup, deliberately out of this plan's scope.

- [ ] **Step 1: Write the failing tests**

Create `web/app/components/sections/search-result-tables.test.tsx`:

```typescript
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SearchResultDataView } from "./search-result-tables";
import type { SearchResultData } from "@/lib/search-result-types";
import type { GameRow, PlayerStatRow } from "@/lib/team-names";

const SAMPLE_GAME: GameRow = {
  game_id: 1, game_date: "2024-01-03", season: 2023, status: "Final", postseason: false,
  home_team: "Dallas Mavericks", away_team: "Portland Trail Blazers", home_score: 126, away_score: 97,
  source_pulled_at: "",
};

const SAMPLE_STAT_ROW: PlayerStatRow = {
  stat_id: "1", game_id: 1, player_id: 1629029, player_first_name: "Luka", player_last_name: "Dončić",
  team: "DAL", points: 41, rebounds: 6, assists: 5, steals: 1, blocks: 0, turnovers: 4, minutes_played: "31",
  game_date: "2024-01-03", home_team: "Dallas Mavericks", away_team: "Portland Trail Blazers",
  home_score: 126, away_score: 97,
};

describe("SearchResultDataView", () => {
  it("renders nothing for null resultData", () => {
    const { container } = render(<SearchResultDataView resultData={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a BoxScoreTable for player_stats", () => {
    const resultData: SearchResultData = {
      type: "player_stats",
      payload: { playerName: "Luka Dončić", games: [SAMPLE_STAT_ROW] },
    };
    render(<SearchResultDataView resultData={resultData} />);
    expect(screen.getByText("Dončić")).toBeInTheDocument();
    expect(screen.getByText("41")).toBeInTheDocument();
  });

  it("renders a matchup card + box score for game_result", () => {
    const resultData: SearchResultData = {
      type: "game_result",
      payload: { game: SAMPLE_GAME, boxScore: [SAMPLE_STAT_ROW] },
    };
    render(<SearchResultDataView resultData={resultData} />);
    expect(screen.getByText("Dallas Mavericks")).toBeInTheDocument();
    expect(screen.getByText("126")).toBeInTheDocument();
    expect(screen.getByText("Dončić")).toBeInTheDocument();
  });

  it("renders one matchup card per game for team_games", () => {
    const secondGame: GameRow = { ...SAMPLE_GAME, game_id: 2, game_date: "2024-01-07", home_team: "Boston Celtics", away_team: "Miami Heat", home_score: 101, away_score: 98 };
    const resultData: SearchResultData = {
      type: "team_games",
      payload: { team: "Boston Celtics", games: [SAMPLE_GAME, secondGame] },
    };
    render(<SearchResultDataView resultData={resultData} />);
    expect(screen.getByText("Dallas Mavericks")).toBeInTheDocument();
    expect(screen.getByText("Boston Celtics")).toBeInTheDocument();
  });

  it("renders a ranked table for leaders", () => {
    const resultData: SearchResultData = {
      type: "leaders",
      payload: {
        stat: "points",
        gameCount: 26,
        leaders: [
          { player_id: 203944, player_name: "Julius Randle", value: 74 },
          { player_id: 1630162, player_name: "Anthony Edwards", value: 70 },
        ],
      },
    };
    render(<SearchResultDataView resultData={resultData} />);
    expect(screen.getByText("Julius Randle")).toBeInTheDocument();
    expect(screen.getByText("74")).toBeInTheDocument();
    expect(screen.getByText(/26 games/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run app/components/sections/search-result-tables.test.tsx`
Expected: FAIL — the module doesn't exist yet (`Cannot find module './search-result-tables'`).

- [ ] **Step 3: Implement**

Create `web/app/components/sections/search-result-tables.tsx`:

```tsx
"use client";

import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  BoxScoreTable,
  displayScore,
  formatGameDate,
  scoreColorClass,
  TeamLink,
  TeamLogo,
  teamLogoUrlFromName,
  TEAM_NAME_TO_ABBREVIATION,
  type GameRow,
} from "@/lib/box-score";
import type { LeadersResultData, SearchResultData } from "@/lib/search-result-types";
import { cn } from "@/lib/utils";

/**
 * A single game's matchup card -- team names/logos, final score, status
 * badge. Built from the same primitives `games/[id]/page.tsx`'s own
 * GameDetail header uses, but is its own small component here (that file
 * is left untouched -- see this task's plan entry for why).
 */
function GameMatchupCard({ game }: { game: GameRow }) {
  const awayAbbreviation = TEAM_NAME_TO_ABBREVIATION[game.away_team] ?? game.away_team;
  const homeAbbreviation = TEAM_NAME_TO_ABBREVIATION[game.home_team] ?? game.home_team;
  return (
    <Card className="gap-3">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="font-geist-mono text-xs font-medium tracking-wide text-muted-foreground">
          {formatGameDate(game.game_date)}
          {game.postseason ? " · Postseason" : ""}
        </CardTitle>
        <Badge variant={game.status.toLowerCase() === "final" ? "secondary" : "outline"}>
          {game.status.charAt(0).toUpperCase() + game.status.slice(1)}
        </Badge>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-2 font-geist-mono text-sm">
          <TeamLink
            abbreviation={awayAbbreviation}
            className={cn(
              "-mx-1 -my-0.5 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-muted",
              scoreColorClass(game.away_score, game.home_score)
            )}
          >
            <TeamLogo src={teamLogoUrlFromName(game.away_team)} alt="" />
            {game.away_team}
          </TeamLink>
          <span
            className={cn(
              "text-lg font-semibold tabular-nums",
              scoreColorClass(game.away_score, game.home_score)
            )}
          >
            {displayScore(game.away_score)}
          </span>
          <span className="text-muted-foreground">@</span>
          <TeamLink
            abbreviation={homeAbbreviation}
            className={cn(
              "-mx-1 -my-0.5 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-muted",
              scoreColorClass(game.home_score, game.away_score)
            )}
          >
            <TeamLogo src={teamLogoUrlFromName(game.home_team)} alt="" />
            {game.home_team}
          </TeamLink>
          <span
            className={cn(
              "text-lg font-semibold tabular-nums",
              scoreColorClass(game.home_score, game.away_score)
            )}
          >
            {displayScore(game.home_score)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/** No existing table in this app renders a ranked leaderboard -- this is a
 * new, small, non-sortable table (the API already returns it pre-ranked by
 * value, per query_tools.py's get_leaders; a client-side re-sort would be
 * pure ceremony for a single stable ordering). */
function LeadersTable({ stat, gameCount, leaders }: LeadersResultData) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        {stat} leaders · {gameCount} game{gameCount === 1 ? "" : "s"}
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">#</TableHead>
            <TableHead>Player</TableHead>
            <TableHead className="text-right">{stat}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {leaders.map((row, index) => (
            <TableRow key={row.player_id}>
              <TableCell className="font-mono tabular-nums text-muted-foreground">
                {index + 1}
              </TableCell>
              <TableCell className="font-medium text-foreground">
                <Link
                  href={`/players/${row.player_id}`}
                  className="-mx-1 -my-0.5 rounded-md px-1 py-0.5 transition-colors hover:bg-muted hover:underline"
                >
                  {row.player_name}
                </Link>
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">{row.value}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Dispatches on `resultData.type` to the right table/card for whichever
 * tool actually answered the question. Renders nothing for `null` (a
 * genuine no-data/ambiguous/error answer never carries resultData -- see
 * search-loop.ts's finalize()). */
export function SearchResultDataView({ resultData }: { resultData: SearchResultData | null }) {
  if (!resultData) return null;

  switch (resultData.type) {
    case "player_stats":
      return <BoxScoreTable rows={resultData.payload.games} showGameContext />;

    case "game_result":
      return (
        <div className="flex flex-col gap-4">
          <GameMatchupCard game={resultData.payload.game} />
          <BoxScoreTable rows={resultData.payload.boxScore} />
        </div>
      );

    case "team_games":
      return (
        <div className="flex flex-col gap-3">
          {resultData.payload.games.map((game) => (
            <GameMatchupCard key={game.game_id} game={game} />
          ))}
        </div>
      );

    case "leaders":
      return <LeadersTable {...resultData.payload} />;

    default: {
      // Exhaustiveness check: a new SearchResultData variant that isn't
      // handled above fails to compile here, same convention already used
      // in search-section.tsx and search-stream.ts.
      const exhaustiveCheck: never = resultData;
      return exhaustiveCheck;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run app/components/sections/search-result-tables.test.tsx`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add web/app/components/sections/search-result-tables.tsx web/app/components/sections/search-result-tables.test.tsx
git commit -m "feat: add SearchResultDataView table/card components"
```

---

### Task 7: Wire `SearchResultDataView` into `search-section.tsx`

**Files:**
- Modify: `web/app/components/sections/search-section.tsx`
- Test: `web/app/components/sections/search-section.test.tsx`

**Interfaces:**
- Consumes: `SearchResultDataView` (Task 6); `SearchDonePayload.resultData` (Task 5).

- [ ] **Step 1: Write the failing test**

Add to `web/app/components/sections/search-section.test.tsx` (following whatever pattern the existing `"done"` → `"answer"` state tests already use for mocking the stream — mock `readSearchStream` to yield a `done` event, then assert on the rendered output):

```typescript
  it("renders SearchResultDataView's content when the done payload carries resultData", async () => {
    mockReadSearchStream([
      { kind: "chunk", text: "Luka Dončić scored 41 points." },
      {
        kind: "done",
        payload: {
          citation: { table: "player_game_stats", dateRange: "2024-01-03" },
          noData: false,
          candidates: null,
          resultData: {
            type: "player_stats",
            payload: {
              playerName: "Luka Dončić",
              games: [
                {
                  stat_id: "1", game_id: 1, player_id: 1629029, player_first_name: "Luka",
                  player_last_name: "Dončić", team: "DAL", points: 41, rebounds: 6, assists: 5,
                  steals: 1, blocks: 0, turnovers: 4, minutes_played: "31", game_date: "2024-01-03",
                  home_team: "Dallas Mavericks", away_team: "Portland Trail Blazers",
                  home_score: 126, away_score: 97,
                },
              ],
            },
          },
        },
      },
    ]);

    render(<SearchSection />);
    await submitQuestion("How many points did Luka score on Jan 3?");

    expect(await screen.findByText("Luka Dončić scored 41 points.")).toBeInTheDocument();
    expect(screen.getByText("41")).toBeInTheDocument();
  });

  it("renders the answer with no table when resultData is null (no-data/ambiguous/older payload)", async () => {
    mockReadSearchStream([
      { kind: "chunk", text: "Some answer." },
      {
        kind: "done",
        payload: { citation: { table: "games", dateRange: "2024-01-03" }, noData: false, candidates: null, resultData: null },
      },
    ]);

    render(<SearchSection />);
    await submitQuestion("A question.");

    expect(await screen.findByText("Some answer.")).toBeInTheDocument();
    // No crash, and no stray table rendered for a null resultData.
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
```

(`mockReadSearchStream` and `submitQuestion` are placeholder names for whatever test helpers this file already uses to mock `readSearchStream` and drive a question through the form — match the existing file's actual helper names; the assertions are what matter.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run app/components/sections/search-section.test.tsx`
Expected: FAIL to compile — `resultData` isn't a valid property on the `done` payload type / the `answer` state variant yet.

- [ ] **Step 3: Implement**

In `web/app/components/sections/search-section.tsx`:

1. Add the import: `import { SearchResultDataView } from "./search-result-tables";` and `import type { SearchResultData } from "@/lib/search-result-types";`

2. Extend the `SearchState` union's `answer` variant:

```typescript
  | { status: "answer"; text: string; citation: SearchCitation | null; resultData: SearchResultData | null }
```

3. In `runSearch()`'s `"done"` case, the `else` branch that sets the `answer` state currently reads:

```typescript
              } else {
                setState((prev) => ({
                  status: "answer",
                  text: prev.status === "streaming" ? prev.text : "",
                  citation: payload.citation,
                }));
              }
```

Add `resultData: payload.resultData,` to that object literal.

4. In the `SearchResult()` render function's `"answer"` case, insert `<SearchResultDataView resultData={state.resultData} />` between the answer-text paragraph and the citation-footer block (i.e. right after the `{state.text ? (...) : (...)}` block, before the `{state.citation ? (...) : (...)}` block), inside the same `CardContent`:

```tsx
          <CardContent className="flex flex-col gap-4">
            {state.text ? (
              <p className="leading-6 whitespace-pre-wrap">{state.text}</p>
            ) : (
              <p className="text-sm text-muted-foreground italic">
                The assistant finished without returning any answer text.
              </p>
            )}
            <SearchResultDataView resultData={state.resultData} />
            {state.citation ? (
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run app/components/sections/search-section.test.tsx`
Expected: PASS, all tests including the 2 new ones.

- [ ] **Step 5: Full verification**

Run, in order:
```bash
cd web
npx next typegen
npx tsc --noEmit
npm run lint
npx vitest run
```
Expected: all four clean/passing — this is the final gate before the manual check below.

- [ ] **Step 6: Manual verification against real data**

With the local dev servers running (`api/`: `uv run uvicorn api.main:app --port 8010`; `web/`: `npm run dev`, `FASTAPI_BASE_URL=http://localhost:8010` in `web/.env.local`), open `/search` in a browser and ask, in turn:
- "How many points did Luka Doncic score on January 3 2024?" → expect the prose answer **and** a box-score row for Dončić.
- "Who led the league in points between January 1 and January 3 2024?" → expect the prose answer **and** a ranked leaders table.
- A game-result question for a real ingested matchup/date → expect a matchup card **and** its box score.
- A team-games question for a real team → expect one matchup card per game.

This step matters because SSE/JSON round-tripping through a real fetch, and shadcn `Table` rendering with real (possibly `null`-scored, DNP) rows, are exactly the class of thing this project's own history shows unit tests alone can miss (e.g. the earlier Gemini `thought_signature` bug, found only live).

- [ ] **Step 7: Commit**

```bash
git add web/app/components/sections/search-section.tsx web/app/components/sections/search-section.test.tsx
git commit -m "feat: render SearchResultDataView in the search answer card"
```

---

## Self-Review Notes

- **Spec coverage:** every layer identified in the data-flow research (`ToolResultEnvelope` → `SearchResult` → SSE `done` → `SearchDonePayload` → React state → render) has a task; the one real gap found during research (`get_game_result`'s unjoined `box_score` rows) is explicitly handled in Task 2, not glossed over.
- **Placeholder scan:** no TBD/TODO; the one intentional placeholder-looking value (`source_pulled_at: ""` in `teamGameViewToGameRow`) is justified inline with the specific reason it's safe (verified by reading every consumer of `GameRow` added in this plan).
- **Type consistency:** `SearchResultData`'s shape (`{type, payload}`) is identical across Task 1's definition, Task 2's `deriveResultData` return values, Task 6's `SearchResultDataView` switch, and every test fixture in Tasks 2/3/4/5/6/7 — checked by re-reading each task's code side by side after writing it.

---

**Plan complete and saved to `docs/superpowers/plans/2026-09-06-search-structured-result-tables.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
