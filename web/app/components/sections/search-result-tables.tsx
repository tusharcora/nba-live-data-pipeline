"use client";

import Image from "next/image";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  BoxScoreTable,
  displayScore,
  formatGameDate,
  playerHeadshotUrl,
  scoreColorClass,
  TeamLink,
  TeamLogo,
  teamLogoUrlFromName,
  TEAM_NAME_TO_ABBREVIATION,
  type GameRow,
} from "@/lib/box-score";
import type { LeadersResultData, SearchResultData } from "@/lib/search-result-types";
import { cn } from "@/lib/utils";

/** Max `GameMatchupCard`s rendered for a `team_games` result -- see the
 * "team_games" case below for why this cap exists. */
const TEAM_GAMES_DISPLAY_LIMIT = 15;

/**
 * A single game's matchup card -- team names/logos, final score, status
 * badge. Built from the same primitives `games/[id]/page.tsx`'s own
 * GameDetail header uses, but is its own small component here (that file
 * is left untouched -- see this task's plan entry for why).
 */
function GameMatchupCard({ game }: { game: GameRow }) {
  const awayAbbreviation = TEAM_NAME_TO_ABBREVIATION[game.away_team] ?? game.away_team;
  const homeAbbreviation = TEAM_NAME_TO_ABBREVIATION[game.home_team] ?? game.home_team;
  return (
    <Card className="gap-3">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="font-geist-mono text-xs font-medium tracking-wide text-muted-foreground">
          {formatGameDate(game.game_date)}
          {game.postseason ? " · Postseason" : ""}
        </CardTitle>
        <Badge variant={game.status.toLowerCase() === "final" ? "secondary" : "outline"}>
          {game.status.charAt(0).toUpperCase() + game.status.slice(1)}
        </Badge>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-2 font-geist-mono text-sm">
          <TeamLink
            abbreviation={awayAbbreviation}
            className={cn(
              "-mx-1 -my-0.5 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-muted",
              scoreColorClass(game.away_score, game.home_score)
            )}
          >
            <TeamLogo src={teamLogoUrlFromName(game.away_team)} alt="" />
            {game.away_team}
          </TeamLink>
          <span
            className={cn(
              "text-lg font-semibold tabular-nums",
              scoreColorClass(game.away_score, game.home_score)
            )}
          >
            {displayScore(game.away_score)}
          </span>
          <span className="text-muted-foreground">@</span>
          <TeamLink
            abbreviation={homeAbbreviation}
            className={cn(
              "-mx-1 -my-0.5 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-muted",
              scoreColorClass(game.home_score, game.away_score)
            )}
          >
            <TeamLogo src={teamLogoUrlFromName(game.home_team)} alt="" />
            {game.home_team}
          </TeamLink>
          <span
            className={cn(
              "text-lg font-semibold tabular-nums",
              scoreColorClass(game.home_score, game.away_score)
            )}
          >
            {displayScore(game.home_score)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/** No existing table in this app renders a ranked leaderboard -- this is a
 * new, small, non-sortable table (the API already returns it pre-ranked by
 * value, per query_tools.py's get_leaders; a client-side re-sort would be
 * pure ceremony for a single stable ordering). */
function LeadersTable({ stat, gameCount, leaders }: LeadersResultData) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        {stat} leaders · {gameCount} game{gameCount === 1 ? "" : "s"}
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">#</TableHead>
            <TableHead>Player</TableHead>
            <TableHead className="text-right">{stat}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {leaders.map((row, index) => (
            <TableRow key={row.player_id}>
              <TableCell className="font-mono tabular-nums text-muted-foreground">
                {index + 1}
              </TableCell>
              <TableCell className="font-medium text-foreground">
                <Link
                  href={`/players/${row.player_id}`}
                  className="-mx-1 -my-0.5 flex items-center gap-2 rounded-md px-1 py-0.5 transition-colors hover:bg-muted hover:underline"
                >
                  <Image
                    src={playerHeadshotUrl(row.player_id)}
                    alt=""
                    width={28}
                    height={28}
                    unoptimized
                    className="size-7 shrink-0 rounded-full object-cover bg-muted"
                  />
                  <span>{row.player_name}</span>
                </Link>
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">{row.value}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Dispatches on `resultData.type` to the right table/card for whichever
 * tool actually answered the question. Renders nothing for `null` (a
 * genuine no-data/ambiguous/error answer never carries resultData -- see
 * search-loop.ts's finalize()). */
export function SearchResultDataView({ resultData }: { resultData: SearchResultData | null }) {
  if (!resultData) return null;

  switch (resultData.type) {
    case "player_stats":
      return <BoxScoreTable rows={resultData.payload.games} showGameContext />;

    case "game_result":
      return (
        <div className="flex flex-col gap-4">
          <GameMatchupCard game={resultData.payload.game} />
          <BoxScoreTable rows={resultData.payload.boxScore} />
        </div>
      );

    case "team_games": {
      // The backend sends up to `DEFAULT_ROWS_LIMIT` (200) games with no
      // `limit` param on get_team_games -- cap the rendered card list so a
      // season-scoped question doesn't stack up to 200 matchup cards (and
      // ~400 remote team-logo images) inside the answer card.
      const games = resultData.payload.games;
      const visibleGames = games.slice(0, TEAM_GAMES_DISPLAY_LIMIT);
      return (
        <div className="flex flex-col gap-3">
          {visibleGames.map((game) => (
            <GameMatchupCard key={game.game_id} game={game} />
          ))}
          {games.length > TEAM_GAMES_DISPLAY_LIMIT && (
            <p className="text-xs text-muted-foreground">
              Showing {TEAM_GAMES_DISPLAY_LIMIT} of {games.length} games
            </p>
          )}
        </div>
      );
    }

    case "leaders":
      return <LeadersTable {...resultData.payload} />;

    default: {
      // Exhaustiveness check: a new SearchResultData variant that isn't
      // handled above fails to compile here, same convention already used
      // in search-section.tsx and search-stream.ts.
      const exhaustiveCheck: never = resultData;
      return exhaustiveCheck;
    }
  }
}
