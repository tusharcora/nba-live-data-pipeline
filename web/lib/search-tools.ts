// Tool definitions + dispatch for the NL stats search BFF route
// (app/api/search/route.ts). Mirrors query-tools.md's four tools exactly by
// name and parameters; the LLM never sees SQL or a database credential —
// only these typed tool schemas.
//
// RECONCILED against Story 1's real endpoints (api/src/api/routers/query_tools.py,
// PR #58). The endpoint paths and auth below were correctly assumed before
// Story 1 landed; the query-param names and response envelope were NOT —
// this module was updated in place once the real contract was available
// (see PR #57's follow-up commit and the comment thread on PR #58).
//
//   GET /tools/player-stats?player_name=...&date=...&start_date=...&end_date=...
//   GET /tools/team-games?team=...&date=...&start_date=...&end_date=...
//   GET /tools/leaders?stat=...&start_date=...&end_date=...&limit=...
//   GET /tools/game-result?team_a=...&team_b=...&date=...
//
// Real response envelope (api/src/api/routers/query_tools.py's module
// docstring — every route returns exactly one of these three shapes):
//   {"status": "ok",        "data": <payload>,  "candidates": null,              "message": null}
//   {"status": "no_match",  "data": null,       "candidates": null,              "message": <str>}
//   {"status": "ambiguous", "data": null,       "candidates": [{"name": ...}],   "message": <str>}
//
// Notably: there is no top-level `table` or `date_range` field, and
// `candidates` is a list of `{name: string}` objects, not plain strings.
// CAP-4 (every answer cites a table + date range) and the pinned
// `citation: {table, dateRange}` contract with Story 3 both need those two
// values regardless — TOOL_TABLE_MAP and deriveDateRange() below compute
// them locally instead of reading them off the wire: `table` from a static
// per-tool map (the BFF always knows which table a tool call is grounded
// in, since it's the one that dispatched the call), and `dateRange` from
// `data.date_range` (present on `get_leaders`) or from the `game_date`
// value(s) actually present in `data` for the other three tools.
//
// CAP-5: a zero-row match is `status: "no_match"`, never an empty `data: []`
// with `status: "ok"` — the model must be able to tell "found nothing" apart
// from "found an empty-but-valid result" without guessing.

import { fetchFromApi } from "@/lib/fastapi-client";
import type { ToolDefinition } from "@/lib/llm/types";
import type { SearchResultData, LeaderRow, StatAggregateResultData } from "@/lib/search-result-types";
import type { GameRow, PlayerStatRow } from "@/lib/team-names";

export interface ToolResultEnvelope {
  status: "ok" | "no_match" | "ambiguous" | "error";
  table: string | null;
  date_range: string | null;
  resultData: SearchResultData | null;
  data: unknown;
  candidates: string[] | null;
  message: string | null;
}

const ERROR_ENVELOPE: ToolResultEnvelope = {
  status: "error",
  table: null,
  date_range: null,
  resultData: null,
  data: null,
  candidates: null,
  message: null,
};

interface DateAwareInput {
  date?: unknown;
  date_range?: unknown;
}

// FastAPI's real query params are `start_date`/`end_date` (api/src/api/routers/query_tools.py),
// not `date_range_start`/`date_range_end` as originally assumed. Our own
// tool schema's input shape (`date_range: {start, end}`, what the LLM sends
// us) is unchanged — only this mapping onto the outgoing query string moves.
function appendDateParams(params: URLSearchParams, input: DateAwareInput): void {
  if (typeof input.date === "string" && input.date) {
    params.set("date", input.date);
  }
  const range = input.date_range;
  if (range && typeof range === "object" && !Array.isArray(range)) {
    const { start, end } = range as { start?: unknown; end?: unknown };
    if (typeof start === "string" && start) params.set("start_date", start);
    if (typeof end === "string" && end) params.set("end_date", end);
  }
}

type ToolName =
  | "get_player_stats"
  | "get_team_games"
  | "get_leaders"
  | "get_game_result"
  | "get_player_stat_aggregate"
  | "get_player_streak";

const TOOL_PATHS: Record<ToolName, string> = {
  get_player_stats: "/tools/player-stats",
  get_team_games: "/tools/team-games",
  get_leaders: "/tools/leaders",
  get_game_result: "/tools/game-result",
  get_player_stat_aggregate: "/tools/player-stat-aggregate",
  get_player_streak: "/tools/player-streak",
};

// The Gold table each tool's "ok" data is grounded in — the real envelope
// carries no `table` field, so this is the BFF's own knowledge of which
// table each tool call ultimately reads (api/src/api/routers/query_tools.py's
// module docstring: get_player_stats/get_leaders read `player_game_stats`,
// get_team_games/get_game_result read `games`).
// Both new tools read player_game_stats, same as get_player_stats/get_leaders.
const TOOL_TABLE_MAP: Record<ToolName, string> = {
  get_player_stats: "player_game_stats",
  get_team_games: "games",
  get_leaders: "player_game_stats",
  get_game_result: "games",
  get_player_stat_aggregate: "player_game_stats",
  get_player_streak: "player_game_stats",
};

function buildQuery(name: ToolName, input: Record<string, unknown>): string {
  const params = new URLSearchParams();

  switch (name) {
    case "get_player_stats": {
      if (typeof input.player_name === "string") params.set("player_name", input.player_name);
      appendDateParams(params, input);
      break;
    }
    case "get_team_games": {
      if (typeof input.team === "string") params.set("team", input.team);
      appendDateParams(params, input);
      break;
    }
    case "get_leaders": {
      if (typeof input.stat === "string") params.set("stat", input.stat);
      appendDateParams(params, input);
      if (typeof input.limit === "number") params.set("limit", String(input.limit));
      break;
    }
    case "get_game_result": {
      if (typeof input.team_a === "string") params.set("team_a", input.team_a);
      if (typeof input.team_b === "string") params.set("team_b", input.team_b);
      if (typeof input.date === "string") params.set("date", input.date);
      break;
    }
    case "get_player_stat_aggregate": {
      if (typeof input.player_name === "string") params.set("player_name", input.player_name);
      if (typeof input.stat === "string") params.set("stat", input.stat);
      if (typeof input.operation === "string") params.set("operation", input.operation);
      if (typeof input.threshold === "number") params.set("threshold", String(input.threshold));
      appendDateParams(params, input);
      break;
    }
    case "get_player_streak": {
      if (typeof input.player_name === "string") params.set("player_name", input.player_name);
      if (typeof input.stat === "string") params.set("stat", input.stat);
      if (typeof input.threshold === "number") params.set("threshold", String(input.threshold));
      appendDateParams(params, input);
      break;
    }
  }

  const query = params.toString();
  return query ? `?${query}` : "";
}

function isToolName(name: string): name is ToolName {
  return name in TOOL_PATHS;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasDateRange(input: Record<string, unknown>): boolean {
  const range = input.date_range;
  if (!range || typeof range !== "object" || Array.isArray(range)) return false;
  const { start, end } = range as { start?: unknown; end?: unknown };
  return isNonEmptyString(start) && isNonEmptyString(end);
}

// Each tool's input_schema.required, re-checked here before spending a
// network call: Claude's own tool-call generation is schema-guided but not
// schema-enforced, so a turn can still omit a required field. Catching that
// here — rather than silently sending FastAPI an incomplete query string —
// surfaces it to the model as a clear tool error it can retry from.
function hasRequiredFields(name: ToolName, input: Record<string, unknown>): boolean {
  switch (name) {
    case "get_player_stats":
      return isNonEmptyString(input.player_name);
    case "get_team_games":
      return isNonEmptyString(input.team);
    case "get_leaders":
      return isNonEmptyString(input.stat) && hasDateRange(input);
    case "get_game_result":
      return (
        isNonEmptyString(input.team_a) &&
        isNonEmptyString(input.team_b) &&
        isNonEmptyString(input.date)
      );
    case "get_player_stat_aggregate":
      return (
        isNonEmptyString(input.player_name) &&
        isNonEmptyString(input.stat) &&
        isNonEmptyString(input.operation)
      );
    case "get_player_streak":
      return (
        isNonEmptyString(input.player_name) &&
        isNonEmptyString(input.stat) &&
        isFiniteNumber(input.threshold)
      );
  }
}

// Extracts a "YYYY-MM-DD" (or ISO datetime) date string off a row, tolerant
// of it being missing or non-string — real rows always have `game_date`,
// but this stays defensive against a shape drift rather than throwing.
function rowDate(row: unknown): string | null {
  if (!row || typeof row !== "object") return null;
  const value = (row as { game_date?: unknown }).game_date;
  return typeof value === "string" ? value : null;
}

function formatDateRange(start: string | null, end: string | null): string | null {
  if (!start && !end) return null;
  if (!start) return end;
  if (!end) return start;
  return start === end ? start : `${start} to ${end}`;
}

// Derives a human-readable date range from an "ok" result's `data` payload.
// Every tool's real shape (per api/tests/test_query_tools.py's fixtures) is
// handled explicitly rather than guessed at generically, since each one
// nests dates differently:
//   get_player_stats / get_team_games -> data.games[].game_date (min..max)
//   get_leaders                       -> data.date_range.{start_date,end_date} (already a range)
//   get_game_result                   -> data.game.game_date (a single date)
function deriveDateRange(name: ToolName, data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const payload = data as Record<string, unknown>;

  if (name === "get_leaders" || name === "get_player_stat_aggregate" || name === "get_player_streak") {
    const range = payload.date_range;
    if (range && typeof range === "object") {
      const { start_date, end_date } = range as { start_date?: unknown; end_date?: unknown };
      return formatDateRange(
        typeof start_date === "string" ? start_date : null,
        typeof end_date === "string" ? end_date : null,
      );
    }
    return null;
  }

  if (name === "get_game_result") {
    return rowDate(payload.game);
  }

  // get_player_stats / get_team_games: both nest their rows under `games`.
  const games = payload.games;
  if (!Array.isArray(games) || games.length === 0) return null;
  const dates = games.map(rowDate).filter((d): d is string => d !== null).sort();
  if (dates.length === 0) return null;
  return formatDateRange(dates[0], dates[dates.length - 1]);
}

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
    case "get_player_stat_aggregate": {
      const value = payload.value;
      if (typeof value !== "number") return null;
      return {
        type: "stat_aggregate",
        payload: {
          playerName: String(payload.player_name ?? ""),
          stat: String(payload.stat ?? ""),
          operation: payload.operation as StatAggregateResultData["operation"],
          threshold: typeof payload.threshold === "number" ? payload.threshold : null,
          value,
          extremeGame: (payload.extreme_game as PlayerStatRow | null) ?? null,
          matchingGames: (payload.matching_games as PlayerStatRow[] | null) ?? null,
          matchingGamesTruncated: payload.matching_games_truncated === true,
          gameCountConsidered:
            typeof payload.game_count_considered === "number" ? payload.game_count_considered : 0,
        },
      };
    }
    case "get_player_streak": {
      const games = payload.games;
      if (!Array.isArray(games)) return null;
      return {
        type: "player_streak",
        payload: {
          playerName: String(payload.player_name ?? ""),
          stat: String(payload.stat ?? ""),
          threshold: typeof payload.threshold === "number" ? payload.threshold : 0,
          longestStreak:
            typeof payload.longest_streak === "number" ? payload.longest_streak : 0,
          isActive: payload.is_active === true,
          games: games as PlayerStatRow[],
        },
      };
    }
  }
}

// The real `candidates` shape is `[{name: string}, ...]` (see
// api/tests/test_query_tools.py's `test_get_player_stats_ambiguous_name_returns_candidates`),
// not plain strings — extract `.name` so the rest of the BFF (and the
// pinned `candidates: string[] | null` contract with Story 3) only ever
// deals with plain names.
function extractCandidateNames(candidates: unknown): string[] | null {
  if (!Array.isArray(candidates)) return null;
  const names = candidates
    .map((c) => (c && typeof c === "object" ? (c as { name?: unknown }).name : null))
    .filter((n): n is string => typeof n === "string");
  return names;
}

function normalizeEnvelope(name: ToolName, raw: unknown): ToolResultEnvelope {
  if (!raw || typeof raw !== "object") return ERROR_ENVELOPE;
  const candidate = raw as { status?: unknown; data?: unknown; candidates?: unknown; message?: unknown };
  if (
    candidate.status !== "ok" &&
    candidate.status !== "no_match" &&
    candidate.status !== "ambiguous"
  ) {
    return ERROR_ENVELOPE;
  }

  const data = candidate.data ?? null;
  const isOk = candidate.status === "ok";

  return {
    status: candidate.status,
    // Derived, not read off the wire — see the module header comment and
    // deriveDateRange() above for why. Only meaningful (and only computed)
    // for a genuinely grounded "ok" result.
    table: isOk ? TOOL_TABLE_MAP[name] : null,
    date_range: isOk ? deriveDateRange(name, data) : null,
    resultData: isOk ? deriveResultData(name, data) : null,
    data,
    candidates: extractCandidateNames(candidate.candidates),
    message: typeof candidate.message === "string" ? candidate.message : null,
  };
}

/** Dispatches one Claude tool_use call to its matching FastAPI tool endpoint. */
export async function callTool(
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResultEnvelope> {
  if (!isToolName(name)) return ERROR_ENVELOPE;
  if (!hasRequiredFields(name, input)) return ERROR_ENVELOPE;
  try {
    const raw = await fetchFromApi(`${TOOL_PATHS[name]}${buildQuery(name, input)}`);
    return normalizeEnvelope(name, raw);
  } catch (error) {
    // Logged (not swallowed silently) so a real FastAPI outage or contract
    // mismatch against Story 1's real endpoints is visible in server logs —
    // the caller still gets a clean ERROR_ENVELOPE either way.
    console.error(`[search-tools] callTool(${name}) failed:`, error);
    return ERROR_ENVELOPE;
  }
}

const dateRangeSchema = {
  type: "object" as const,
  description:
    "An inclusive ISO date range (YYYY-MM-DD) to look up across multiple games.",
  properties: {
    start: { type: "string", description: "Range start, inclusive (YYYY-MM-DD)." },
    end: { type: "string", description: "Range end, inclusive (YYYY-MM-DD)." },
  },
  required: ["start", "end"],
};

// Plain JSON-schema tool definitions (no Zod dependency). Provider-agnostic
// on purpose -- typed as ToolDefinition[] (llm/types.ts) rather than any
// one provider's own tool-schema type, since this array is shared between
// whichever LlmClient the search loop is using (llm/get-llm-client.ts).
// Each provider adapter translates `inputSchema` into its own shape:
// Anthropic's `input_schema`, Gemini's `parametersJsonSchema` (both happen
// to accept a plain JSON Schema object directly).
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "get_player_stats",
    description:
      "Look up one player's per-game stat line(s) on a specific date or over a date range. Fuzzy-matches the player name. Returns status \"no_match\" if no player matches, or \"ambiguous\" with a candidate list if more than one close match exists.",
    inputSchema: {
      type: "object",
      properties: {
        player_name: { type: "string", description: "The player's full or partial name." },
        date: { type: "string", description: "A single ISO date (YYYY-MM-DD)." },
        date_range: dateRangeSchema,
      },
      required: ["player_name"],
    },
  },
  {
    name: "get_team_games",
    description:
      "Look up one team's game rows (opponent, score, date) on a specific date or over a date range. Returns status \"no_match\" if no team matches, or \"ambiguous\" with a candidate list if more than one close match exists.",
    inputSchema: {
      type: "object",
      properties: {
        team: { type: "string", description: "The team's name or abbreviation." },
        date: { type: "string", description: "A single ISO date (YYYY-MM-DD)." },
        date_range: dateRangeSchema,
      },
      required: ["team"],
    },
  },
  {
    name: "get_leaders",
    description:
      "Get a ranked leaderboard of players or teams by a given stat over a date range. The date range and game count computed over are always included in the result — never state a leader without them.",
    inputSchema: {
      type: "object",
      properties: {
        stat: {
          type: "string",
          description: "The stat to rank by, e.g. points, rebounds, assists.",
        },
        date_range: dateRangeSchema,
        limit: { type: "integer", description: "Max number of ranked entries (default 10)." },
      },
      required: ["stat", "date_range"],
    },
  },
  {
    name: "get_game_result",
    description:
      "Look up the final score (and box score, where available) of the specific game between two named teams on a given date. Returns status \"no_match\" if no such game exists — never guess a score.",
    inputSchema: {
      type: "object",
      properties: {
        team_a: { type: "string", description: "The first team's name or abbreviation." },
        team_b: { type: "string", description: "The second team's name or abbreviation." },
        date: { type: "string", description: "The game date (YYYY-MM-DD)." },
      },
      required: ["team_a", "team_b", "date"],
    },
  },
  {
    name: "get_player_stat_aggregate",
    description:
      "Compute a single player's threshold-count, sum, average, max, or min for one stat over a date range (default: full ingested history if omitted). Use for questions like \"how many 30-point games does X have\" (operation: count_over_threshold, threshold: 30) or \"X's scoring average\" (operation: avg). threshold is required for count_over_threshold/count_under_threshold and must be omitted for sum/avg/max/min. For a comparison between two subjects, call this tool once per subject with the same stat/operation.",
    inputSchema: {
      type: "object",
      properties: {
        player_name: { type: "string", description: "The player's full or partial name." },
        stat: {
          type: "string",
          description: "The stat to aggregate, e.g. points, rebounds, assists.",
        },
        operation: {
          type: "string",
          enum: ["count_over_threshold", "count_under_threshold", "sum", "avg", "max", "min"],
          description: "The aggregate to compute.",
        },
        threshold: {
          type: "number",
          description: "Required for count_over_threshold/count_under_threshold; omit for sum/avg/max/min.",
        },
        date: { type: "string", description: "A single ISO date (YYYY-MM-DD)." },
        date_range: dateRangeSchema,
      },
      required: ["player_name", "stat", "operation"],
    },
  },
  {
    name: "get_player_streak",
    description:
      "Find a player's longest consecutive run of games meeting a stat threshold over a date range (default: full ingested history if omitted). Use for questions like \"X's longest streak of 20+ point games.\" is_active in the result means the streak is still ongoing as of the most recent game in range.",
    inputSchema: {
      type: "object",
      properties: {
        player_name: { type: "string", description: "The player's full or partial name." },
        stat: {
          type: "string",
          description: "The stat to track, e.g. points, rebounds, assists.",
        },
        threshold: {
          type: "number",
          description: "A game counts toward the streak if stat >= threshold.",
        },
        date_range: dateRangeSchema,
      },
      required: ["player_name", "stat", "threshold"],
    },
  },
];
