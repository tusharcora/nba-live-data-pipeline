import { SiteHeader } from "@/app/components/site-header";
import { SettingsSection } from "@/app/components/sections/settings-section";

export default function SettingsPage() {
  return (
    <div className="flex flex-1 flex-col">
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
        <SiteHeader current="/settings" />
        <SettingsSection />
      </main>
    </div>
  );
}
