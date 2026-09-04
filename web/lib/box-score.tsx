"use client";

// Shared player/team box-score rendering -- used by both the Historical
// Explorer (per-game box scores and player-name search results) and the
// player detail page (`app/players/[id]/page.tsx`). Extracted here rather
// than duplicated once a second page needed the same table.

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowDown } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** Mirrors `ingestion/src/ingestion/sources/nba_stats.py`'s
 * `NBA_GAME_ID_OFFSET` -- nba_stats-sourced game_ids are this real
 * balldontlie-space offset plus the raw NBA.com game id, so any real
 * backfilled game_id is far above this threshold. balldontlie's own 2024
 * pilot data (this project's very first, pre-backfill games) sits below
 * it. Used to pick a team's most recent *real* season without a max-season
 * computation mistakenly preferring the pilot's stale 2023 season value
 * over the real, still-growing nba_stats seasons. */
export const NBA_GAME_ID_OFFSET = 100_000_000_000;

export type GameRow = {
  game_id: number;
  game_date: string;
  season: number;
  status: string;
  postseason: boolean;
  home_team: string;
  away_team: string;
  home_score: number | null;
  away_score: number | null;
  source_pulled_at: string;
};

export type PlayerStatRow = {
  // Serialized as a string by the API (see
  // api/src/api/routers/player_stats.py) -- stat_id = game_id * 10_000_000
  // + player_id can reach ~10^18 for nba_stats-sourced rows (offset
  // game_id space), past JS's Number.MAX_SAFE_INTEGER (2^53-1), so a plain
  // `number` here would silently lose precision / collide on real data.
  stat_id: string;
  game_id: number;
  player_id: number;
  player_first_name: string;
  player_last_name: string;
  team: string;
  points: number;
  rebounds: number;
  assists: number;
  steals: number;
  blocks: number;
  turnovers: number;
  minutes_played: string | null;
  // Joined in from the game this stat line belongs to (see
  // api/src/api/routers/player_stats.py) -- needed so a player-name search
  // (or a player's full game log) spanning many games can show which game
  // each row came from.
  game_date: string;
  home_team: string;
  away_team: string;
  home_score: number | null;
  away_score: number | null;
};

/**
 * NBA.com's own player-headshot CDN, keyed by `player_id` -- unofficial
 * (not a public documented API, same low-stakes trade-off category as this
 * project's `nba_api` backfill), but a widely-used, stable convention.
 * `player_id` on `PlayerStatRow` is nba_api's own id space, which is
 * exactly what this endpoint expects (this only works for nba_stats-
 * sourced rows -- balldontlie's `player_id` space is different, but that
 * source's own box-score path is realistically permanently empty, so this
 * isn't a real near-term gap). Players NBA.com hasn't photographed
 * (mostly obscure/historical role players) resolve to a generic silhouette
 * placeholder server-side rather than a broken image or a 404.
 */
export function playerHeadshotUrl(playerId: number): string {
  return `https://cdn.nba.com/headshots/nba/latest/1040x760/${playerId}.png`;
}

/**
 * ESPN's team-logo CDN (`https://a.espncdn.com/i/teamlogos/nba/500/<code>.png`)
 * is keyed by a team code that matches nba_api's own 3-letter
 * `TEAM_ABBREVIATION` for every *current* franchise except two real,
 * verified exceptions (`NOP`->`NO`, `UTA`->`UTAH`; every other current-era
 * code was checked directly against the CDN and returned 200).
 *
 * For *historical* franchises, nba_api preserves the period-accurate
 * abbreviation at the time (see docs/superpowers/specs/2026-09-03-full-
 * nba-history-backfill-design.md for the same period-accuracy property in
 * team *names*) -- e.g. this project's own real backfilled data has `VAN`
 * (Vancouver Grizzlies), `SEA` (Seattle SuperSonics), `NJN` (New Jersey
 * Nets), and `CHH` (the original 1988-2002 Charlotte Hornets, a different
 * abbreviation from the current, unrelated Charlotte franchise's `CHA` --
 * confirmed by checking real games in this app's own data). None of these
 * old codes exist on ESPN's CDN, so they're mapped to the current
 * franchise's logo (the same team, for the ones that relocated/renamed --
 * `CHH` is a judgment call: it shows the *current* Hornets' teal logo,
 * which is the branding fans actually associate with "Hornets," even
 * though official record continuity for those 1988-2002 games actually
 * runs through the Pelicans lineage, not the current Hornets).
 */
const ESPN_LOGO_CODE_OVERRIDES: Record<string, string> = {
  VAN: "MEM",
  SEA: "OKC",
  NJN: "BKN",
  CHH: "CHA",
  NOH: "NO",
  NOP: "NO",
  UTA: "UTAH",
};

export function teamLogoUrlFromAbbreviation(abbreviation: string): string {
  const code = ESPN_LOGO_CODE_OVERRIDES[abbreviation] ?? abbreviation;
  return `https://a.espncdn.com/i/teamlogos/nba/500/${code}.png`;
}

/**
 * `games.home_team`/`away_team` are full names (e.g. "Chicago Bulls"), not
 * abbreviations, but the logo CDN needs an abbreviation -- this maps every
 * name this app's own nba_api-sourced games can carry (verified against
 * real backfilled data for 1996-2003; extended with well-documented
 * franchise history for later eras not yet backfilled) back to its
 * abbreviation, then reuses `teamLogoUrlFromAbbreviation`'s overrides.
 */
export const TEAM_NAME_TO_ABBREVIATION: Record<string, string> = {
  "Atlanta Hawks": "ATL",
  "Boston Celtics": "BOS",
  "Brooklyn Nets": "BKN",
  "New Jersey Nets": "NJN",
  "Charlotte Hornets": "CHA",
  "Charlotte Bobcats": "CHA",
  "Chicago Bulls": "CHI",
  "Cleveland Cavaliers": "CLE",
  "Dallas Mavericks": "DAL",
  "Denver Nuggets": "DEN",
  "Detroit Pistons": "DET",
  "Golden State Warriors": "GSW",
  "Houston Rockets": "HOU",
  "Indiana Pacers": "IND",
  "Los Angeles Clippers": "LAC",
  "LA Clippers": "LAC",
  "Los Angeles Lakers": "LAL",
  "Memphis Grizzlies": "MEM",
  "Vancouver Grizzlies": "VAN",
  "Miami Heat": "MIA",
  "Milwaukee Bucks": "MIL",
  "Minnesota Timberwolves": "MIN",
  "New Orleans Pelicans": "NOP",
  "New Orleans Hornets": "NOH",
  "New Orleans/Oklahoma City Hornets": "NOH",
  "New York Knicks": "NYK",
  "Oklahoma City Thunder": "OKC",
  "Seattle SuperSonics": "SEA",
  "Orlando Magic": "ORL",
  "Philadelphia 76ers": "PHI",
  "Phoenix Suns": "PHX",
  "Portland Trail Blazers": "POR",
  "Sacramento Kings": "SAC",
  "San Antonio Spurs": "SAS",
  "Toronto Raptors": "TOR",
  "Utah Jazz": "UTA",
  "Washington Wizards": "WAS",
  "Washington Bullets": "WAS",
};

export function teamLogoUrlFromName(teamName: string): string | null {
  const abbreviation = TEAM_NAME_TO_ABBREVIATION[teamName];
  return abbreviation ? teamLogoUrlFromAbbreviation(abbreviation) : null;
}

/** Every full name `TEAM_NAME_TO_ABBREVIATION` maps to a given abbreviation
 * -- e.g. `namesForAbbreviation("CHA")` returns both "Charlotte Hornets"
 * and "Charlotte Bobcats". Used by the team detail page to ask `GET
 * /games?team=...` (repeatable) for every game under any historical name
 * a franchise has played under, since the Gold `games` table has no
 * team-id column to key on directly (see `api/src/api/routers/games.py`). */
export function namesForAbbreviation(abbreviation: string): string[] {
  return Object.entries(TEAM_NAME_TO_ABBREVIATION)
    .filter(([, abbr]) => abbr === abbreviation)
    .map(([name]) => name);
}

/** The current (2026), display name for each of the 30 active
 * franchises' abbreviations -- the team detail page's header and its
 * `/teams/<abbreviation>` route only ever address a *current* franchise,
 * never a retired historical one, so this is deliberately not derived
 * from `TEAM_NAME_TO_ABBREVIATION` (which has no marked "current" entry
 * where a franchise has more than one historical name, e.g. CHA). */
export const ABBREVIATION_TO_TEAM_NAME: Record<string, string> = {
  ATL: "Atlanta Hawks",
  BOS: "Boston Celtics",
  BKN: "Brooklyn Nets",
  CHA: "Charlotte Hornets",
  CHI: "Chicago Bulls",
  CLE: "Cleveland Cavaliers",
  DAL: "Dallas Mavericks",
  DEN: "Denver Nuggets",
  DET: "Detroit Pistons",
  GSW: "Golden State Warriors",
  HOU: "Houston Rockets",
  IND: "Indiana Pacers",
  LAC: "LA Clippers",
  LAL: "Los Angeles Lakers",
  MEM: "Memphis Grizzlies",
  MIA: "Miami Heat",
  MIL: "Milwaukee Bucks",
  MIN: "Minnesota Timberwolves",
  NOP: "New Orleans Pelicans",
  NYK: "New York Knicks",
  OKC: "Oklahoma City Thunder",
  ORL: "Orlando Magic",
  PHI: "Philadelphia 76ers",
  PHX: "Phoenix Suns",
  POR: "Portland Trail Blazers",
  SAC: "Sacramento Kings",
  SAS: "San Antonio Spurs",
  TOR: "Toronto Raptors",
  UTA: "Utah Jazz",
  WAS: "Washington Wizards",
};

/** Small team badge -- `src === null` (a team name not in the lookup
 * table above) renders nothing rather than a broken image. */
export function TeamLogo({ src, alt }: { src: string | null; alt: string }) {
  if (!src) return null;
  return (
    <Image
      src={src}
      alt={alt}
      width={18}
      height={18}
      unoptimized
      className="size-[18px] shrink-0 object-contain"
    />
  );
}

/** Links to the team detail page (`app/teams/[abbreviation]/page.tsx`).
 * Takes an abbreviation directly (the form already available everywhere
 * this is used -- `PlayerStatRow.team`, or a full name already resolved
 * through `TEAM_NAME_TO_ABBREVIATION`). */
export function TeamLink({
  abbreviation,
  className,
  children,
}: {
  abbreviation: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link href={`/teams/${abbreviation}`} className={className}>
      {children}
    </Link>
  );
}

/** "YYYY-MM-DD" -> "Jan 5, 2026", parsed as a calendar date (no timezone shift). */
export function formatGameDate(dateStr: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return dateStr;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function displayScore(score: number | null): string {
  return score === null || score === undefined ? "–" : String(score);
}

/** Bold green for the winning side, muted red for the losing side. Neutral
 * (no color) if either score is missing or they're tied -- never guesses
 * a winner from incomplete data. */
export function scoreColorClass(
  thisScore: number | null,
  otherScore: number | null
): string {
  if (thisScore === null || otherScore === null || thisScore === otherScore) {
    return "text-muted-foreground";
  }
  return thisScore > otherScore ? "font-bold text-emerald-500" : "font-bold text-red-500/70";
}

type SortableColumn =
  | "player"
  | "points"
  | "rebounds"
  | "assists"
  | "steals"
  | "blocks"
  | "turnovers"
  | "minutes";

/** `minutes_played` is a display string (e.g. "34", already rounded to a
 * whole minute -- see stg_player_game_stats*.sql), or `null` for a
 * DNP/inactive row. Parsed back to a number purely for sorting; `null`
 * (and any unparseable value) sorts last regardless of column. */
function parseMinutesForSort(minutesPlayed: string | null): number | null {
  if (minutesPlayed === null) return null;
  const value = Number(minutesPlayed);
  return Number.isFinite(value) ? value : null;
}

/** Every numeric stat column is typed `number` on `PlayerStatRow`, but a
 * DNP/inactive row's real API response actually sends `null` for these
 * (rendered as a blank cell below) -- so this returns `number | null`
 * despite the type, and callers must not assume non-null. */
function sortValue(row: PlayerStatRow, column: SortableColumn): number | string | null {
  switch (column) {
    case "player": {
      // A roster slot with no resolved player identity at all (both name
      // fields `null` at runtime despite the `string` type -- confirmed
      // against real data, e.g. two Bulls rows in the 1998 Finals Game 6
      // box score) sorts last here too, matching every numeric column's
      // "incomplete row sinks to the bottom" rule -- otherwise the literal
      // string "null null" would sort alphabetically among real names.
      const lastName = row.player_last_name as string | null;
      const firstName = row.player_first_name as string | null;
      if (lastName === null && firstName === null) return null;
      return `${lastName ?? ""} ${firstName ?? ""}`.toLowerCase();
    }
    case "points":
      return row.points as number | null;
    case "rebounds":
      return row.rebounds as number | null;
    case "assists":
      return row.assists as number | null;
    case "steals":
      return row.steals as number | null;
    case "blocks":
      return row.blocks as number | null;
    case "turnovers":
      return row.turnovers as number | null;
    case "minutes":
      return parseMinutesForSort(row.minutes_played);
  }
}

/** Always descending -- a DNP/inactive row (`null` for the sorted column)
 * sorts to the bottom no matter which column is active, rather than
 * competing with real values via a numeric coercion of `null`. */
function compareDescending(a: PlayerStatRow, b: PlayerStatRow, column: SortableColumn): number {
  const aValue = sortValue(a, column);
  const bValue = sortValue(b, column);
  if (aValue === null && bValue === null) return 0;
  if (aValue === null) return 1;
  if (bValue === null) return -1;
  if (typeof aValue === "string" || typeof bValue === "string") {
    return String(bValue).localeCompare(String(aValue));
  }
  return bValue - aValue;
}

function SortableHeader({
  label,
  column,
  activeColumn,
  onSort,
  align = "left",
}: {
  label: string;
  column: SortableColumn;
  activeColumn: SortableColumn;
  onSort: (column: SortableColumn) => void;
  align?: "left" | "right";
}) {
  const isActive = column === activeColumn;
  return (
    <TableHead className={align === "right" ? "text-right" : undefined}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "inline-flex cursor-pointer items-center gap-1 hover:text-foreground",
          align === "right" && "flex-row-reverse",
          isActive ? "font-semibold text-foreground" : "text-muted-foreground"
        )}
      >
        {label}
        {isActive && <ArrowDown aria-hidden="true" className="size-3" />}
      </button>
    </TableHead>
  );
}

export function BoxScoreTable({
  rows,
  showGameContext = false,
}: {
  rows: PlayerStatRow[];
  // The per-game box score card (Explorer) already shows its own
  // date/matchup in the card header, so repeating it per row there would
  // be redundant -- only views spanning many different games (a
  // player-name search, or a player's full game log) need this.
  showGameContext?: boolean;
}) {
  const [sortColumn, setSortColumn] = useState<SortableColumn>("points");
  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => compareDescending(a, b, sortColumn)),
    [rows, sortColumn]
  );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableHeader
            label="Player"
            column="player"
            activeColumn={sortColumn}
            onSort={setSortColumn}
          />
          <TableHead>Team</TableHead>
          {showGameContext && <TableHead>Date</TableHead>}
          {showGameContext && <TableHead>Result</TableHead>}
          <SortableHeader
            label="Pts"
            column="points"
            activeColumn={sortColumn}
            onSort={setSortColumn}
            align="right"
          />
          <SortableHeader
            label="Reb"
            column="rebounds"
            activeColumn={sortColumn}
            onSort={setSortColumn}
            align="right"
          />
          <SortableHeader
            label="Ast"
            column="assists"
            activeColumn={sortColumn}
            onSort={setSortColumn}
            align="right"
          />
          <SortableHeader
            label="Stl"
            column="steals"
            activeColumn={sortColumn}
            onSort={setSortColumn}
            align="right"
          />
          <SortableHeader
            label="Blk"
            column="blocks"
            activeColumn={sortColumn}
            onSort={setSortColumn}
            align="right"
          />
          <SortableHeader
            label="TO"
            column="turnovers"
            activeColumn={sortColumn}
            onSort={setSortColumn}
            align="right"
          />
          <SortableHeader
            label="Min"
            column="minutes"
            activeColumn={sortColumn}
            onSort={setSortColumn}
            align="right"
          />
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedRows.map((row) => (
          <TableRow key={row.stat_id}>
            <TableCell className="font-medium text-foreground">
              <Link
                href={`/players/${row.player_id}`}
                className="flex items-center gap-2 hover:underline"
              >
                <Image
                  src={playerHeadshotUrl(row.player_id)}
                  alt=""
                  width={28}
                  height={28}
                  unoptimized
                  className="size-7 shrink-0 rounded-full object-cover bg-muted"
                />
                <span>
                  {row.player_first_name} {row.player_last_name}
                </span>
              </Link>
            </TableCell>
            <TableCell className="text-muted-foreground">
              <TeamLink
                abbreviation={row.team}
                className="flex items-center gap-1.5 hover:underline"
              >
                <TeamLogo src={teamLogoUrlFromAbbreviation(row.team)} alt="" />
                <span>{row.team}</span>
              </TeamLink>
            </TableCell>
            {showGameContext && (
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {formatGameDate(row.game_date)}
              </TableCell>
            )}
            {showGameContext && (
              <TableCell className="whitespace-nowrap">
                <div className="flex items-center gap-2 text-sm">
                  <TeamLink
                    abbreviation={TEAM_NAME_TO_ABBREVIATION[row.away_team] ?? row.away_team}
                    className={cn(
                      "flex items-center gap-1.5 hover:underline",
                      scoreColorClass(row.away_score, row.home_score)
                    )}
                  >
                    <TeamLogo src={teamLogoUrlFromName(row.away_team)} alt="" />
                    <span>
                      {TEAM_NAME_TO_ABBREVIATION[row.away_team] ?? row.away_team}{" "}
                      {displayScore(row.away_score)}
                    </span>
                  </TeamLink>
                  <span className="text-muted-foreground">@</span>
                  <TeamLink
                    abbreviation={TEAM_NAME_TO_ABBREVIATION[row.home_team] ?? row.home_team}
                    className={cn(
                      "flex items-center gap-1.5 hover:underline",
                      scoreColorClass(row.home_score, row.away_score)
                    )}
                  >
                    <TeamLogo src={teamLogoUrlFromName(row.home_team)} alt="" />
                    <span>
                      {TEAM_NAME_TO_ABBREVIATION[row.home_team] ?? row.home_team}{" "}
                      {displayScore(row.home_score)}
                    </span>
                  </TeamLink>
                </div>
              </TableCell>
            )}
            <TableCell className="text-right font-mono tabular-nums">
              {row.points}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {row.rebounds}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {row.assists}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {row.steals}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {row.blocks}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {row.turnovers}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
              {row.minutes_played ?? "–"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
