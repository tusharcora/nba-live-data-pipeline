"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  ABBREVIATION_TO_TEAM_NAME,
  displayScore,
  formatGameDate,
  type GameRow,
  NBA_GAME_ID_OFFSET,
  scoreColorClass,
  teamLogoUrlFromAbbreviation,
  teamLogoUrlFromName,
  TeamLogo,
} from "@/lib/box-score";

type ApiList<T> = { data: T[]; count: number };

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; games: GameRow[] };

const FETCH_ERROR = "Couldn't reach the games service. Try refreshing the page.";

/** Whether this team won `game` -- null if either score is missing (game
 * not yet final) or the game doesn't involve this team at all. */
function wonGame(game: GameRow, abbreviation: string, teamName: string): boolean | null {
  const isHome = game.home_team === teamName;
  const isAway = game.away_team === teamName;
  if (!isHome && !isAway) return null;
  if (game.home_score === null || game.away_score === null) return null;
  return isHome ? game.home_score > game.away_score : game.away_score > game.home_score;
}

export default function TeamPage({
  params,
}: {
  params: Promise<{ abbreviation: string }>;
}) {
  const [abbreviation, setAbbreviation] = useState<string | null>(null);
  const [state, setState] = useState<FetchState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    params.then(({ abbreviation }) => {
      if (!cancelled) setAbbreviation(abbreviation.toUpperCase());
    });
    return () => {
      cancelled = true;
    };
  }, [params]);

  useEffect(() => {
    if (abbreviation === null) return;
    let cancelled = false;
    // `setState` calls stay inside `.then()`/`.catch()` callbacks -- see
    // app/players/[id]/page.tsx's identical comment for why (this repo's
    // `react-hooks/set-state-in-effect` lint rule).
    Promise.resolve().then(() => {
      if (!cancelled) setState({ status: "loading" });
    });

    fetch(`/api/teams/${abbreviation}`)
      .then((res) => res.json())
      .then((data: { games: ApiList<GameRow> | null }) => {
        if (cancelled) return;
        setState({ status: "loaded", games: data.games?.data ?? [] });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", message: FETCH_ERROR });
      });

    return () => {
      cancelled = true;
    };
  }, [abbreviation]);

  const teamName = abbreviation ? ABBREVIATION_TO_TEAM_NAME[abbreviation] : undefined;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6">
      <Link
        href="/explorer"
        className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground hover:underline"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Back to Historical Explorer
      </Link>

      {state.status === "loading" && (
        <div role="status" aria-live="polite" className="flex flex-col gap-4">
          <span className="sr-only">Loading team…</span>
          <div className="flex items-center gap-4">
            <Skeleton className="size-16 rounded-full" />
            <Skeleton className="h-8 w-56" />
          </div>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      )}

      {state.status === "error" && (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Couldn&apos;t load this team</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      {state.status === "loaded" && (!abbreviation || !teamName) && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center">
          <p className="text-sm font-medium text-foreground">Unknown team</p>
          <p className="text-sm text-muted-foreground">
            {abbreviation} isn&apos;t one of the 30 current NBA franchises.
          </p>
        </div>
      )}

      {state.status === "loaded" && abbreviation && teamName && (
        <TeamDetail abbreviation={abbreviation} teamName={teamName} games={state.games} />
      )}
    </main>
  );
}

function TeamDetail({
  abbreviation,
  teamName,
  games,
}: {
  abbreviation: string;
  teamName: string;
  games: GameRow[];
}) {
  // Only real nba_stats-backfilled games (see NBA_GAME_ID_OFFSET) count
  // toward "current season" -- balldontlie's 2024 pilot game_ids sit below
  // this threshold and would otherwise win a naive max(season) even though
  // the real backfill has since moved past it.
  const realGames = games.filter((g) => g.game_id >= NBA_GAME_ID_OFFSET);
  const currentSeason =
    realGames.length > 0 ? Math.max(...realGames.map((g) => g.season)) : null;
  const seasonGames = realGames.filter((g) => g.season === currentSeason);
  const sortedSeasonGames = [...seasonGames].sort((a, b) =>
    b.game_date.localeCompare(a.game_date)
  );

  const results = seasonGames.map((g) => wonGame(g, abbreviation, teamName));
  const wins = results.filter((r) => r === true).length;
  const losses = results.filter((r) => r === false).length;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-4">
        <Image
          src={teamLogoUrlFromAbbreviation(abbreviation)}
          alt=""
          width={64}
          height={64}
          unoptimized
          className="size-16 shrink-0 object-contain"
        />
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{teamName}</h1>
          <p className="text-sm text-muted-foreground">
            {currentSeason !== null
              ? `${currentSeason}–${(currentSeason + 1).toString().slice(-2)} season`
              : "No backfilled games yet for this franchise"}
          </p>
        </div>
      </div>

      {currentSeason !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Season record</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-2xl tabular-nums text-foreground">
              {wins}-{losses}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Across {seasonGames.length} backfilled game{seasonGames.length === 1 ? "" : "s"}{" "}
              this season. A game with no final score yet counts toward neither total.
            </p>
          </CardContent>
        </Card>
      )}

      {sortedSeasonGames.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-medium text-foreground">Games this season</h2>
          <div className="flex flex-col gap-2">
            {sortedSeasonGames.map((game) => (
              <SeasonGameRow key={game.game_id} game={game} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SeasonGameRow({ game }: { game: GameRow }) {
  return (
    <Link
      href={`/games/${game.game_id}`}
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3 hover:bg-muted/50"
    >
      <span className="font-mono text-xs font-medium tracking-wide text-muted-foreground">
        {formatGameDate(game.game_date)}
        {game.postseason ? " · Postseason" : ""}
      </span>
      <div className="flex flex-wrap items-center gap-2 font-mono text-sm">
        <span
          className={cn(
            "inline-flex items-center gap-1.5",
            scoreColorClass(game.away_score, game.home_score)
          )}
        >
          <TeamLogo src={teamLogoUrlFromName(game.away_team)} alt="" />
          {game.away_team}
        </span>
        <span
          className={cn(
            "font-semibold tabular-nums",
            scoreColorClass(game.away_score, game.home_score)
          )}
        >
          {displayScore(game.away_score)}
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
        </span>
        <span
          className={cn(
            "font-semibold tabular-nums",
            scoreColorClass(game.home_score, game.away_score)
          )}
        >
          {displayScore(game.home_score)}
        </span>
      </div>
    </Link>
  );
}
