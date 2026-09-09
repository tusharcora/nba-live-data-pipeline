import Link from "next/link";

import { Separator } from "@/components/ui/separator";
import { isTrustCenterLive } from "@/lib/feature-flags";

import { RecentGamesBoard } from "./components/recent-games-board";
import { SiteHeader } from "./components/site-header";

export default function Home() {
  // Gated by TRUST_CENTER_LIVE (web/lib/feature-flags.ts) -- the "we tell
  // you" copy is a present-tense claim that source_conflicts/schema_change_log/
  // quality_metrics can't back up until the real-data verification pass in
  // docs/PROGRESS.md clears (NBA off-season as of this flag's introduction).
  // Defaults to the safe, forward-looking copy below.
  const trustCenterLive = isTrustCenterLive();

  return (
    <div className="flex flex-1 flex-col">
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6">
        <SiteHeader current="/" />

        <section className="flex flex-col gap-2">
          {trustCenterLive ? (
            <>
              <h2 className="max-w-2xl font-heading text-2xl font-bold tracking-wide text-foreground uppercase sm:text-3xl">
                We tell you when the data disagrees with itself.
              </h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Every score comes from two independent sources. When they
                don&apos;t match, you see it — not a quietly-picked number.{" "}
                <Link href="/quality" className="underline underline-offset-2 hover:text-foreground">
                  See what we&apos;ve caught
                </Link>
                .
              </p>
            </>
          ) : (
            <>
              <h2 className="max-w-2xl font-heading text-2xl font-bold tracking-wide text-foreground uppercase sm:text-3xl">
                Built to catch it when the data disagrees with itself.
              </h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Every score comes from two independent sources, and
                disagreement detection is built into the pipeline.{" "}
                <Link href="/quality" className="underline underline-offset-2 hover:text-foreground">
                  See how it works
                </Link>
                .
              </p>
            </>
          )}
        </section>

        <section aria-label="Recent games">
          <RecentGamesBoard />
        </section>

        <Separator />

        <footer className="flex flex-col gap-3 text-sm text-muted-foreground">
          <p className="max-w-2xl leading-6">
            Two independent sources feed every NBA game through a
            Bronze/Silver/Gold warehouse, and every disagreement between them
            is logged, not silently resolved.
          </p>
          <p>
            Built on Prefect, dbt, FastAPI, and Next.js — a medallion pipeline
            from raw pulls to a reconciled, drift-monitored warehouse.
          </p>
        </footer>
      </main>
    </div>
  );
}
