"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  CalendarX,
  ChevronDown,
  ChevronUp,
  Inbox,
  Search,
  Star,
  TriangleAlert,
  UserRound,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FOCUS_RING } from "@/app/components/site-nav";
import { cn } from "@/lib/utils";
import * as localStore from "@/lib/local-store";

// Response shapes match `GET /games` and the new `GET /player-stats`
// FastAPI endpoints (Employee "games-search-api", week5/historical-explorer,
// already merged) as fanned out by this page's own `/api/explorer` BFF
// route (`app/api/explorer/route.ts`) — see that file's header for the
// exact request/response contract.
type GameRow = {
  game_id: number;
  game_date: string;
  season: number;
  status: string;
  postseason: boolean;
  home_team: string;
  away_team: string;
  home_score: number | null;
  away_score: number | null;
  source_pulled_at: string;
};

type PlayerStatRow = {
  stat_id: number;
  game_id: number;
  player_id: number;
  player_first_name: string;
  player_last_name: string;
  team: string;
  points: number;
  rebounds: number;
  assists: number;
  steals: number;
  blocks: number;
  turnovers: number;
  minutes_played: string | null;
};

type ApiList<T> = { data: T[]; count: number };

type ExplorerResponse = {
  games: ApiList<GameRow> | null;
  playerStats: ApiList<PlayerStatRow> | null;
};

type FetchState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; result: T };

const GAMES_FETCH_ERROR =
  "Couldn't reach the games service. Please try your search again.";
const PLAYER_SEARCH_FETCH_ERROR =
  "Couldn't reach the player stats service. Please try your search again.";
const BOX_SCORE_FETCH_ERROR = "Couldn't load the box score. Try again.";

/** "YYYY-MM-DD" -> "Jan 5, 2026", parsed as a calendar date (no timezone shift). */
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

function prettifyStatus(status: string): string {
  const cleaned = status.replace(/^status[_-]?/i, "").trim();
  if (!cleaned) return "Unknown";
  return cleaned
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function statusBadgeVariant(
  status: string
): "secondary" | "outline" | "default" {
  const normalized = status.toUpperCase();
  if (normalized.includes("FINAL")) return "secondary";
  if (normalized.includes("IN_PROGRESS") || normalized.includes("HALFTIME"))
    return "default";
  return "outline";
}

function displayScore(score: number | null): string {
  return score === null || score === undefined ? "–" : String(score);
}

// --- Personalization (localStorage-only, per-browser, no auth/accounts) ---
// See `lib/local-store.ts` for the get/set/remove wrapper this all rests
// on, and its own header comment for the fail-open contract.

type SavedSearch = {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  playerName: string;
};

const FAVORITE_TEAMS_KEY = "explorer:favoriteTeams";
const SAVED_SEARCHES_KEY = "explorer:savedSearches";

const emptySubscribe = () => () => {};

/**
 * True only once the client has hydrated. Copied from
 * `app/components/theme-toggle.tsx`'s `useHasMounted` rather than
 * reinvented: favorite teams / saved searches live in `localStorage`,
 * which the server can't see, so this page must render a neutral
 * placeholder for that UI (matching what the server rendered) until this
 * flips, avoiding a hydration mismatch. `useSyncExternalStore`'s client
 * snapshot (`true`) vs. server snapshot (`false`) gives a one-time flip
 * without ever calling `setState` synchronously from an effect body,
 * which this repo's `react-hooks/set-state-in-effect` lint rule forbids.
 */
function useHasMounted() {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
}

function generateSavedSearchId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function savedSearchSummary(preset: SavedSearch): string {
  const parts: string[] = [];
  if (preset.startDate || preset.endDate) {
    parts.push(`${preset.startDate || "…"} → ${preset.endDate || "…"}`);
  }
  if (preset.playerName) parts.push(`Player: ${preset.playerName}`);
  return parts.length > 0 ? parts.join(" · ") : "All games, no player filter";
}

/**
 * Favorite-teams quick-filter chip row. Every team seen in the *current*
 * (already-fetched) games list gets a chip; the star toggles that team
 * as a favorite (persisted), and once a team is a favorite its chip
 * becomes clickable to filter the games list below down to just that
 * team, purely client-side, and clickable again to clear the filter.
 * Non-favorited chips are shown (dashed border) so there's a way to
 * discover and favorite a team in the first place, but aren't
 * filter-clickable themselves — favoriting is the deliberate gate, per
 * the "favorite-teams quick-filter" framing of this task.
 *
 * NOTE for whoever reviews the overlap: a separate teammate (C1) is
 * building a general team-filter dropdown on this same Explorer page in
 * a parallel branch. This chip row is a distinct, additive surface
 * (favorites-first quick access) rather than a competing general filter,
 * but the two should likely be reconciled into one coherent filter
 * control when both branches land — see the PR description.
 */
function FavoriteTeamsRow({
  teams,
  favoriteTeams,
  activeTeam,
  onToggleFavorite,
  onToggleFilter,
}: {
  teams: string[];
  favoriteTeams: string[];
  activeTeam: string | null;
  onToggleFavorite: (team: string) => void;
  onToggleFilter: (team: string) => void;
}) {
  if (teams.length === 0) return null;
  const favoriteSet = new Set(favoriteTeams);

  return (
    <div
      role="group"
      aria-label="Favorite teams quick filter"
      className="flex flex-wrap items-center gap-2"
    >
      <span className="text-xs font-medium text-muted-foreground">
        Favorite teams
      </span>
      {teams.map((team) => {
        const isFavorite = favoriteSet.has(team);
        const isActive = activeTeam === team;
        return (
          <span
            key={team}
            className={cn(
              "flex items-center gap-1 rounded-full border py-1 pr-2.5 pl-1 text-xs font-medium transition-colors duration-200",
              isActive
                ? "border-primary bg-primary/10 text-primary"
                : isFavorite
                  ? "border-border bg-muted/50 text-foreground"
                  : "border-dashed border-border text-muted-foreground"
            )}
          >
            <button
              type="button"
              onClick={() => onToggleFavorite(team)}
              aria-pressed={isFavorite}
              aria-label={
                isFavorite
                  ? `Remove ${team} from favorite teams`
                  : `Add ${team} to favorite teams`
              }
              className={cn(
                "flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:text-foreground",
                FOCUS_RING
              )}
            >
              <Star
                aria-hidden="true"
                className={cn(
                  "size-3.5",
                  isFavorite && "fill-primary text-primary"
                )}
              />
            </button>
            <button
              type="button"
              onClick={() => onToggleFilter(team)}
              disabled={!isFavorite}
              aria-pressed={isActive}
              title={
                isFavorite
                  ? `Filter games to ${team}`
                  : `Favorite ${team} to enable quick-filtering`
              }
              className={cn(
                "cursor-pointer whitespace-nowrap rounded-sm disabled:cursor-default",
                FOCUS_RING
              )}
            >
              {team}
            </button>
          </span>
        );
      })}
    </div>
  );
}

/** Save-current-search-as-a-preset form + list of saved presets with
 * load/delete actions. Presets store `{startDate, endDate, playerName}`
 * plus a user-typed label; there is no server-side concept of a "saved
 * search" — this is purely `localStorage`, per browser. */
function SavedSearchesSection({
  hasMounted,
  savedSearches,
  presetLabel,
  onLabelChange,
  onSave,
  onLoad,
  onDelete,
}: {
  hasMounted: boolean;
  savedSearches: SavedSearch[];
  presetLabel: string;
  onLabelChange: (label: string) => void;
  onSave: () => void;
  onLoad: (preset: SavedSearch) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">Saved searches</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
        >
          <div className="flex flex-1 flex-col gap-1.5">
            <label
              htmlFor="preset-label"
              className="text-xs font-medium text-muted-foreground"
            >
              Save current search as
            </label>
            <Input
              id="preset-label"
              type="text"
              placeholder="e.g. LeBron road games this season"
              value={presetLabel}
              onChange={(event) => onLabelChange(event.target.value)}
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            className="cursor-pointer"
            disabled={!presetLabel.trim()}
          >
            Save search
          </Button>
        </form>

        {!hasMounted ? (
          <Skeleton className="h-10 w-full" aria-hidden="true" />
        ) : savedSearches.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No saved searches yet — save your current filters above to come
            back to them later.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {savedSearches.map((preset) => (
              <li
                key={preset.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
              >
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-foreground">
                    {preset.label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {savedSearchSummary(preset)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="cursor-pointer"
                    onClick={() => onLoad(preset)}
                  >
                    Load
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="cursor-pointer text-destructive hover:text-destructive"
                    onClick={() => onDelete(preset.id)}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Calm, deliberate empty state — icon + two-line message, per the
 * LiveBoard/quality-page precedent. Distinct icon+wording per call site so
 * "no games matched" is never confused with "player stats aren't in yet". */
function EmptyState({
  icon,
  title,
  message,
}: {
  icon: React.ReactNode;
  title: string;
  message: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center">
      {icon}
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

/** Loading skeleton shaped like the real game-result list, not a spinner. */
function GamesSkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading games"
      className="flex flex-col gap-3"
    >
      <span className="sr-only">Searching games…</span>
      {[0, 1, 2, 3].map((i) => (
        <Card key={i} aria-hidden="true" className="gap-3">
          <CardHeader className="flex-row items-center justify-between gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </CardHeader>
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-6" />
              <Skeleton className="h-4 w-20" />
            </div>
            <Skeleton className="h-7 w-28 rounded-lg" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function BoxScoreTable({ rows }: { rows: PlayerStatRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Player</TableHead>
          <TableHead>Team</TableHead>
          <TableHead className="text-right">Pts</TableHead>
          <TableHead className="text-right">Reb</TableHead>
          <TableHead className="text-right">Ast</TableHead>
          <TableHead className="text-right">Stl</TableHead>
          <TableHead className="text-right">Blk</TableHead>
          <TableHead className="text-right">TO</TableHead>
          <TableHead className="text-right">Min</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.stat_id}>
            <TableCell className="font-medium text-foreground">
              {row.player_first_name} {row.player_last_name}
            </TableCell>
            <TableCell className="text-muted-foreground">{row.team}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {row.points}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {row.rebounds}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {row.assists}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {row.steals}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {row.blocks}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {row.turnovers}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
              {row.minutes_played ?? "–"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Inline per-game box score section — its own fetch, its own states.
 * The empty state here is deliberately worded differently from "no games
 * matched your search": zero rows here means the game matched fine, it's
 * player_game_stats that hasn't been populated for it yet. */
function BoxScoreSection({
  state,
}: {
  state: FetchState<ApiList<PlayerStatRow>> | undefined;
}) {
  if (!state || state.status === "loading") {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label="Loading box score"
        className="flex flex-col gap-2 border-t border-border pt-3"
      >
        <span className="sr-only">Loading box score…</span>
        <Skeleton className="h-4 w-full" aria-hidden="true" />
        <Skeleton className="h-4 w-full" aria-hidden="true" />
        <Skeleton className="h-4 w-2/3" aria-hidden="true" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <p className="border-t border-border pt-3 text-sm text-destructive">
        {state.message}
      </p>
    );
  }

  if (state.result.data.length === 0) {
    return (
      <div className="border-t border-border pt-3">
        <EmptyState
          icon={<Inbox aria-hidden="true" className="size-5 text-muted-foreground" />}
          title="Player box scores aren't available for this game yet"
          message="The stats-ingestion pipeline hasn't populated player_game_stats for this game yet — check back once that lands."
        />
      </div>
    );
  }

  return (
    <div className="border-t border-border pt-3">
      <BoxScoreTable rows={state.result.data} />
    </div>
  );
}

function GameCard({
  game,
  expanded,
  onToggle,
  boxScoreState,
}: {
  game: GameRow;
  expanded: boolean;
  onToggle: () => void;
  boxScoreState: FetchState<ApiList<PlayerStatRow>> | undefined;
}) {
  return (
    <Card className="gap-3">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="font-mono text-xs font-medium tracking-wide text-muted-foreground">
          {formatGameDate(game.game_date)}
          {game.postseason ? " · Postseason" : ""}
        </CardTitle>
        <CardAction>
          <Badge variant={statusBadgeVariant(game.status)}>
            {prettifyStatus(game.status)}
          </Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-baseline gap-2 font-mono text-sm text-foreground">
            <span>{game.away_team}</span>
            <span className="text-lg font-semibold tabular-nums">
              {displayScore(game.away_score)}
            </span>
            <span className="text-muted-foreground">@</span>
            <span>{game.home_team}</span>
            <span className="text-lg font-semibold tabular-nums">
              {displayScore(game.home_score)}
            </span>
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="cursor-pointer"
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {expanded ? "Hide box score" : "View box score"}
            {expanded ? (
              <ChevronUp aria-hidden="true" data-icon="inline-end" className="size-4" />
            ) : (
              <ChevronDown aria-hidden="true" data-icon="inline-end" className="size-4" />
            )}
          </Button>
        </div>

        {expanded && <BoxScoreSection state={boxScoreState} />}
      </CardContent>
    </Card>
  );
}

async function fetchExplorer(params: URLSearchParams): Promise<ExplorerResponse> {
  const query = params.toString();
  const res = await fetch(`/api/explorer${query ? `?${query}` : ""}`);
  if (!res.ok) {
    throw new Error(`/api/explorer responded ${res.status}`);
  }
  return res.json();
}

export default function ExplorerPage() {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [playerName, setPlayerName] = useState("");

  const [gamesState, setGamesState] = useState<FetchState<ApiList<GameRow>>>({
    status: "loading",
  });
  const [playerSearchState, setPlayerSearchState] = useState<
    FetchState<ApiList<PlayerStatRow>> | null
  >(null);
  const [lastSearchedName, setLastSearchedName] = useState("");

  const [expandedGameIds, setExpandedGameIds] = useState<Set<number>>(
    () => new Set()
  );
  const [boxScores, setBoxScores] = useState<
    Record<number, FetchState<ApiList<PlayerStatRow>> | undefined>
  >({});

  // --- Personalization: favorite teams + saved searches (localStorage) ---
  const hasMounted = useHasMounted();
  const [favoriteTeams, setFavoriteTeams] = useState<string[]>([]);
  const [activeTeamFilter, setActiveTeamFilter] = useState<string | null>(
    null
  );
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [presetLabel, setPresetLabel] = useState("");

  // Reads persisted state in after mount. The initial `useState([])`
  // above already matches what the server rendered (it has no way to see
  // `localStorage`), so this doesn't itself cause a hydration mismatch —
  // but the setState calls are still deferred into a resolved-microtask
  // `.then()` rather than called synchronously in the effect body, for
  // consistency with the same constraint documented on the games-fetch
  // effect above (this repo's `react-hooks/set-state-in-effect` rule).
  useEffect(() => {
    if (!hasMounted) return;
    Promise.resolve().then(() => {
      setFavoriteTeams(localStore.get<string[]>(FAVORITE_TEAMS_KEY, []));
      setSavedSearches(
        localStore.get<SavedSearch[]>(SAVED_SEARCHES_KEY, [])
      );
    });
  }, [hasMounted]);

  const availableTeams = useMemo(() => {
    if (gamesState.status !== "loaded") return [] as string[];
    const teams = new Set<string>();
    for (const game of gamesState.result.data) {
      teams.add(game.home_team);
      teams.add(game.away_team);
    }
    return Array.from(teams).sort((a, b) => a.localeCompare(b));
  }, [gamesState]);

  const orderedTeams = useMemo(() => {
    const favoriteSet = new Set(favoriteTeams);
    return [...availableTeams].sort((a, b) => {
      const aFav = favoriteSet.has(a);
      const bFav = favoriteSet.has(b);
      if (aFav !== bFav) return aFav ? -1 : 1;
      return a.localeCompare(b);
    });
  }, [availableTeams, favoriteTeams]);

  // Client-side only: filters the already-fetched games list down to the
  // active favorite team, if any. No new API/BFF params are added for
  // this — see the PR description's note on the parallel general
  // team-filter surface (Employee C1) for the overlap to reconcile later.
  const displayedGames = useMemo(() => {
    if (gamesState.status !== "loaded") return [];
    if (!activeTeamFilter) return gamesState.result.data;
    return gamesState.result.data.filter(
      (game) =>
        game.home_team === activeTeamFilter ||
        game.away_team === activeTeamFilter
    );
  }, [gamesState, activeTeamFilter]);

  function toggleFavoriteTeam(team: string) {
    const isFavorite = favoriteTeams.includes(team);
    const next = isFavorite
      ? favoriteTeams.filter((t) => t !== team)
      : [...favoriteTeams, team];
    localStore.set(FAVORITE_TEAMS_KEY, next);
    setFavoriteTeams(next);
    if (isFavorite && activeTeamFilter === team) {
      setActiveTeamFilter(null);
    }
  }

  function toggleTeamFilter(team: string) {
    setActiveTeamFilter((prev) => (prev === team ? null : team));
  }

  function saveCurrentSearch() {
    const label = presetLabel.trim();
    if (!label) return;
    const preset: SavedSearch = {
      id: generateSavedSearchId(),
      label,
      startDate,
      endDate,
      playerName,
    };
    const next = [...savedSearches, preset];
    localStore.set(SAVED_SEARCHES_KEY, next);
    setSavedSearches(next);
    setPresetLabel("");
  }

  function deleteSavedSearch(id: string) {
    const next = savedSearches.filter((preset) => preset.id !== id);
    localStore.set(SAVED_SEARCHES_KEY, next);
    setSavedSearches(next);
  }

  function loadSavedSearch(preset: SavedSearch) {
    setStartDate(preset.startDate);
    setEndDate(preset.endDate);
    setPlayerName(preset.playerName);
    setActiveTeamFilter(null);
    setGamesState({ status: "loading" });
    setPlayerSearchState(
      preset.playerName.trim() ? { status: "loading" } : null
    );
    setExpandedGameIds(new Set());
    setBoxScores({});
    performSearch(preset.startDate, preset.endDate, preset.playerName);
  }

  const dateRangeInvalid =
    startDate !== "" && endDate !== "" && startDate > endDate;

  // Fires the fetch and, once it resolves, writes the loaded/error result
  // state. Deliberately does NOT synchronously set any "loading" state at
  // the top (before the `await`) — that reset lives in `handleSubmit`
  // instead, an event handler, so this function stays safe to call
  // directly from the mount effect below without a synchronous setState
  // inside the effect body (see LiveBoard.tsx's onmessage/onerror callbacks
  // for the same "setState only after the async gap" shape).
  async function performSearch(
    nextStartDate: string,
    nextEndDate: string,
    nextPlayerName: string
  ) {
    const trimmedName = nextPlayerName.trim();

    const params = new URLSearchParams();
    if (nextStartDate) params.set("start_date", nextStartDate);
    if (nextEndDate) params.set("end_date", nextEndDate);
    if (trimmedName) params.set("player_name", trimmedName);

    try {
      const data = await fetchExplorer(params);
      setLastSearchedName(trimmedName);
      setGamesState({
        status: "loaded",
        result: data.games ?? { data: [], count: 0 },
      });
      setPlayerSearchState(
        trimmedName
          ? { status: "loaded", result: data.playerStats ?? { data: [], count: 0 } }
          : null
      );
    } catch {
      setLastSearchedName(trimmedName);
      setGamesState({ status: "error", message: GAMES_FETCH_ERROR });
      setPlayerSearchState(
        trimmedName ? { status: "error", message: PLAYER_SEARCH_FETCH_ERROR } : null
      );
    }
  }

  // Initial load: most recent 20 games, no filters — so the page shows a
  // furnished results view before the user interacts with the form. The
  // `gamesState`/`playerSearchState` useState initializers already reflect
  // this "loading, no player search yet" starting point, so no reset is
  // needed here — and unlike `handleSubmit`, this runs inside an effect, so
  // the setState calls are kept inside `.then`/`.catch` callback literals
  // (same shape as LiveBoard.tsx's `onmessage`/`onerror`) rather than going
  // through the shared `performSearch` async function directly, so the
  // effect body itself never calls setState synchronously.
  useEffect(() => {
    fetchExplorer(new URLSearchParams())
      .then((data) => {
        setGamesState({
          status: "loaded",
          result: data.games ?? { data: [], count: 0 },
        });
      })
      .catch(() => {
        setGamesState({ status: "error", message: GAMES_FETCH_ERROR });
      });
  }, []);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (dateRangeInvalid) return;
    setGamesState({ status: "loading" });
    setPlayerSearchState(playerName.trim() ? { status: "loading" } : null);
    // A fresh search invalidates any previously-expanded per-game box
    // scores from a prior result set.
    setExpandedGameIds(new Set());
    setBoxScores({});
    performSearch(startDate, endDate, playerName);
  }

  async function loadBoxScore(gameId: number) {
    setBoxScores((prev) => ({ ...prev, [gameId]: { status: "loading" } }));
    try {
      const params = new URLSearchParams({ game_id: String(gameId) });
      const data = await fetchExplorer(params);
      setBoxScores((prev) => ({
        ...prev,
        [gameId]: {
          status: "loaded",
          result: data.playerStats ?? { data: [], count: 0 },
        },
      }));
    } catch {
      setBoxScores((prev) => ({
        ...prev,
        [gameId]: { status: "error", message: BOX_SCORE_FETCH_ERROR },
      }));
    }
  }

  function toggleBoxScore(gameId: number) {
    setExpandedGameIds((prev) => {
      const next = new Set(prev);
      if (next.has(gameId)) {
        next.delete(gameId);
      } else {
        next.add(gameId);
        if (!boxScores[gameId]) {
          loadBoxScore(gameId);
        }
      }
      return next;
    });
  }

  return (
    <div className="flex flex-1 flex-col font-sans">
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Historical Explorer
          </h1>
          <p className="text-sm text-muted-foreground">
            Search past games by date range, and look up a player&apos;s box
            score across games.
          </p>
        </div>

        <Card>
          <CardContent>
            <form
              onSubmit={handleSubmit}
              className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:items-end lg:grid-cols-[1fr_1fr_1.4fr_auto]"
            >
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="start-date"
                  className="text-xs font-medium text-muted-foreground"
                >
                  From
                </label>
                <Input
                  id="start-date"
                  type="date"
                  value={startDate}
                  max={endDate || undefined}
                  aria-invalid={dateRangeInvalid || undefined}
                  onChange={(event) => setStartDate(event.target.value)}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="end-date"
                  className="text-xs font-medium text-muted-foreground"
                >
                  To
                </label>
                <Input
                  id="end-date"
                  type="date"
                  value={endDate}
                  min={startDate || undefined}
                  aria-invalid={dateRangeInvalid || undefined}
                  onChange={(event) => setEndDate(event.target.value)}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="player-name"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Player name
                </label>
                <Input
                  id="player-name"
                  type="text"
                  placeholder="e.g. LeBron James"
                  value={playerName}
                  onChange={(event) => setPlayerName(event.target.value)}
                />
              </div>

              <Button
                type="submit"
                className="cursor-pointer sm:col-span-2 lg:col-span-1"
                disabled={dateRangeInvalid}
              >
                Search
                <Search aria-hidden="true" data-icon="inline-end" className="size-4" />
              </Button>

              {dateRangeInvalid && (
                <p
                  role="alert"
                  className="text-sm text-destructive sm:col-span-2 lg:col-span-4"
                >
                  Start date must be on or before end date.
                </p>
              )}
            </form>
          </CardContent>
        </Card>

        <SavedSearchesSection
          hasMounted={hasMounted}
          savedSearches={savedSearches}
          presetLabel={presetLabel}
          onLabelChange={setPresetLabel}
          onSave={saveCurrentSearch}
          onLoad={loadSavedSearch}
          onDelete={deleteSavedSearch}
        />

        <section aria-label="Games" className="flex flex-col gap-3">
          <h2 className="text-lg font-medium text-foreground">Games</h2>

          {hasMounted && (
            <FavoriteTeamsRow
              teams={orderedTeams}
              favoriteTeams={favoriteTeams}
              activeTeam={activeTeamFilter}
              onToggleFavorite={toggleFavoriteTeam}
              onToggleFilter={toggleTeamFilter}
            />
          )}

          {gamesState.status === "loading" && <GamesSkeleton />}

          {gamesState.status === "error" && (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>Couldn&apos;t load games</AlertTitle>
              <AlertDescription>{gamesState.message}</AlertDescription>
            </Alert>
          )}

          {gamesState.status === "loaded" && gamesState.result.data.length === 0 && (
            <EmptyState
              icon={<CalendarX aria-hidden="true" className="size-6 text-muted-foreground" />}
              title="No games matched your search"
              message="Try widening the date range or clearing the filters to see more games."
            />
          )}

          {gamesState.status === "loaded" &&
            gamesState.result.data.length > 0 &&
            displayedGames.length === 0 && (
              <EmptyState
                icon={<CalendarX aria-hidden="true" className="size-6 text-muted-foreground" />}
                title={`No ${activeTeamFilter ?? ""} games in this list`}
                message="Clear the favorite-team filter above to see the rest of the search results."
              />
            )}

          {gamesState.status === "loaded" && displayedGames.length > 0 && (
            <div className="flex flex-col gap-3">
              {displayedGames.map((game) => (
                <GameCard
                  key={game.game_id}
                  game={game}
                  expanded={expandedGameIds.has(game.game_id)}
                  onToggle={() => toggleBoxScore(game.game_id)}
                  boxScoreState={boxScores[game.game_id]}
                />
              ))}
            </div>
          )}
        </section>

        {playerSearchState && (
          <section aria-label="Player search results" className="flex flex-col gap-3">
            <h2 className="text-lg font-medium text-foreground">
              Player stats for &ldquo;{lastSearchedName}&rdquo;
            </h2>

            {playerSearchState.status === "loading" && (
              <div
                role="status"
                aria-live="polite"
                aria-label="Searching player stats"
                className="flex flex-col gap-2"
              >
                <span className="sr-only">Searching player stats…</span>
                <Skeleton className="h-10 w-full" aria-hidden="true" />
                <Skeleton className="h-10 w-full" aria-hidden="true" />
              </div>
            )}

            {playerSearchState.status === "error" && (
              <Alert variant="destructive">
                <TriangleAlert aria-hidden="true" />
                <AlertTitle>Couldn&apos;t load player stats</AlertTitle>
                <AlertDescription>{playerSearchState.message}</AlertDescription>
              </Alert>
            )}

            {playerSearchState.status === "loaded" &&
              playerSearchState.result.data.length === 0 && (
                <EmptyState
                  icon={<UserRound aria-hidden="true" className="size-6 text-muted-foreground" />}
                  title={`No player box scores found for "${lastSearchedName}" yet`}
                  message="Player-level stats are still being backfilled by the ingestion pipeline — this is expected until that lands, not an error."
                />
              )}

            {playerSearchState.status === "loaded" &&
              playerSearchState.result.data.length > 0 && (
                <BoxScoreTable rows={playerSearchState.result.data} />
              )}
          </section>
        )}
      </main>
    </div>
  );
}
