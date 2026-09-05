"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  BoxScoreTable,
  displayScore,
  formatGameDate,
  type GameRow,
  scoreColorClass,
  TeamLink,
  TeamLogo,
  teamLogoUrlFromName,
  TEAM_NAME_TO_ABBREVIATION,
  type PlayerStatRow,
} from "@/lib/box-score";

type ApiList<T> = { data: T[]; count: number };

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; game: GameRow | null; playerStats: PlayerStatRow[] };

const FETCH_ERROR = "Couldn't reach the games service. Try refreshing the page.";

function statusBadgeVariant(status: string): "default" | "secondary" | "outline" {
  if (status.toLowerCase() === "final") return "secondary";
  return "outline";
}

function prettifyStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export default function GamePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [gameId, setGameId] = useState<string | null>(null);
  const [state, setState] = useState<FetchState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    params.then(({ id }) => {
      if (!cancelled) setGameId(id);
    });
    return () => {
      cancelled = true;
    };
  }, [params]);

  useEffect(() => {
    if (gameId === null) return;
    let cancelled = false;
    // `setState` calls stay inside `.then()`/`.catch()` callbacks -- see
    // app/players/[id]/page.tsx's identical comment for why (this repo's
    // `react-hooks/set-state-in-effect` lint rule).
    Promise.resolve().then(() => {
      if (!cancelled) setState({ status: "loading" });
    });

    fetch(`/api/games/${gameId}`)
      .then((res) => res.json())
      .then((data: { game: GameRow | null; playerStats: ApiList<PlayerStatRow> | null }) => {
        if (cancelled) return;
        setState({
          status: "loaded",
          game: data.game,
          playerStats: data.playerStats?.data ?? [],
        });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", message: FETCH_ERROR });
      });

    return () => {
      cancelled = true;
    };
  }, [gameId]);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6">
      <Link
        href="/explorer"
        className="-mx-2 -my-1 inline-flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Back to Historical Explorer
      </Link>

      {state.status === "loading" && (
        <div role="status" aria-live="polite" className="flex flex-col gap-4">
          <span className="sr-only">Loading game…</span>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {state.status === "error" && (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Couldn&apos;t load this game</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      {state.status === "loaded" && state.game === null && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center">
          <p className="text-sm font-medium text-foreground">No game found</p>
          <p className="text-sm text-muted-foreground">
            This game_id doesn&apos;t exist in the backfilled data.
          </p>
        </div>
      )}

      {state.status === "loaded" && state.game !== null && (
        <GameDetail game={state.game} playerStats={state.playerStats} />
      )}
    </main>
  );
}

function GameDetail({
  game,
  playerStats,
}: {
  game: GameRow;
  playerStats: PlayerStatRow[];
}) {
  const awayAbbreviation = TEAM_NAME_TO_ABBREVIATION[game.away_team] ?? game.away_team;
  const homeAbbreviation = TEAM_NAME_TO_ABBREVIATION[game.home_team] ?? game.home_team;
  const awayStats = playerStats.filter((row) => row.team === awayAbbreviation);
  const homeStats = playerStats.filter((row) => row.team === homeAbbreviation);

  return (
    <div className="flex flex-col gap-8">
      <Card className="gap-3">
        <CardHeader className="flex-row items-center justify-between gap-2">
          <CardTitle className="font-geist-mono text-xs font-medium tracking-wide text-muted-foreground">
            {formatGameDate(game.game_date)}
            {game.postseason ? " · Postseason" : ""}
          </CardTitle>
          <Badge variant={statusBadgeVariant(game.status)}>{prettifyStatus(game.status)}</Badge>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2 font-geist-mono text-sm">
            <TeamLink
              abbreviation={awayAbbreviation}
              className={cn(
                "-mx-1 -my-0.5 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-muted",
                scoreColorClass(game.away_score, game.home_score)
              )}
            >
              <TeamLogo src={teamLogoUrlFromName(game.away_team)} alt="" />
              {game.away_team}
            </TeamLink>
            <span
              className={cn(
                "text-lg font-semibold tabular-nums",
                scoreColorClass(game.away_score, game.home_score)
              )}
            >
              {displayScore(game.away_score)}
            </span>
            <span className="text-muted-foreground">@</span>
            <TeamLink
              abbreviation={homeAbbreviation}
              className={cn(
                "-mx-1 -my-0.5 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-muted",
                scoreColorClass(game.home_score, game.away_score)
              )}
            >
              <TeamLogo src={teamLogoUrlFromName(game.home_team)} alt="" />
              {game.home_team}
            </TeamLink>
            <span
              className={cn(
                "text-lg font-semibold tabular-nums",
                scoreColorClass(game.home_score, game.away_score)
              )}
            >
              {displayScore(game.home_score)}
            </span>
          </div>
        </CardContent>
      </Card>

      {playerStats.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center">
          <p className="text-sm font-medium text-foreground">No box score for this game</p>
          <p className="text-sm text-muted-foreground">
            The game itself has been reconciled, but the backfill hasn&apos;t reached its
            player-level stats yet.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            <h2 className="text-lg font-medium text-foreground">{game.away_team}</h2>
            <BoxScoreTable rows={awayStats} />
          </div>
          <div className="flex flex-col gap-3">
            <h2 className="text-lg font-medium text-foreground">{game.home_team}</h2>
            <BoxScoreTable rows={homeStats} />
          </div>
        </>
      )}
    </div>
  );
}
