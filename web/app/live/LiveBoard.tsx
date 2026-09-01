"use client";

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

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
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {games.map((game, index) => {
        const updatedAt = formatUpdatedAt(game.pulled_at);

        return (
          <li key={game.game_id ?? index}>
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
  );
}
