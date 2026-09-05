import { SiteHeader } from "@/app/components/site-header";
import { ExplorerSection } from "@/app/components/sections/explorer-section";

export default function ExplorerPage() {
  return (
    <div className="flex flex-1 flex-col">
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
        <SiteHeader current="/explorer" />
        <ExplorerSection />
      </main>
    </div>
  );
}
