/**
 * Deliberately NOT marked "use client" -- see lib/density.ts's header for
 * why (app/layout.tsx, a Server Component, imports constants from this
 * file directly; the reactive hook lives in `lib/use-background-choice.ts`
 * instead).
 *
 * Dark-mode background/neutral-surface preference. Four options --
 * Slate (the original shadcn dark-tech-navy palette), Charcoal (true
 * neutral gray, the default), Graphite (warm neutral), and Espresso
 * (deep warm brown) -- explored first as artifact mockups against a
 * fixed amber accent, then implemented here against this app's real
 * --primary (unchanged) once Charcoal was picked as the new default.
 *
 * Applied as a `data-background` attribute on `<html>`, which
 * `web/app/globals.css` reads via `.dark[data-background="..."]` blocks
 * to override --background/--card/--popover/--muted/--secondary/--accent/
 * --border/--input/--foreground and their *-foreground pairs. Scoped to
 * `.dark` only -- these are dark-neutral concepts with no light-mode
 * equivalent, so light mode is never touched by this preference.
 *
 * Every new palette here is the same lightness or darker than the
 * original Slate values it replaces as the default, which can only
 * improve (never regress) the MASTER.md palette's documented 4.5:1
 * contrast guarantees for the fixed light-colored foreground/destructive
 * colors that sit on top of these surfaces.
 */

import { get, set } from "@/lib/local-store";

export type BackgroundChoice = "slate" | "charcoal" | "graphite" | "espresso";

export const BACKGROUND_CHOICE_STORAGE_KEY = "nba-pipeline:background";
export const DEFAULT_BACKGROUND_CHOICE: BackgroundChoice = "charcoal";

export const BACKGROUND_CHOICE_OPTIONS: { value: BackgroundChoice; label: string }[] = [
  { value: "slate", label: "Slate" },
  { value: "charcoal", label: "Charcoal" },
  { value: "graphite", label: "Graphite" },
  { value: "espresso", label: "Espresso" },
];

// Exported so lib/use-background-choice.ts's hook can listen for changes
// made via setBackgroundChoice() from anywhere else in the app.
export const BACKGROUND_CHOICE_CHANGE_EVENT = "nba-pipeline:background-choice-change";

export function isBackgroundChoice(value: unknown): value is BackgroundChoice {
  return BACKGROUND_CHOICE_OPTIONS.some((option) => option.value === value);
}

function applyBackgroundChoiceAttribute(choice: BackgroundChoice): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.setAttribute("data-background", choice);
}

/** Reads the current stored background choice (falls back to
 * `DEFAULT_BACKGROUND_CHOICE`). */
export function getBackgroundChoice(): BackgroundChoice {
  const stored = get<BackgroundChoice>(BACKGROUND_CHOICE_STORAGE_KEY, DEFAULT_BACKGROUND_CHOICE);
  return isBackgroundChoice(stored) ? stored : DEFAULT_BACKGROUND_CHOICE;
}

/** Persists `choice`, applies it to the DOM, and notifies other listeners. */
export function setBackgroundChoice(choice: BackgroundChoice): void {
  set(BACKGROUND_CHOICE_STORAGE_KEY, choice);
  applyBackgroundChoiceAttribute(choice);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<BackgroundChoice>(BACKGROUND_CHOICE_CHANGE_EVENT, { detail: choice })
    );
  }
}

/** Applies whatever background choice is currently persisted to the DOM.
 * The blocking inline script in `app/layout.tsx` already handles the
 * before-first-paint case; this covers any later re-application. */
export function initBackgroundChoice(): void {
  applyBackgroundChoiceAttribute(getBackgroundChoice());
}
