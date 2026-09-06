# Recent Games board redesign + rule-based commentator

Status: proposed
Author: Tushar (via Claude)
Date: 2026-09-06

## 1. Summary

Replace the homepage's `RecentGamesBoard` (currently historical-only —
every row is always "Final," pulled from the Gold `games` table) with a
single unified board that shows today's scheduled, live, and just-finished
games alongside the historical tail, styled after the reference mockup:
a pulsing "LIVE" indicator, greyed-out finished games, scheduled games
showing tip-off time, a "View Feed" button per row, and a per-row
"updated Ns ago" freshness stamp.

Alongside the visual redesign, add a rule-based **commentator**: one line
of templated text per live game — a detected scoring run
("MIA on a 7-0 run"), a plain leader margin ("LAL leads by 5"), or a
data-quality warning ("Feed stale · nba_stats delayed", "Source conflict
· home_score") — computed from real signals this pipeline already
collects (`live_game_state` time series, `source_conflicts`), not
fabricated for effect. This is a genuine extension of the project's
stated differentiator (drift/reconciliation monitoring), not a bolt-on
gimmick.

This also means retiring the separate `/live` (all-games) page —
`LiveBoard.tsx` and `app/live/page.tsx` are deleted — since the homepage
board now covers what that page was for.

## 2. Non-goals

- No LLM-generated or free-form commentary. Every line comes from a
  fixed, testable template driven by numeric thresholds.
- No persisted commentary history. A per-game commentary log (see §6) is
  session-local, rebuilt from live state as it's observed — not written
  to a new table.
- No changes to `/games/[id]`'s existing behavior or its callers
  (historical explorer, player pages) — it remains the historical
  box-score deep link, untouched by this work.
- No changes to the historical backfill flow or `nba_api`'s non-live
  endpoints. This spec only adds `nba_api`'s **live** scoreboard as a
  third real-time ingestion source.
- Win-probability / predictive modeling is explicitly out of scope
  (tracked separately per `docs/prd.md`'s stretch goals).

## 3. Background: what exists today, and the real gaps

- `RecentGamesBoard` (`web/app/components/recent-games-board.tsx`) reads
  `GET /games` (Gold, dbt-owned, reconciled) — every row is a completed
  historical game. Its own header comment states this was a deliberate
  simplification: the `/live` SSE stream didn't carry team names, so the
  board couldn't honestly render a live row.
- `LiveBoard.tsx` (`app/live/page.tsx`) separately consumes `GET /live`
  (FastAPI `StreamingResponse`, re-streamed by `app/api/live/route.ts`),
  which serves the `live_game_state` Silver table: `game_id`, scores,
  `period`, `clock`, `status`, `source`, `pulled_at` — no team names, no
  scheduled tip-off time.
- Real live sources feeding `live_game_state` today: `balldontlie` and
  `public_feed` (ESPN's unauthenticated scoreboard). **`nba_stats` is
  not a source in this pipeline today** — it's only used for the
  historical `nba_api` backfill. The reference mockup's "nba_stats
  delayed" example doesn't correspond to anything real yet; this spec
  makes it real (§4).
- `source_conflicts` already flags per-field disagreements between two
  sources, but there is no way to query it per `game_id` — only "most
  recent 10 overall," via `GET /quality`.
- There is no scheduled-game tip-off time anywhere in the live pipeline.

## 4. Ingestion & schema changes

### 4.1 New source: `nba_stats`

Add `ingestion/src/ingestion/sources/nba_stats.py`, wrapping
`nba_api.live.nba.endpoints.scoreboard.ScoreBoard()` behind a small
Protocol (matching the existing `GamesPageSource`/`BallDontLieClient`
DI seam) so `live_game_flow` can inject a fake in tests. `nba_api` makes
its own HTTP calls internally (not via `httpx`), so — unlike this
project's other HTTP clients — tests for this source patch the wrapper
object itself, not `httpx.get`. This is a deliberate, documented
deviation from the `httpx.get` mocking convention in the root
`CLAUDE.md`, not an inconsistency to "fix."

`nba_api`'s live scoreboard returns every one of today's games in one
call — scheduled, live, and final — each with team names, a real
`gameTimeUTC`, and an official status code. This makes `nba_stats` the
canonical source for "what games exist today and what's their status";
`balldontlie` and `public_feed` remain secondary reconciliation sources
for score agreement, consistent with the existing primary/secondary
source framing in `docs/prd.md` §07.

`live_game_flow` gains a third pull per run:
`RawPull(source="nba_stats", endpoint="scoreboard", payload=...)`,
extracting one `LiveGameState` row per game the same way the other two
sources already do.

### 4.2 `LiveGameState` schema change

Add three nullable columns to `live_game_state` (hand-written Alembic
migration, verified offline via `alembic upgrade head --sql`, per this
project's convention):

- `home_team: str | None`
- `away_team: str | None`
- `scheduled_start: datetime | None`

Only `nba_stats` rows populate these; `balldontlie`/`public_feed` rows
leave them `NULL`. This keeps the table's existing append-only,
one-row-per-poll shape (matching how `status` is already stored
per-row despite being redundant across polls) rather than introducing a
second table.

### 4.3 Reconciliation

`source_conflicts` detection extends from the current 2-way comparison
(`balldontlie` vs `public_feed`) to pairwise comparison across all three
sources for shared fields (score, status). Same detection code path,
now run over 3 pairs instead of 1.

## 5. API layer

### 5.1 `GET /board` and `GET /board/stream` (new router, `board.py`)

Neither `/games` (Gold-only, other pages depend on its current filter
contract) nor `/live` (live-only, no historical rows) is the right shape
for "the homepage's unified board." A new router serves the merged read
model:

- **`GET /board`** — cached JSON (short TTL, matching `/games`'s
  15s pattern), used for first paint. Computed by:
  1. Grouping today's `live_game_state` rows by `game_id`, taking the
     latest row per source, and merging fields — team names and
     `scheduled_start` from the `nba_stats` row when present, scores
     from whichever source has the most recent `pulled_at`. Row
     `status` is `scheduled` / `live` / `final` derived primarily from
     `nba_stats`'s status code, falling back to the other sources'
     status strings via the existing `isLiveStatus`-style matching if
     `nba_stats` didn't report this game.
  2. Falling back to the Gold `games` table for any game not present in
     today's `live_game_state` set (i.e., the historical tail) — this
     is why older finals don't depend on dbt having run recently.
  3. Returning one list, ordered: live, then final, then scheduled
     within "today," then historical finals by date descending —
     matching the reference mockup's row grouping.
- **`GET /board/stream`** (SSE) — re-streams updates only for today's
  rows (the set that actually changes) on the same
  `DEFAULT_POLL_INTERVAL_SECONDS` cadence `/live` already uses.
  Historical rows are static and are never re-emitted. Replaces
  `GET /live` and its BFF proxy (`app/api/live/route.ts` becomes
  `app/api/board/route.ts` / `app/api/board/stream/route.ts`).

Each row in both responses carries a `commentary` field (§6):
`{ text: string, kind: "conflict" | "stale" | "run" | "leader" } | null`
— `null` for `scheduled`/`final` rows, always populated for `live` rows.

### 5.2 Per-game conflict lookup

`QualityReader` (or a small addition to it) gains a
`recent_conflicts_for_game(game_id, window_seconds)` method, backing the
commentary engine's conflict check (§6) — the missing per-game query
identified in §3.

## 6. Commentary engine

A pure function, `compute_commentary(game_id, recent_states, conflicts)
-> Commentary | None`, in a new module
(`api/src/api/routers/board_commentary.py`). Called once per `live` game
inside `/board`'s merge step and on every SSE emission tick. No new
tables, no persisted state — always recomputed from `live_game_state`
history and `source_conflicts`, the same "fakeable with no live DB"
shape as `quality.py`'s `_latest_per_check`, so it's unit-testable
against constructed rows.

### 6.1 Priority (exactly one line per row; highest wins)

1. **Source conflict** — a `source_conflicts` row for this `game_id`
   detected within `CONFLICT_DISPLAY_WINDOW_SECONDS` (default 300) →
   `"Source conflict · <field_name>"`, `kind: "conflict"`.
2. **Feed stale** — the freshest source's `pulled_at` for this game is
   current, but another source hasn't reported in more than
   `STALE_THRESHOLD_SECONDS` (default 45) → `"Feed stale · <source>
   delayed"`, `kind: "stale"`. This replaces `LiveBoard`'s old 60s
   *connection*-level staleness check with a more honest *per-source,
   per-game* one.
3. **Scoring run** — see §6.2 → `"<TEAM> on a <N>-0 run"`,
   `kind: "run"`.
4. **Leader margin** (fallback) — `"<TEAM> leads by <N>"`, or `"Tied"`
   if scores are equal, `kind: "leader"`.

### 6.2 Run detection

`live_game_state` only holds cumulative score snapshots at poll
granularity, not play-by-play, so a "run" is inferred, not observed —
documented here as an approximation, matching this codebase's existing
"ASSUMED shape" comment convention rather than presenting it as exact.

Algorithm: take the freshest source's rows for this `game_id`,
newest-first; walk backwards accumulating each team's score delta
between consecutive snapshots. The streak breaks at the first snapshot
where the *other* team's score also increased. Sum the still-scoring
team's points over the unbroken streak. If the total is
≥ `MIN_RUN_POINTS` (default 6), emit the run line; otherwise fall
through to the leader-margin default.

### 6.3 Constants

Named and overridable, same style as `LiveBoard`'s
`STALE_THRESHOLD_MS`:

| Constant | Default |
|---|---|
| `MIN_RUN_POINTS` | 6 |
| `STALE_THRESHOLD_SECONDS` | 45 |
| `CONFLICT_DISPLAY_WINDOW_SECONDS` | 300 |

## 7. Frontend

### 7.1 Data fetching (`RecentGamesBoard`)

1. `GET /api/board` once on mount for the full merged list (initial
   paint / loading state).
2. Open an `EventSource` to `GET /api/board/stream`; each message
   upserts the matching row by `game_id` into local state. Historical
   rows below the fold are never patched.
3. On SSE error: keep the last good state, show a visible reconnecting
   indicator — the same posture `LiveBoard` already has today, just
   relocated to this component.

### 7.2 Row rendering

One `BoardGameRow` component, branching on `status`. `LiveBoard`'s
existing `getStatusPresentation`/`isLiveStatus` helpers move out of
`live-status.ts` into a shared location and are reused here rather than
re-derived a third time.

- **Live** — pulsing orange "LIVE" pill + `period`/`clock`; the
  commentary line, colored per its `kind` (conflict = pink, stale =
  amber, run = orange, leader = neutral); "View Feed" button; "Ns ago"
  freshness against the row's latest `pulled_at` (reusing the existing
  `formatFreshness`-style helper already in `box-score.tsx`).
- **Final** — muted "FINAL" badge; greyed team names and scores
  (`text-muted-foreground`); no commentary line; "View Feed" still
  present (routes to the settled box score); freshness still shown.
- **Scheduled** — outline "SCHED" badge; tip-off time converted
  client-side from `scheduled_start` (UTC → local, e.g. "7:30 PM ET");
  em-dash score; no commentary; "View Feed" present; freshness shows
  "—".

### 7.3 New route: `/live/[gameId]`

Replaces the old all-games `/live` page — `app/live/page.tsx` and
`LiveBoard.tsx` are deleted, and every "View Feed" button routes here
with the selected game's id. Renders:

- The live ticker (score/period/clock, same pulsing treatment) for
  `live` games.
- A tip-off countdown instead of a ticker for `scheduled` games.
- The settled box score (reusing the existing `box-score.tsx`
  component) for `final` games, once rows exist.
- An in-session **commentary log**: each time `compute_commentary`'s
  text changes across successive SSE ticks, the client appends it to a
  local list rendered as a scrollable feed. Deliberately ephemeral —
  no persisted history table (§2) — lost on page reload, same scope
  boundary the retiring `LiveBoard` already had.

The existing `/games/[id]` route and its callers are untouched.

### 7.4 Nav cleanup

The `site-header.tsx` comment enumerating pages (`/`, `/live`,
`/quality`, ...) drops `/live` as a standalone nav destination since it
no longer has an all-games view of its own.

## 8. Testing

- **Ingestion**: `nba_stats.py`'s extraction function tested the same
  way `extract_balldontlie_live_states`/`extract_public_feed_live_states`
  are — pure functions over a fixed payload fixture, no network. The
  `ScoreBoard()` wrapper itself is faked via the injected Protocol,
  documented as the one client in this codebase not mocked at the
  `httpx` layer (§4.1).
- **API**: `compute_commentary` gets direct unit tests per priority
  branch (conflict present, stale source, run above/below threshold,
  plain leader, tied) using constructed `LiveGameState`/conflict rows —
  no live DB. `/board`'s merge logic (today's live-set + Gold fallback)
  tested against a fake `GamesReader`/`LiveStateReader` pair, matching
  the existing DI test pattern in `games.py`/`live.py`.
- **DB migration**: the new `live_game_state` columns verified offline
  via `alembic upgrade head --sql` / `alembic downgrade base --sql`.
- **Frontend**: `web/` has no unit test runner today (`package.json`
  only wires `tsc`/`eslint`), so verification follows the existing
  convention — `npx tsc --noEmit`, `npm run lint`, and a manual pass in
  the dev server checking all three row states, the pulsing-live
  treatment, SSE reconnect behavior, and the new `/live/[gameId]`
  route, per this repo's standing rule to exercise UI changes in a
  real browser before calling them done.

## 9. Rollout order

1. DB migration (`live_game_state` columns) — additive, non-breaking.
2. Ingestion: `nba_stats` source + 3-way reconciliation.
3. API: `board.py` router, `/board` + `/board/stream`, per-game
   conflict lookup, `board_commentary.py`.
4. Frontend: `BoardGameRow` + rewritten `RecentGamesBoard`, new
   `/live/[gameId]` route.
5. Delete `app/live/page.tsx`, `LiveBoard.tsx`, `app/api/live/route.ts`,
   and the nav reference, once the new board is confirmed working end
   to end.

Each step is independently shippable and the old `/live` page keeps
working until step 5, so there's no forced big-bang cutover.

## 10. Open risks

- `nba_api`'s live scoreboard endpoint shape is unverified against real
  ingested data, same caveat this codebase already carries for
  `balldontlie`/`public_feed` (`stg_games.sql`'s header comment) — the
  exact field names assumed in `nba_stats.py` need confirming against a
  real response during implementation.
- Run detection is an approximation from cumulative snapshots, not true
  play-by-play (§6.2) — acceptable per this spec's scope, but worth
  restating in code comments so it isn't mistaken for exact play
  tracking later.
- Three-way reconciliation changes `source_conflicts`' volume (more
  pairs compared) — worth a quick sanity check post-rollout that this
  doesn't flood the quality scorecard with noise from `nba_stats`
  disagreeing with the others in ways that aren't meaningful.
