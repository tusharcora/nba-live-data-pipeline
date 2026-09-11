"use client";

import { useEffect, useState } from "react";

import { appendCommentaryTick, type BoardGameRow } from "@/lib/board";

type ApiList<T> = { data: T[]; count: number };

/**
 * Accumulates a session-local commentary log for one game from `/board`
 * (initial fetch) and `/board/stream` (SSE ticks), for as long as the
 * calling component stays mounted. Lifted out of `GameFeed.tsx` (the only
 * previous consumer) so `FeedTicket` can show the same history -- the
 * accumulation behavior here is unchanged from what `GameFeed` did before
 * this extraction: unbounded array, deduped only against the immediately-
 * previous entry. Deliberately ephemeral (no persisted table), matching
 * this feature's non-goals.
 *
 * Each consumer decides its own display truncation (e.g. `log.slice(-8)`)
 * at the call site -- this hook only owns accumulation, not how much of it
 * gets rendered.
 */
export function useGameCommentaryLog(gameId: string): {
  game: BoardGameRow | null;
  log: string[];
  status: "loading" | "error" | "not_found" | "ready";
} {
  const [game, setGame] = useState<BoardGameRow | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [status, setStatus] = useState<"loading" | "error" | "not_found" | "ready">("loading");

  useEffect(() => {
    let cancelled = false;
    const numericId = Number(gameId);

    fetch("/api/board")
      .then((res) => {
        if (!res.ok) throw new Error("unreachable");
        return res.json();
      })
      .then((data: ApiList<BoardGameRow> | null) => {
        if (cancelled) return;
        const found = data?.data.find((g) => g.game_id === numericId) ?? null;
        if (found === null) {
          setStatus("not_found");
          return;
        }
        setGame(found);
        setStatus("ready");
        if (found.commentary) setLog([found.commentary.text]);
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    const source = new EventSource("/api/board/stream");
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as ApiList<BoardGameRow>;
        const updated = parsed.data.find((g) => g.game_id === numericId);
        if (!updated) return;
        setGame(updated);
        setStatus("ready");
        setLog((prev) => appendCommentaryTick(prev, updated.commentary));
      } catch {
        // Malformed tick -- keep last good state.
      }
    };

    return () => {
      cancelled = true;
      source.close();
    };
  }, [gameId]);

  return { game, log, status };
}
