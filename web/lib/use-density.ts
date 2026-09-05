"use client";

import { useEffect, useState } from "react";

import {
  DENSITY_CHANGE_EVENT,
  type Density,
  getDensity,
  isDensity,
  setDensity,
} from "@/lib/density";

/**
 * React hook for components that need to reactively read (and optionally
 * set) the current density, e.g. a settings toggle switch that should
 * reflect changes made elsewhere (a keyboard shortcut, the command
 * palette). Not required for reading/writing density from a one-off
 * event handler — use `getDensity`/`setDensity`/`toggleDensity` from
 * `lib/density` directly for that.
 *
 * Split into its own "use client" file, separate from `lib/density.ts`'s
 * plain constants/functions -- see that file's header for why.
 */
export function useDensity(): [Density, (next: Density) => void] {
  const [density, setDensityState] = useState<Density>(() => getDensity());

  useEffect(() => {
    function handleChange(event: Event) {
      const detail = (event as CustomEvent<Density>).detail;
      if (isDensity(detail)) {
        setDensityState(detail);
      }
    }
    window.addEventListener(DENSITY_CHANGE_EVENT, handleChange);
    return () => window.removeEventListener(DENSITY_CHANGE_EVENT, handleChange);
  }, []);

  return [density, setDensity];
}
