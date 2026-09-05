/**
 * Deliberately NOT marked "use client" -- see lib/density.ts's header for
 * why (app/layout.tsx, a Server Component, imports constants from this
 * file directly; the reactive hook lives in `lib/use-text-size.ts`
 * instead, since a file importing `useState`/`useEffect` can't be
 * imported into a Server Component's module graph at all).
 *
 * App-wide text-size preference, mirroring `lib/density.ts`'s exact
 * shape (storage key, DOM-attribute application, change event, hook) --
 * see that file's header for the rationale behind each piece.
 *
 * The active size is applied as a `data-text-size` attribute on `<html>`,
 * which `web/app/globals.css` reads to redefine Tailwind's own `--text-*`
 * theme tokens (`--text-sm`, `--text-base`, etc.) via a `--text-scale`
 * multiplier -- since every `text-*` utility class already reads its
 * value from those tokens, this scales all typography app-wide with no
 * per-component changes needed.
 *
 * `DEFAULT_TEXT_SIZE` is `"large"`, not `"normal"` -- the baseline this
 * app now ships with is a step up from stock Tailwind sizing, per an
 * explicit request to make text bigger by default. `"normal"` is still
 * offered as an opt-out on the settings page for anyone who prefers the
 * original, smaller sizing.
 */

import { get, set } from "@/lib/local-store";

export type TextSize = "normal" | "large" | "larger";

export const TEXT_SIZE_STORAGE_KEY = "nba-pipeline:text-size";
export const DEFAULT_TEXT_SIZE: TextSize = "large";

// Exported so lib/use-text-size.ts's hook can listen for changes made via
// setTextSize() from anywhere else in the app.
export const TEXT_SIZE_CHANGE_EVENT = "nba-pipeline:text-size-change";

export function isTextSize(value: unknown): value is TextSize {
  return value === "normal" || value === "large" || value === "larger";
}

function applyTextSizeAttribute(size: TextSize): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.setAttribute("data-text-size", size);
}

/** Reads the current stored text size (falls back to `DEFAULT_TEXT_SIZE`). */
export function getTextSize(): TextSize {
  const stored = get<TextSize>(TEXT_SIZE_STORAGE_KEY, DEFAULT_TEXT_SIZE);
  return isTextSize(stored) ? stored : DEFAULT_TEXT_SIZE;
}

/** Persists `size`, applies it to the DOM, and notifies other listeners. */
export function setTextSize(size: TextSize): void {
  set(TEXT_SIZE_STORAGE_KEY, size);
  applyTextSizeAttribute(size);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<TextSize>(TEXT_SIZE_CHANGE_EVENT, { detail: size })
    );
  }
}

/**
 * Applies whatever text size is currently persisted to the DOM. Call once
 * on mount so a returning visitor's saved preference takes effect (the
 * blocking inline script in `app/layout.tsx` already handles the
 * before-first-paint case; this covers any later re-application).
 */
export function initTextSize(): void {
  applyTextSizeAttribute(getTextSize());
}
