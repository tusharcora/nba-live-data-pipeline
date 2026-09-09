"use client";

import { useState, useSyncExternalStore } from "react";
import { Star, Bookmark } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type TextSize } from "@/lib/text-size";
import { useTextSize } from "@/lib/use-text-size";
import * as localStore from "@/lib/local-store";
import { FAVORITE_TEAMS_KEY, SAVED_SEARCHES_KEY } from "@/app/components/sections/explorer-section";

const emptySubscribe = () => () => {};

/** True only once the client has hydrated -- every control on this page
 * reads a preference that lives in localStorage and would otherwise
 * render a value the server can't know, causing a hydration mismatch.
 * Same `useSyncExternalStore` pattern as `explorer-section.tsx`'s
 * `useHasMounted`. */
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
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" className="flex flex-wrap gap-2">
      {options.map(({ value: optionValue, label }) => {
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
            {label}
          </Button>
        );
      })}
    </div>
  );
}

const TEXT_SIZE_OPTIONS: { value: TextSize; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "large", label: "Large" },
  { value: "larger", label: "Larger" },
];

export function SettingsSection() {
  const hasMounted = useHasMounted();
  const [textSize, setTextSize] = useTextSize();

  return (
    <div className="flex w-full max-w-3xl flex-1 flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-bold tracking-wide text-foreground uppercase">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Every preference here is saved to this browser only -- there&apos;s no account system, so
          nothing syncs across devices.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Accessibility</CardTitle>
          <CardDescription>Text size across the whole app.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
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
    </div>
  );
}

export default SettingsSection;

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
