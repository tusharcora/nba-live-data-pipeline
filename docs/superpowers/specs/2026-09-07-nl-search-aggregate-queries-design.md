# NL Search — Aggregate & Streak Queries — Design

## Context

The Statmuse-style NL stats search feature
(`web/app/api/search/route.ts`, `web/lib/search-loop.ts`,
`web/lib/search-tools.ts`, `api/src/api/routers/query_tools.py`) exists on
unmerged feature branches (`story2/bff-search-route`,
`story3/search-page-ui`, `origin/worktree-search-result-tables`) under the
canonical contract `SPEC-nl-stats-search` (`_bmad-output/specs/spec-nl-stats-search/{SPEC,query-tools}.md`)
— not yet on `main` or `v2-sportsbook-redesign`. This design is written
against the feature as it exists on `origin/worktree-search-result-tables`
today, same precedent as `2026-09-07-search-result-cache-design.md`:
implementation lands wherever that feature actually merges.

SPEC-nl-stats-search v1 ships exactly four narrow, typed tools —
`get_player_stats`, `get_team_games`, `get_leaders`, `get_game_result` —
each a thin wrapper returning raw rows or a top-N ranking. None of them can
answer a threshold-count or aggregate question: **"How many 30-point games
does LeBron have"** has no matching tool. `get_player_stats` would return
every game row for the player and leave counting to the model — which
breaks down the moment a career's worth of rows (LeBron: 1,600+ games)
exceeds what an LLM can reliably tally from raw text, and burns context
tokens doing arithmetic a database does natively and exactly. The fix is
new, typed, narrow SQL-aggregation tools, not a smarter prompt — same
philosophy as the existing four, and still inside SPEC-nl-stats-search's
hard constraint of "no general/arbitrary SQL-execution tool."

## Question taxonomy

The full space of stats questions this pipeline's data could plausibly
answer, and which tier handles each:

| Question type | Example | Tier |
|---|---|---|
| Point-lookup | "LeBron's stats on Jan 5" | **v1 (existing)** — `get_player_stats` |
| Team game log / result | "Lakers' last 5 games" | **v1 (existing)** — `get_team_games` |
| Head-to-head result | "Lakers vs Celtics on Jan 5" | **v1 (existing)** — `get_game_result` |
| League leaderboard | "Who leads in assists" | **v1 (existing)** — `get_leaders` |
| Threshold-count | "How many 30-point games does LeBron have" | **v2 (this design)** — `get_player_stat_aggregate` |
| Simple aggregate (sum/avg/max/min) | "LeBron's scoring average", "his career-high rebounds" | **v2 (this design)** — `get_player_stat_aggregate` |
| Player/team comparison | "Who scored more, LeBron or Durant" | **v2 (this design)** — two calls to `get_player_stat_aggregate`, no new tool |
| Streak detection | "LeBron's longest streak of 20+ point games" | **v2 (this design)** — `get_player_streak` |
| Multi-stat combo count (double-/triple-doubles) | "How many triple-doubles does he have" | **Deferred** — needs a multi-column threshold, not a single `stat`; a plausible v3 tool, not designed here |
| Conditional split (home/away, vs. opponent) | "His scoring average on the road" | **Deferred** — needs a new filter dimension on top of the aggregate tool; not designed here |
| Rate/percentage stats | "His true shooting percentage this season" | **Deferred** — FG%/3P%/TS% are numerator/denominator pairs that don't `sum`/`avg` correctly as a single column the way count stats do; needs its own aggregation shape, not built here |
| Team-level aggregate leaders | "Which team has the most wins" | **Deferred** — `SPEC-nl-stats-search`'s own v1 deviation already scoped `get_leaders` to players only; unchanged here |
| Cross-season trend narration | "How has his scoring changed over his career" | **Out of scope** — borders on the existing SPEC non-goal against generative/predictive framing |
| Predictive/projection | "Will he score 30 tonight" | **Out of scope** — explicit existing SPEC non-goal |
| Opinion/subjective | "Who's the best scorer" | **Out of scope** — explicit existing SPEC non-goal (general chatbot territory) |

## Goals

- Answer threshold-count, sum/avg/max/min, comparison, and streak
  questions about a single player's real ingested box-score stats, with
  the same citation/no-guessing discipline (CAP-4/CAP-5) the four v1 tools
  already enforce.
- Keep the tool set small, fixed, and narrow — no arbitrary SQL, no
  generic "any aggregate" escape hatch.
- Every numeric answer traces back to a specific tool call and its
  literal result, including which exact game(s) it cites, deterministically.

## Non-goals (explicit deferrals — see taxonomy table)

- Multi-stat combo counts (double-doubles, triple-doubles).
- Home/away or opponent-conditioned splits.
- Rate/percentage stats (FG%, 3P%, TS%, etc.).
- Team-level aggregate leaders (unchanged v1 scope cut).
- Cross-season trend narration, predictive/projection, and opinion
  questions — already excluded by `SPEC-nl-stats-search`'s non-goals.

## Architecture: two new tools

Threshold-count, sum, avg, max, and min all reduce to the same SQL shape —
a `GROUP BY` aggregate, optionally filtered by a `HAVING`/`WHERE` threshold
— so they collapse into **one** generalized tool. Streak detection is a
consecutive-run (gaps-and-islands) query over date-ordered rows: a
genuinely different query shape, not a 6th `operation` value on the same
endpoint, so it gets its own tool. Comparison needs no tool at all — the
LLM issues the same aggregate call twice.

```
NL question
  │
  ▼
search-loop.ts tool-choice (unchanged loop, updated system prompt)
  │
  ├─ single-subject threshold/sum/avg/max/min ──► get_player_stat_aggregate (1 call)
  ├─ comparison of two subjects ──────────────────► get_player_stat_aggregate (2 calls, same operation)
  └─ streak question ─────────────────────────────► get_player_streak (1 call)
```

### Tool 1 — `get_player_stat_aggregate`

```
GET /tools/player-stat-aggregate
  ?player_name=<str>
  &stat=points|rebounds|assists|steals|blocks|turnovers
  &operation=count_over_threshold|count_under_threshold|sum|avg|max|min
  &threshold=<number>        # required iff operation is count_over_threshold/count_under_threshold
  &date=<YYYY-MM-DD> | &start_date=&end_date=
```

Same envelope shape as the v1 tools (`status: ok|no_match|ambiguous|error`),
same name-resolution path (`_resolve_name`, shared with the v1 tools) for
`player_name`.

**`ok` data shape:**

```jsonc
{
  "player_name": "LeBron James",
  "stat": "points",
  "operation": "count_over_threshold",
  "threshold": 30,               // null for sum/avg/max/min
  "value": 47,                   // the true, authoritative aggregate result
  "extreme_game": null,          // populated only for operation == max|min, see below
  "matching_games": [ /* up to 20 rows, newest first */ ],   // populated only for count_* operations
  "matching_games_truncated": true,  // len(matching_games) < value; see Truncation contract
  "game_count_considered": 1611,
  "date_range": {"start": "2003-10-29", "end": "2026-09-06"}
}
```

**`extreme_game` (max/min only) — deterministic tie-break.** A tie on the
extreme value (e.g. two games tied for career-high rebounds) is not rare
for round-number stat lines, and this feature's whole point is citation
discipline — "the database picked one arbitrarily, by incidental row
order" is not an acceptable answer to "which game." The rule: **order by
the aggregated value (`DESC` for max, `ASC` for min), then by `game_date
DESC`, and take the first row.** The most recent of the tied games is
always the one cited. This is deterministic and reproducible across runs
regardless of physical row order.

**Truncation contract.** `value` is always the true, complete
count/sum/avg/extreme — it is never affected by the `matching_games` cap.
`matching_games` (count operations only) caps at 20 rows, newest first,
purely so a 47-game drill-down list doesn't blow up the response/UI. The
response always carries `matching_games_truncated: boolean`
(`len(matching_games) < value`) so the UI can render "showing 20 of 47,"
never a silently-partial list that looks complete. `sum`/`avg`/`max`/`min`
never populate `matching_games` at all (there's nothing to drill into
beyond the single `extreme_game` for max/min).

**Default date range.** Omitting both `date` and `date_range` means **full
ingested history** for every operation, uniformly — there is no
per-operation special case (e.g. "avg defaults to season, max defaults to
career"). A single uniform default is simpler and less surprising than
one that silently varies by operation, and the existing CAP-2 disclosure
requirement (every aggregate answer states its date range) is the actual
safety net against misinterpretation: "LeBron's scoring average" with no
range stated returns the career-to-date average *and* discloses
`"2003-10-29 to 2026-09-06"` in the answer, so a user who meant "this
season" sees the scope and can re-ask with an explicit range rather than
silently getting the wrong number with no way to notice.

**Allowed `stat` values** reuse the existing `ALLOWED_LEADER_STATS` set
from `get_leaders` (`points`, `rebounds`, `assists`, `steals`, `blocks`,
`turnovers`) — no new stat vocabulary introduced.

### Tool 2 — `get_player_streak`

```
GET /tools/player-streak
  ?player_name=<str>
  &stat=points|rebounds|assists|steals|blocks|turnovers
  &threshold=<number>
  &start_date=&end_date=       # optional, same "omitted = full history" default as Tool 1
```

**`ok` data shape:**

```jsonc
{
  "player_name": "LeBron James",
  "stat": "points",
  "threshold": 20,
  "longest_streak": 9,
  "streak_date_range": {"start": "2025-11-02", "end": "2025-11-20"},
  "is_active": false,
  "games": [ /* the streak's own games, chronological, uncapped — a streak is bounded by construction */ ]
}
```

**Streak tie-break — same directional rule as `extreme_game`.** If two
non-overlapping streaks of equal length exist, the **more recent** streak
is reported. Consistent with Tool 1's "most recent wins ties" rule rather
than introducing a second convention.

**`is_active` semantics.** `true` iff the reported streak's last game is
also the most recent game inside the considered date range (i.e., the
streak has not yet been broken by a subsequent game falling under
`threshold`). This is the only place order-of-computation matters: the
streak search must run over every game in range including the most recent
one, not stop early, or an active streak would be silently invisible.

**Implementation shape.** Standard gaps-and-islands over date-ordered rows
per player: flag each game as hit/miss against the threshold, group
consecutive hits via `row_number() over (order by game_date) -
row_number() over (partition by hit order by game_date)` (or equivalent),
take the longest group, applying the tie-break and `is_active` rules
above. Implemented as a single parameterized SQLAlchemy Core query
alongside the existing `Table(..., autoload_with=engine)` reflection
pattern — no raw SQL string, consistent with every other reader in this
codebase.

### Comparison — no new tool, a system-prompt rule

`search-loop.ts`'s `SYSTEM_PROMPT` gains one explicit rule:

> For a question comparing two subjects (e.g. "who scored more, X or Y"),
> call `get_player_stat_aggregate` once per subject with the same `stat`
> and `operation`. If the question gives one date range for both subjects,
> use it for both calls. If the question gives a *different* range per
> subject (e.g. "LeBron this month vs. Steph this season"), use each
> subject's own stated range in its own call — do not force both calls to
> share a single range, and never fabricate a single "combined" tool call
> that doesn't exist. State both results and name which is higher.

This is stated explicitly (per-subject ranges are supported, not
rejected) rather than left to in-the-moment model judgment, since either
answer would have been defensible and consistency matters more than which
one was picked.

## Response contract (`web/lib/search-result-types.ts`)

Two new `SearchResultData` variants, following the existing
one-variant-per-tool pattern exactly (no generic "any tabular shape"
fallback):

```ts
export interface StatAggregateResultData {
  playerName: string;
  stat: string;
  operation: "count_over_threshold" | "count_under_threshold" | "sum" | "avg" | "max" | "min";
  threshold: number | null;
  value: number;
  extremeGame: GameStatRow | null;
  matchingGames: GameStatRow[] | null;
  matchingGamesTruncated: boolean;
  gameCountConsidered: number;
}

export interface PlayerStreakResultData {
  playerName: string;
  stat: string;
  threshold: number;
  longestStreak: number;
  isActive: boolean;
  games: GameStatRow[];
}

export type SearchResultData =
  | { type: "player_stats"; payload: PlayerStatsResultData }
  | { type: "team_games"; payload: TeamGamesResultData }
  | { type: "leaders"; payload: LeadersResultData }
  | { type: "game_result"; payload: GameResultResultData }
  | { type: "stat_aggregate"; payload: StatAggregateResultData }     // new
  | { type: "player_streak"; payload: PlayerStreakResultData };     // new
```

`Citation`/`deriveDateRange` in `search-tools.ts` extend the same way the
v1 tools do: `date_range` comes straight off the tool's own response
payload (already present on both new tools), no new derivation logic
needed.

**UI.** Two new result-view components (`StatAggregateResultView`,
`PlayerStreakResultView`) alongside the existing per-type views — a stat
tile for the headline `value`, plus the (possibly-truncated,
explicitly-labeled) game list for count operations or the streak's own
game list.

## Error handling

Same fail-open, honest-gap conventions as the v1 tools — no new pattern:

- Zero games matching the player/date range at all → `no_match` (CAP-5),
  never a `value: 0` masquerading as a real answer to "how many."
- Ambiguous player name → `ambiguous` with candidates, same
  `_resolve_name` path the v1 tools already share.
- A `stat` outside the allowed set → 400 (caller error), same as
  `get_leaders` today — not a tool-result envelope.

## Known limitation: data coverage

Per `docs/PROGRESS.md`, the `nba_stats` historical backfill has been run
for real (2026-09-03) and Gold `player_game_stats` now holds genuine
ingested rows, but coverage is whatever that backfill window actually
covers — not necessarily every player's full career. A "career-high" or
"how many" answer is only ever correct **within the ingested date range**,
same caveat CAP-1 already carries for point-lookup questions; nothing
about the aggregate/streak tools changes that boundary, they just inherit
it. `game_count_considered` / `date_range` in every response is what lets
a user or reviewer notice when a suspiciously-low count is actually a
data-coverage gap, not a real answer.

## Testing

Following this repo's offline-verification convention (fixture rows
through a fake `PlayerStatsReader`-style DI seam, no live Postgres):

- **Threshold boundary**: `count_over_threshold` at exactly `threshold`
  is inclusive (`>=`, not `>`) — a fixture game scoring exactly 30 points
  must count toward "30-point games."
- **`extreme_game` tie-break**: a fixture with two games tied for the max
  value must resolve to the more recent one, deterministically across
  repeated runs.
- **Truncation flag**: a fixture with >20 matching games asserts both
  `value` (the true count) and `matching_games_truncated: true`, with
  `matching_games` capped at 20.
- **Default date range disclosure**: omitting `date_range` returns the
  full fixture history's actual min/max dates in `date_range`, not a
  hardcoded or guessed range.
- **Streak — active case**: a fixture where the most recent game in range
  is part of the longest streak asserts `is_active: true`.
- **Streak — equal-length tie**: a fixture with two non-overlapping
  streaks of the same length asserts the more recent one is returned.
- **Comparison (loop-level)**: `search-loop.ts`'s test suite gets a case
  asserting two `get_player_stat_aggregate` calls (with a mocked
  `LlmClient`) rather than one fabricated combined call, including the
  differing-per-subject-date-range case.
