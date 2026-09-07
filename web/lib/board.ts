// Shared types/formatting for the homepage's unified games board
// (`/api/board`) and the per-game live view (`/live/[gameId]`).

export type BoardStatus = "scheduled" | "live" | "final" | "postponed";

export type BoardCommentaryKind = "conflict" | "stale" | "run" | "leader";

export type BoardCommentary = { text: string; kind: BoardCommentaryKind };

export type BoardGameRow = {
  game_id: number;
  gold_game_id: number | null;
  status: BoardStatus;
  home_team: string | null;
  away_team: string | null;
  home_score: number | null;
  away_score: number | null;
  period: number | null;
  clock: string | null;
  scheduled_start: string | null;
  source_pulled_at: string | null;
  commentary: BoardCommentary | null;
};

export type StatusPresentation =
  | { kind: "live"; label: string }
  | { kind: "static"; label: string; variant: "secondary" | "outline" | "destructive" };

/** `/board`'s `status` is already normalized server-side
 * (api/src/api/routers/board.py) to exactly these four values -- no
 * fuzzy substring matching against raw per-source status strings needed
 * here, unlike the retired `/live` SSE stream this replaces. */
export function getStatusPresentation(status: BoardStatus): StatusPresentation {
  switch (status) {
    case "live":
      return { kind: "live", label: "LIVE" };
    case "final":
      return { kind: "static", label: "Final", variant: "secondary" };
    case "scheduled":
      return { kind: "static", label: "Sched", variant: "outline" };
    case "postponed":
      return { kind: "static", label: "Postponed", variant: "destructive" };
  }
}

/** "4s ago" / "2m ago" / "3h ago" -- relocated from the original
 * `recent-games-board.tsx`'s `formatFreshness` so `BoardGameRow` and the
 * per-game feed view can share it. */
export function formatFreshness(iso: string | null): string {
  if (iso === null) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** "2026-09-07T00:30:00+00:00" -> "7:30 PM ET" -- rendered client-side in
 * the viewer's own locale time formatting, but explicitly labeled ET (the
 * league's own scheduling zone) rather than silently converting to the
 * viewer's local zone unlabeled. */
export function formatScheduledStart(iso: string | null): string {
  if (iso === null) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  const time = parsed.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
  return `${time} ET`;
}
