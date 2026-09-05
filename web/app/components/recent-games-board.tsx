"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  displayScore,
  formatGameDate,
  type GameRow,
  scoreColorClass,
  TeamLogo,
  teamLogoUrlFromName,
} from "@/lib/box-score";

import { FOCUS_RING } from "./site-nav";

type ApiList<T> = { data: T[]; count: number };

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; games: GameRow[] };

const FETCH_ERROR = "Couldn't reach the games service.";

/** One `away @ home score` fragment per game, for the scrolling ticker.
 * Duplicated once by the caller so the marquee loops seamlessly. */
function tickerLabel(game: GameRow): string {
  return `${game.away_team} ${displayScore(game.away_score)} @ ${game.home_team} ${displayScore(game.home_score)}`;
}

/**
 * Homepage "board" -- a real-data adaptation of an explored sportsbook-
 * style mockup (ticker + game list + a "feed ticket" detail rail).
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
  const tickerGames = [...state.games, ...state.games];

  return (
    <div className="flex flex-col gap-3">
      {/* Ticker */}
      <div
        className="group/ticker relative overflow-hidden rounded-lg border border-border bg-card"
        aria-hidden="true"
      >
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-r from-card to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l from-card to-transparent" />
        <div className="flex w-max animate-[ticker-scroll_38s_linear_infinite] gap-10 px-4 py-2 font-mono text-xs whitespace-nowrap text-muted-foreground group-hover/ticker:[animation-play-state:paused] motion-reduce:animate-none">
          {tickerGames.map((game, i) => (
            <span key={`${game.game_id}-${i}`} className="inline-flex items-center gap-2">
              <span className="text-foreground">{tickerLabel(game)}</span>
              <span className="text-amber-500 dark:text-amber-400">FINAL</span>
            </span>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
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
                  "flex items-center justify-between gap-4 border-b border-border px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/60",
                  FOCUS_RING,
                  isSelected && "border-l-2 border-l-amber-500 bg-muted/60 dark:border-l-amber-400"
                )}
              >
                <span className="w-28 shrink-0 font-mono text-xs text-muted-foreground">
                  {formatGameDate(game.game_date)}
                  {game.postseason ? (
                    <span className="ml-1 text-amber-600 dark:text-amber-400">·PO</span>
                  ) : null}
                </span>
                <span className="flex flex-1 flex-wrap items-center justify-center gap-2 font-mono text-sm">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5",
                      scoreColorClass(game.away_score, game.home_score)
                    )}
                  >
                    <TeamLogo src={teamLogoUrlFromName(game.away_team)} alt="" />
                    {game.away_team}
                    <span className="font-semibold tabular-nums">
                      {displayScore(game.away_score)}
                    </span>
                  </span>
                  <span className="text-muted-foreground">@</span>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5",
                      scoreColorClass(game.home_score, game.away_score)
                    )}
                  >
                    <TeamLogo src={teamLogoUrlFromName(game.home_team)} alt="" />
                    {game.home_team}
                    <span className="font-semibold tabular-nums">
                      {displayScore(game.home_score)}
                    </span>
                  </span>
                </span>
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                  View ticket
                </span>
              </button>
            );
          })}
        </div>

        {/* Feed ticket */}
        <div className="relative flex flex-col overflow-hidden rounded-xl border border-border bg-card">
          <div
            aria-hidden="true"
            className="absolute top-10 -left-2.5 size-5 rounded-full bg-background"
          />
          <div
            aria-hidden="true"
            className="absolute top-10 -right-2.5 size-5 rounded-full bg-background"
          />
          <div className="flex items-start justify-between gap-2 border-b border-dashed border-border px-4 py-3">
            <div>
              <h3 className="font-mono text-sm font-semibold tracking-wide text-foreground uppercase">
                {selected.away_team} @ {selected.home_team}
              </h3>
              <p className="mt-0.5 font-mono text-[10px] text-muted-foreground uppercase">
                Feed ticket · Game #{selected.game_id}
              </p>
            </div>
            <span className="shrink-0 rounded-md bg-amber-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wide text-amber-600 uppercase dark:text-amber-400">
              Final
            </span>
          </div>

          <dl className="flex flex-col gap-3 px-4 py-3 font-mono text-xs">
            <div className="flex items-center justify-between gap-2">
              <dt className="tracking-wide text-muted-foreground uppercase">Date</dt>
              <dd className="text-foreground">
                {formatGameDate(selected.game_date)}
                {selected.postseason ? " · Postseason" : ""}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="tracking-wide text-muted-foreground uppercase">Score</dt>
              <dd className="text-amber-600 dark:text-amber-400">
                {selected.away_team} {displayScore(selected.away_score)} — {selected.home_team}{" "}
                {displayScore(selected.home_score)}
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
          </dl>

          <div className="border-t border-dashed border-border px-4 py-3">
            <Button
              render={<Link href={`/games/${selected.game_id}`} />}
              nativeButton={false}
              size="sm"
              variant="secondary"
              className={cn("w-full cursor-pointer", FOCUS_RING)}
            >
              View full box score
              <ArrowRight aria-hidden="true" data-icon="inline-end" className="size-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default RecentGamesBoard;
