import { SiteHeader } from "@/app/components/site-header";

import { GameFeed } from "./GameFeed";

export default async function GameFeedPage({
  params,
}: {
  params: Promise<{ gameId: string }>;
}) {
  const { gameId } = await params;
  return (
    <div className="flex flex-1 flex-col">
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
        <SiteHeader />
        <GameFeed gameId={gameId} />
      </main>
    </div>
  );
}
