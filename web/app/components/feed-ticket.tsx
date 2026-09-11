"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PlayerPopover } from "@/components/player-popover";
import {
  type BoardGameRow,
  formatFreshness,
  formatScheduledStart,
  getStatusPresentation,
} from "@/lib/board";
import {
  displayScore,
  playerHeadshotUrl,
  TEAM_NAME_TO_ABBREVIATION,
  type PlayerStatRow,
} from "@/lib/box-score";
import { cn } from "@/lib/utils";

function abbr(teamName: string | null): string {
  if (!teamName) return "—";
  return TEAM_NAME_TO_ABBREVIATION[teamName] ?? teamName;
}

/** "HH:MM:SS UTC" render of the exact pull timestamp -- only the sidebar
 * shows this alongside the row list's relative "Ns ago" freshness,
 * matching the pre-redesign board's "Last Pulled" field. */
function formatExactPulledAt(iso: string | null): string {
  if (iso === null) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  return `${parsed.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
  })} UTC`;
}

const COMMENTARY_COLOR: Record<string, string> = {
  conflict: "text-pink-600 dark:text-pink-400",
  stale: "text-amber-600 dark:text-amber-500",
  run: "text-amber-600 dark:text-amber-500",
  leader: "text-muted-foreground",
};

// Session-scoped, not per-component: true the first time *any* ticket's
// leaders query on this page has returned real rows. `player_game_stats`
// is empty in production pending the historical backfill -- a "final"
// game's leaders query coming back empty is the expected, known state
// until then. But once this flag is true (backfill has clearly run, since
// some other game on this page had rows), a *different* "final" game still
// coming back empty is no longer that same expected case -- it's either a
// genuine per-game gap or a query problem, worth a console note so it
// doesn't silently look identical to the pre-backfill state once backfill
// has actually landed. Not surfaced in the UI -- both cases render the
// same "no leaders" placeholder to the viewer.
let sawAnyPlayerStatsThisSession = false;

type LeadersState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "empty" }
  | { status: "loaded"; leaders: { label: string; row: PlayerStatRow }[] };

function topBy(rows: PlayerStatRow[], stat: "points" | "rebounds" | "assists"): PlayerStatRow | null {
  let best: PlayerStatRow | null = null;
  for (const row of rows) {
    // `points`/`rebounds`/`assists` are typed `number` but a DNP/inactive
    // row's real API response sends `null` (see box-score.tsx's identical
    // note) -- treat as possibly null despite the type.
    const value = row[stat] as number | null;
    if (value === null) continue;
    const bestValue = best ? (best[stat] as number | null) : null;
    if (best === null || bestValue === null || value > bestValue) best = row;
  }
  return best;
}

/** Each team's top scorer/rebounder/assist leader for the selected game --
 * up to 3 mini chips (a player leading two categories only appears once,
 * under their highest-value category). Only queried when `goldGameId` is
 * resolved (a live/scheduled game has none yet -- `gold_game_id` is only
 * set once a game is reconciled into the Gold layer -- so there's no valid
 * query to make at all, a different situation from a "final" game's query
 * coming back genuinely empty). */
function Leaders({ goldGameId, status }: { goldGameId: number | null; status: BoardGameRow["status"] }) {
  const [state, setState] = useState<LeadersState>({ status: "idle" });

  useEffect(() => {
    let cancelled = false;
    if (goldGameId === null) {
      Promise.resolve().then(() => {
        if (!cancelled) setState({ status: "idle" });
      });
      return () => {
        cancelled = true;
      };
    }
    Promise.resolve().then(() => {
      if (!cancelled) setState({ status: "loading" });
    });

    fetch(`/api/player-stats?game_id=${goldGameId}`)
      .then((res) => {
        if (!res.ok) throw new Error("unreachable");
        return res.json();
      })
      .then((data: { data: PlayerStatRow[]; count: number } | null) => {
        if (cancelled) return;
        const rows = data?.data ?? [];
        if (rows.length > 0) {
          sawAnyPlayerStatsThisSession = true;
        } else if (status === "final" && sawAnyPlayerStatsThisSession) {
          console.warn(
            `[FeedTicket] leaders query for gold_game_id=${goldGameId} (final) returned no rows, ` +
              "but other games this session did -- possible per-game data gap, not the expected " +
              "pre-backfill empty state."
          );
        }

        const seen = new Set<number>();
        const leaders: { label: string; row: PlayerStatRow }[] = [];
        for (const [label, stat] of [
          ["Pts", "points"],
          ["Reb", "rebounds"],
          ["Ast", "assists"],
        ] as const) {
          const row = topBy(rows, stat);
          if (row && !seen.has(row.player_id)) {
            seen.add(row.player_id);
            leaders.push({ label: `${label} · ${row[stat]}`, row });
          }
        }
        setState(leaders.length > 0 ? { status: "loaded", leaders } : { status: "empty" });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "empty" });
      });

    return () => {
      cancelled = true;
    };
  }, [goldGameId, status]);

  if (state.status === "idle" || state.status === "loading" || state.status === "empty") {
    return null;
  }

  return (
    <div className="flex items-center justify-between gap-2 border-t border-dashed border-border px-4 py-3">
      <span className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
        Leaders
      </span>
      <div className="flex items-center gap-3">
        {state.leaders.map(({ label, row }) => (
          <PlayerPopover
            key={`${row.player_id}-${label}`}
            playerId={row.player_id}
            className="flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-muted"
          >
            <Image
              src={playerHeadshotUrl(row.player_id)}
              alt=""
              width={22}
              height={22}
              unoptimized
              className="size-[22px] shrink-0 rounded-full bg-muted object-cover"
            />
            <span className="font-mono text-xs text-foreground">{label}</span>
          </PlayerPopover>
        ))}
      </div>
    </div>
  );
}

/** Collapsed-by-default history of every commentary line observed this
 * session for the selected game (not just the latest, which the "Commentary"
 * row above already shows for a live game) -- last 8 lines, newest first,
 * behind a "Recent updates" toggle so the ticket stays a quick glance by
 * default. */
function RecentUpdates({ log }: { log: string[] }) {
  const [expanded, setExpanded] = useState(false);

  if (log.length === 0) return null;

  return (
    <div className="border-t border-dashed border-border px-4 py-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 font-mono text-xs tracking-wide text-muted-foreground uppercase"
      >
        <span>Recent updates ({log.length})</span>
        <ChevronDown
          aria-hidden="true"
          className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
        />
      </button>
      {expanded && (
        <ul className="mt-2 flex flex-col gap-1.5 font-mono text-xs text-muted-foreground">
          {log
            .slice(-8)
            .reverse()
            .map((line, i) => (
              <li key={i}>{line}</li>
            ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The board's "Feed ticket" detail panel -- the currently-selected row's
 * quick-glance detail, restoring the pre-redesign board's sidebar
 * alongside the unified row list (Task 15 had dropped it; re-added at
 * user request). Content varies by status: live shows running
 * score/period/clock/commentary, scheduled shows tip-off time,
 * final/postponed show the settled state. "Box score"/"View Feed"
 * always links to `/live/<id>` -- the fuller live ticker + commentary
 * log view -- so this panel stays a quick glance and that page stays
 * the deep dive.
 */
export function FeedTicket({ game, log = [] }: { game: BoardGameRow; log?: string[] }) {
  const presentation = getStatusPresentation(game.status);

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="relative flex items-start justify-between gap-2 border-b border-dashed border-border px-4 py-3">
        <div>
          <h3 className="font-mono text-base font-semibold tracking-wide text-foreground uppercase">
            {abbr(game.away_team)} · {abbr(game.home_team)}
          </h3>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground uppercase">
            Feed ticket · Game #{game.game_id}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-md px-2 py-0.5 font-mono text-xs font-semibold tracking-wide uppercase",
            presentation.kind === "live"
              ? "bg-primary/15 text-primary"
              : "bg-amber-600/15 text-amber-600 dark:text-amber-500"
          )}
        >
          {presentation.label}
        </span>
        <div
          aria-hidden="true"
          className="absolute -bottom-2.5 -left-2.5 size-5 rounded-full bg-background"
        />
        <div
          aria-hidden="true"
          className="absolute -right-2.5 -bottom-2.5 size-5 rounded-full bg-background"
        />
      </div>

      <dl className="flex flex-col gap-3 px-4 py-3 font-mono text-sm">
        <div className="flex items-center justify-between gap-2">
          <dt className="tracking-wide text-muted-foreground uppercase">Status</dt>
          <dd className="text-foreground">{presentation.label}</dd>
        </div>

        {game.status === "live" && (
          <div className="flex items-center justify-between gap-2">
            <dt className="tracking-wide text-muted-foreground uppercase">Period / Clock</dt>
            <dd className="text-foreground">
              {game.period ? `Q${game.period}` : "—"}
              {game.clock ? ` · ${game.clock}` : ""}
            </dd>
          </div>
        )}

        {game.status === "scheduled" && (
          <div className="flex items-center justify-between gap-2">
            <dt className="tracking-wide text-muted-foreground uppercase">Tips Off</dt>
            <dd className="text-foreground">{formatScheduledStart(game.scheduled_start)}</dd>
          </div>
        )}

        {(game.status === "live" || game.status === "final") && (
          <div className="flex items-center justify-between gap-2">
            <dt className="tracking-wide text-muted-foreground uppercase">Score</dt>
            <dd className="text-amber-600 dark:text-amber-500">
              {abbr(game.away_team)} {displayScore(game.away_score)} —{" "}
              {abbr(game.home_team)} {displayScore(game.home_score)}
            </dd>
          </div>
        )}

        {game.status === "live" && game.commentary && (
          <div className="flex items-center justify-between gap-2">
            <dt className="tracking-wide text-muted-foreground uppercase">Commentary</dt>
            <dd className={cn("text-right", COMMENTARY_COLOR[game.commentary.kind])}>
              {game.commentary.text}
            </dd>
          </div>
        )}

        {/* Fixed descriptive string, not a per-row field -- the API
            doesn't return a "source" value on a board row. Matches the
            pre-redesign sidebar's identical hardcoded behavior. */}
        <div className="flex items-center justify-between gap-2">
          <dt className="tracking-wide text-muted-foreground uppercase">Source</dt>
          <dd className="text-foreground">balldontlie · nba_stats</dd>
        </div>

        <div className="flex items-center justify-between gap-2">
          <dt className="tracking-wide text-muted-foreground uppercase">Last Pulled</dt>
          <dd className="text-foreground">{formatExactPulledAt(game.source_pulled_at)}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="tracking-wide text-muted-foreground uppercase">Freshness</dt>
          <dd className="text-foreground">{formatFreshness(game.source_pulled_at)}</dd>
        </div>
      </dl>

      <Leaders goldGameId={game.gold_game_id} status={game.status} />
      <RecentUpdates log={log} />

      <div className="relative flex items-center border-t border-dashed border-border px-4 py-5">
        <Button
          render={<Link href={`/live/${game.game_id}`} />}
          nativeButton={false}
          size="sm"
          variant="ghost"
          className="w-full cursor-pointer border border-border bg-transparent hover:bg-muted/60"
        >
          {game.status === "final" ? "Box score" : "View Feed"}
        </Button>
        <div
          aria-hidden="true"
          className="absolute -top-2.5 -left-2.5 size-5 rounded-full bg-background"
        />
        <div
          aria-hidden="true"
          className="absolute -top-2.5 -right-2.5 size-5 rounded-full bg-background"
        />
      </div>
    </div>
  );
}

export default FeedTicket;
