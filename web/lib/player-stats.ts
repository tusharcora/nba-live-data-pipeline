// Pure data helpers for player-level stat aggregation -- no React, no "use
// client". Split out of `app/players/[id]/page.tsx` so the compact
// `PlayerCard` popover can compute the same season averages from the same
// `PlayerStatRow[]` shape without duplicating the math.

import { average, parseMinutesPlayed, type PlayerStatRow } from "@/lib/team-names";

export type SeasonAverages = {
  points: number | null;
  rebounds: number | null;
  assists: number | null;
  steals: number | null;
  blocks: number | null;
  turnovers: number | null;
  minutes: number | null;
};

/** Averaged only over games with a recorded stat line -- DNP/inactive games
 * (no minutes played) are excluded via `average`, not counted as a zero.
 * Identical computation to the one previously inline in
 * `app/players/[id]/page.tsx`'s `PlayerDetail` (its FG%/3P% career figures
 * are a separate `sumRatio` computation, not part of this averages object,
 * and stay inline there -- this only extracts the plain per-game averages
 * both that page and the compact `PlayerCard` need). */
export function computeSeasonAverages(rows: PlayerStatRow[]): SeasonAverages {
  return {
    points: average(rows.map((r) => r.points)),
    rebounds: average(rows.map((r) => r.rebounds)),
    assists: average(rows.map((r) => r.assists)),
    steals: average(rows.map((r) => r.steals)),
    blocks: average(rows.map((r) => r.blocks)),
    turnovers: average(rows.map((r) => r.turnovers)),
    minutes: average(rows.map((r) => parseMinutesPlayed(r.minutes_played))),
  };
}
