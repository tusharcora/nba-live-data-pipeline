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
