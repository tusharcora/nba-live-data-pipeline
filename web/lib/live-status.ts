/**
 * Shared "is this raw game status string a live game" predicate.
 *
 * Factored out of `app/live/LiveBoard.tsx`'s `getStatusPresentation` so
 * both `LiveBoard` (per-game status badge) and
 * `lib/use-live-game-count.ts` (the topbar's "N LIVE" count) apply the
 * exact same rule to the same upstream status strings rather than each
 * re-implementing the same substring matching and risking drift.
 *
 * Deliberately a plain module (no "use client") -- it's pure string
 * logic, not a hook or a component, so it's safe to import from both a
 * client component (`LiveBoard.tsx`) and a client hook
 * (`use-live-game-count.ts`) without pulling either into the other's
 * module graph unnecessarily.
 *
 * The upstream feed sends values like "STATUS_IN_PROGRESS" /
 * "STATUS_HALFTIME" / "STATUS_FINAL" / "STATUS_SCHEDULED" (see
 * `ingestion/src/ingestion/flows/live_game_flow.py`) or a defaulted
 * "unknown" -- this only asserts what counts as "live", it doesn't
 * attempt to enumerate every other status.
 */
export function isLiveStatus(status?: string): boolean {
  const normalized = (status ?? "").toUpperCase();
  return normalized.includes("IN_PROGRESS") || normalized.includes("HALFTIME");
}
