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
import {
  displayScore,
  formatGameDate,
  parseMinutesPlayed,
  playerHeadshotUrl,
  scoreColorClass,
  TEAM_NAME_TO_ABBREVIATION,
  teamLogoUrlFromAbbreviation,
  teamLogoUrlFromName,
  type PlayerStatRow,
} from "@/lib/team-names";

// Re-exported so existing imports of these (pages, other components) don't
// need to change -- only server-only code (route handlers) must import
// straight from "@/lib/team-names" instead of here, since this module's
// "use client" directive can't be imported into a plain route.ts.
export {
  ABBREVIATION_TO_TEAM_NAME,
  average,
  displayScore,
  formatAverage,
  formatGameDate,
  namesForAbbreviation,
  NBA_GAME_ID_OFFSET,
  parseMinutesPlayed,
  playerHeadshotUrl,
  scoreColorClass,
  TEAM_NAME_TO_ABBREVIATION,
  teamLogoUrlFromAbbreviation,
  teamLogoUrlFromName,
  type GameRow,
  type PlayerStatRow,
} from "@/lib/team-names";

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

type SortableColumn =
  | "player"
  | "points"
  | "rebounds"
  | "assists"
  | "steals"
  | "blocks"
  | "turnovers"
  | "minutes"
  // Not exposed as a clickable header (Date has no SortableHeader below) --
  // only used as the initial default for a `showGameContext` table (player
  // search results, a player's game log), where most-recent-first is the
  // natural order. A single-game box score has no `game_date` column at
  // all, so it stays defaulted to "points" instead.
  | "date";

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
      return parseMinutesPlayed(row.minutes_played);
    case "date":
      // ISO "YYYY-MM-DD" sorts correctly as a plain string (most-recent-
      // first under compareDescending's string branch below).
      return row.game_date;
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
  const [sortColumn, setSortColumn] = useState<SortableColumn>(
    showGameContext ? "date" : "points"
  );
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
                className="flex items-center gap-1.5 font-jetbrains-mono hover:underline"
              >
                <TeamLogo src={teamLogoUrlFromAbbreviation(row.team)} alt="" />
                <span>{row.team}</span>
              </TeamLink>
            </TableCell>
            {showGameContext && (
              <TableCell className="whitespace-nowrap font-jetbrains-mono text-muted-foreground">
                {formatGameDate(row.game_date)}
              </TableCell>
            )}
            {showGameContext && (
              <TableCell className="whitespace-nowrap">
                <div className="flex items-center gap-2 font-jetbrains-mono text-sm">
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
