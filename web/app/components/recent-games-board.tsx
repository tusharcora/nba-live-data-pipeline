"use client";

import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { appendCommentaryTick, type BoardGameRow as BoardGameRowData } from "@/lib/board";

import { BoardGameRow } from "./board-game-row";
import { FeedTicket } from "./feed-ticket";

type ApiList<T> = { data: T[]; count: number };

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; games: BoardGameRowData[] };

const FETCH_ERROR = "Couldn't reach the games service.";

/**
 * Homepage "board" -- game list + a "feed ticket" detail rail, styled after
 * an explored sportsbook mockup. Reads the real unified `GET /board` (live,
 * scheduled, and recent final games together) and subscribes to
 * `/board/stream` for live updates, using the already-built `BoardGameRow`
 * row component and `FeedTicket` detail panel -- both existed in this
 * codebase but weren't wired into any page yet (the merge that brought them
 * in left this board on the older, historical-only `GET /games` with its
 * own duplicate inline ticket markup; this replaces that with the real
 * thing).
 *
 * Commentary history is tracked per `game_id` across every tick this
 * component observes (not just the selected game) so switching the
 * selected row doesn't lose history already seen this session -- matching
 * `GameFeed.tsx`'s same ephemeral, session-local (no persisted table)
 * commentary log, via the same `appendCommentaryTick` helper.
 */
export function RecentGamesBoard() {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [commentaryLogs, setCommentaryLogs] = useState<Record<number, string[]>>({});

  useEffect(() => {
    let cancelled = false;

    fetch("/api/board")
      .then((res) => {
        // The BFF route always returns valid JSON, even on a backend
        // failure (`{status: "unreachable"}` with a 502) -- without
        // checking `res.ok`, that gets parsed same as a real response and
        // this board renders as simply empty rather than a distinct error.
        if (!res.ok) throw new Error("unreachable");
        return res.json();
      })
      .then((data: ApiList<BoardGameRowData> | null) => {
        if (cancelled) return;
        const games = data?.data ?? [];
        setState({ status: "loaded", games });
        setCommentaryLogs((prev) => {
          const next = { ...prev };
          for (const g of games) next[g.game_id] = appendCommentaryTick([], g.commentary);
          return next;
        });
        if (games.length > 0) {
          Promise.resolve().then(() => {
            if (!cancelled) setSelectedId(games[0].game_id);
          });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", message: FETCH_ERROR });
      });

    const source = new EventSource("/api/board/stream");
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as ApiList<BoardGameRowData>;
        if (cancelled) return;
        if (parsed.data.length === 0) return;
        // `/board/stream` emits only *today's* rows (per its own docstring
        // in api/src/api/routers/board.py) -- historical rows are static
        // and never appear in a tick. A tick is an upsert of the games it
        // *does* include, not the full board's new state: replacing the
        // whole list wholesale would wipe every historical row the moment
        // no game is live today, exactly the bug this comment is guarding
        // against (caught via a real browser check, not by tsc/lint).
        setState((prev) => {
          if (prev.status !== "loaded") return prev;
          const byId = new Map(prev.games.map((g) => [g.game_id, g]));
          for (const g of parsed.data) byId.set(g.game_id, g);
          return { status: "loaded", games: Array.from(byId.values()) };
        });
        setCommentaryLogs((prev) => {
          const next = { ...prev };
          for (const g of parsed.data) {
            next[g.game_id] = appendCommentaryTick(next[g.game_id] ?? [], g.commentary);
          }
          return next;
        });
      } catch {
        // Malformed tick -- keep last good state.
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

  const selected = state.games.find((g) => g.game_id === selectedId) ?? state.games[0];

  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-heading text-lg font-bold tracking-wide text-foreground uppercase">
        Recent games
      </h2>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
          {state.games.slice(0, 8).map((game) => (
            <BoardGameRow
              key={game.game_id}
              game={game}
              isSelected={game.game_id === selected.game_id}
              onSelect={setSelectedId}
            />
          ))}
        </div>

        <FeedTicket game={selected} log={commentaryLogs[selected.game_id] ?? []} />
      </div>
    </div>
  );
}

export default RecentGamesBoard;
