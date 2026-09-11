"use client";

import Link from "next/link";
import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatScheduledStart, getStatusPresentation } from "@/lib/board";
import { displayScore, TEAM_NAME_TO_ABBREVIATION } from "@/lib/box-score";
import { useGameCommentaryLog } from "@/lib/use-game-commentary-log";

function abbr(teamName: string | null): string {
  if (!teamName) return "—";
  return TEAM_NAME_TO_ABBREVIATION[teamName] ?? teamName;
}

const FETCH_ERROR = "Couldn't reach the games service.";

/**
 * Per-game live view -- the destination every board row's "View Feed"
 * button links to. Live ticker + an in-session commentary log for a live
 * game, a tip-off countdown for a scheduled one, and a link to the
 * existing box-score page for a finished one. Fetch + SSE + log
 * accumulation live in `useGameCommentaryLog` (shared with the homepage
 * board's `FeedTicket`) -- the log is deliberately ephemeral (component
 * state only, lost on reload), matching this feature's spec's non-goals.
 */
export function GameFeed({ gameId }: { gameId: string }) {
  const { game, log, status } = useGameCommentaryLog(gameId);

  if (status === "loading") {
    return <Skeleton className="h-64 w-full" />;
  }

  if (status === "error") {
    return (
      <Alert variant="destructive">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>Couldn&apos;t load this game</AlertTitle>
        <AlertDescription>{FETCH_ERROR}</AlertDescription>
      </Alert>
    );
  }

  if (status === "not_found" || game === null) {
    return <p className="text-sm text-muted-foreground">No game found for this id.</p>;
  }

  const presentation = getStatusPresentation(game.status);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Badge variant={presentation.kind === "live" ? "secondary" : presentation.variant}>
          {presentation.label}
        </Badge>
        {game.status === "live" && (
          <span className="font-mono text-sm text-muted-foreground">
            {game.period ? `Q${game.period}` : ""} {game.clock}
          </span>
        )}
        {game.status === "scheduled" && (
          <span className="font-mono text-sm text-muted-foreground">
            Tips off {formatScheduledStart(game.scheduled_start)}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-6 rounded-xl border border-border bg-card p-6">
        <div className="flex flex-col items-center gap-2">
          <span className="text-sm text-muted-foreground">{abbr(game.away_team)}</span>
          <span className="font-mono text-4xl font-bold tabular-nums">
            {displayScore(game.away_score)}
          </span>
        </div>
        <div className="flex flex-col items-center gap-2">
          <span className="text-sm text-muted-foreground">{abbr(game.home_team)}</span>
          <span className="font-mono text-4xl font-bold tabular-nums">
            {displayScore(game.home_score)}
          </span>
        </div>
      </div>

      {log.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Commentary
          </h2>
          <ul className="flex flex-col gap-1.5 font-mono text-sm">
            {log
              .slice()
              .reverse()
              .map((line, i) => (
                <li key={i}>{line}</li>
              ))}
          </ul>
        </div>
      )}

      {game.gold_game_id !== null && (
        <Link
          href={`/games/${game.gold_game_id}`}
          className="text-sm text-amber-600 underline dark:text-amber-500"
        >
          View full box score
        </Link>
      )}
    </div>
  );
}

export default GameFeed;
