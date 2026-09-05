"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  displayScore,
  formatGameDate,
  type GameRow,
  scoreColorClass,
  TEAM_NAME_TO_ABBREVIATION,
  TeamLogo,
  teamLogoUrlFromName,
} from "@/lib/box-score";
import { FOCUS_RING } from "@/lib/focus-ring";

type ApiList<T> = { data: T[]; count: number };

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; games: GameRow[] };

const FETCH_ERROR = "Couldn't reach the games service.";

/** Falls back to the full name for any team missing from the map rather
 * than rendering "undefined" -- matches the fallback `box-score.tsx`
 * itself already uses wherever it reads this same map. */
function abbr(teamName: string): string {
  return TEAM_NAME_TO_ABBREVIATION[teamName] ?? teamName;
}

/** "HH:MM:SS UTC" render of `GameRow.source_pulled_at` -- the real
 * timestamp `raw_pulls` recorded when this row was ingested, not a
 * fabricated one. */
function formatPulledAt(iso: string): string {
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

/** "4s ago" / "2d ago" / "3mo ago" -- real elapsed time since
 * `source_pulled_at`, evaluated at render time. For these backfilled
 * historical games this is genuinely how long ago the pipeline last
 * pulled the row (typically days), not a fake "just happened" value --
 * the same real-vs-fabricated-data stance the rest of this board takes. */
function formatFreshness(iso: string): string {
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

/**
 * Homepage "board" -- a real-data adaptation of an explored sportsbook-
 * style mockup (game list + a "feed ticket" detail rail). The mockup's
 * ticker is now `SiteHeader`'s, shared across every page rather than
 * owned by this board specifically.
 *
 * One deliberate departure from that mockup, stated plainly rather than
 * faked: its "LIVE" pills and pulsing dots assumed a live-game feed with
 * team names, which the real `/live` SSE stream doesn't carry yet (see
 * `app/live/LiveBoard.tsx`'s own header comment). This board instead
 * pulls from `GET /games` (unfiltered -- the most recent backfilled
 * games), so every game here is real and complete, but genuinely
 * "Final," not live. The ticket sidebar's fields are adapted to match:
 * matchup/date/score/season, not a freshness bar or a fabricated
 * stat-ingestion barcode that would have nothing real to show for a
 * historical game.
 */
export function RecentGamesBoard() {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/games")
      .then((res) => res.json())
      .then((data: ApiList<GameRow> | null) => {
        if (cancelled) return;
        const games = data?.data ?? [];
        setState({ status: "loaded", games });
        if (games.length > 0) {
          Promise.resolve().then(() => {
            if (!cancelled) setSelectedId(games[0].game_id);
          });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", message: FETCH_ERROR });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <Alert variant="destructive">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>Couldn&apos;t load recent games</AlertTitle>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  }

  if (state.games.length === 0) {
    return null;
  }

  const selected = state.games.find((g) => g.game_id === selectedId) ?? state.games[0];

  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-heading text-lg font-bold tracking-wide text-foreground uppercase">
        Recent games
      </h2>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1fr_320px]">
        {/* Board */}
        <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
          {state.games.slice(0, 8).map((game) => {
            const isSelected = game.game_id === selected.game_id;
            return (
              <button
                key={game.game_id}
                type="button"
                onClick={() => setSelectedId(game.game_id)}
                aria-pressed={isSelected}
                className={cn(
                  "grid grid-cols-[64px_1fr] items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/60 sm:grid-cols-[88px_1fr_88px]",
                  FOCUS_RING,
                  isSelected && "border-l-2 border-l-amber-600 bg-muted/60 dark:border-l-amber-500"
                )}
              >
                <span className="flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
                  {formatGameDate(game.game_date)}
                  {game.postseason ? (
                    <span className="text-amber-600 dark:text-amber-500">PO</span>
                  ) : null}
                </span>

                {/* Matchup -- away team stacked directly above home team,
                    each its own full-width row with the score pushed to
                    the far right, matching the reference mockup's
                    `.team-line` layout instead of one inline "A @ B" row. */}
                <span className="flex flex-col gap-1.5">
                  <span
                    className={cn(
                      "flex items-center gap-2",
                      scoreColorClass(game.away_score, game.home_score)
                    )}
                  >
                    <TeamLogo src={teamLogoUrlFromName(game.away_team)} alt="" />
                    <span className="flex-1 truncate font-bebas-neue-raw text-sm font-medium">
                      {game.away_team}
                    </span>
                    <span className="font-mono text-xl leading-none font-bold tabular-nums">
                      {displayScore(game.away_score)}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "flex items-center gap-2",
                      scoreColorClass(game.home_score, game.away_score)
                    )}
                  >
                    <TeamLogo src={teamLogoUrlFromName(game.home_team)} alt="" />
                    <span className="flex-1 truncate font-bebas-neue-raw text-sm font-medium">
                      {game.home_team}
                    </span>
                    <span className="font-mono text-xl leading-none font-bold tabular-nums">
                      {displayScore(game.home_score)}
                    </span>
                  </span>
                </span>

                <span className="hidden shrink-0 justify-self-end text-xs text-muted-foreground sm:inline">
                  View ticket
                </span>
              </button>
            );
          })}
        </div>

        {/* Feed ticket */}
        <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
          {/* Header is its own `relative` block so the notches below sit
              exactly on its bottom (dashed) border regardless of how tall
              the title/subtitle/badge make it, rather than an estimated
              fixed pixel offset from the card's own top edge. */}
          <div className="relative flex items-start justify-between gap-2 border-b border-dashed border-border px-4 py-3">
            <div>
              <h3 className="font-mono text-base font-semibold tracking-wide text-foreground uppercase">
                {abbr(selected.away_team)} · {abbr(selected.home_team)}
              </h3>
              <p className="mt-0.5 font-mono text-xs text-muted-foreground uppercase">
                Feed ticket · Game #{selected.game_id}
              </p>
            </div>
            <span className="shrink-0 rounded-md bg-amber-600/15 px-2 py-0.5 font-mono text-xs font-semibold tracking-wide text-amber-600 uppercase dark:text-amber-500">
              Final
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
              <dt className="tracking-wide text-muted-foreground uppercase">Date</dt>
              <dd className="text-foreground">
                {formatGameDate(selected.game_date)}
                {selected.postseason ? " · Postseason" : ""}
              </dd>
            </div>
            {/* No real live period/clock exists for a completed historical
                game -- this shows the game's actual real status (always
                "Final" on this board) rather than fabricating an
                in-progress quarter/clock value. */}
            <div className="flex items-center justify-between gap-2">
              <dt className="tracking-wide text-muted-foreground uppercase">Period / Clock</dt>
              <dd className="text-foreground">{selected.status}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="tracking-wide text-muted-foreground uppercase">Score</dt>
              <dd className="text-amber-600 dark:text-amber-500">
                {abbr(selected.away_team)} {displayScore(selected.away_score)} —{" "}
                {abbr(selected.home_team)} {displayScore(selected.home_score)}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="tracking-wide text-muted-foreground uppercase">Season</dt>
              <dd className="text-foreground">
                {selected.season}–{(selected.season + 1).toString().slice(-2)}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="tracking-wide text-muted-foreground uppercase">Source</dt>
              <dd className="text-foreground">balldontlie · nba_stats</dd>
            </div>
            {/* Real ingestion timestamps from raw_pulls (`source_pulled_at`)
                -- for these backfilled historical games "Freshness" is
                genuinely however long ago the pipeline pulled the row
                (usually days), not a live "just happened" value. */}
            <div className="flex items-center justify-between gap-2">
              <dt className="tracking-wide text-muted-foreground uppercase">Last Pulled</dt>
              <dd className="text-foreground">{formatPulledAt(selected.source_pulled_at)}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="tracking-wide text-muted-foreground uppercase">Freshness</dt>
              <dd className="text-foreground">{formatFreshness(selected.source_pulled_at)}</dd>
            </div>
          </dl>

          {/* Footer -- its own `relative` block too, same reasoning as the
              header, plus taller padding (py-5 vs the header's py-3) so
              its total height matches the header's despite having only
              one line of content instead of a title/subtitle/badge. */}
          <div className="relative flex items-center border-t border-dashed border-border px-4 py-5">
            <Button
              render={<Link href={`/games/${selected.game_id}`} />}
              nativeButton={false}
              size="sm"
              variant="ghost"
              className={cn(
                "w-full cursor-pointer border border-border bg-transparent hover:bg-muted/60",
                FOCUS_RING
              )}
            >
              Box score
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
      </div>
    </div>
  );
}

export default RecentGamesBoard;
