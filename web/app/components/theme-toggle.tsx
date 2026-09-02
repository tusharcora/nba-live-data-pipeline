"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { cn } from "@/lib/utils";

import { FOCUS_RING } from "./site-nav";

const emptySubscribe = () => () => {};

/**
 * True only once the client has hydrated. `next-themes` can't know the
 * resolved theme during SSR (the server has no way to know the visitor's
 * OS preference), so `ThemeToggle` renders a neutral placeholder until
 * this flips, avoiding a hydration mismatch / a flash of the wrong
 * icon-label pairing. Implemented via `useSyncExternalStore` rather than
 * the common `useEffect(() => setMounted(true), [])` idiom, since a
 * synchronous `setState` call in an effect body trips this repo's
 * `react-hooks/set-state-in-effect` lint rule — `useSyncExternalStore`'s
 * client snapshot (`true`) vs. server snapshot (`false`) gives the same
 * one-time flip without ever calling `setState` from an effect.
 */
function useHasMounted() {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
}

/**
 * Light/dark theme toggle for the nav bar. Reads/writes theme via
 * `next-themes`'s `useTheme()`, which flips the `.dark` class on `<html>`
 * (wired up in `app/layout.tsx`'s `ThemeProvider attribute="class"`) —
 * `globals.css` already keys every dark-mode color token off that class,
 * this is just the first thing that ever applies it.
 *
 * The accessible name reflects the *effect* of activating the control
 * ("Switch to light theme" while dark is active, and vice versa) rather
 * than a generic "Toggle theme" label, per WCAG 4.1.2 / the ui-ux-pro-max
 * "ARIA Labels" guideline (icon-only buttons need a real accessible name).
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const hasMounted = useHasMounted();

  if (!hasMounted) {
    return (
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground"
      >
        <Sun className="size-4" />
      </span>
    );
  }

  const isDark = resolvedTheme === "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className={cn(
        "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-200 hover:bg-muted hover:text-foreground",
        FOCUS_RING
      )}
    >
      {isDark ? (
        <Sun aria-hidden="true" className="size-4" />
      ) : (
        <Moon aria-hidden="true" className="size-4" />
      )}
    </button>
  );
}

export default ThemeToggle;
