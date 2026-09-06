// Tool definitions + dispatch for the NL stats search BFF route
// (app/api/search/route.ts). Mirrors query-tools.md's four tools exactly by
// name and parameters; the LLM never sees SQL or a database credential —
// only these typed tool schemas.
//
// ASSUMED Story 1 contract: at the time this route was built, Story 1
// (api/'s new FastAPI tool endpoints) had not landed yet. query-tools.md
// pins each tool's name/params/return *shape* but not its HTTP path or
// wire envelope, so the endpoint paths and ToolResultEnvelope below are
// this story's own assumption, made to the same conventions every other
// api/ router already follows (kebab-case path, GET, require_api_key,
// slowapi rate limit). If Dev1's real endpoints differ, that mismatch is
// exactly what Story 4's integration pass reconciles — see this repo's PR
// description for the full assumption written out for reviewers.
//
//   GET /tools/player-stats?player_name=...&date=...&date_range_start=...&date_range_end=...
//   GET /tools/team-games?team=...&date=...&date_range_start=...&date_range_end=...
//   GET /tools/leaders?stat=...&date_range_start=...&date_range_end=...&limit=...
//   GET /tools/game-result?team_a=...&team_b=...&date=...
//
// Assumed response envelope (every tool, always this shape):
//   {
//     status: "ok" | "no_match" | "ambiguous",
//     table: string | null,       // e.g. "player_game_stats" — null unless status "ok"
//     date_range: string | null,  // human-readable, e.g. "2024-10-22 to 2024-11-05" — CAP-2/CAP-4
//     data: unknown | null,
//     candidates: string[] | null // populated only when status is "ambiguous"
//   }
//
// CAP-5: a zero-row match is `status: "no_match"`, never an empty `data: []`
// with `status: "ok"` — the model must be able to tell "found nothing" apart
// from "found an empty-but-valid result" without guessing.

import type Anthropic from "@anthropic-ai/sdk";
import { fetchFromApi } from "@/lib/fastapi-client";

export interface ToolResultEnvelope {
  status: "ok" | "no_match" | "ambiguous" | "error";
  table: string | null;
  date_range: string | null;
  data: unknown;
  candidates: string[] | null;
}

const ERROR_ENVELOPE: ToolResultEnvelope = {
  status: "error",
  table: null,
  date_range: null,
  data: null,
  candidates: null,
};

interface DateAwareInput {
  date?: unknown;
  date_range?: unknown;
}

function appendDateParams(params: URLSearchParams, input: DateAwareInput): void {
  if (typeof input.date === "string" && input.date) {
    params.set("date", input.date);
  }
  const range = input.date_range;
  if (range && typeof range === "object" && !Array.isArray(range)) {
    const { start, end } = range as { start?: unknown; end?: unknown };
    if (typeof start === "string" && start) params.set("date_range_start", start);
    if (typeof end === "string" && end) params.set("date_range_end", end);
  }
}

type ToolName = "get_player_stats" | "get_team_games" | "get_leaders" | "get_game_result";

const TOOL_PATHS: Record<ToolName, string> = {
  get_player_stats: "/tools/player-stats",
  get_team_games: "/tools/team-games",
  get_leaders: "/tools/leaders",
  get_game_result: "/tools/game-result",
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
  }
}

function normalizeEnvelope(raw: unknown): ToolResultEnvelope {
  if (!raw || typeof raw !== "object") return ERROR_ENVELOPE;
  const candidate = raw as Partial<ToolResultEnvelope>;
  if (
    candidate.status !== "ok" &&
    candidate.status !== "no_match" &&
    candidate.status !== "ambiguous"
  ) {
    return ERROR_ENVELOPE;
  }
  return {
    status: candidate.status,
    table: typeof candidate.table === "string" ? candidate.table : null,
    date_range: typeof candidate.date_range === "string" ? candidate.date_range : null,
    data: candidate.data ?? null,
    candidates: Array.isArray(candidate.candidates) ? candidate.candidates : null,
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
    return normalizeEnvelope(raw);
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

// Plain JSON-schema tool definitions (no Zod / beta tool runner dependency;
// see this story's spec Design Notes for why a manual loop was chosen).
// Annotated as Anthropic.Tool[] (the custom-tool variant) rather than left
// to inference — every entry here is a custom tool, never an
// Anthropic-defined one, so the narrower annotation is correct (see
// typescript/claude-api/tool-use.md's "Don't type-annotate as Tool[]"
// caveat, which is about arrays mixing custom and built-in tool types).
export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "get_player_stats",
    description:
      "Look up one player's per-game stat line(s) on a specific date or over a date range. Fuzzy-matches the player name. Returns status \"no_match\" if no player matches, or \"ambiguous\" with a candidate list if more than one close match exists.",
    input_schema: {
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
    input_schema: {
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
    input_schema: {
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
    input_schema: {
      type: "object",
      properties: {
        team_a: { type: "string", description: "The first team's name or abbreviation." },
        team_b: { type: "string", description: "The second team's name or abbreviation." },
        date: { type: "string", description: "The game date (YYYY-MM-DD)." },
      },
      required: ["team_a", "team_b", "date"],
    },
  },
];
