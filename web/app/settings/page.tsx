"use client";

import { useState, useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Laptop, Moon, Sun, Star, Bookmark } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type Density } from "@/lib/density";
import { FONT_CHOICE_OPTIONS } from "@/lib/font-choice";
import { type TextSize } from "@/lib/text-size";
import { useDensity } from "@/lib/use-density";
import { useFontChoice } from "@/lib/use-font-choice";
import { useTextSize } from "@/lib/use-text-size";
import * as localStore from "@/lib/local-store";
import { FAVORITE_TEAMS_KEY, SAVED_SEARCHES_KEY } from "@/app/explorer/page";

const emptySubscribe = () => () => {};

/** True only once the client has hydrated -- every control on this page
 * reads a preference that lives in localStorage/next-themes and would
 * otherwise render a value the server can't know, causing a hydration
 * mismatch. Same `useSyncExternalStore` pattern as `theme-toggle.tsx`
 * and `explorer/page.tsx`'s `useHasMounted`. */
function useHasMounted() {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string; icon?: React.ComponentType<{ className?: string }> }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" className="flex flex-wrap gap-2">
      {options.map(({ value: optionValue, label, icon: Icon }) => {
        const active = optionValue === value;
        return (
          <Button
            key={optionValue}
            type="button"
            role="radio"
            aria-checked={active}
            variant={active ? "default" : "outline"}
            size="sm"
            className="cursor-pointer"
            onClick={() => onChange(optionValue)}
          >
            {Icon && <Icon className="size-3.5" />}
            {label}
          </Button>
        );
      })}
    </div>
  );
}

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Laptop },
] as const;

const TEXT_SIZE_OPTIONS: { value: TextSize; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "large", label: "Large" },
  { value: "larger", label: "Larger" },
];

const DENSITY_OPTIONS: { value: Density; label: string }[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

export default function SettingsPage() {
  const hasMounted = useHasMounted();
  const { theme, setTheme } = useTheme();
  const [textSize, setTextSize] = useTextSize();
  const [density, setDensity] = useDensity();
  const [fontChoice, setFontChoice] = useFontChoice();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Every preference here is saved to this browser only -- there&apos;s no account system, so
          nothing syncs across devices.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>
            Theme, font, text size, and layout density across the whole app.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-foreground">Theme</span>
            {hasMounted ? (
              <SegmentedControl
                options={THEME_OPTIONS}
                value={(theme as (typeof THEME_OPTIONS)[number]["value"]) ?? "system"}
                onChange={setTheme}
              />
            ) : (
              <div className="h-7 w-64 animate-pulse rounded-lg bg-muted" aria-hidden="true" />
            )}
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-foreground">Font</span>
            {hasMounted ? (
              <select
                value={fontChoice}
                onChange={(e) => setFontChoice(e.target.value as typeof fontChoice)}
                className="h-8 w-fit rounded-lg border border-border bg-background px-2.5 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {FONT_CHOICE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <div className="h-8 w-40 animate-pulse rounded-lg bg-muted" aria-hidden="true" />
            )}
            <p className="text-xs text-muted-foreground">
              Every heading, table, and label app-wide switches to this typeface immediately.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-foreground">Text size</span>
            {hasMounted ? (
              <SegmentedControl options={TEXT_SIZE_OPTIONS} value={textSize} onChange={setTextSize} />
            ) : (
              <div className="h-7 w-56 animate-pulse rounded-lg bg-muted" aria-hidden="true" />
            )}
            <p className="text-xs text-muted-foreground">
              Scales every table, card, and label app-wide. Defaults to Large.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-foreground">Density</span>
            {hasMounted ? (
              <SegmentedControl options={DENSITY_OPTIONS} value={density} onChange={setDensity} />
            ) : (
              <div className="h-7 w-48 animate-pulse rounded-lg bg-muted" aria-hidden="true" />
            )}
            <p className="text-xs text-muted-foreground">
              Compact tightens table row height and card padding -- useful for scanning long game
              lists.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your data</CardTitle>
          <CardDescription>
            Favorite teams and saved searches from the Historical Explorer, stored in this
            browser&apos;s local storage.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <DataResetRow
            icon={Star}
            label="Favorite teams"
            storageKey={FAVORITE_TEAMS_KEY}
            itemNoun="team"
          />
          <DataResetRow
            icon={Bookmark}
            label="Saved searches"
            storageKey={SAVED_SEARCHES_KEY}
            itemNoun="search"
          />
        </CardContent>
      </Card>
    </main>
  );
}

function DataResetRow({
  icon: Icon,
  label,
  storageKey,
  itemNoun,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  storageKey: string;
  itemNoun: string;
}) {
  const hasMounted = useHasMounted();
  // Initialized lazily from localStorage on first client render; clicking
  // Clear updates this directly rather than re-reading storage, so the
  // count reflects the click immediately.
  const [count, setCount] = useState(() => localStore.get<unknown[]>(storageKey, []).length);
  const displayCount = hasMounted ? count : 0;

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3">
      <div className="flex items-center gap-2 text-sm">
        <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="text-foreground">{label}</span>
        <span className="text-muted-foreground">
          ({displayCount} {itemNoun}
          {displayCount === 1 ? "" : "s"})
        </span>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="cursor-pointer"
        disabled={!hasMounted || count === 0}
        onClick={() => {
          localStore.remove(storageKey);
          setCount(0);
        }}
      >
        Clear
      </Button>
    </div>
  );
}
