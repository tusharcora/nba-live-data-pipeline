"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowRight, BarChart3, History, Radio, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import * as localStore from "@/lib/local-store";

import { FOCUS_RING } from "./components/site-nav";
import { LAST_VISITED_KEY } from "./components/last-visited-tracker";
import { RecentGamesBoard } from "./components/recent-games-board";

const DESTINATIONS = [
  {
    href: "/live",
    icon: Radio,
    title: "Live Board",
    description: "Today's games, score and clock, pushed to the browser as they happen.",
  },
  {
    href: "/quality",
    icon: BarChart3,
    title: "Data Quality Scorecard",
    description: "Schema-drift timeline, null-rate trends, cross-source agreement.",
  },
  {
    href: "/explorer",
    icon: Search,
    title: "Historical Explorer",
    description: "Search past games by date range and look up a player's box score.",
  },
] as const;

const emptySubscribe = () => () => {};

/**
 * True only once the client has hydrated -- the "Continue" resume button
 * reads `localStorage`, invisible to the server, so this avoids a
 * hydration mismatch by rendering the server-matching default (no banner)
 * until this flips. Same `useSyncExternalStore` pattern as
 * `app/components/theme-toggle.tsx`.
 */
function useHasMounted() {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
}

export default function Home() {
  const hasMounted = useHasMounted();
  const [lastVisited, setLastVisited] = useState<string | null>(null);

  useEffect(() => {
    if (!hasMounted) return;
    Promise.resolve().then(() => {
      setLastVisited(localStore.get<string | null>(LAST_VISITED_KEY, null));
    });
  }, [hasMounted]);

  const continueDestination =
    hasMounted && lastVisited
      ? DESTINATIONS.find((d) => d.href === lastVisited)
      : undefined;

  return (
    <div className="relative isolate flex flex-1 flex-col overflow-hidden">
      {/* Decorative background glow — purely visual, clipped by the parent's overflow-hidden so it can never introduce scroll. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      >
        <div className="absolute -top-32 left-1/4 size-72 rounded-full bg-primary/20 blur-3xl" />
        <div className="absolute top-1/2 -right-24 size-80 rounded-full bg-amber-500/10 blur-3xl" />
      </div>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-12 px-4 py-16 sm:px-6 sm:py-24">
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
              <History aria-hidden="true" data-icon="inline-start" className="size-4" />
              Continue: {continueDestination.title}
              <ArrowRight aria-hidden="true" data-icon="inline-end" className="size-4" />
            </Button>
          )}
        </section>

        <section aria-label="Recent games" className="flex flex-col gap-3">
          <h2 className="text-lg font-medium text-foreground">Recent games</h2>
          <RecentGamesBoard />
        </section>

        <section aria-label="Explore the pipeline" className="flex flex-wrap gap-3">
          {DESTINATIONS.map(({ href, icon: Icon, title, description }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "group flex flex-1 basis-56 items-start gap-3 rounded-xl border border-border bg-card/60 px-4 py-3.5 backdrop-blur-xl transition-colors hover:border-amber-500/40 hover:bg-card",
                FOCUS_RING
              )}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon aria-hidden="true" className="size-4.5" />
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="flex items-center gap-1 text-sm font-medium text-foreground">
                  {title}
                  <ArrowRight
                    aria-hidden="true"
                    className="size-3.5 -translate-x-0.5 opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100"
                  />
                </span>
                <span className="text-xs leading-5 text-muted-foreground">{description}</span>
              </span>
            </Link>
          ))}
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
