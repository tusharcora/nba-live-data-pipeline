"use client";

import type { ReactNode } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PlayerCard } from "@/components/player-card";

/**
 * Click-to-open (not hover, for touch/mobile parity) wrapper that opens a
 * compact `PlayerCard` inline instead of navigating straight to
 * `/players/[id]`. `Popover`'s `modal="trap-focus"` (see
 * `components/ui/popover.tsx`) gives this focus-trap, Escape, and
 * outside-click dismissal, plus focus-return-to-trigger on close, for free.
 */
export function PlayerPopover({
  playerId,
  children,
  className,
}: {
  playerId: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger
        nativeButton
        className={className}
        render={<button type="button" />}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent>
        <PlayerCard playerId={playerId} />
      </PopoverContent>
    </Popover>
  );
}

export default PlayerPopover;
