/**
 * Deliberately NOT marked "use client" -- see lib/density.ts's header for
 * why (app/layout.tsx, a Server Component, imports FONT_CHOICE_OPTIONS
 * directly; the reactive hook lives in `lib/use-font-choice.ts` instead).
 * This is what previously crashed with "FONT_CHOICE_OPTIONS.map is not a
 * function" -- a "use client" file's exports resolve to opaque
 * client-reference proxies when accessed from server code, and the fix
 * one level up (just removing "use client") in turn crashed differently:
 * a file importing `useState`/`useEffect` can't be imported into a Server
 * Component's module graph AT ALL, so the hook had to move to its own file.
 *
 * App-wide font-family preference, mirroring `lib/density.ts`'s exact
 * shape (storage key, DOM-attribute application, change event, hook).
 *
 * All seven candidate fonts are loaded once in `app/layout.tsx` (each its
 * own next/font/google instance, each with its own `--font-<id>-raw` CSS
 * variable) and applied to `<html>` as `.variable` classes, so their
 * `@font-face` declarations are always present. The active choice is
 * applied separately as a `data-font` attribute on `<html>`, which
 * `web/app/globals.css` reads to point `--font-mono`/`--font-heading`/
 * `--font-geist-mono` at the selected font's raw variable -- the same "one
 * set of tokens, everything reads from them" approach the text-size
 * preference uses. Body copy (`--font-sans`) is deliberately excluded from
 * this and pinned to a fixed Barlow face instead (see `app/layout.tsx`),
 * matching the "Four Dark Neutrals" reference mockup's own separate
 * display/body faces.
 */

import { get, set } from "@/lib/local-store";

export type FontChoice =
  | "teko"
  | "oswald"
  | "barlow-condensed"
  | "rajdhani"
  | "russo-one"
  | "ibm-plex-mono"
  | "space-mono";

export const FONT_CHOICE_STORAGE_KEY = "nba-pipeline:font";
export const DEFAULT_FONT_CHOICE: FontChoice = "barlow-condensed";

export const FONT_CHOICE_OPTIONS: { value: FontChoice; label: string }[] = [
  { value: "teko", label: "Teko" },
  { value: "oswald", label: "Oswald" },
  { value: "barlow-condensed", label: "Barlow Condensed (default)" },
  { value: "rajdhani", label: "Rajdhani" },
  { value: "russo-one", label: "Russo One" },
  { value: "ibm-plex-mono", label: "IBM Plex Mono" },
  { value: "space-mono", label: "Space Mono" },
];

// Exported so lib/use-font-choice.ts's hook can listen for changes made
// via setFontChoice() from anywhere else in the app.
export const FONT_CHOICE_CHANGE_EVENT = "nba-pipeline:font-choice-change";

export function isFontChoice(value: unknown): value is FontChoice {
  return FONT_CHOICE_OPTIONS.some((option) => option.value === value);
}

function applyFontChoiceAttribute(choice: FontChoice): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.setAttribute("data-font", choice);
}

/** Reads the current stored font choice (falls back to `DEFAULT_FONT_CHOICE`). */
export function getFontChoice(): FontChoice {
  const stored = get<FontChoice>(FONT_CHOICE_STORAGE_KEY, DEFAULT_FONT_CHOICE);
  return isFontChoice(stored) ? stored : DEFAULT_FONT_CHOICE;
}

/** Persists `choice`, applies it to the DOM, and notifies other listeners. */
export function setFontChoice(choice: FontChoice): void {
  set(FONT_CHOICE_STORAGE_KEY, choice);
  applyFontChoiceAttribute(choice);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<FontChoice>(FONT_CHOICE_CHANGE_EVENT, { detail: choice })
    );
  }
}

/** Applies whatever font choice is currently persisted to the DOM. The
 * blocking inline script in `app/layout.tsx` already handles the
 * before-first-paint case; this covers any later re-application. */
export function initFontChoice(): void {
  applyFontChoiceAttribute(getFontChoice());
}
