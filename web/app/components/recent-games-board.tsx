"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  appendCommentaryTick,
  type BoardGameRow,
  formatFreshness,
  formatScheduledStart,
  getStatusPresentation,
} from "@/lib/board";
import {
  displayScore,
  playerHeadshotUrl,
  scoreColorClass,
  TEAM_NAME_TO_ABBREVIATION,
  TeamLogo,
  teamLogoUrlFromName,
  type PlayerStatRow,
} from "@/lib/box-score";
import { FOCUS_RING } from "@/lib/focus-ring";
import { PlayerPopover } from "@/components/player-popover";

type ApiList<T> = { data: T[]; count: number };

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; games: BoardGameRow[] };

const FETCH_ERROR = "Couldn't reach the games service.";

/** Falls back to the full name for any team missing from the map rather
 * than rendering "undefined" -- matches the fallback `box-score.tsx`
 * itself already uses wherever it reads this same map. */
function abbr(teamName: string | null): string {
  if (!teamName) return "—";
  return TEAM_NAME_TO_ABBREVIATION[teamName] ?? teamName;
}

/** "HH:MM:SS UTC" render of the exact pull timestamp -- only the ticket
 * panel shows this alongside the relative "Ns ago" freshness. */
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

// Session-scoped, not per-component: true the first time *any* leaders
// query on this page has returned real rows. `player_game_stats` is empty
// in production pending the historical backfill -- a "final" game's
// leaders query coming back empty is the expected, known state until then.
// But once this flag is true (backfill has clearly run, since some other
// game on this page had rows), a *different* "final" game still coming
// back empty is no longer that same expected case -- it's either a genuine
// per-game gap or a query problem, worth a console note so it doesn't
// silently look identical to the pre-backfill state once backfill has
// actually landed. Not surfaced in the UI -- both cases render the same
// "no leaders" placeholder to the viewer.
let sawAnyPlayerStatsThisSession = false;

type LeadersState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "empty" }
  | { status: "loaded"; leaders: { label: string; row: PlayerStatRow }[] };

function topBy(
  rows: PlayerStatRow[],
  stat: "points" | "rebounds" | "assists"
): PlayerStatRow | null {
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
function Leaders({
  goldGameId,
  status,
}: {
  goldGameId: number | null;
  status: BoardGameRow["status"];
}) {
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
            `[RecentGamesBoard] leaders query for gold_game_id=${goldGameId} (final) returned ` +
              "no rows, but other games this session did -- possible per-game data gap, not " +
              "the expected pre-backfill empty state."
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
 * session for the selected game (not just the latest, which the
 * "Commentary" row above already shows for a live game) -- last 8 lines,
 * newest first, behind a "Recent updates" toggle so the ticket stays a
 * quick glance by default. */
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
 * Homepage "board" -- a grid of individually-bordered "market cards"
 * (Direction G) plus a "feed ticket" detail rail. Reads the real unified
 * `GET /board` (live, scheduled, and recent final games together) and
 * subscribes to `/board/stream` for live updates, replacing the previous
 * `GET /games` (historical-only, always "Final") data source -- the
 * Direction-G grid's visual shape is unchanged, only what feeds it.
 *
 * `/board/stream` emits only *today's* rows (see its own docstring in
 * `api/src/api/routers/board.py`) -- historical rows are static and never
 * appear in a tick. A tick is therefore an upsert of the games it *does*
 * include, not the board's new full state: replacing the whole list
 * wholesale on every tick would wipe every historical row the moment no
 * game is live today.
 *
 * `BoardGameRow` has no `game_date`/`postseason` fields (those only
 * existed on the old historical-only `GameRow`) -- the grid card's header
 * line shows live period/clock or a scheduled tip-off time instead of a
 * date, rather than fabricating one that isn't in the response.
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
      .then((data: ApiList<BoardGameRow> | null) => {
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
        const parsed = JSON.parse(event.data) as ApiList<BoardGameRow>;
        if (cancelled) return;
        if (parsed.data.length === 0) return;
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
  const selectedPresentation = getStatusPresentation(selected.status);
  const selectedLog = commentaryLogs[selected.game_id] ?? [];

  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-heading text-lg font-bold tracking-wide text-foreground uppercase">
        Recent games
      </h2>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1fr_320px]">
        {/* Board -- a grid of individually-bordered "market cards"
            (Direction G). Clicking a card still only calls setSelectedId
            -- the feed ticket's own markup and behavior below are
            unchanged in shape, only now fed by real live/scheduled/final
            data instead of always "Final". */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 font-mono text-xs tracking-widest text-muted-foreground uppercase">
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-amber-600 shadow-[0_0_6px_rgba(217,119,6,0.6)] dark:bg-amber-500"
              />
              Market board
            </span>
            <span className="hidden font-mono text-xs text-muted-foreground sm:inline">
              Select a game →
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {state.games.slice(0, 8).map((game) => {
              const isSelected = game.game_id === selected.game_id;
              const presentation = getStatusPresentation(game.status);
              // Winner glow (Direction G): scoreColorClass already colors
              // the winning row's name+score amber -- these two booleans
              // only add the extra LED-style glow on top of that existing
              // amber, they don't duplicate its win/lose/tie logic (a tie
              // or a missing score glows neither side, matching
              // scoreColorClass's own "never guesses a winner from
              // incomplete data" rule).
              const awayIsWinner =
                game.away_score !== null &&
                game.home_score !== null &&
                game.away_score > game.home_score;
              const homeIsWinner =
                game.away_score !== null &&
                game.home_score !== null &&
                game.home_score > game.away_score;
              return (
                <button
                  key={game.game_id}
                  type="button"
                  onClick={() => setSelectedId(game.game_id)}
                  aria-pressed={isSelected}
                  className={cn(
                    "flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left transition-colors hover:border-amber-500/40",
                    FOCUS_RING,
                    isSelected &&
                      "border-amber-600 shadow-[0_0_0_1px_rgba(217,119,6,0.5),0_0_18px_rgba(217,119,6,0.18)] dark:border-amber-500"
                  )}
                >
                  <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                    <span className="flex items-center gap-1.5 truncate font-mono text-[11px] text-muted-foreground uppercase">
                      <span>
                        {abbr(game.away_team)} @ {abbr(game.home_team)}
                      </span>
                      {game.status === "live" && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>
                            {game.period ? `Q${game.period}` : ""}
                            {game.clock ? ` ${game.clock}` : ""}
                          </span>
                        </>
                      )}
                      {game.status === "scheduled" && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{formatScheduledStart(game.scheduled_start)}</span>
                        </>
                      )}
                    </span>
                    <span
                      className={cn(
                        "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wide uppercase",
                        presentation.kind === "live"
                          ? "bg-primary/15 text-primary"
                          : "bg-amber-600/15 text-amber-600 dark:text-amber-500"
                      )}
                    >
                      {presentation.kind === "live" && (
                        <span aria-hidden="true" className="relative flex size-1.5">
                          <span className="absolute inline-flex size-full rounded-full bg-primary/70 motion-safe:animate-ping" />
                          <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
                        </span>
                      )}
                      {presentation.label}
                    </span>
                  </div>

                  <div className="flex flex-col">
                    <div
                      className={cn(
                        "flex items-center gap-2 px-3 py-2",
                        scoreColorClass(game.away_score, game.home_score)
                      )}
                    >
                      <TeamLogo src={teamLogoUrlFromName(game.away_team ?? "")} alt="" />
                      <span className="flex-1 truncate text-sm font-medium">
                        {game.away_team ?? "—"}
                      </span>
                      <span
                        className={cn(
                          "font-[family-name:var(--font-orbitron-raw)] text-2xl leading-none font-bold tabular-nums",
                          awayIsWinner && "drop-shadow-[0_0_10px_rgba(245,166,35,0.45)]"
                        )}
                      >
                        {displayScore(game.away_score)}
                      </span>
                    </div>
                    <div
                      className={cn(
                        "flex items-center gap-2 border-t border-border px-3 py-2",
                        scoreColorClass(game.home_score, game.away_score)
                      )}
                    >
                      <TeamLogo src={teamLogoUrlFromName(game.home_team ?? "")} alt="" />
                      <span className="flex-1 truncate text-sm font-medium">
                        {game.home_team ?? "—"}
                      </span>
                      <span
                        className={cn(
                          "font-[family-name:var(--font-orbitron-raw)] text-2xl leading-none font-bold tabular-nums",
                          homeIsWinner && "drop-shadow-[0_0_10px_rgba(245,166,35,0.45)]"
                        )}
                      >
                        {displayScore(game.home_score)}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Feed ticket */}
        <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card lg:sticky lg:top-4">
          {/* Header is its own `relative` block so the notches below sit
              exactly on its bottom (dashed) border regardless of how tall
              the title/subtitle/badge make it, rather than an estimated
              fixed pixel offset from the card's own top edge. */}
          <div className="relative flex items-start justify-between gap-2 border-b border-dashed border-border px-4 py-3">
            <div>
              <h3 className="flex items-center gap-1.5 font-mono text-base font-semibold tracking-wide text-foreground uppercase">
                <TeamLogo src={teamLogoUrlFromName(selected.away_team ?? "")} alt="" />
                {abbr(selected.away_team)} ·
                <TeamLogo src={teamLogoUrlFromName(selected.home_team ?? "")} alt="" />
                {abbr(selected.home_team)}
              </h3>
              <p className="mt-0.5 font-mono text-xs text-muted-foreground uppercase">
                Feed ticket · Game #{selected.game_id}
              </p>
            </div>
            <span
              className={cn(
                "shrink-0 rounded-md px-2 py-0.5 font-mono text-xs font-semibold tracking-wide uppercase",
                selectedPresentation.kind === "live"
                  ? "bg-primary/15 text-primary"
                  : "bg-amber-600/15 text-amber-600 dark:text-amber-500"
              )}
            >
              {selectedPresentation.label}
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
              <dd className="text-foreground">{selectedPresentation.label}</dd>
            </div>

            {selected.status === "live" && (
              <div className="flex items-center justify-between gap-2">
                <dt className="tracking-wide text-muted-foreground uppercase">Period / Clock</dt>
                <dd className="text-foreground">
                  {selected.period ? `Q${selected.period}` : "—"}
                  {selected.clock ? ` · ${selected.clock}` : ""}
                </dd>
              </div>
            )}

            {selected.status === "scheduled" && (
              <div className="flex items-center justify-between gap-2">
                <dt className="tracking-wide text-muted-foreground uppercase">Tips Off</dt>
                <dd className="text-foreground">
                  {formatScheduledStart(selected.scheduled_start)}
                </dd>
              </div>
            )}

            {(selected.status === "live" || selected.status === "final") && (
              <div className="flex items-center justify-between gap-2">
                <dt className="tracking-wide text-muted-foreground uppercase">Score</dt>
                <dd className="flex items-center gap-1.5 text-amber-600 dark:text-amber-500">
                  <TeamLogo src={teamLogoUrlFromName(selected.away_team ?? "")} alt="" />
                  {abbr(selected.away_team)} {displayScore(selected.away_score)} —{" "}
                  {abbr(selected.home_team)} {displayScore(selected.home_score)}
                  <TeamLogo src={teamLogoUrlFromName(selected.home_team ?? "")} alt="" />
                </dd>
              </div>
            )}

            {selected.status === "live" && selected.commentary && (
              <div className="flex items-center justify-between gap-2">
                <dt className="tracking-wide text-muted-foreground uppercase">Commentary</dt>
                <dd className={cn("text-right", COMMENTARY_COLOR[selected.commentary.kind])}>
                  {selected.commentary.text}
                </dd>
              </div>
            )}

            {/* Fixed descriptive string, not a per-row field -- the API
                doesn't return a "source" value on a board row. */}
            <div className="flex items-center justify-between gap-2">
              <dt className="tracking-wide text-muted-foreground uppercase">Source</dt>
              <dd className="text-foreground">balldontlie · nba_stats</dd>
            </div>

            <div className="flex items-center justify-between gap-2">
              <dt className="tracking-wide text-muted-foreground uppercase">Last Pulled</dt>
              <dd className="text-foreground">{formatExactPulledAt(selected.source_pulled_at)}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="tracking-wide text-muted-foreground uppercase">Freshness</dt>
              <dd className="text-foreground">{formatFreshness(selected.source_pulled_at)}</dd>
            </div>
          </dl>

          <Leaders goldGameId={selected.gold_game_id} status={selected.status} />
          <RecentUpdates log={selectedLog} />

          {/* Footer -- its own `relative` block too, same reasoning as the
              header, plus taller padding (py-5 vs the header's py-3) so
              its total height matches the header's despite having only
              one line of content instead of a title/subtitle/badge.
              Always links to `/live/<game_id>` (not `/games/<gold_game_id>`
              directly) -- `gold_game_id` is null for rows without a
              reliable Gold-table id yet, and `/live/[gameId]`'s own
              GameFeed already forwards a final game to the box score via
              its own gold_game_id check once it has real data to show. */}
          <div className="relative flex items-center border-t border-dashed border-border px-4 py-5">
            <Button
              render={<Link href={`/live/${selected.game_id}`} />}
              nativeButton={false}
              size="sm"
              variant="ghost"
              className={cn(
                "w-full cursor-pointer border border-border bg-transparent font-mono font-semibold tracking-[0.06em] uppercase hover:bg-muted/60",
                FOCUS_RING
              )}
            >
              {selected.status === "final" ? "Box score" : "View Feed"}
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
      </div>
    </div>
  );
}

export default RecentGamesBoard;
