"use client";

import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { type BoardGameRow as BoardGameRowData } from "@/lib/board";

import { BoardGameRow } from "./board-game-row";

type ApiList<T> = { data: T[]; count: number };

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; games: BoardGameRowData[] };

const FETCH_ERROR = "Couldn't reach the games service.";

/**
 * Homepage "Recent games" board — a unified list of today's
 * scheduled/live/final games plus the historical tail, replacing the
 * former historical-only board and the separate `/live` page it used to
 * take alongside. Initial paint comes from one `GET /api/board` fetch;
 * an SSE subscription to `/api/board/stream` then patches in updates for
 * today's rows only (historical rows never change once loaded).
 */
export function RecentGamesBoard() {
  const [state, setState] = useState<FetchState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    fetch("/api/board")
      .then((res) => res.json())
      .then((data: ApiList<BoardGameRowData> | null) => {
        if (!cancelled) setState({ status: "loaded", games: data?.data ?? [] });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", message: FETCH_ERROR });
      });

    const source = new EventSource("/api/board/stream");
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as ApiList<BoardGameRowData>;
        const updates = new Map(parsed.data.map((g) => [g.game_id, g]));
        setState((prev) => {
          if (prev.status !== "loaded") return prev;
          return {
            status: "loaded",
            games: prev.games.map((g) => updates.get(g.game_id) ?? g),
          };
        });
      } catch {
        // Malformed tick -- keep showing the last good state.
      }
    };

    return () => {
      cancelled = true;
      source.close();
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

  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-heading text-lg font-bold tracking-wide text-foreground uppercase">
        Recent games
      </h2>
      <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
        {state.games.map((game) => (
          <BoardGameRow key={game.game_id} game={game} />
        ))}
      </div>
    </div>
  );
}

export default RecentGamesBoard;
