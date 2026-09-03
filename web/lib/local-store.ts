/**
 * Thin, typed `localStorage` wrapper for per-browser personalization
 * (favorite teams, saved searches, dashboard layout, last-visited page,
 * etc.). There is no auth/user-accounts system in this app and none is
 * planned — anything "saved" is best-effort, per-browser state, never
 * synced to the backend.
 *
 * Every operation is wrapped in try/catch and fails open: `localStorage`
 * can throw (private browsing, storage disabled, quota exceeded, a
 * non-browser/SSR environment with no `window`) and a failed read/write
 * here must degrade to "no saved state" rather than crash the page —
 * mirroring the fail-open philosophy in `api/src/api/core/cache.py`
 * (a cache miss/error is never allowed to surface as a request failure).
 *
 * Deliberately kept generic (get/set/remove over an arbitrary JSON-
 * serializable value) rather than shaped around any one feature, since
 * multiple call sites (Historical Explorer favorites/saved searches,
 * home dashboard customization, last-visited-page tracking) share this
 * one wrapper.
 *
 * Callers are responsible for their own SSR/hydration handling (Next.js
 * renders pages on the server first, where `window`/`localStorage` don't
 * exist, and the value read here on the client after mount will usually
 * differ from whatever a component rendered during SSR) — see
 * `app/components/theme-toggle.tsx`'s `useHasMounted` for the pattern
 * this repo uses to avoid a hydration mismatch when a component's output
 * depends on localStorage-backed state.
 */

/** Reads and JSON-parses `key`, returning `fallback` if the key is
 * missing, unparsable, or `localStorage` is unavailable/throws. */
export function get<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** JSON-serializes `value` and writes it to `key`. No-ops silently if
 * `localStorage` is unavailable, throws, or `value` isn't serializable. */
export function set<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Fail open: private browsing / storage disabled / quota exceeded /
    // circular value. The page keeps working with unsaved state.
  }
}

/** Removes `key`. No-ops silently if `localStorage` is unavailable or
 * throws. */
export function remove(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Fail open, same as `set`.
  }
}
