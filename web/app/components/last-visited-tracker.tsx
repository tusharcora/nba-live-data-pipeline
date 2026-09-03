"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

import * as localStore from "@/lib/local-store";

/** localStorage key for the "last visited page" affordance on the home
 * page (`app/page.tsx`'s "Continue: <Page Name>" card). Exported so the
 * home page can read the same key this writes. */
export const LAST_VISITED_KEY = "home:lastVisitedPage";

/**
 * "Last visited page" is defined narrowly as the most recent of these
 * three top-level destinations — not every route or query-param change,
 * and not sub-states within one of them (e.g. an expanded box score on
 * Explorer doesn't count as a new "visit"). `usePathname()` only changes
 * on an actual route change, and the exact-match check below means a
 * future sub-route (e.g. `/explorer/foo`) wouldn't be recorded either,
 * matching that same narrow definition.
 */
const TRACKED_ROUTES = ["/live", "/quality", "/explorer"] as const;

/**
 * Side-effect-only component (renders nothing) that records the most
 * recent of `/live`, `/quality`, `/explorer` the user navigated to, for
 * the home page's "Continue where you left off" affordance.
 *
 * Mounted once inside `SiteNav` (see `site-nav.tsx`), which is itself
 * rendered above every page from `app/layout.tsx` — so this observes
 * every client-side navigation for the app's lifetime without needing
 * its own place in the layout tree. Kept as its own file rather than
 * inlined into `site-nav.tsx` since it's a distinct concern (persistence
 * side effect vs. nav-bar rendering) that a future page/nav change
 * shouldn't have to wade through.
 */
export function LastVisitedTracker() {
  const pathname = usePathname();

  useEffect(() => {
    if ((TRACKED_ROUTES as readonly string[]).includes(pathname)) {
      localStore.set(LAST_VISITED_KEY, pathname);
    }
  }, [pathname]);

  return null;
}

export default LastVisitedTracker;
