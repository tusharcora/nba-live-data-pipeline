"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import {
  displayScore,
  type GameRow,
  TEAM_NAME_TO_ABBREVIATION,
} from "@/lib/box-score";
import { FOCUS_RING } from "@/lib/focus-ring";
import { cn } from "@/lib/utils";

import { JumpLinks, type PageHref } from "./jump-links";

type ApiList<T> = { data: T[]; count: number };

type FetchState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; games: GameRow[] };

/** Falls back to the full name for any team missing from the map --
 * matches every other call site of this same map (`box-score.tsx`,
 * `recent-games-board.tsx`). */
function abbr(teamName: string): string {
  return TEAM_NAME_TO_ABBREVIATION[teamName] ?? teamName;
}

/** One `AWY 91 · HME 103` fragment per game, three-letter codes. */
function tickerLabel(game: GameRow): string {
  return `${abbr(game.away_team)} ${displayScore(game.away_score)} · ${abbr(game.home_team)} ${displayScore(game.home_score)}`;
}

/**
 * The app's shared chrome: a slim brand+nav header row, followed
 * immediately by a full-bleed scrolling ticker of recent games -- both
 * rendered identically at the top of every page (`/`, `/live`, `/quality`,
 * `/explorer`, `/settings`), matching the reference "Four Dark Neutrals"
 * mockup's own topbar-then-ticker layout. The ticker has no border of its
 * own header to sit against; the header row has none either, so the
 * ticker itself is the only divider between the header and whatever page
 * content follows -- deliberately, per the site owner's "let the banner
 * act as a divider" direction.
 *
 * Fetches `/api/games` independently on every page (same BFF route
 * `RecentGamesBoard` and the command palette already call) -- this is a
 * page-level banner now, not something owned by the homepage's board, so
 * it needs its own data regardless of which page it's mounted on.
 */
export function SiteHeader({ current }: { current: PageHref }) {
  const [state, setState] = useState<FetchState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/games")
      .then((res) => res.json())
      .then((data: ApiList<GameRow> | null) => {
        if (!cancelled) setState({ status: "loaded", games: data?.data ?? [] });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const games = state.status === "loaded" ? state.games : [];
  const tickerGames = [...games, ...games];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Link
          href="/"
          className={cn(
            "flex shrink-0 items-baseline gap-3 rounded-md transition-opacity hover:opacity-80",
            FOCUS_RING
          )}
        >
          {/* Fixed brand wordmark -- always Bebas Neue regardless of the
              user's font-choice setting, the same way a real product's
              logotype doesn't follow a reader's font preference. */}
          <h1 className="font-[family-name:var(--font-bebas-neue-raw)] text-2xl leading-none uppercase sm:text-3xl">
            <span className="text-white">Box</span>
            <span className="text-[#F5A623]">score.gg</span>
          </h1>
          <p className="hidden font-[family-name:var(--font-bebas-neue-raw)] text-xs font-light tracking-[0.18em] whitespace-nowrap text-[#6B7280] uppercase sm:inline">
            Bronze → Gold reconciled pipeline
          </p>
        </Link>

        {/* Centered in the space beside the brand (not absolutely centered
            on the whole row) so it can never overlap the tagline. */}
        <div className="flex flex-1 justify-center">
          <JumpLinks current={current} />
        </div>
      </header>

      {/* Ticker -- deliberately full-bleed (breaks out of the page's
          max-w-6xl container via the left-1/2/-mx-[50vw] trick) so it
          reads as a bar spanning the whole page width, matching the
          reference mockup's edge-to-edge ticker rather than a card
          contained within the content column. Renders an empty bar while
          loading/on error/with zero games rather than collapsing, so the
          header's height (and the divider it provides) never jumps. */}
      <div
        className="group/ticker relative left-1/2 right-1/2 -mx-[50vw] w-screen overflow-hidden border-y border-border bg-card"
        aria-hidden="true"
      >
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-r from-card to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l from-card to-transparent" />
        <div className="flex h-8 w-max animate-[ticker-scroll_75s_linear_infinite] items-center gap-10 px-4 font-mono text-xs whitespace-nowrap text-muted-foreground group-hover/ticker:[animation-play-state:paused] motion-reduce:animate-none">
          {tickerGames.map((game, i) => (
            <span key={`${game.game_id}-${i}`} className="inline-flex items-center gap-2">
              <span className="text-foreground">{tickerLabel(game)}</span>
              <span className="text-amber-600 dark:text-amber-500">FINAL</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export default SiteHeader;
