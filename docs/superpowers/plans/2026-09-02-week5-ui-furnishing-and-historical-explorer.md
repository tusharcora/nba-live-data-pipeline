# Week 5 Implementation Plan — UI Furnishing & Historical Explorer

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development — one fresh specialized subagent ("employee") per task below, reviewed and merged by a "boss" subagent per team before human sign-off, exactly as executed for Weeks 1-4 and the UI modernization pass. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/prd.md` §12 Week 5 against the actual gaps found by auditing the codebase — not a generic checklist. Two real gaps were found before scoping this plan and are now in scope (per human decision, 2026-09-02):

1. `player_game_stats` has zero rows in real Postgres, and it isn't a "hasn't run yet" problem — there is no ingestion path at all. `BallDontLieClient` only implements `get_games_pages()`; `backfill_flow` only ever calls the games endpoint. The dbt `stg_player_game_stats`/`player_game_stats` models were built in Week 1 against a documented-but-never-implemented `/stats` shape. Historical Explorer's "player box scores" requirement has no data without this.
2. The win-probability stretch model (§10) is **explicitly cut from this week** — no real time-series training data exists (0 live-poll runs have ever produced `LiveGameState` snapshots; only 26 historical games from a 3-day backfill window). This is deferred, not abandoned — the human wants to expand on it once `live_game_flow` has run for real during actual game windows. Do not build any part of it this week.

**Architecture:** Three boss teams, fully parallel. Team A (backend/ingestion) has no dependency on the other two. Team B (foundation UX — theme, stale-state, a11y, mobile) touches only existing pages and has no dependency on Team A or C. Team C (Historical Explorer) builds against the Gold schema that already exists today (`games`, `player_game_stats` — both real dbt models, `player_game_stats` is just empty until Team A's ingestion runs) — it does **not** need to wait for Team A to merge; the box-score section will render an empty state until real stats data exists, same as any other genuinely-empty-for-now data.

**Tech Stack:** No new backend dependencies. Frontend: `next-themes` (new dependency — tiny, standard library for a persisted, `prefers-color-scheme`-respecting light/dark toggle; nothing like it exists today — `.dark` is a real CSS class in `globals.css` but nothing in the app ever applies it).

**Spec:** `docs/prd.md` §10 (stretch model — explicitly NOT building this week, cited only so employees know why it's absent), §11 (Frontend & the "modern, furnished" bar — the "fully furnished checklist" is the acceptance bar for Team B), §12 Week 5 bullets.

## Global Constraints

- No live Postgres/Redis/network in employee sandboxes — same as every prior week. Verify with fakes/mocks/offline checks (`dbt parse --no-partial-parse`, `dbt compile --no-populate-cache`, mocked `httpx`). The human (this orchestrating session) has live infra on this machine and will do the live verification pass after each team merges, same pattern as Week 4.
- Every existing test suite (204 tests as of `main` post-Week-4) must keep passing.
- Follow `CLAUDE.md`'s Prefect flow convention exactly: new flow parameters needing test fakes must be `@runtime_checkable` `Protocol`s, never a bare `Protocol` or a concrete-class annotation — Prefect builds a Pydantic parameter schema from type hints at decoration time and will crash at import or reject fakes otherwise.
- `raw_pulls` is append-only — any new staging model must de-duplicate via `row_number() over (partition by <id> order by pulled_at desc)`, matching `stg_games`/`stg_player_game_stats`'s existing pattern.
- Employee branch names use a hyphen after the boss name (`week5/stats-ingestion-client-and-flow`, not a nested slash) — same git ref constraint as every prior week.
- Do not build any win-probability / prediction-drift-logging code this week — it's explicitly deferred (see Goal above).

---

## Team A: `week5/stats-ingestion` (2 employees)

### Employee A1: `client-and-flow`

**Files:** Modify `ingestion/src/ingestion/sources/balldontlie.py`. Create: `ingestion/src/ingestion/flows/backfill_stats_flow.py`. Test: `ingestion/tests/test_balldontlie_stats.py` (new), `ingestion/tests/test_backfill_stats_flow.py` (new).

**Task:**
1. Read `ingestion/src/ingestion/sources/balldontlie.py`'s existing `get_games_pages(date: str) -> Iterator[dict]` and its pagination handling (`meta.next_cursor`) before writing anything — the stats method must follow the exact same pagination contract, just against balldontlie's `/stats` endpoint (fetch the real endpoint docs — `https://docs.balldontlie.io` — for the exact query param name(s) it uses to filter by date/game, since `stg_player_game_stats.sql`'s header comment documents an *assumed* shape that has never been checked against the real API). Add `get_stats_pages(date: str) -> Iterator[dict]` to `BallDontLieClient`, reusing the existing `_get()` helper and pagination loop structure.
2. Write `ingestion/tests/test_balldontlie_stats.py` mocking `httpx.get` (never a real network call, per `CLAUDE.md`) across at least: a single page of results, a multi-page response via `meta.next_cursor`, and an empty result set.
3. Create `ingestion/src/ingestion/flows/backfill_stats_flow.py` mirroring `backfill_flow.py`'s structure: a new `@runtime_checkable` `StatsPageSource` Protocol (`get_stats_pages(self, date: str) -> Iterator[dict]`) alongside the existing `RawPullSink`/`CheckpointStore` Protocols (reuse those two as-is — a stats backfill still just writes `RawPull` rows and checkpoints), a distinct checkpoint `flow_name` (e.g. `"backfill_stats"`, never share a row with the games backfill's `"backfill"` checkpoint — they must be independently resumable). Read `backfill_flow.py` in full before writing this; don't guess at the resumability logic, copy its actual checkpoint-read/advance pattern.
4. Write `ingestion/tests/test_backfill_stats_flow.py` using fakes for all three Protocols (same fake-building pattern as `ingestion/tests/test_backfill_flow.py` — check that file for the existing fake classes before writing new ones from scratch), proving: a fresh run with no prior checkpoint pulls from the beginning, a resumed run continues from the checkpoint, and each page's raw payload is written via the sink unmodified (Bronze is a raw capture layer, no transformation belongs here).

**Skills for this task:** superpowers:test-driven-development for both new test files — write the failing test before the implementation in each case. superpowers:systematic-debugging if the real `/stats` endpoint's actual response shape doesn't match `stg_player_game_stats.sql`'s current assumption (flag this explicitly for Employee A2 rather than silently reshaping the client's output to match a possibly-wrong staging model).

### Employee A2: `dbt-stats-verification-and-docs`

**Files:** Modify `dbt/models/staging/stg_player_game_stats.sql` (header comment + column extraction paths if wrong), `dbt/models/marts/player_game_stats.sql`/`.yml` if needed. Read (don't modify unless a real mismatch is found): `db/src/db/models.py`, `db/migrations/versions/`.

**Task:**
1. Once Employee A1's branch has a real `/stats` payload shape (coordinate via the shared `week5/stats-ingestion` boss branch — read A1's merged PR diff, specifically any real balldontlie API response sample captured in A1's test fixtures), compare it field-by-field against `stg_player_game_stats.sql`'s current JSONB extraction paths (`payload->>'stat_id'`, etc. — read the file's own header comment, which documents the *assumed* shape from Week 1). Fix any mismatched field names/paths.
2. Update `stg_player_game_stats.sql`'s header comment: it currently says the shape is "not yet validated against real ingested data" (per `CLAUDE.md`'s standing caveat) — once you've confirmed it against A1's real client output, update the comment to state it's now backed by a real ingestion path, and note explicitly that it still hasn't been run against a live Postgres/dbt build in this sandbox (that's the human's job, same as every prior week's dbt verification).
3. Run `dbt parse --no-partial-parse` and `dbt compile --no-populate-cache` (per `CLAUDE.md` — never plain `dbt compile`, it opens a live connection) to confirm the DAG still validates and the compiled SQL in `target/compiled/` looks correct for the (possibly-updated) staging model.
4. If `db/src/db/models.py`'s `RawPull` model or any Meta table needs a change to support this — it shouldn't, `raw_pulls` is a generic `(source, endpoint, payload)` capture table — confirm this by reading the model before assuming; if a real gap is found, stop and flag it to the boss rather than improvising a schema change outside this task's scope.

**Skills for this task:** superpowers:systematic-debugging for reconciling the assumed vs. real `/stats` shape — this is exactly the kind of "looked right by inspection, wrong against real data" bug `CLAUDE.md` warns about for the `/games` endpoint (which A1/A2's Week 1 counterparts already hit once).

---

## Team B: `week5/foundation-ux` (2 employees)

### Employee B1: `theme-toggle-and-stale-state`

**Files:** Modify `web/package.json` (add `next-themes`), `web/app/layout.tsx`, `web/app/components/site-nav.tsx`, `web/app/live/LiveBoard.tsx`. Create: `web/app/components/theme-toggle.tsx`.

**Task:**
1. Add `next-themes` as a real dependency (`npm install next-themes` from `web/`). Wrap `RootLayout`'s children in `next-themes`'s `ThemeProvider` (`attribute="class"` — `globals.css` already keys dark-mode styles off a `.dark` class selector, confirm this by reading `globals.css` before wiring anything, `defaultTheme="system"`, `enableSystem`). This is the first time anything actually toggles the `.dark` class — today the CSS exists but nothing ever applies it.
2. Create `web/app/components/theme-toggle.tsx`: a small client component (sun/moon icon button from `lucide-react`, already a dependency — check `site-nav.tsx`'s imports for the exact usage pattern) using `next-themes`'s `useTheme()` hook, with a visible focus ring matching `site-nav.tsx`'s existing `FOCUS_RING` constant (reuse it, don't redefine), and an accessible name via `aria-label` that reflects the *current* theme (e.g. `aria-label="Switch to light theme"` when dark is active) rather than a generic "Toggle theme" label — this is a real WCAG requirement (the control's accessible name should describe its effect), not a nice-to-have.
3. Add the toggle to `site-nav.tsx`'s nav bar, in the flex row alongside `NAV_LINKS` — don't restructure the existing nav layout, just add one more flex child.
4. Add an explicit **stale** state to `LiveBoard.tsx`, distinct from the existing hard-error state (`LiveBoardError`, shown when the `EventSource` itself errors) and the existing loading/empty states: if the connection is `"open"` but no message has arrived in over 60 seconds, show a non-destructive stale indicator (e.g. a muted-tone `Alert` or inline banner reading "No update in over a minute — the feed may be delayed" with the actual elapsed time) without tearing down the currently-rendered game cards. Implement via a `setInterval` comparing `Date.now()` against a `lastMessageAt` ref/state updated in `source.onmessage`; clear the interval on unmount alongside the existing `source.close()` cleanup.

**Skills for this task:** Use the `ui-ux-pro-max` skill — query `"theme toggle accessible label" --domain ux` and `"live badge count screen reader" --domain ux` (the latter is directly relevant to the stale-state announcement: it must not spam screen readers the same way the existing `GameStatusBadge` deliberately avoids `aria-live` on every ~5s tick) before implementing. superpowers:verification-before-completion — `npx tsc --noEmit` and `npm run lint` must both stay clean (per `CLAUDE.md`'s web commands); you cannot run a browser in this sandbox, so state explicitly in your PR that the actual toggle behavior and stale-timer countdown need a real browser check (the human will do this, same pattern as every prior UI-facing PR in this project).

### Employee B2: `accessibility-and-mobile-audit`

**Files:** Modify `web/app/quality/page.tsx`, `web/app/live/LiveBoard.tsx`, `web/app/components/site-nav.tsx`, `web/app/globals.css` as needed. No new files expected unless a genuine structural gap is found (e.g. a mobile-specific table treatment).

**Task:**
1. Use the `ui-ux-pro-max` skill for each concern before touching code — don't rely on unaided judgment for an accessibility pass: query `"keyboard focus modal" --domain ux`, `"focus not obscured" --domain ux`, and `"badge chip label wraps" --domain ux`, then a stack-specific query `"table overflow mobile" --stack html-tailwind` for the responsive-table concern in step 3.
2. Audit every interactive element across `site-nav.tsx`, `LiveBoard.tsx`, and `quality/page.tsx` for a visible focus state. `site-nav.tsx` already has a `FOCUS_RING` constant applied to its own links — confirm it's *also* applied (or an equivalent visible ring exists) on every other focusable element added since the UI modernization pass (the theme toggle from B1 will land after this task starts — coordinate via the shared `week5/foundation-ux` boss branch, or audit it as a fast follow-up once B1 merges into the boss branch, whichever the boss directs).
3. `quality/page.tsx`'s schema-change and conflicts tables (`Table`/`TableRow`/`TableCell` from shadcn) — check them at a 375px viewport width (iPhone SE-class, the narrowest common real device) for horizontal overflow or truncated/unreadable cells. If real overflow exists, wrap the table in a horizontally-scrollable container (`overflow-x-auto` on a wrapping `div`, the same pattern already used for the artifact-style tables you may have seen elsewhere) rather than redesigning the table into cards — the fix should be the smallest change that removes the layout break, not a rewrite.
4. Confirm WCAG AA contrast (4.5:1 body text, 3:1 large text/UI components) on any new visual elements introduced by B1 (the theme toggle icon, the stale-state banner) — the existing design-system contrast work from the UI modernization pass (`docs/PROGRESS.md`'s "UI Modernization pass" section) computed ratios for the base palette; new elements reusing existing tokens (`text-muted-foreground`, `border-border`, etc.) inherit those already-verified ratios, so this step is really "confirm B1 didn't introduce a new raw color," not a full re-audit.
5. Write up findings as a short markdown section appended to `docs/PROGRESS.md`'s Week 5 entry (the boss will consolidate all teams' notes into one entry, per this project's established documentation convention) — list what was checked, what was fixed, and what still needs a real browser/screen-reader to confirm (this sandbox has no browser).

**Skills for this task:** superpowers:verification-before-completion — be explicit about the same sandbox-vs-real-browser boundary every prior UI PR in this project has called out; don't claim an accessibility fix is confirmed working when it's only correct by code inspection.

---

## Team C: `week5/historical-explorer` (2 employees)

### Employee C1: `games-search-api`

**Files:** Modify `api/src/api/routers/games.py`. Create: `api/src/api/routers/player_stats.py`, `api/tests/test_player_stats.py`. Modify `api/src/api/main.py` (register the new router), `api/tests/test_games.py` (new date-range test cases).

**Task:**
1. Read `api/src/api/routers/games.py`'s current `GamesReader` protocol and `SQLAlchemyGamesReader.list_games(filter_date)` in full before changing anything — it currently supports exactly one exact-date filter or "most recent 20." Extend it to accept an optional `start_date`/`end_date` range in addition to the existing single-`date` behavior (keep `?date=` working unchanged for backward compatibility with the existing Live Board/home page — nothing there uses date range, but don't break what's there). Add `start_date`/`end_date` as new optional `Query` params on `GET /games`, validated the same way as the existing `date` param (`date.fromisoformat()`, `400` on parse failure — reuse the existing validation pattern, don't write a second one). Update the cache key logic in this route (it currently does `cache_key = f"games:{date or 'recent'}"`) to incorporate the range params too, so a range query doesn't collide with a single-date or unfiltered cache entry.
2. Create a new `GET /player-stats` router (`api/src/api/routers/player_stats.py`) reading from the `player_game_stats` Gold table, filterable by `game_id` (exact) and `player_name` (case-insensitive partial match on the combined first/last name — check `player_game_stats.sql`'s actual column names, `player_first_name`/`player_last_name`, before writing the query). Follow `games.py`'s existing structure exactly: a `PlayerStatsReader` Protocol + `SQLAlchemyPlayerStatsReader` implementation + a `get_player_stats_reader()` FastAPI dependency + `require_api_key` gating (every route except `/health` requires it, per `CLAUDE.md`) + rate limiting via the shared `api.core.rate_limit.limiter`/`DEFAULT_RATE_LIMIT` (already used by `games.py`/`live.py`/`quality.py` — import and apply the same way). Wrap the response in `cached_json` (from `api.core.cache`, already built in Week 4) with a short TTL (~15s, matching `/games`'s existing choice).
3. Register the new router in `api/src/api/main.py` alongside the existing three.
4. Write `api/tests/test_player_stats.py` following `api/tests/test_games.py`'s existing test structure (a fake reader, auth-bypass cases, a filter-by-`game_id` case, a filter-by-`player_name` case, an unfiltered case) — this table is empty in real Postgres today (Team A's ingestion hasn't run for real yet), so all tests here must use a fake reader, never assume real rows exist.
5. Add date-range test cases to `api/tests/test_games.py` for the new `start_date`/`end_date` params (valid range, invalid date format on either bound, `start_date` after `end_date` — decide and document whether that's a `400` or just an empty result; either is defensible, but pick one and test it).

**Skills for this task:** superpowers:test-driven-development for the new router and the date-range extension — both are new query-parameter-driven branches, exactly the kind of logic that benefits from a failing test written first.

### Employee C2: `historical-explorer-page`

**Files:** Create: `web/app/explorer/page.tsx`, `web/app/api/explorer/route.ts` (or extend `web/app/api/games/route.ts` if the boss judges a single BFF route cleaner — check with the boss before deciding, since Employee C1's `/player-stats` endpoint is a second real upstream call this page needs). Modify `web/app/components/site-nav.tsx` (add a nav link), `web/app/page.tsx` (add a third card to `DESTINATIONS`).

**Task:**
1. Build a new `/explorer` page: a date-range search form (two date inputs, native `<input type="date">` is fine — no need for a calendar-picker library) plus a text input for player-name search, calling through a new BFF route (`web/app/api/explorer/route.ts`, following `web/app/api/games/route.ts`'s existing fetch-through pattern exactly — read that file before writing this one) that proxies to FastAPI's `GET /games` (with the new range params from Employee C1) and `GET /player-stats`. The BFF holds the API key server-side via `lib/fastapi-client.ts`, per `CLAUDE.md` — the browser must never see it, same as every existing route.
2. Design every state per the PRD's "fully furnished checklist" (§11): a loading skeleton shaped like the actual results layout (not a generic spinner — follow `LiveBoard.tsx`'s `LiveBoardSkeleton` precedent, which mirrors its real grid rather than using a placeholder shape), an explicit empty state for "no games matched" (follow `LiveBoardEmpty`'s precedent — a calm, deliberate message, not a bare "no results"), and an explicit error state for a failed fetch (follow `quality/page.tsx`'s `Alert`-based pattern for a full-page fetch failure).
3. Since `player_game_stats` is empty in real data today (Team A's ingestion hasn't been run for real yet — this is expected, not a bug), the player-box-score section of a game's detail view needs its own empty state distinct from "no games matched your search" — e.g. "Player box scores aren't available for this game yet" — so the page doesn't look broken once real users/reviewers click into a game before Team A's data lands.
4. Add `/explorer` to `site-nav.tsx`'s `NAV_LINKS` array (an appropriate `lucide-react` icon — e.g. `Search` or `History`) and add a third card to `page.tsx`'s `DESTINATIONS` array, following the existing two entries' exact shape (`href`, `icon`, `title`, `description`, `cta`).
5. Confirm mobile responsiveness on the search form and results layout at a 375px width (same check as Employee B2, but scoped to this new page — coordinate rather than duplicate if B2's audit already produced a reusable pattern, e.g. the `overflow-x-auto` table wrapper).

**Skills for this task:** superpowers:test-driven-development doesn't apply cleanly to a page component in this codebase (no frontend test runner exists per `CLAUDE.md`'s command list — only `tsc`/`eslint`) — instead, use superpowers:verification-before-completion: `npx tsc --noEmit` and `npm run lint` must both be clean, and state explicitly in your PR that the actual search behavior and empty-state rendering need a real browser check, same as every prior frontend PR in this project.

---

## Verification (all three bosses, before reporting to the human)

- `ingestion`: `uv run pytest -v` (existing 61 + new stats-client/stats-flow tests).
- `db`: no schema changes expected this week — if Employee A2 finds a genuine gap requiring one, that boss must flag it explicitly rather than let it happen silently; otherwise `db`'s existing 16 tests are unaffected.
- `dbt`: `dbt parse --no-partial-parse` and `dbt compile --no-populate-cache` clean (per `CLAUDE.md`, never plain `dbt compile`).
- `api`: `uv run pytest -v` (existing 60 + new `player_stats`/date-range tests).
- `web`: `npx tsc --noEmit` and `npm run lint` both clean.
- No boss can verify against a live Postgres/Redis, a real browser, or a real balldontlie `/stats` response in these sandboxes — say so plainly in the final report, same as every prior week. The human will, after each team merges: run the real stats backfill and confirm `player_game_stats` actually populates; open the app in a real browser to confirm the theme toggle, stale-state timer, and Historical Explorer search actually work; and re-run `dbt run`/`dbt test` for real.

## Execution Handoff

All three boss branches are created and their teams dispatched in parallel immediately after this plan is saved, matching every prior week. The human sign-off gate remains the final merge into `main`.
