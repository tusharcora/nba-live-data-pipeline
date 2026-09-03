"use client";

/**
 * Comfortable/compact information-density preference.
 *
 * This is the module a sibling task's command palette should import to
 * wire up a "Toggle density" command:
 *
 *   import { toggleDensity } from "@/lib/density";
 *   // ...inside a command action handler:
 *   toggleDensity();
 *
 * Persistence goes through `web/lib/local-store.ts` (see that file's header
 * for why this project built its own copy instead of Team B's). The active
 * density is applied as a `data-density` attribute on `<html>`, which
 * `web/app/globals.css` reads to swap spacing custom properties consumed by
 * cards and tables (see the "Density tokens" section of that file).
 */

import { useEffect, useState } from "react";

import { get, set } from "@/lib/local-store";

export type Density = "comfortable" | "compact";

export const DENSITY_STORAGE_KEY = "nba-pipeline:density";
export const DEFAULT_DENSITY: Density = "comfortable";

const DENSITY_CHANGE_EVENT = "nba-pipeline:density-change";

function isDensity(value: unknown): value is Density {
  return value === "comfortable" || value === "compact";
}

function applyDensityAttribute(density: Density): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.setAttribute("data-density", density);
}

/** Reads the current stored density (falls back to "comfortable"). */
export function getDensity(): Density {
  const stored = get<Density>(DENSITY_STORAGE_KEY, DEFAULT_DENSITY);
  return isDensity(stored) ? stored : DEFAULT_DENSITY;
}

/** Persists `density`, applies it to the DOM, and notifies other listeners. */
export function setDensity(density: Density): void {
  set(DENSITY_STORAGE_KEY, density);
  applyDensityAttribute(density);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<Density>(DENSITY_CHANGE_EVENT, { detail: density })
    );
  }
}

/**
 * Flips comfortable <-> compact. This is the single function a command
 * palette entry, a settings toggle, or a keyboard shortcut can call
 * directly — it needs no React context and works from any client-side
 * call site. Returns the new density.
 */
export function toggleDensity(): Density {
  const next: Density = getDensity() === "compact" ? "comfortable" : "compact";
  setDensity(next);
  return next;
}

/**
 * Applies whatever density is currently persisted to the DOM. Call once on
 * mount (see `web/app/layout.tsx`) so a returning visitor's saved
 * preference takes effect. A no-op on the server.
 */
export function initDensity(): void {
  applyDensityAttribute(getDensity());
}

/**
 * React hook for components that need to reactively read (and optionally
 * set) the current density, e.g. a settings toggle switch that should
 * reflect changes made elsewhere (a keyboard shortcut, the command
 * palette). Not required for reading/writing density from a one-off
 * event handler — use `getDensity`/`setDensity`/`toggleDensity` directly
 * for that.
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
