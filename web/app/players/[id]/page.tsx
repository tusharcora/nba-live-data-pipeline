"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, TriangleAlert, UserRound } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BoxScoreTable,
  formatGameDate,
  playerHeadshotUrl,
  TeamLogo,
  teamLogoUrlFromAbbreviation,
  type PlayerStatRow,
} from "@/lib/box-score";

type ApiList<T> = { data: T[]; count: number };

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; rows: PlayerStatRow[] };

const FETCH_ERROR = "Couldn't reach the player stats service. Try refreshing the page.";

/** Parses `minutes_played` (a display string, e.g. "34" -- already rounded
 * to a whole minute, see stg_player_game_stats*.sql) back to a number for
 * averaging. Null/unparseable rows are excluded from both the sum and the
 * count, same as every other stat here. */
function parseMinutes(minutesPlayed: string | null): number | null {
  if (minutesPlayed === null) return null;
  const value = Number(minutesPlayed);
  return Number.isFinite(value) ? value : null;
}

/** Average of a stat across every row where it's non-null (a DNP/inactive
 * row has null stats -- see stg_player_game_stats_nba.sql's header -- and
 * must not be averaged in as a zero, which would understate real per-game
 * production). Returns null if no row has that stat at all. */
function average(values: (number | null)[]): number | null {
  const real = values.filter((v): v is number => v !== null);
  if (real.length === 0) return null;
  return real.reduce((sum, v) => sum + v, 0) / real.length;
}

function formatAverage(value: number | null): string {
  return value === null ? "–" : value.toFixed(1);
}

/** One row per team the player has a stat line for, spanning the earliest
 * to latest game found for that team's abbreviation, sorted by when that
 * span started.
 *
 * Known limitation, stated plainly rather than silently overclaiming
 * precision: a player who left a team and later returned to the *same*
 * team (not just a different team, which works fine here) would show one
 * merged date range spanning the whole gap, not two separate stints --
 * this groups by team abbreviation only, it doesn't detect a gap and
 * split it into multiple rows. */
function computeTeamTenure(
  rows: PlayerStatRow[]
): { team: string; firstGame: string; lastGame: string; games: number }[] {
  const byTeam = new Map<string, { first: string; last: string; games: number }>();
  for (const row of rows) {
    const existing = byTeam.get(row.team);
    if (!existing) {
      byTeam.set(row.team, { first: row.game_date, last: row.game_date, games: 1 });
      continue;
    }
    existing.games += 1;
    if (row.game_date < existing.first) existing.first = row.game_date;
    if (row.game_date > existing.last) existing.last = row.game_date;
  }
  return Array.from(byTeam.entries())
    .map(([team, { first, last, games }]) => ({
      team,
      firstGame: first,
      lastGame: last,
      games,
    }))
    .sort((a, b) => a.firstGame.localeCompare(b.firstGame));
}

export default function PlayerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [state, setState] = useState<FetchState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    params.then(({ id }) => {
      if (!cancelled) setPlayerId(id);
    });
    return () => {
      cancelled = true;
    };
  }, [params]);

  useEffect(() => {
    if (playerId === null) return;
    let cancelled = false;
    // `setState` calls stay inside `.then()`/`.catch()` callbacks (never
    // called synchronously in the effect body itself) -- same shape as
    // Explorer's own fetch-on-mount effect, per this repo's
    // `react-hooks/set-state-in-effect` lint rule.
    Promise.resolve().then(() => {
      if (!cancelled) setState({ status: "loading" });
    });

    fetch(`/api/players/${playerId}`)
      .then((res) => res.json())
      .then((data: { playerStats: ApiList<PlayerStatRow> | null }) => {
        if (cancelled) return;
        setState({ status: "loaded", rows: data.playerStats?.data ?? [] });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", message: FETCH_ERROR });
      });

    return () => {
      cancelled = true;
    };
  }, [playerId]);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6">
      <Link
        href="/explorer"
        className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground hover:underline"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Back to Historical Explorer
      </Link>

      {state.status === "loading" && (
        <div role="status" aria-live="polite" className="flex flex-col gap-4">
          <span className="sr-only">Loading player…</span>
          <div className="flex items-center gap-4">
            <Skeleton className="size-20 rounded-full" />
            <Skeleton className="h-8 w-56" />
          </div>
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {state.status === "error" && (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Couldn&apos;t load this player</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      {state.status === "loaded" && state.rows.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center">
          <UserRound aria-hidden="true" className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">No games found for this player</p>
          <p className="text-sm text-muted-foreground">
            Either this player_id doesn&apos;t exist, or the historical backfill hasn&apos;t
            reached any of their seasons yet.
          </p>
        </div>
      )}

      {state.status === "loaded" && state.rows.length > 0 && (
        <PlayerDetail playerId={playerId as string} rows={state.rows} />
      )}
    </main>
  );
}

function PlayerDetail({ playerId, rows }: { playerId: string; rows: PlayerStatRow[] }) {
  // `rows` arrives most-recent-first (stat_id desc, see
  // api/src/api/routers/player_stats.py) -- re-sorted here by the actual
  // game_date string (ISO dates sort correctly lexicographically) so this
  // page's own ordering is explicit and doesn't depend on that incidental
  // upstream property.
  const sortedByDateDesc = [...rows].sort((a, b) => b.game_date.localeCompare(a.game_date));
  const latest = sortedByDateDesc[0];
  const last10 = sortedByDateDesc.slice(0, 10);
  const teamTenure = computeTeamTenure(rows);

  const averages = {
    points: average(rows.map((r) => r.points)),
    rebounds: average(rows.map((r) => r.rebounds)),
    assists: average(rows.map((r) => r.assists)),
    steals: average(rows.map((r) => r.steals)),
    blocks: average(rows.map((r) => r.blocks)),
    turnovers: average(rows.map((r) => r.turnovers)),
    minutes: average(rows.map((r) => parseMinutes(r.minutes_played))),
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-4">
        <Image
          src={playerHeadshotUrl(latest.player_id)}
          alt=""
          width={80}
          height={80}
          unoptimized
          className="size-20 shrink-0 rounded-full bg-muted object-cover"
        />
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {latest.player_first_name} {latest.player_last_name}
          </h1>
          <p className="text-sm text-muted-foreground">
            {rows.length} game{rows.length === 1 ? "" : "s"} in this app&apos;s backfilled
            data (player_id {playerId})
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Career averages</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-3 gap-4 sm:grid-cols-7">
            {(
              [
                ["PPG", averages.points],
                ["RPG", averages.rebounds],
                ["APG", averages.assists],
                ["SPG", averages.steals],
                ["BPG", averages.blocks],
                ["TOV", averages.turnovers],
                ["MPG", averages.minutes],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex flex-col gap-1">
                <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
                <dd className="font-mono text-lg tabular-nums text-foreground">
                  {formatAverage(value)}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            Averaged only over games with a recorded stat line -- DNP/inactive games (no
            minutes played) are excluded, not counted as a zero.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Teams</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2">
            {teamTenure.map((stint) => (
              <li key={stint.team} className="flex items-center gap-2 text-sm">
                <TeamLogo src={teamLogoUrlFromAbbreviation(stint.team)} alt="" />
                <span className="font-jetbrains-mono font-medium text-foreground">
                  {stint.team}
                </span>
                <span className="font-jetbrains-mono text-muted-foreground">
                  {formatGameDate(stint.firstGame)} – {formatGameDate(stint.lastGame)} (
                  {stint.games} game{stint.games === 1 ? "" : "s"})
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            Each row spans this player&apos;s earliest to latest recorded game for that team.
            A player who left and later returned to the *same* team would show one merged
            range here, not separate stints — this groups by team only, it doesn&apos;t detect
            a gap in between.
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-medium text-foreground">Last 10 games</h2>
        <BoxScoreTable rows={last10} showGameContext />
      </div>
    </div>
  );
}
