"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { type BoardGameRow, formatScheduledStart, getStatusPresentation } from "@/lib/board";
import { displayScore, TEAM_NAME_TO_ABBREVIATION } from "@/lib/box-score";

function abbr(teamName: string | null): string {
  if (!teamName) return "—";
  return TEAM_NAME_TO_ABBREVIATION[teamName] ?? teamName;
}

type ApiList<T> = { data: T[]; count: number };

/**
 * Per-game live view -- the destination every board row's "View Feed"
 * button links to. Live ticker + an in-session commentary log for a live
 * game, a tip-off countdown for a scheduled one, and a link to the
 * existing box-score page for a finished one. The commentary log is
 * deliberately ephemeral (component state only, lost on reload) -- no
 * persisted history table, matching this feature's spec's non-goals.
 */
export function GameFeed({ gameId }: { gameId: string }) {
  const [game, setGame] = useState<BoardGameRow | null>(null);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const numericId = Number(gameId);

    fetch("/api/board")
      .then((res) => res.json())
      .then((data: ApiList<BoardGameRow> | null) => {
        if (cancelled) return;
        const found = data?.data.find((g) => g.game_id === numericId) ?? null;
        setGame(found);
        if (found?.commentary) setLog([found.commentary.text]);
      })
      .catch(() => {
        // Handled by the render-time null-game empty state below.
      });

    const source = new EventSource("/api/board/stream");
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as ApiList<BoardGameRow>;
        const updated = parsed.data.find((g) => g.game_id === numericId);
        if (!updated) return;
        setGame(updated);
        setLog((prev) => {
          if (!updated.commentary) return prev;
          if (prev[prev.length - 1] === updated.commentary.text) return prev;
          return [...prev, updated.commentary.text];
        });
      } catch {
        // Malformed tick -- keep last good state.
      }
    };

    return () => {
      cancelled = true;
      source.close();
    };
  }, [gameId]);

  if (game === null) {
    return <Skeleton className="h-64 w-full" />;
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

      <Link
        href={`/games/${game.game_id}`}
        className="text-sm text-amber-600 underline dark:text-amber-500"
      >
        View full box score
      </Link>
    </div>
  );
}

export default GameFeed;
