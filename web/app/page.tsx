"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BarChart3,
  Eye,
  EyeOff,
  History,
  Radio,
  Search,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import * as localStore from "@/lib/local-store";

import { FOCUS_RING } from "./components/site-nav";
import { LAST_VISITED_KEY } from "./components/last-visited-tracker";

const DESTINATIONS = [
  {
    href: "/live",
    icon: Radio,
    title: "Live Board",
    description:
      "Today's games, score and clock, pushed to the browser as they happen.",
    cta: "Open Live Board",
  },
  {
    href: "/quality",
    icon: BarChart3,
    title: "Data Quality Scorecard",
    description:
      "Schema-drift timeline, null-rate trends, and cross-source agreement — the pipeline watching itself.",
    cta: "Open Scorecard",
  },
  {
    href: "/explorer",
    icon: Search,
    title: "Historical Explorer",
    description:
      "Search past games by date range and look up a player's box score across games.",
    cta: "Open Explorer",
  },
] as const;

type DestinationHref = (typeof DESTINATIONS)[number]["href"];

const DEFAULT_ORDER: DestinationHref[] = DESTINATIONS.map((d) => d.href);

// --- Personalization: home dashboard customization (localStorage-only,
// per-browser, no auth/accounts) ---
// See `lib/local-store.ts` for the get/set/remove wrapper this rests on.
const ORDER_KEY = "home:destinationOrder";
const HIDDEN_KEY = "home:hiddenDestinations";

const emptySubscribe = () => () => {};

/**
 * True only once the client has hydrated. Copied from
 * `app/components/theme-toggle.tsx`'s `useHasMounted` (also duplicated in
 * `app/explorer/page.tsx`) rather than shared, since card order/
 * visibility and the "last visited page" banner both live in
 * `localStorage`, invisible to the server — this avoids a hydration
 * mismatch by rendering the server-matching default (full order, nothing
 * hidden, no "Continue" banner) until this flips, via
 * `useSyncExternalStore` rather than a synchronous `setState` in a bare
 * effect body, which this repo's `react-hooks/set-state-in-effect` lint
 * rule forbids.
 */
function useHasMounted() {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
}

/** Validates a persisted order array against the current DESTINATIONS
 * hrefs, so a stale/tampered/missing localStorage value can never
 * produce a duplicate, unknown, or missing destination — any recognized
 * href keeps its stored position, anything unrecognized is dropped, and
 * any destination that's missing from `stored` (freshly added, or never
 * persisted yet) is appended at the end. */
function sanitizeOrder(stored: unknown): DestinationHref[] {
  const known = new Set<string>(DEFAULT_ORDER);
  const valid = Array.isArray(stored)
    ? stored.filter(
        (href): href is DestinationHref =>
          typeof href === "string" && known.has(href)
      )
    : [];
  const deduped = Array.from(new Set(valid));
  const missing = DEFAULT_ORDER.filter((href) => !deduped.includes(href));
  return [...deduped, ...missing];
}

/** Same validation as `sanitizeOrder`, but for the hidden-set: unknown
 * hrefs are dropped, duplicates collapsed, and there's no "fill in the
 * missing ones" step since the default is simply "nothing hidden". */
function sanitizeHidden(stored: unknown): DestinationHref[] {
  const known = new Set<string>(DEFAULT_ORDER);
  const valid = Array.isArray(stored)
    ? stored.filter(
        (href): href is DestinationHref =>
          typeof href === "string" && known.has(href)
      )
    : [];
  return Array.from(new Set(valid));
}

/**
 * Swaps `href` with its visible neighbor in `direction` (-1 = earlier,
 * +1 = later), computing "neighbor" only among *visible* destinations —
 * a hidden card sitting between two visible ones shouldn't block moving
 * them past each other. The swap itself still happens on their absolute
 * positions in the full `order` array, so a hidden destination keeps its
 * own place once it's shown again rather than getting shuffled by moves
 * that happened while it was hidden.
 */
function moveVisible(
  order: DestinationHref[],
  hidden: DestinationHref[],
  href: DestinationHref,
  direction: -1 | 1
): DestinationHref[] {
  const hiddenSet = new Set(hidden);
  const visible = order.filter((h) => !hiddenSet.has(h));
  const fromIndex = visible.indexOf(href);
  const toIndex = fromIndex + direction;
  if (fromIndex === -1 || toIndex < 0 || toIndex >= visible.length) {
    return order;
  }
  const neighbor = visible[toIndex];
  const posA = order.indexOf(href);
  const posB = order.indexOf(neighbor);
  const next = [...order];
  [next[posA], next[posB]] = [next[posB], next[posA]];
  return next;
}

export default function Home() {
  const hasMounted = useHasMounted();
  const [order, setOrder] = useState<DestinationHref[]>(DEFAULT_ORDER);
  const [hidden, setHidden] = useState<DestinationHref[]>([]);
  const [lastVisited, setLastVisited] = useState<string | null>(null);

  // Reads persisted card layout + last-visited-page in after mount. The
  // initial state above already matches what the server rendered (full
  // order, nothing hidden, no banner), so this doesn't itself cause a
  // hydration mismatch — but the setState calls are still deferred into a
  // resolved-microtask `.then()` rather than called synchronously in the
  // effect body, for consistency with the identical constraint documented
  // on the personalization effect in `app/explorer/page.tsx` (this repo's
  // `react-hooks/set-state-in-effect` rule).
  useEffect(() => {
    if (!hasMounted) return;
    Promise.resolve().then(() => {
      setOrder(sanitizeOrder(localStore.get<unknown>(ORDER_KEY, [])));
      setHidden(sanitizeHidden(localStore.get<unknown>(HIDDEN_KEY, [])));
      setLastVisited(localStore.get<string | null>(LAST_VISITED_KEY, null));
    });
  }, [hasMounted]);

  function moveDestination(href: DestinationHref, direction: -1 | 1) {
    const next = moveVisible(order, hidden, href, direction);
    localStore.set(ORDER_KEY, next);
    setOrder(next);
  }

  function toggleHidden(href: DestinationHref) {
    const next = hidden.includes(href)
      ? hidden.filter((h) => h !== href)
      : [...hidden, href];
    localStore.set(HIDDEN_KEY, next);
    setHidden(next);
  }

  const byHref = new Map(DESTINATIONS.map((d) => [d.href, d] as const));
  const hiddenSet = new Set(hidden);
  const visibleOrder = order.filter((href) => !hiddenSet.has(href));
  const hiddenOrder = order.filter((href) => hiddenSet.has(href));

  let continueDestination: (typeof DESTINATIONS)[number] | undefined;
  if (hasMounted && lastVisited) {
    continueDestination = byHref.get(lastVisited as DestinationHref);
  }

  return (
    <div className="relative isolate flex flex-1 flex-col overflow-hidden">
      {/* Decorative background glow — purely visual, clipped by the parent's overflow-hidden so it can never introduce scroll. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      >
        <div className="absolute -top-32 left-1/4 size-72 rounded-full bg-primary/20 blur-3xl" />
        <div className="absolute top-1/2 -right-24 size-80 rounded-full bg-primary/10 blur-3xl" />
      </div>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-16 px-4 py-16 sm:px-6 sm:py-24">
        <section className="flex flex-col items-start gap-5">
          <Badge variant="secondary" className="font-mono uppercase tracking-wide">
            Data engineering portfolio project
          </Badge>
          <h1 className="max-w-2xl text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Boxscore.gg
          </h1>
          <p className="max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
            An end-to-end NBA data pipeline where the portfolio-differentiating
            work is the ingestion, source reconciliation, and drift
            monitoring — not the dashboard on top of it. Two independent
            sources feed the same games through a Bronze/Silver/Gold
            warehouse, and every disagreement between them is logged, not
            silently resolved.
          </p>

          {continueDestination && (
            <Button
              render={<Link href={continueDestination.href} />}
              nativeButton={false}
              variant="secondary"
              className={cn("cursor-pointer", FOCUS_RING)}
            >
              <History
                aria-hidden="true"
                data-icon="inline-start"
                className="size-4"
              />
              Continue: {continueDestination.title}
              <ArrowRight
                aria-hidden="true"
                data-icon="inline-end"
                className="size-4"
              />
            </Button>
          )}
        </section>

        <section aria-label="Explore the pipeline" className="flex flex-col gap-4">
          {visibleOrder.length === 0 ? (
            <div className="flex flex-col items-start gap-1 rounded-xl border border-dashed border-border/60 px-6 py-10 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">
                All three shortcuts below are hidden.
              </p>
              <p>Use the buttons below to bring one back.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {visibleOrder.map((href, index) => {
                const { icon: Icon, title, description, cta } = byHref.get(
                  href
                )!;
                return (
                  <Card
                    key={href}
                    className="border border-border/60 bg-card/60 backdrop-blur-xl transition-all duration-200 hover:border-border hover:shadow-lg motion-safe:hover:-translate-y-0.5"
                  >
                    <CardHeader>
                      <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Icon aria-hidden="true" className="size-5" />
                      </div>
                      <CardTitle className="text-lg">{title}</CardTitle>
                      <CardDescription className="text-sm leading-6">
                        {description}
                      </CardDescription>
                      <CardAction className="flex items-center gap-0.5">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => moveDestination(href, -1)}
                          disabled={index === 0}
                          aria-label={`Move ${title} earlier`}
                          className={cn("cursor-pointer disabled:cursor-not-allowed", FOCUS_RING)}
                        >
                          <ArrowUp aria-hidden="true" className="size-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => moveDestination(href, 1)}
                          disabled={index === visibleOrder.length - 1}
                          aria-label={`Move ${title} later`}
                          className={cn("cursor-pointer disabled:cursor-not-allowed", FOCUS_RING)}
                        >
                          <ArrowDown aria-hidden="true" className="size-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => toggleHidden(href)}
                          aria-label={`Hide ${title}`}
                          className={cn("cursor-pointer", FOCUS_RING)}
                        >
                          <EyeOff aria-hidden="true" className="size-3.5" />
                        </Button>
                      </CardAction>
                    </CardHeader>
                    <CardContent>
                      <Button
                        render={<Link href={href} />}
                        nativeButton={false}
                        className="w-full cursor-pointer sm:w-auto"
                      >
                        {cta}
                        <ArrowRight
                          aria-hidden="true"
                          data-icon="inline-end"
                          className="size-4"
                        />
                      </Button>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

          {hiddenOrder.length > 0 && (
            <div
              role="group"
              aria-label="Hidden shortcuts"
              className="flex flex-wrap items-center gap-2 text-sm"
            >
              <span className="text-muted-foreground">Hidden:</span>
              {hiddenOrder.map((href) => {
                const { title } = byHref.get(href)!;
                return (
                  <Button
                    key={href}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => toggleHidden(href)}
                    className={cn("cursor-pointer", FOCUS_RING)}
                  >
                    <Eye
                      aria-hidden="true"
                      data-icon="inline-start"
                      className="size-3.5"
                    />
                    Show {title}
                  </Button>
                );
              })}
            </div>
          )}
        </section>

        <Separator />

        <footer className="text-sm text-muted-foreground">
          Built on Prefect, dbt, FastAPI, and Next.js — a medallion pipeline
          from raw pulls to a reconciled, drift-monitored warehouse.
        </footer>
      </main>
    </div>
  );
}
