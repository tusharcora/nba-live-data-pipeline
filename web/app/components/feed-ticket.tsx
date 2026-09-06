"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  type BoardGameRow,
  formatFreshness,
  formatScheduledStart,
  getStatusPresentation,
} from "@/lib/board";
import { displayScore, TEAM_NAME_TO_ABBREVIATION } from "@/lib/box-score";
import { cn } from "@/lib/utils";

function abbr(teamName: string | null): string {
  if (!teamName) return "—";
  return TEAM_NAME_TO_ABBREVIATION[teamName] ?? teamName;
}

/** "HH:MM:SS UTC" render of the exact pull timestamp -- only the sidebar
 * shows this alongside the row list's relative "Ns ago" freshness,
 * matching the pre-redesign board's "Last Pulled" field. */
function formatExactPulledAt(iso: string | null): string {
  if (iso === null) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  return `${parsed.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
  })} UTC`;
}

const COMMENTARY_COLOR: Record<string, string> = {
  conflict: "text-pink-600 dark:text-pink-400",
  stale: "text-amber-600 dark:text-amber-500",
  run: "text-amber-600 dark:text-amber-500",
  leader: "text-muted-foreground",
};

/**
 * The board's "Feed ticket" detail panel -- the currently-selected row's
 * quick-glance detail, restoring the pre-redesign board's sidebar
 * alongside the unified row list (Task 15 had dropped it; re-added at
 * user request). Content varies by status: live shows running
 * score/period/clock/commentary, scheduled shows tip-off time,
 * final/postponed show the settled state. "Box score"/"View Feed"
 * always links to `/live/<id>` -- the fuller live ticker + commentary
 * log view -- so this panel stays a quick glance and that page stays
 * the deep dive.
 */
export function FeedTicket({ game }: { game: BoardGameRow }) {
  const presentation = getStatusPresentation(game.status);

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="relative flex items-start justify-between gap-2 border-b border-dashed border-border px-4 py-3">
        <div>
          <h3 className="font-mono text-base font-semibold tracking-wide text-foreground uppercase">
            {abbr(game.away_team)} · {abbr(game.home_team)}
          </h3>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground uppercase">
            Feed ticket · Game #{game.game_id}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-md px-2 py-0.5 font-mono text-xs font-semibold tracking-wide uppercase",
            presentation.kind === "live"
              ? "bg-primary/15 text-primary"
              : "bg-amber-600/15 text-amber-600 dark:text-amber-500"
          )}
        >
          {presentation.label}
        </span>
        <div
          aria-hidden="true"
          className="absolute -bottom-2.5 -left-2.5 size-5 rounded-full bg-background"
        />
        <div
          aria-hidden="true"
          className="absolute -right-2.5 -bottom-2.5 size-5 rounded-full bg-background"
        />
      </div>

      <dl className="flex flex-col gap-3 px-4 py-3 font-mono text-sm">
        <div className="flex items-center justify-between gap-2">
          <dt className="tracking-wide text-muted-foreground uppercase">Status</dt>
          <dd className="text-foreground">{presentation.label}</dd>
        </div>

        {game.status === "live" && (
          <div className="flex items-center justify-between gap-2">
            <dt className="tracking-wide text-muted-foreground uppercase">Period / Clock</dt>
            <dd className="text-foreground">
              {game.period ? `Q${game.period}` : "—"}
              {game.clock ? ` · ${game.clock}` : ""}
            </dd>
          </div>
        )}

        {game.status === "scheduled" && (
          <div className="flex items-center justify-between gap-2">
            <dt className="tracking-wide text-muted-foreground uppercase">Tips Off</dt>
            <dd className="text-foreground">{formatScheduledStart(game.scheduled_start)}</dd>
          </div>
        )}

        {(game.status === "live" || game.status === "final") && (
          <div className="flex items-center justify-between gap-2">
            <dt className="tracking-wide text-muted-foreground uppercase">Score</dt>
            <dd className="text-amber-600 dark:text-amber-500">
              {abbr(game.away_team)} {displayScore(game.away_score)} —{" "}
              {abbr(game.home_team)} {displayScore(game.home_score)}
            </dd>
          </div>
        )}

        {game.status === "live" && game.commentary && (
          <div className="flex items-center justify-between gap-2">
            <dt className="tracking-wide text-muted-foreground uppercase">Commentary</dt>
            <dd className={cn("text-right", COMMENTARY_COLOR[game.commentary.kind])}>
              {game.commentary.text}
            </dd>
          </div>
        )}

        {/* Fixed descriptive string, not a per-row field -- the API
            doesn't return a "source" value on a board row. Matches the
            pre-redesign sidebar's identical hardcoded behavior. */}
        <div className="flex items-center justify-between gap-2">
          <dt className="tracking-wide text-muted-foreground uppercase">Source</dt>
          <dd className="text-foreground">balldontlie · nba_stats</dd>
        </div>

        <div className="flex items-center justify-between gap-2">
          <dt className="tracking-wide text-muted-foreground uppercase">Last Pulled</dt>
          <dd className="text-foreground">{formatExactPulledAt(game.source_pulled_at)}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="tracking-wide text-muted-foreground uppercase">Freshness</dt>
          <dd className="text-foreground">{formatFreshness(game.source_pulled_at)}</dd>
        </div>
      </dl>

      <div className="relative flex items-center border-t border-dashed border-border px-4 py-5">
        <Button
          render={<Link href={`/live/${game.game_id}`} />}
          nativeButton={false}
          size="sm"
          variant="ghost"
          className="w-full cursor-pointer border border-border bg-transparent hover:bg-muted/60"
        >
          {game.status === "final" ? "Box score" : "View Feed"}
        </Button>
        <div
          aria-hidden="true"
          className="absolute -top-2.5 -left-2.5 size-5 rounded-full bg-background"
        />
        <div
          aria-hidden="true"
          className="absolute -top-2.5 -right-2.5 size-5 rounded-full bg-background"
        />
      </div>
    </div>
  );
}

export default FeedTicket;
