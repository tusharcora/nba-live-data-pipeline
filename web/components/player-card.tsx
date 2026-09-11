"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import {
  formatAverage,
  playerHeadshotUrl,
  TeamLogo,
  teamLogoUrlFromAbbreviation,
  type PlayerStatRow,
} from "@/lib/box-score";
import { computeSeasonAverages } from "@/lib/player-stats";

type ApiList<T> = { data: T[]; count: number };

type FetchState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "no_data" }
  | { status: "loaded"; rows: PlayerStatRow[] };

/**
 * Compact "quick glance" player card -- the content rendered inside
 * `PlayerPopover`. Deliberately reuses `computeSeasonAverages` (see
 * `web/lib/player-stats.ts`) rather than its own math, and the same
 * `/api/players/[id]` BFF route the full `/players/[id]` page already
 * calls, so this never drifts from that page's numbers.
 *
 * `player_game_stats` is empty in production until the historical backfill
 * lands -- this renders an honest "stats not available yet" state instead
 * of blank numbers or a fabricated placeholder.
 */
export function PlayerCard({ playerId }: { playerId: number }) {
  const [state, setState] = useState<FetchState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) setState({ status: "loading" });
    });

    fetch(`/api/players/${playerId}`)
      .then((res) => {
        if (!res.ok) throw new Error("unreachable");
        return res.json();
      })
      .then((data: { playerStats: ApiList<PlayerStatRow> | null }) => {
        if (cancelled) return;
        const rows = data.playerStats?.data ?? [];
        setState(rows.length === 0 ? { status: "no_data" } : { status: "loaded", rows });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });

    return () => {
      cancelled = true;
    };
  }, [playerId]);

  if (state.status === "loading") {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <Skeleton className="size-12 shrink-0 rounded-full" />
          <Skeleton className="h-5 w-32" />
        </div>
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (state.status === "error") {
    return <p className="text-sm text-muted-foreground">Couldn&apos;t load this player.</p>;
  }

  if (state.status === "no_data") {
    return (
      <p className="text-sm text-muted-foreground">
        Stats not available yet for this player (before the historical backfill reaches
        their seasons).
      </p>
    );
  }

  const latest = [...state.rows].sort((a, b) => b.game_date.localeCompare(a.game_date))[0];
  const averages = computeSeasonAverages(state.rows);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Image
          src={playerHeadshotUrl(playerId)}
          alt=""
          width={48}
          height={48}
          unoptimized
          className="size-12 shrink-0 rounded-full bg-muted object-cover"
        />
        <div className="flex flex-col gap-0.5">
          <p className="font-medium text-foreground">
            {latest.player_first_name} {latest.player_last_name}
          </p>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <TeamLogo src={teamLogoUrlFromAbbreviation(latest.team)} alt="" />
            <span>{latest.team}</span>
          </div>
        </div>
      </div>

      <dl className="grid grid-cols-3 gap-2">
        {(
          [
            ["PPG", averages.points],
            ["RPG", averages.rebounds],
            ["APG", averages.assists],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="flex flex-col gap-0.5">
            <dt className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              {label}
            </dt>
            <dd className="font-mono text-sm tabular-nums text-foreground">
              {formatAverage(value)}
            </dd>
          </div>
        ))}
      </dl>

      <Link
        href={`/players/${playerId}`}
        className="text-xs text-amber-600 underline underline-offset-2 dark:text-amber-500"
      >
        Full profile →
      </Link>
    </div>
  );
}

export default PlayerCard;
