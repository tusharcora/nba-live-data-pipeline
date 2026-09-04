"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  ABBREVIATION_TO_TEAM_NAME,
  average,
  displayScore,
  formatAverage,
  formatGameDate,
  type GameRow,
  NBA_GAME_ID_OFFSET,
  parseMinutesPlayed,
  type PlayerStatRow,
  playerHeadshotUrl,
  scoreColorClass,
  TEAM_NAME_TO_ABBREVIATION,
  teamLogoUrlFromAbbreviation,
  teamLogoUrlFromName,
  TeamLogo,
} from "@/lib/box-score";

type ApiList<T> = { data: T[]; count: number };

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; games: GameRow[] };

const FETCH_ERROR = "Couldn't reach the games service. Try refreshing the page.";

/** "1996–97", from the season's starting year. */
function formatSeasonLabel(season: number): string {
  return `${season}–${(season + 1).toString().slice(-2)}`;
}

/** Whether this team (identified by abbreviation, not a fixed display
 * name) won `game` -- null if either score is missing (game not yet
 * final) or the game doesn't involve this team at all. Compares
 * abbreviations rather than a single current team name because a
 * franchise's full name can change mid-history under the same
 * abbreviation (e.g. Charlotte Bobcats -> Hornets, both "CHA") -- a
 * fixed-name comparison would silently fail to match every game from
 * before the rename. */
function wonGame(game: GameRow, abbreviation: string): boolean | null {
  const homeAbbr = TEAM_NAME_TO_ABBREVIATION[game.home_team] ?? game.home_team;
  const awayAbbr = TEAM_NAME_TO_ABBREVIATION[game.away_team] ?? game.away_team;
  const isHome = homeAbbr === abbreviation;
  const isAway = awayAbbr === abbreviation;
  if (!isHome && !isAway) return null;
  if (game.home_score === null || game.away_score === null) return null;
  return isHome ? game.home_score > game.away_score : game.away_score > game.home_score;
}

export default function TeamPage({
  params,
}: {
  params: Promise<{ abbreviation: string }>;
}) {
  const [abbreviation, setAbbreviation] = useState<string | null>(null);
  const [state, setState] = useState<FetchState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    params.then(({ abbreviation }) => {
      if (!cancelled) setAbbreviation(abbreviation.toUpperCase());
    });
    return () => {
      cancelled = true;
    };
  }, [params]);

  useEffect(() => {
    if (abbreviation === null) return;
    let cancelled = false;
    // `setState` calls stay inside `.then()`/`.catch()` callbacks -- see
    // app/players/[id]/page.tsx's identical comment for why (this repo's
    // `react-hooks/set-state-in-effect` lint rule).
    Promise.resolve().then(() => {
      if (!cancelled) setState({ status: "loading" });
    });

    fetch(`/api/teams/${abbreviation}`)
      .then((res) => res.json())
      .then((data: { games: ApiList<GameRow> | null }) => {
        if (cancelled) return;
        setState({ status: "loaded", games: data.games?.data ?? [] });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", message: FETCH_ERROR });
      });

    return () => {
      cancelled = true;
    };
  }, [abbreviation]);

  const teamName = abbreviation ? ABBREVIATION_TO_TEAM_NAME[abbreviation] : undefined;

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
          <span className="sr-only">Loading team…</span>
          <div className="flex items-center gap-4">
            <Skeleton className="size-16 rounded-full" />
            <Skeleton className="h-8 w-56" />
          </div>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      )}

      {state.status === "error" && (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Couldn&apos;t load this team</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      {state.status === "loaded" && (!abbreviation || !teamName) && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center">
          <p className="text-sm font-medium text-foreground">Unknown team</p>
          <p className="text-sm text-muted-foreground">
            {abbreviation} isn&apos;t one of the 30 current NBA franchises.
          </p>
        </div>
      )}

      {state.status === "loaded" && abbreviation && teamName && (
        // Keyed by abbreviation so navigating from one team's page straight
        // to another's (both render the same component type/position)
        // remounts TeamDetail instead of carrying over its season-picker
        // state -- otherwise a season picked while viewing one team could
        // silently persist onto an unrelated team.
        <TeamDetail key={abbreviation} abbreviation={abbreviation} teamName={teamName} games={state.games} />
      )}
    </main>
  );
}

function TeamDetail({
  abbreviation,
  teamName,
  games,
}: {
  abbreviation: string;
  teamName: string;
  games: GameRow[];
}) {
  // Only real nba_stats-backfilled games (see NBA_GAME_ID_OFFSET) count --
  // balldontlie's 2024 pilot game_ids sit below this threshold and would
  // otherwise pollute the season list with a stale, disconnected 2023 entry.
  const realGames = useMemo(
    () => games.filter((g) => g.game_id >= NBA_GAME_ID_OFFSET),
    [games]
  );
  const availableSeasons = useMemo(
    () => Array.from(new Set(realGames.map((g) => g.season))).sort((a, b) => b - a),
    [realGames]
  );
  const mostRecentSeason = availableSeasons[0] ?? null;
  const [manualSeason, setManualSeason] = useState<number | null>(null);
  const selectedSeason = manualSeason ?? mostRecentSeason;

  const seasonGames = useMemo(
    () =>
      selectedSeason === null ? [] : realGames.filter((g) => g.season === selectedSeason),
    [realGames, selectedSeason]
  );
  const sortedSeasonGames = useMemo(
    () => [...seasonGames].sort((a, b) => b.game_date.localeCompare(a.game_date)),
    [seasonGames]
  );

  const { wins, losses } = useMemo(() => {
    const results = seasonGames.map((g) => wonGame(g, abbreviation));
    return {
      wins: results.filter((r) => r === true).length,
      losses: results.filter((r) => r === false).length,
    };
  }, [seasonGames, abbreviation]);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-4">
        <Image
          src={teamLogoUrlFromAbbreviation(abbreviation)}
          alt=""
          width={64}
          height={64}
          unoptimized
          className="size-16 shrink-0 object-contain"
        />
        <div className="flex flex-col gap-1">
          <h1 className="font-jetbrains-mono text-2xl font-semibold tracking-tight text-foreground">
            {teamName}
          </h1>
          {availableSeasons.length > 0 ? (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              Season
              <select
                value={selectedSeason ?? ""}
                onChange={(e) => setManualSeason(Number(e.target.value))}
                className="h-8 rounded-lg border border-border bg-background px-2 font-jetbrains-mono text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {availableSeasons.map((season) => (
                  <option key={season} value={season}>
                    {formatSeasonLabel(season)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="text-sm text-muted-foreground">
              No backfilled games yet for this franchise
            </p>
          )}
        </div>
      </div>

      {selectedSeason !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Season record</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-2xl tabular-nums text-foreground">
              {wins}-{losses}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Across {seasonGames.length} backfilled game{seasonGames.length === 1 ? "" : "s"}{" "}
              this season. A game with no final score yet counts toward neither total.
            </p>
          </CardContent>
        </Card>
      )}

      {selectedSeason !== null && (
        <TeamRoster
          key={selectedSeason}
          abbreviation={abbreviation}
          gameIds={seasonGames.map((g) => g.game_id)}
        />
      )}

      {sortedSeasonGames.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-medium text-foreground">
            Games this season
          </h2>
          <div className="flex flex-col gap-2">
            {sortedSeasonGames.map((game) => (
              <SeasonGameRow key={game.game_id} game={game} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

type RosterFetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; rows: PlayerStatRow[] };

const ROSTER_FETCH_ERROR = "Couldn't reach the player stats service.";

type RosterEntry = {
  playerId: number;
  firstName: string;
  lastName: string;
  gamesPlayed: number;
  points: number | null;
  rebounds: number | null;
  assists: number | null;
  minutes: number | null;
};

/** One row per player who has a resolved identity (some roster slots carry
 * `null` for both name fields at runtime -- confirmed against real data --
 * and are excluded here, same as BoxScoreTable's sort does for those rows),
 * with this season's per-game averages. Sorted by points per game
 * descending, matching BoxScoreTable's own default. */
function buildRoster(rows: PlayerStatRow[], abbreviation: string): RosterEntry[] {
  const byPlayer = new Map<
    number,
    {
      firstName: string;
      lastName: string;
      points: (number | null)[];
      rebounds: (number | null)[];
      assists: (number | null)[];
      minutes: (number | null)[];
    }
  >();

  for (const row of rows) {
    if (row.team !== abbreviation) continue;
    const firstName = row.player_first_name as string | null;
    const lastName = row.player_last_name as string | null;
    if (firstName === null && lastName === null) continue;

    const existing = byPlayer.get(row.player_id) ?? {
      firstName: firstName ?? "",
      lastName: lastName ?? "",
      points: [],
      rebounds: [],
      assists: [],
      minutes: [],
    };
    existing.points.push(row.points);
    existing.rebounds.push(row.rebounds);
    existing.assists.push(row.assists);
    existing.minutes.push(parseMinutesPlayed(row.minutes_played));
    byPlayer.set(row.player_id, existing);
  }

  return Array.from(byPlayer.entries())
    .map(([playerId, v]) => ({
      playerId,
      firstName: v.firstName,
      lastName: v.lastName,
      // "Played" means a recorded stat line -- a DNP/inactive row has
      // null points and isn't a game actually played.
      gamesPlayed: v.points.filter((p) => p !== null).length,
      points: average(v.points),
      rebounds: average(v.rebounds),
      assists: average(v.assists),
      minutes: average(v.minutes),
    }))
    .sort((a, b) => (b.points ?? -1) - (a.points ?? -1));
}

function TeamRoster({ abbreviation, gameIds }: { abbreviation: string; gameIds: number[] }) {
  const [state, setState] = useState<RosterFetchState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) setState({ status: "loading" });
    });

    if (gameIds.length === 0) {
      Promise.resolve().then(() => {
        if (!cancelled) setState({ status: "loaded", rows: [] });
      });
      return () => {
        cancelled = true;
      };
    }

    const search = new URLSearchParams();
    for (const id of gameIds) search.append("game_id", String(id));

    fetch(`/api/player-stats?${search.toString()}`)
      .then((res) => res.json())
      .then((data: { data: PlayerStatRow[] } | null) => {
        if (cancelled) return;
        setState({ status: "loaded", rows: data?.data ?? [] });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", message: ROSTER_FETCH_ERROR });
      });

    return () => {
      cancelled = true;
    };
    // gameIds is a fresh array every render; TeamRoster is remounted (via
    // `key`) whenever the selected season changes, which is the only time
    // this should refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-medium text-foreground">Players</h2>

      {state.status === "loading" && <Skeleton className="h-48 w-full" />}

      {state.status === "error" && (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Couldn&apos;t load this season&apos;s roster</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      {state.status === "loaded" && (
        <RosterTable roster={buildRoster(state.rows, abbreviation)} />
      )}
    </div>
  );
}

function RosterTable({ roster }: { roster: RosterEntry[] }) {
  if (roster.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center">
        <p className="text-sm font-medium text-foreground">No player stats for this season</p>
        <p className="text-sm text-muted-foreground">
          The games are backfilled, but the player-level box scores for them aren&apos;t yet.
        </p>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Player</TableHead>
          <TableHead className="text-right">GP</TableHead>
          <TableHead className="text-right">PPG</TableHead>
          <TableHead className="text-right">RPG</TableHead>
          <TableHead className="text-right">APG</TableHead>
          <TableHead className="text-right">MPG</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {roster.map((player) => (
          <TableRow key={player.playerId}>
            <TableCell className="font-medium text-foreground">
              <Link
                href={`/players/${player.playerId}`}
                className="flex items-center gap-2 hover:underline"
              >
                <Image
                  src={playerHeadshotUrl(player.playerId)}
                  alt=""
                  width={28}
                  height={28}
                  unoptimized
                  className="size-7 shrink-0 rounded-full bg-muted object-cover"
                />
                <span>
                  {player.firstName} {player.lastName}
                </span>
              </Link>
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
              {player.gamesPlayed}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {formatAverage(player.points)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {formatAverage(player.rebounds)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {formatAverage(player.assists)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
              {formatAverage(player.minutes)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SeasonGameRow({ game }: { game: GameRow }) {
  return (
    <Link
      href={`/games/${game.game_id}`}
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3 hover:bg-muted/50"
    >
      <span className="font-jetbrains-mono text-xs font-medium tracking-wide text-muted-foreground">
        {formatGameDate(game.game_date)}
        {game.postseason ? " · Postseason" : ""}
      </span>
      <div className="flex flex-wrap items-center gap-2 font-jetbrains-mono text-sm">
        <span
          className={cn(
            "inline-flex items-center gap-1.5",
            scoreColorClass(game.away_score, game.home_score)
          )}
        >
          <TeamLogo src={teamLogoUrlFromName(game.away_team)} alt="" />
          {game.away_team}
        </span>
        <span
          className={cn(
            "font-semibold tabular-nums",
            scoreColorClass(game.away_score, game.home_score)
          )}
        >
          {displayScore(game.away_score)}
        </span>
        <span className="text-muted-foreground">@</span>
        <span
          className={cn(
            "inline-flex items-center gap-1.5",
            scoreColorClass(game.home_score, game.away_score)
          )}
        >
          <TeamLogo src={teamLogoUrlFromName(game.home_team)} alt="" />
          {game.home_team}
        </span>
        <span
          className={cn(
            "font-semibold tabular-nums",
            scoreColorClass(game.home_score, game.away_score)
          )}
        >
          {displayScore(game.home_score)}
        </span>
      </div>
    </Link>
  );
}
