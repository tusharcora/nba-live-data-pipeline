/**
 * Shared focus-visible ring treatment, used across custom interactive
 * elements app-wide (buttons, links, table sort headers, filter chips,
 * etc.) for a consistent, visible keyboard-focus indicator.
 *
 * Originally defined in `app/components/site-nav.tsx` (the now-removed top
 * nav bar) and imported from there by several unrelated components. Moved
 * to this plain, dependency-free module so those importers don't depend on
 * a nav-bar component that no longer exists.
 */
export const FOCUS_RING =
  "outline-none border border-transparent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
