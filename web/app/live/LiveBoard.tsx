"use client";

import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";

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

/**
 * Skeleton placeholders shown before the first SSE message arrives.
 * Shaped like the real game-card row (team/score line + status pill) so
 * layout doesn't jump once live data replaces it.
 */
function LiveBoardSkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading live games"
      className="flex flex-col gap-3"
    >
      <span className="sr-only">Connecting to live game feed…</span>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          aria-hidden="true"
          className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3"
        >
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-20" />
          </div>
          <div className="flex flex-col items-end gap-2">
            <Skeleton className="h-4 w-14" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Calm, deliberate empty state for a tick where zero games came back. */
function LiveBoardEmpty() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border py-16 text-center">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="h-10 w-10 text-muted-foreground"
      >
        <rect x="3" y="6" width="18" height="12" rx="2" />
        <path d="M7 6v12M17 6v12" />
        <path d="M3 3l18 18" />
      </svg>
      <p className="text-sm font-medium text-foreground">
        No live games right now
      </p>
      <p className="text-sm text-muted-foreground">
        Check back when the next scheduled game tips off.
      </p>
    </div>
  );
}

/** Destructive alert shown when the SSE connection drops. */
function LiveBoardError() {
  return (
    <Alert variant="destructive">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5" />
        <path d="M12 16h.01" />
      </svg>
      <AlertTitle>Live connection lost</AlertTitle>
      <AlertDescription>
        We couldn&apos;t reach the live game feed. Refresh the page to try
        again.
      </AlertDescription>
    </Alert>
  );
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
    return <LiveBoardError />;
  }

  if (games === null) {
    return <LiveBoardSkeleton />;
  }

  if (games.length === 0) {
    return <LiveBoardEmpty />;
  }

  return (
    <ul className="flex flex-col gap-3">
      {games.map((game, index) => (
        <li
          key={game.game_id ?? index}
          style={{ animationDelay: `${Math.min(index, 6) * 60}ms` }}
          className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:fill-mode-backwards motion-safe:duration-300 motion-safe:ease-out flex items-center justify-between rounded border border-black/[.08] px-4 py-3 dark:border-white/[.145]"
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
