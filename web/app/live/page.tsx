import { SiteHeader } from "@/app/components/site-header";

import LiveBoard from "./LiveBoard";

export default function LivePage() {
  return (
    <div className="flex flex-1 flex-col">
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
        <SiteHeader current="/live" />
        <h1 className="font-heading text-2xl font-bold tracking-wide text-foreground uppercase">
          Live Board
        </h1>
        <LiveBoard />
      </main>
    </div>
  );
}
