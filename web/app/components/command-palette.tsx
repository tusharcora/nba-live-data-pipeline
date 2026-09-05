"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  Activity,
  BarChart3,
  Gauge,
  Moon,
  Radio,
  Search,
  Sun,
} from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { toggleDensity } from "@/lib/density";
import { useDensity } from "@/lib/use-density";

// Subset of `GameRow` from `app/explorer/page.tsx` — only the fields this
// palette actually renders/searches on. Per the shared-data-contract
// decision made during planning review (to avoid a cross-team collision
// with the sibling "sortable-filterable-tables" work), this fetches games
// straight from the existing `/api/games` BFF route rather than importing
// anything from that sibling team's code.
type GameRow = {
  game_id: number;
  game_date: string;
  home_team: string;
  away_team: string;
};

type GamesFetchState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; games: GameRow[] };

const NAV_ITEMS = [
  { href: "/", label: "Home", icon: Activity },
  { href: "/live", label: "Live Board", icon: Radio },
  { href: "/quality", label: "Data Quality Scorecard", icon: BarChart3 },
  { href: "/explorer", label: "Historical Explorer", icon: Search },
] as const;

/** "YYYY-MM-DD" -> "Jan 5, 2026", parsed as a calendar date (no timezone
 * shift) — same approach as `formatGameDate` in `app/explorer/page.tsx`. */
function formatGameDate(dateStr: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return dateStr;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Global ⌘K / Ctrl+K command palette, mounted once in `app/layout.tsx` so
 * it's reachable from every page. Three sections:
 *
 * - Navigate: the same destinations as `SiteNav`'s `NAV_LINKS`, plus Home.
 * - Actions: theme toggle (reuses the exact `useTheme()` call from
 *   `theme-toggle.tsx` — same `resolvedTheme`/`setTheme` pair, no new
 *   theme-reading mechanism) and a density toggle, wired to Employee D2's
 *   ("keyboard-shortcuts-and-density") `toggleDensity()`/`useDensity()`
 *   from `@/lib/density` (this item started as a disabled stub before
 *   D2's PR merged into this branch — see git history).
 * - Games: fuzzy search over real games, fetched from the existing
 *   `/api/games` BFF route (the same route Explorer's data flows through).
 *   Selecting one navigates to `/explorer?game_id=<id>` — a bare
 *   navigation fallback, since no game-detail affordance to scroll-to/
 *   highlight exists yet on this branch.
 *
 * Per the ui-ux-pro-max "Keyboard Navigation" guideline (Accessibility,
 * High severity — full keyboard operability with visible focus on every
 * operable control), the palette must be entirely keyboard-drivable: ⌘K/
 * Ctrl+K opens it, arrow keys move the highlighted item (native to
 * shadcn's `Command`/`cmdk`), Enter selects, and Escape closes (native to
 * the underlying `Dialog`). No mouse-only affordance exists anywhere here.
 */
export function CommandPalette() {
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const [density] = useDensity();
  const [open, setOpen] = useState(false);
  const [gamesState, setGamesState] = useState<GamesFetchState>({
    status: "loading",
  });

  // Global ⌘K / Ctrl+K listener. The `setOpen` calls below run inside the
  // `keydown` event handler, not synchronously in the effect body itself,
  // so this doesn't trip `react-hooks/set-state-in-effect` (same shape as
  // the fetch-then-setState effects elsewhere in this app — the effect
  // only *registers* something; state updates happen later, in a callback).
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Fetches the games list once, on mount, straight from the `/api/games`
  // BFF route — same pattern as Explorer's initial-load effect: the
  // `useState` initializer above already reflects "loading", and every
  // setState call here lives inside a `.then`/`.catch` callback, never
  // synchronously in the effect body.
  useEffect(() => {
    fetch("/api/games")
      .then((res) => {
        if (!res.ok) throw new Error(`/api/games responded ${res.status}`);
        return res.json();
      })
      .then((json: { data?: GameRow[] }) => {
        setGamesState({ status: "loaded", games: json.data ?? [] });
      })
      .catch(() => {
        setGamesState({ status: "error" });
      });
  }, []);

  function runAndClose(action: () => void) {
    setOpen(false);
    action();
  }

  const isDark = resolvedTheme === "dark";

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Search games or jump to a page"
    >
      <CommandInput placeholder="Search games, pages, or actions..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Navigate">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
            <CommandItem
              key={href}
              value={`navigate ${label}`}
              onSelect={() => runAndClose(() => router.push(href))}
            >
              <Icon aria-hidden="true" />
              <span>{label}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Actions">
          <CommandItem
            value="toggle theme light dark appearance"
            onSelect={() =>
              runAndClose(() => setTheme(isDark ? "light" : "dark"))
            }
          >
            {isDark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
            <span>{isDark ? "Switch to light theme" : "Switch to dark theme"}</span>
          </CommandItem>
          {/*
            Wired to Employee D2's ("keyboard-shortcuts-and-density")
            `toggleDensity()`/`useDensity()` from `@/lib/density`, merged
            into this branch after this component was first built (see
            git history — this item started as a disabled TODO stub before
            D2's PR merged). `useDensity()` gives a reactive read so the
            label reflects the live density even if it was changed
            elsewhere (a keyboard shortcut, another palette invocation).
          */}
          <CommandItem
            value="toggle density compact comfortable"
            onSelect={() => runAndClose(() => toggleDensity())}
          >
            <Gauge aria-hidden="true" />
            <span>
              {density === "compact"
                ? "Switch to comfortable density"
                : "Switch to compact density"}
            </span>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Games">
          {gamesState.status === "loading" && (
            <CommandItem value="games loading" disabled>
              <span>Loading games…</span>
            </CommandItem>
          )}
          {gamesState.status === "loaded" &&
            gamesState.games.map((game) => (
              <CommandItem
                key={game.game_id}
                value={`game ${game.home_team} ${game.away_team} ${formatGameDate(
                  game.game_date
                )}`}
                onSelect={() =>
                  runAndClose(() =>
                    router.push(`/explorer?game_id=${game.game_id}`)
                  )
                }
              >
                <Search aria-hidden="true" />
                <span>
                  {game.away_team} @ {game.home_team}
                </span>
                <CommandShortcut>{formatGameDate(game.game_date)}</CommandShortcut>
              </CommandItem>
            ))}
          {gamesState.status === "error" && (
            <CommandItem value="games unavailable" disabled>
              <span>Couldn&apos;t load games. Try again later.</span>
            </CommandItem>
          )}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

export default CommandPalette;
