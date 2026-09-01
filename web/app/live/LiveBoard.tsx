"use client";

import { useEffect, useState } from "react";

/**
 * Defensive, loosely-typed shape for a single game state entry pushed by the
 * FastAPI `/live` SSE stream (proxied by our own `/api/live` BFF route).
 * The sibling FastAPI PR that produces this payload is still in flight, so
 * every field is optional and rendering falls back gracefully when a field
 * is missing or of an unexpected type.
 */
type LiveGameState = {
  game_id?: string | number;
  home_score?: number | string;
  away_score?: number | string;
  status?: string;
  period?: number | string;
  clock?: string;
};

type ConnectionState = "connecting" | "open" | "error";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow an arbitrary parsed JSON value down to a best-effort game list. */
function coerceGames(payload: unknown): LiveGameState[] {
  if (!Array.isArray(payload)) return [];
  return payload.filter(isPlainObject) as LiveGameState[];
}

function displayValue(value: unknown, fallback: string): string {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

export default function LiveBoard() {
  const [games, setGames] = useState<LiveGameState[] | null>(null);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");

  useEffect(() => {
    const source = new EventSource("/api/live");

    source.onmessage = (event) => {
      setConnectionState("open");
      try {
        const parsed = JSON.parse(event.data);
        setGames(coerceGames(parsed));
      } catch {
        // Malformed payload for this tick — keep showing the last good
        // state rather than crashing the page.
      }
    };

    source.onerror = () => {
      setConnectionState("error");
      source.close();
    };

    return () => {
      source.close();
    };
  }, []);

  if (connectionState === "error") {
    return (
      <p className="text-red-600 dark:text-red-400">
        Live connection lost. Refresh the page to try again.
      </p>
    );
  }

  if (games === null) {
    return (
      <p className="text-zinc-600 dark:text-zinc-400">
        Connecting to live game feed…
      </p>
    );
  }

  if (games.length === 0) {
    return (
      <p className="text-zinc-600 dark:text-zinc-400">
        No live games right now.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {games.map((game, index) => (
        <li
          key={game.game_id ?? index}
          className="flex items-center justify-between rounded border border-black/[.08] px-4 py-3 dark:border-white/[.145]"
        >
          <span className="font-medium text-black dark:text-zinc-50">
            {displayValue(game.away_score, "–")} @{" "}
            {displayValue(game.home_score, "–")}
          </span>
          <span className="text-sm text-zinc-600 dark:text-zinc-400">
            {displayValue(game.status, "unknown")}
            {game.period !== undefined && game.period !== null
              ? ` · Q${displayValue(game.period, "")}`
              : ""}
            {game.clock ? ` · ${game.clock}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}
