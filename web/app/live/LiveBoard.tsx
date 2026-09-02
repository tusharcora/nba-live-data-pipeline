"use client";

import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Defensive, loosely-typed shape for a single game state entry pushed by the
 * FastAPI `/live` SSE stream (proxied by our own `/api/live` BFF route).
 * The sibling FastAPI PR that produces this payload is still in flight, so
 * every field is optional and rendering falls back gracefully when a field
 * is missing or of an unexpected type.
 *
 * `pulled_at` (already emitted by `api/src/api/routers/live.py`'s
 * `serialize_live_state`, just not previously read here) is added so the
 * card can show an update timestamp per the design system's "label
 * telemetry as live only when backed by a current source, with update
 * time" requirement — purely a render addition, `coerceGames`/the
 * `EventSource` wiring below are untouched.
 */
type LiveGameState = {
  game_id?: string | number;
  home_score?: number | string;
  away_score?: number | string;
  status?: string;
  period?: number | string;
  clock?: string;
  pulled_at?: string;
};

type ConnectionState = "connecting" | "open" | "error";

/** No SSE message for this long while "open" counts as stale. */
const STALE_THRESHOLD_MS = 60_000;
/** How often the stale check re-evaluates elapsed time against `Date.now()`. */
const STALE_CHECK_INTERVAL_MS = 1_000;

/** "45s" / "1m 06s" render of a whole-second duration for the stale banner. */
function formatStaleDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

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
 * Best-effort "HH:MM:SS" render of an ISO timestamp for the per-card
 * "Updated …" caption. Returns "" (rendered as nothing) for a missing or
 * unparsable value rather than showing a confusing placeholder — the
 * connection-level stale/error state itself is out of scope here, that's
 * the sibling `live-board-motion-and-states` branch's job.
 */
function formatUpdatedAt(pulledAt: unknown): string {
  if (typeof pulledAt !== "string" || pulledAt === "") return "";
  const parsed = new Date(pulledAt);
  if (Number.isNaN(parsed.getTime())) return "";
  return `Updated ${parsed.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })}`;
}

/**
 * One badge-worth of presentation per raw status string. The upstream feed
 * sends values like "STATUS_IN_PROGRESS" / "STATUS_FINAL" / "STATUS_SCHEDULED"
 * (see `ingestion/src/ingestion/flows/live_game_flow.py`) or a defaulted
 * "unknown" — this maps whatever comes through to a small closed set of
 * visual treatments without assuming any exact string.
 */
type StatusPresentation =
  | { kind: "live"; label: string }
  | {
      kind: "static";
      label: string;
      variant: "secondary" | "destructive" | "outline";
    };

function prettifyStatus(status?: string): string {
  const cleaned = (status ?? "").replace(/^status[_-]?/i, "").trim();
  if (!cleaned) return "Unknown";
  return cleaned
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getStatusPresentation(status?: string): StatusPresentation {
  const normalized = (status ?? "").toUpperCase();

  if (normalized.includes("IN_PROGRESS") || normalized.includes("HALFTIME")) {
    return { kind: "live", label: "LIVE" };
  }
  if (normalized.includes("FINAL")) {
    return { kind: "static", label: "Final", variant: "secondary" };
  }
  if (normalized.includes("SCHEDULED") || normalized.includes("PRE")) {
    return { kind: "static", label: "Scheduled", variant: "outline" };
  }
  if (
    normalized.includes("POSTPON") ||
    normalized.includes("CANCEL") ||
    normalized.includes("SUSPEND") ||
    normalized.includes("DELAY")
  ) {
    return { kind: "static", label: prettifyStatus(status), variant: "destructive" };
  }
  return { kind: "static", label: prettifyStatus(status), variant: "outline" };
}

/**
 * Status badge for a single game. For live games this renders a visually
 * distinct pulsing-dot "LIVE" treatment; for every other status it's a
 * plain shadcn `Badge`. The "live" state is always conveyed via the literal
 * "LIVE" text as well as color, never color/motion alone (colorblind-safe,
 * screen-reader-legible). The dot itself is `aria-hidden` decoration and
 * the badge carries no `aria-live` region — re-announcing "LIVE" on every
 * ~5s SSE poll tick would spam screen reader users for a value that isn't
 * actually changing.
 */
function GameStatusBadge({ status }: { status?: string }) {
  const presentation = getStatusPresentation(status);

  if (presentation.kind === "live") {
    return (
      <Badge
        variant="secondary"
        className="gap-1.5 border-transparent bg-accent text-accent-foreground"
      >
        <span aria-hidden="true" className="relative flex size-1.5">
          <span className="absolute inline-flex size-full rounded-full bg-accent-foreground/70 motion-safe:animate-ping" />
          <span className="relative inline-flex size-1.5 rounded-full bg-accent-foreground" />
        </span>
        {presentation.label}
      </Badge>
    );
  }

  return <Badge variant={presentation.variant}>{presentation.label}</Badge>;
}

/**
 * Skeleton placeholders shown before the first SSE message arrives.
 * Mirrors the real game-card grid (`grid-cols-1 sm:grid-cols-2 xl:grid-cols-3`
 * of `Card`s with a header/badge row and a two-score content row) rather
 * than a generic stacked-row placeholder, so the loading layout doesn't
 * jump to a different column count once live data replaces it.
 */
function LiveBoardSkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading live games"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
    >
      <span className="sr-only">Connecting to live game feed…</span>
      {[0, 1, 2].map((i) => (
        <Card key={i} aria-hidden="true" className="h-full gap-4">
          <CardHeader className="flex-row items-center justify-between gap-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-5 w-14 rounded-full" />
          </CardHeader>

          <CardContent className="flex flex-col gap-3">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
              <div className="flex flex-col items-center gap-2">
                <Skeleton className="h-3 w-10" />
                <Skeleton className="h-9 w-12" />
              </div>
              <Skeleton className="h-3 w-3" />
              <div className="flex flex-col items-center gap-2">
                <Skeleton className="h-3 w-10" />
                <Skeleton className="h-9 w-12" />
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-16" />
            </div>
          </CardContent>
        </Card>
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

/**
 * Non-destructive banner for a connection that's still `"open"` but has
 * gone quiet for over a minute — distinct from `LiveBoardError` (the
 * `EventSource` itself erroring). Rendered alongside the last-known game
 * cards rather than replacing them, since a delayed upstream tick isn't
 * the same as a dead connection.
 *
 * Screen-reader behavior mirrors `GameStatusBadge`'s restraint above: the
 * visible elapsed-time text ticks up every second (the parent re-renders
 * this on a 1s `setInterval`), but that changing duration is wrapped in
 * `aria-hidden` so screen readers never see the mutation — a live region
 * only reacts to changes in its *accessible* content. The one sentence
 * that stays in the accessible tree ("No update in over a minute…") never
 * changes text, so `role="status"` announces it exactly once, when the
 * banner first mounts, rather than re-announcing on every tick.
 */
function LiveBoardStale({ secondsStale }: { secondsStale: number }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-muted-foreground"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
      <p>
        <span>No update in over a minute — the feed may be delayed.</span>{" "}
        <span aria-hidden="true">
          (last update {formatStaleDuration(secondsStale)} ago)
        </span>
      </p>
    </div>
  );
}

export default function LiveBoard() {
  const [games, setGames] = useState<LiveGameState[] | null>(null);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  /**
   * Seconds since the last SSE message, once that exceeds
   * `STALE_THRESHOLD_MS` — `null` while fresh. Distinct from
   * `connectionState === "error"`: the `EventSource` is still open here,
   * it's just gone quiet, so the currently-rendered game cards stay up
   * rather than being replaced by `LiveBoardError`.
   */
  const [staleSeconds, setStaleSeconds] = useState<number | null>(null);
  const lastMessageAtRef = useRef<number | null>(null);

  useEffect(() => {
    const source = new EventSource("/api/live");

    source.onmessage = (event) => {
      setConnectionState("open");
      lastMessageAtRef.current = Date.now();
      setStaleSeconds(null);
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

    const staleCheckInterval = setInterval(() => {
      const lastMessageAt = lastMessageAtRef.current;
      if (lastMessageAt === null) return;
      const elapsedMs = Date.now() - lastMessageAt;
      setStaleSeconds(
        elapsedMs >= STALE_THRESHOLD_MS ? Math.floor(elapsedMs / 1000) : null
      );
    }, STALE_CHECK_INTERVAL_MS);

    return () => {
      source.close();
      clearInterval(staleCheckInterval);
    };
  }, []);

  if (connectionState === "error") {
    return <LiveBoardError />;
  }

  if (games === null) {
    return <LiveBoardSkeleton />;
  }

  return (
    <div className="flex flex-col gap-4">
      {staleSeconds !== null && <LiveBoardStale secondsStale={staleSeconds} />}
      {games.length === 0 ? (
        <LiveBoardEmpty />
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {games.map((game, index) => {
            const updatedAt = formatUpdatedAt(game.pulled_at);

            return (
              <li
                key={game.game_id ?? index}
                style={{ animationDelay: `${Math.min(index, 6) * 60}ms` }}
                className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:fill-mode-backwards motion-safe:duration-300 motion-safe:ease-out"
              >
                <Card className="h-full gap-4">
                  <CardHeader className="flex-row items-center justify-between gap-2">
                    <CardTitle className="font-mono text-xs font-medium tracking-wide text-muted-foreground">
                      Game {displayValue(game.game_id, "—")}
                    </CardTitle>
                    <CardAction>
                      <GameStatusBadge status={game.status} />
                    </CardAction>
                  </CardHeader>

                  <CardContent className="flex flex-col gap-3">
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
                      <div className="flex flex-col items-center gap-1">
                        <span
                          aria-hidden="true"
                          className="text-xs font-medium tracking-wider text-muted-foreground uppercase"
                        >
                          Away
                        </span>
                        <span
                          aria-label={`Away score ${displayValue(game.away_score, "unavailable")}`}
                          className="font-mono text-3xl font-semibold tabular-nums text-foreground sm:text-4xl"
                        >
                          {displayValue(game.away_score, "–")}
                        </span>
                      </div>

                      <span
                        aria-hidden="true"
                        className="font-mono text-sm text-muted-foreground"
                      >
                        @
                      </span>

                      <div className="flex flex-col items-center gap-1">
                        <span
                          aria-hidden="true"
                          className="text-xs font-medium tracking-wider text-muted-foreground uppercase"
                        >
                          Home
                        </span>
                        <span
                          aria-label={`Home score ${displayValue(game.home_score, "unavailable")}`}
                          className="font-mono text-3xl font-semibold tabular-nums text-foreground sm:text-4xl"
                        >
                          {displayValue(game.home_score, "–")}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
                      <span>
                        {game.period !== undefined && game.period !== null
                          ? `Q${displayValue(game.period, "")}`
                          : "—"}
                        {game.clock ? ` · ${game.clock}` : ""}
                      </span>
                      {updatedAt ? <span>{updatedAt}</span> : null}
                    </div>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
