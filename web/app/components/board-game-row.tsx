"use client";

import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type BoardGameRow as BoardGameRowData,
  formatFreshness,
  formatScheduledStart,
  getStatusPresentation,
} from "@/lib/board";
import { displayScore, TEAM_NAME_TO_ABBREVIATION, TeamLogo, teamLogoUrlFromName } from "@/lib/box-score";
import { FOCUS_RING } from "@/lib/focus-ring";
import { cn } from "@/lib/utils";

function abbr(teamName: string | null): string {
  if (!teamName) return "—";
  return TEAM_NAME_TO_ABBREVIATION[teamName] ?? teamName;
}

const COMMENTARY_COLOR: Record<string, string> = {
  conflict: "text-pink-600 dark:text-pink-400",
  stale: "text-amber-600 dark:text-amber-500",
  run: "text-amber-600 dark:text-amber-500",
  leader: "text-muted-foreground",
};

function StatusBadge({ status }: { status: BoardGameRowData["status"] }) {
  const presentation = getStatusPresentation(status);
  if (presentation.kind === "live") {
    return (
      <Badge variant="secondary" className="gap-1.5 border-transparent bg-primary text-primary-foreground">
        <span aria-hidden="true" className="relative flex size-1.5">
          <span className="absolute inline-flex size-full rounded-full bg-primary-foreground/70 motion-safe:animate-ping" />
          <span className="relative inline-flex size-1.5 rounded-full bg-primary-foreground" />
        </span>
        {presentation.label}
      </Badge>
    );
  }
  return <Badge variant={presentation.variant}>{presentation.label}</Badge>;
}

export function BoardGameRow({
  game,
  isSelected,
  onSelect,
}: {
  game: BoardGameRowData;
  isSelected?: boolean;
  onSelect?: (gameId: number) => void;
}) {
  const isGreyed = game.status === "final" || game.status === "postponed";
  const showScore = game.status === "live" || game.status === "final";

  return (
    <div
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={onSelect ? () => onSelect(game.game_id) : undefined}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(game.game_id);
              }
            }
          : undefined
      }
      className={cn(
        "grid grid-cols-[80px_1fr_auto] items-center gap-4 border-b border-border px-4 py-3 last:border-b-0",
        isGreyed && "opacity-60",
        onSelect && "cursor-pointer",
        onSelect && FOCUS_RING,
        isSelected && "border-l-2 border-l-amber-600 bg-muted/60 dark:border-l-amber-500"
      )}
    >
      <div className="flex flex-col gap-1">
        <StatusBadge status={game.status} />
        {game.status === "live" && (
          <span className="font-mono text-xs text-muted-foreground">
            {game.period ? `Q${game.period}` : ""}
            {game.clock ? ` · ${game.clock}` : ""}
          </span>
        )}
        {game.status === "scheduled" && (
          <span className="font-mono text-xs text-muted-foreground">
            {formatScheduledStart(game.scheduled_start)}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <TeamLogo src={teamLogoUrlFromName(game.away_team ?? "")} alt="" />
          <span className="flex-1 truncate font-medium">{abbr(game.away_team)}</span>
          {showScore && (
            <span className="font-mono text-lg font-bold tabular-nums">
              {displayScore(game.away_score)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <TeamLogo src={teamLogoUrlFromName(game.home_team ?? "")} alt="" />
          <span className="flex-1 truncate font-medium">{abbr(game.home_team)}</span>
          {showScore && (
            <span className="font-mono text-lg font-bold tabular-nums">
              {displayScore(game.home_score)}
            </span>
          )}
        </div>
        {game.commentary && (
          <span className={cn("font-mono text-xs", COMMENTARY_COLOR[game.commentary.kind])}>
            {game.commentary.text}
          </span>
        )}
      </div>

      <div
        className="flex flex-col items-end gap-1.5"
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          render={<Link href={`/live/${game.game_id}`} />}
          nativeButton={false}
          size="sm"
          variant="ghost"
          aria-label={`View feed for ${abbr(game.away_team)} at ${abbr(game.home_team)}`}
          className={cn("border border-border bg-transparent hover:bg-muted/60", FOCUS_RING)}
        >
          View Feed
        </Button>
        <span className="font-mono text-xs text-muted-foreground">
          {formatFreshness(game.source_pulled_at)}
        </span>
      </div>
    </div>
  );
}

export default BoardGameRow;
