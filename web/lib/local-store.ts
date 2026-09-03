/**
 * Minimal typed localStorage wrapper.
 *
 * ============================================================================
 * BUILT BY EMPLOYEE D2 (keyboard-shortcuts-and-density), NOT TEAM B.
 * ============================================================================
 * This task depends on Team B's (favorites-and-saved-searches) own
 * `web/lib/local-store.ts`, but Team B's branch had not been merged into
 * `ui-pass/power-user` at the time this task started, so this file did not
 * exist on this branch's base. Per the boss's explicit instruction, this is
 * a from-scratch, deliberately minimal implementation built only to satisfy
 * this task's own need (persisting a density preference) — it is NOT a
 * negotiated shared contract with Team B.
 *
 * THIS FILE WILL LIKELY NEED TO BE DEDUPLICATED / RECONCILED against Team
 * B's own version of `web/lib/local-store.ts` during cross-team integration.
 * Whoever merges the four teams' branches should treat this as a stand-in,
 * diff it against Team B's real version, and keep whichever shape (or a
 * merged shape) is agreed on — do not assume this is final.
 * ============================================================================
 *
 * Shape mirrors the plan's Global Constraints: typed get/set/remove, every
 * operation wrapped in try/catch, JSON-serialized. Mirrors the fail-open
 * philosophy already used in `api/src/api/core/cache.py` — a failed read or
 * write degrades gracefully to "no saved state" rather than throwing, since
 * `localStorage` can throw in private browsing / storage-disabled contexts,
 * and simply doesn't exist during SSR.
 */

export function get<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch {
    // Fail open: unavailable storage, disabled storage, or corrupt JSON all
    // degrade to "no saved state" rather than crashing the page.
    return fallback;
  }
}

export function set<T>(key: string, value: T): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Fail open: e.g. private browsing / storage quota exceeded / storage
    // disabled by the user. Losing the write is preferable to crashing.
  }
}

export function remove(key: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Fail open, same rationale as set().
  }
}
