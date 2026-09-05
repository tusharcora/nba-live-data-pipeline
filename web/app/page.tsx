import { Separator } from "@/components/ui/separator";

import { RecentGamesBoard } from "./components/recent-games-board";
import { SiteHeader } from "./components/site-header";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col">
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6">
        <SiteHeader current="/" />

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
