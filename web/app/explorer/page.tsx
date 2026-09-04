"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  CalendarX,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Filter,
  Inbox,
  Search,
  Star,
  TriangleAlert,
  UserRound,
  X,
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
import { FOCUS_RING } from "@/app/components/site-nav";
import {
  BoxScoreTable,
  displayScore,
  formatGameDate,
  scoreColorClass,
  TeamLogo,
  teamLogoUrlFromName,
  type PlayerStatRow,
} from "@/lib/box-score";
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
const PLAYER_RESULTS_PAGE_SIZE = 25;

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
  selectedTeams,
  onToggleFavorite,
  onToggleFilter,
}: {
  teams: string[];
  favoriteTeams: string[];
  selectedTeams: Set<string>;
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
        const isActive = selectedTeams.has(team);
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

/** Player-name search results, 25 rows per page (`PLAYER_RESULTS_PAGE_SIZE`)
 * rather than every game a prolific career has ever shown at once. */
function PaginatedPlayerResults({
  rows,
  page,
  onPageChange,
}: {
  rows: PlayerStatRow[];
  page: number;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(rows.length / PLAYER_RESULTS_PAGE_SIZE));
  // Clamp rather than assume `page` is always in range -- the result set
  // can shrink between renders (a new, smaller search) faster than the
  // page-reset effect in `handleSubmit` runs.
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  const start = (currentPage - 1) * PLAYER_RESULTS_PAGE_SIZE;
  const pageRows = rows.slice(start, start + PLAYER_RESULTS_PAGE_SIZE);

  return (
    <div className="flex flex-col gap-3">
      <BoxScoreTable rows={pageRows} showGameContext />
      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            Showing {start + 1}–{Math.min(start + PLAYER_RESULTS_PAGE_SIZE, rows.length)} of{" "}
            {rows.length}
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={currentPage === 1}
              onClick={() => onPageChange(currentPage - 1)}
            >
              <ChevronLeft aria-hidden="true" className="size-4" />
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {currentPage} of {totalPages}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={currentPage === totalPages}
              onClick={() => onPageChange(currentPage + 1)}
            >
              Next
              <ChevronRight aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </div>
      )}
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

/** Client-side multi-select team filter over the already-fetched games list
 * — no new network request, pure array filtering over `gamesState.result.data`.
 * Built as a plain popover of native checkboxes (not a full ARIA
 * listbox/option widget) so keyboard operability comes for free from native
 * `<input type="checkbox">`/`<label>` semantics rather than a hand-rolled
 * roving-tabindex pattern that's easy to get subtly wrong. Closes on
 * outside-click or Escape. Selected teams are also echoed as removable
 * badges below the trigger — per the ui-ux-pro-max "table filter dropdown"
 * finding on chip-collection reflow, that row uses `flex-wrap` rather than
 * clipping overflow. */
function TeamFilterDropdown({
  teams,
  selected,
  onToggleTeam,
  onClear,
}: {
  teams: string[];
  selected: Set<string>;
  onToggleTeam: (team: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (teams.length === 0) return null;

  const summary =
    selected.size === 0
      ? "All teams"
      : `${selected.size} team${selected.size === 1 ? "" : "s"}`;

  return (
    <div className="flex flex-col gap-2">
      <div ref={containerRef} className="relative w-fit">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn("cursor-pointer gap-1.5", FOCUS_RING)}
          aria-haspopup="true"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
        >
          <Filter aria-hidden="true" className="size-4" />
          Filter by team: {summary}
          <ChevronDown
            aria-hidden="true"
            className={cn("size-3.5 transition-transform", open && "rotate-180")}
          />
        </Button>

        {open && (
          <div className="absolute z-10 mt-2 w-56 rounded-md border border-border bg-popover p-2 shadow-md">
            <div className="flex items-center justify-between px-1 pb-1.5">
              <span
                id="team-filter-heading"
                className="text-xs font-medium text-muted-foreground"
              >
                Filter by team
              </span>
              {selected.size > 0 && (
                <button
                  type="button"
                  onClick={onClear}
                  className={cn(
                    "cursor-pointer rounded-sm text-xs font-medium text-primary hover:underline",
                    FOCUS_RING
                  )}
                >
                  Clear
                </button>
              )}
            </div>
            <div
              role="group"
              aria-labelledby="team-filter-heading"
              className="flex max-h-64 flex-col gap-0.5 overflow-y-auto"
            >
              {teams.map((team) => {
                const checked = selected.has(team);
                const inputId = `team-filter-${team}`;
                return (
                  <div
                    key={team}
                    className="flex items-center gap-2 rounded-sm px-1.5 py-1 hover:bg-muted"
                  >
                    <input
                      id={inputId}
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggleTeam(team)}
                      className={cn(
                        "size-3.5 cursor-pointer rounded-sm border-border",
                        FOCUS_RING
                      )}
                    />
                    <label
                      htmlFor={inputId}
                      className="flex-1 cursor-pointer text-sm text-foreground"
                    >
                      {team}
                    </label>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {Array.from(selected)
            .sort()
            .map((team) => (
              <Badge key={team} variant="secondary" className="gap-1 pr-1">
                {team}
                <button
                  type="button"
                  onClick={() => onToggleTeam(team)}
                  aria-label={`Remove ${team} filter`}
                  className={cn(
                    "cursor-pointer rounded-full p-0.5 hover:bg-muted-foreground/20",
                    FOCUS_RING
                  )}
                >
                  <X aria-hidden="true" className="size-3" />
                </button>
              </Badge>
            ))}
        </div>
      )}
    </div>
  );
}

// Shared styling for the native `<select>` comparison pickers below —
// matches `components/ui/input.tsx`'s sizing/tokens (this project has no
// shadcn Select component installed; a plain native <select> keeps this
// feature dependency-free) plus the shared FOCUS_RING treatment.
const COMPARE_SELECT_CLASSES = cn(
  "flex h-8 w-full min-w-0 cursor-pointer rounded-lg border border-border bg-background px-2.5 py-1 text-sm text-foreground shadow-xs outline-none transition-[color,box-shadow] dark:bg-input/30",
  FOCUS_RING
);

/** "Jan 5, 2026 — BOS @ ATL (105–121)" — a single-line label identifying a
 * game unambiguously in the comparison pickers, reusing the same
 * date/score formatting as the rest of this page. */
function formatGameOptionLabel(game: GameRow): string {
  return `${formatGameDate(game.game_date)} — ${game.away_team} @ ${game.home_team} (${displayScore(
    game.away_score
  )}–${displayScore(game.home_score)})`;
}

/** One side of the side-by-side game comparison. Deliberately limited to
 * fields that actually exist on the Gold `games` table / `GameRow` (final
 * score, teams, date, season, status, postseason) — there is no
 * quarter-by-quarter breakdown anywhere upstream of this table (checked
 * `dbt/models/marts/games.sql` and `dbt/models/staging/stg_games.sql`
 * directly: neither the mart, the staging model, nor its documented
 * balldontlie payload-shape comment has any per-quarter/period column), so
 * building a quarter-by-quarter UI here would mean fabricating a section
 * with nothing real to show. */
function GameComparisonCard({ game }: { game: GameRow }) {
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
        <div className="flex flex-col gap-1.5 font-mono text-sm">
          <div className="flex items-center justify-between gap-2">
            <span
              className={cn(
                "flex min-w-0 items-center gap-1.5 truncate",
                scoreColorClass(game.away_score, game.home_score)
              )}
            >
              <TeamLogo src={teamLogoUrlFromName(game.away_team)} alt="" />
              <span className="truncate">{game.away_team}</span>
            </span>
            <span
              className={cn(
                "text-lg font-semibold tabular-nums",
                scoreColorClass(game.away_score, game.home_score)
              )}
            >
              {displayScore(game.away_score)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span
              className={cn(
                "flex min-w-0 items-center gap-1.5 truncate",
                scoreColorClass(game.home_score, game.away_score)
              )}
            >
              <TeamLogo src={teamLogoUrlFromName(game.home_team)} alt="" />
              <span className="truncate">{game.home_team}</span>
            </span>
            <span
              className={cn(
                "text-lg font-semibold tabular-nums",
                scoreColorClass(game.home_score, game.away_score)
              )}
            >
              {displayScore(game.home_score)}
            </span>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
          <div className="flex flex-col gap-0.5">
            <dt className="font-medium text-foreground">Season</dt>
            <dd>{game.season}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="font-medium text-foreground">Postseason</dt>
            <dd>{game.postseason ? "Yes" : "No"}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

/** Simple side-by-side comparison of two games picked from the already-
 * fetched `games` array — two native `<select>` pickers plus two
 * `GameComparisonCard`s. All client-side over `games`; no new network call.
 * ui-ux-pro-max ("side by side comparison view", `--domain ux`) had no
 * direct hit for that exact query; broadening to "comparison table" /
 * "compare" surfaced only the Responsive/"Table Handling" guideline (tables
 * can overflow on mobile — use horizontal scroll or a card layout instead
 * of a wide table). Applied here by using a two-card grid
 * (`grid-cols-1 sm:grid-cols-2`, stacking on narrow viewports) rather than
 * a single wide comparison table, so nothing needs its own horizontal
 * scroll container on mobile. */
function GameComparisonSection({ games }: { games: GameRow[] }) {
  const [leftId, setLeftId] = useState<string>("");
  const [rightId, setRightId] = useState<string>("");

  const leftGame = useMemo(
    () => games.find((game) => String(game.game_id) === leftId) ?? null,
    [games, leftId]
  );
  const rightGame = useMemo(
    () => games.find((game) => String(game.game_id) === rightId) ?? null,
    [games, rightId]
  );

  const sameGameSelected =
    leftId !== "" && rightId !== "" && leftId === rightId;

  if (games.length < 2) return null;

  return (
    <section aria-label="Compare games" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-medium text-foreground">Compare games</h2>
        <p className="text-sm text-muted-foreground">
          Pick two games from the results above to see their final scores
          side by side.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="compare-game-left"
            className="text-xs font-medium text-muted-foreground"
          >
            Game A
          </label>
          <select
            id="compare-game-left"
            value={leftId}
            onChange={(event) => setLeftId(event.target.value)}
            className={COMPARE_SELECT_CLASSES}
          >
            <option value="">Select a game…</option>
            {games.map((game) => (
              <option key={game.game_id} value={game.game_id}>
                {formatGameOptionLabel(game)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="compare-game-right"
            className="text-xs font-medium text-muted-foreground"
          >
            Game B
          </label>
          <select
            id="compare-game-right"
            value={rightId}
            onChange={(event) => setRightId(event.target.value)}
            className={COMPARE_SELECT_CLASSES}
          >
            <option value="">Select a game…</option>
            {games.map((game) => (
              <option key={game.game_id} value={game.game_id}>
                {formatGameOptionLabel(game)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {sameGameSelected && (
        <p role="alert" className="text-sm text-destructive">
          Pick two different games to compare.
        </p>
      )}

      {leftGame && rightGame && !sameGameSelected && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <GameComparisonCard game={leftGame} />
          <GameComparisonCard game={rightGame} />
        </div>
      )}
    </section>
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
          <div className="flex flex-wrap items-baseline gap-2 font-mono text-sm">
            <TeamLogo src={teamLogoUrlFromName(game.away_team)} alt="" />
            <span className={scoreColorClass(game.away_score, game.home_score)}>
              {game.away_team}
            </span>
            <span
              className={cn(
                "text-lg font-semibold tabular-nums",
                scoreColorClass(game.away_score, game.home_score)
              )}
            >
              {displayScore(game.away_score)}
            </span>
            <span className="text-muted-foreground">@</span>
            <TeamLogo src={teamLogoUrlFromName(game.home_team)} alt="" />
            <span className={scoreColorClass(game.home_score, game.away_score)}>
              {game.home_team}
            </span>
            <span
              className={cn(
                "text-lg font-semibold tabular-nums",
                scoreColorClass(game.home_score, game.away_score)
              )}
            >
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
  // A prolific player's career can span hundreds of games (e.g. Michael
  // Jordan's real backfilled data already has 348 rows) -- shown 25 at a
  // time rather than all at once. Reset to page 1 on every new search
  // (see `handleSubmit`), not carried over from a previous player's
  // result set.
  const [playerResultsPage, setPlayerResultsPage] = useState(1);

  const [expandedGameIds, setExpandedGameIds] = useState<Set<number>>(
    () => new Set()
  );
  // Bumped on every fresh search so `GameComparisonSection` below remounts
  // with its two picker selections cleared — otherwise a select could keep
  // holding a `game_id` value from the previous result set that no longer
  // has a matching `<option>`. Same "a fresh search invalidates prior
  // per-result UI state" idea as the `expandedGameIds`/`boxScores` reset
  // in `handleSubmit` below, just via remount (`key`) since this state
  // lives inside the child component rather than here.
  const [compareResetKey, setCompareResetKey] = useState(0);
  const [boxScores, setBoxScores] = useState<
    Record<number, FetchState<ApiList<PlayerStatRow>> | undefined>
  >({});

  // --- Personalization: favorite teams + saved searches (localStorage) ---
  const hasMounted = useHasMounted();
  const [favoriteTeams, setFavoriteTeams] = useState<string[]>([]);
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

  // Client-side team filter over the already-fetched games list — shared
  // by both the favorite-teams quick-filter row and the general
  // `TeamFilterDropdown` below. (Reconciled at integration time: Team B and
  // Team C each independently built a "filter games by team" mechanism in
  // parallel branches — this single `Set`-based multi-select is now the one
  // source of truth both drive, rather than two competing filter states.)
  // Empty selection means "no filter" (all teams shown), matching this
  // project's established "unfiltered means unfiltered" convention
  // elsewhere (e.g. `/games` with no query params).
  const [selectedTeams, setSelectedTeams] = useState<Set<string>>(
    () => new Set()
  );

  const availableTeams = useMemo(() => {
    if (gamesState.status !== "loaded") return [] as string[];
    const teams = new Set<string>();
    for (const game of gamesState.result.data) {
      teams.add(game.home_team);
      teams.add(game.away_team);
    }
    return Array.from(teams).sort((a, b) => a.localeCompare(b));
  }, [gamesState]);

  // Favorites-first ordering for the quick-filter chip row — purely a
  // display-order concern, independent of which teams are currently
  // selected/filtered.
  const orderedTeams = useMemo(() => {
    const favoriteSet = new Set(favoriteTeams);
    return [...availableTeams].sort((a, b) => {
      const aFav = favoriteSet.has(a);
      const bFav = favoriteSet.has(b);
      if (aFav !== bFav) return aFav ? -1 : 1;
      return a.localeCompare(b);
    });
  }, [availableTeams, favoriteTeams]);

  // A new search can return a different set of teams than the last one —
  // derive an "effective" selection that drops any team no longer present,
  // rather than syncing it back into state via an effect (which would just
  // trigger a second, cascading render for the same result). `selectedTeams`
  // itself is left alone; only this derived view is ever read for filtering
  // or for what's shown as selected.
  const effectiveSelectedTeams = useMemo(() => {
    if (selectedTeams.size === 0) return selectedTeams;
    const availableSet = new Set(availableTeams);
    const filtered = new Set(
      Array.from(selectedTeams).filter((team) => availableSet.has(team))
    );
    return filtered.size === selectedTeams.size ? selectedTeams : filtered;
  }, [selectedTeams, availableTeams]);

  const visibleGames = useMemo(() => {
    if (gamesState.status !== "loaded") return [];
    if (effectiveSelectedTeams.size === 0) return gamesState.result.data;
    return gamesState.result.data.filter(
      (game) =>
        effectiveSelectedTeams.has(game.home_team) ||
        effectiveSelectedTeams.has(game.away_team)
    );
  }, [gamesState, effectiveSelectedTeams]);

  // Toggles a team's membership in the shared `selectedTeams` set — called
  // both by `TeamFilterDropdown`'s checkboxes and by clicking a favorited
  // chip in `FavoriteTeamsRow`, so favoriting and the general dropdown stay
  // in sync (checking a team in one surface is reflected in the other).
  function toggleTeamFilter(team: string) {
    setSelectedTeams((prev) => {
      const next = new Set(prev);
      if (next.has(team)) {
        next.delete(team);
      } else {
        next.add(team);
      }
      return next;
    });
  }

  function toggleFavoriteTeam(team: string) {
    const isFavorite = favoriteTeams.includes(team);
    const next = isFavorite
      ? favoriteTeams.filter((t) => t !== team)
      : [...favoriteTeams, team];
    localStore.set(FAVORITE_TEAMS_KEY, next);
    setFavoriteTeams(next);
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
    setSelectedTeams(new Set());
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
    setPlayerResultsPage(1);
    // A fresh search invalidates any previously-expanded per-game box
    // scores from a prior result set.
    setExpandedGameIds(new Set());
    setBoxScores({});
    setCompareResetKey((key) => key + 1);
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
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6">
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
              selectedTeams={effectiveSelectedTeams}
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

          {gamesState.status === "loaded" && gamesState.result.data.length > 0 && (
            <>
              <TeamFilterDropdown
                teams={availableTeams}
                selected={effectiveSelectedTeams}
                onToggleTeam={toggleTeamFilter}
                onClear={() => setSelectedTeams(new Set())}
              />

              {visibleGames.length === 0 ? (
                <EmptyState
                  icon={<Filter aria-hidden="true" className="size-6 text-muted-foreground" />}
                  title="No games match the selected team filter"
                  message="Clear the team filter or pick a different team to see more games."
                />
              ) : (
                <div className="flex flex-col gap-3">
                  {visibleGames.map((game) => (
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
            </>
          )}
        </section>

        {gamesState.status === "loaded" && (
          <GameComparisonSection key={compareResetKey} games={visibleGames} />
        )}

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
                <PaginatedPlayerResults
                  rows={playerSearchState.result.data}
                  page={playerResultsPage}
                  onPageChange={setPlayerResultsPage}
                />
              )}
          </section>
        )}
      </main>
    </div>
  );
}
