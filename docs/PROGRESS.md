# Progress Log

This is the running build log for the Live Box Score Pipeline & Data Quality
Observatory — what's been built, in what order, what's verified, and what's
still open. `docs/prd.md` is the spec (what we're building and why);
`CLAUDE.md` is developer-facing conventions (commands, architecture); this
file is the narrative history and current status.

**Convention for future updates:** each new phase of work gets a new dated
section appended under [Timeline](#timeline), oldest first. The
[Current Status](#current-status) section at the top is kept in sync with
whatever the most recent entry says — update it every time, don't let it go
stale.

---

## Current Status (2026-09-02)

Weeks 1–6 of the PRD plan are complete. Weeks 1–5 (foundations through
Historical Explorer) are merged to `main`. Week 6 (final QA & write-up) is
done: a real end-to-end browser walkthrough, a real load test that found
and fixed a genuine bug, a real schema-drift run, a demo GIF
(`docs/demo/nba-pipeline-demo.gif`), and this write-up.

**What's confirmed working right now, with real data and a real browser,
not mocks:**
- `make up` → `make migrate` → `make dbt-run` → real schema, roles, and Gold
  tables in Postgres, including Week 4's `audit_log` table, the hot-path
  indexes, and dbt's `games.game_date` index.
- A real historical backfill (`ingestion/flows/backfill_flow.py`) against
  balldontlie's live API — the assumed JSON shape in `stg_games.sql`
  (flagged "unverified" since Week 1) is confirmed byte-for-byte correct.
- `GET /games`, `/games?date=...`, `/games?start_date=&end_date=`,
  `/player-stats`, `/quality` all serving real data with real API-key
  enforcement, real CORS, real Redis caching, and real rate limiting.
- The security definition-of-done (`docs/prd.md` §08) confirmed in a real
  browser, not just via `curl`/tests: the API key never appears in any
  network request, response body, or header the browser can see —
  `/quality` fetches entirely server-side (zero client-visible API calls
  at all), `/explorer` only ever calls its own domain's `/api/explorer`.
- **A real load test** (`docs/performance-loadtest.md`) at 30 and 50
  concurrent simulated dashboard users found and fixed a genuine bug: the
  shared-API-key rate limit (100/minute, set in Week 3, never load-tested)
  was a global ceiling on *all* real end-user traffic combined, rejecting
  ~48% of normal requests with 429s under realistic concurrency. Fixed by
  raising it to 600/minute; re-verified at 0 failures and aggregate p95
  ~23-26ms — about 12x under the PRD's <300ms target.
- **A real theme toggle, real Live Board/Quality/Explorer empty states,
  real Historical Explorer search** (date-range and player-name, both
  confirmed via actual network requests carrying the right query params),
  and **a real, working keyboard focus ring** (`:focus-visible` confirmed
  true with an active box-shadow ring via real Tab navigation) — all
  verified in an actual Chrome browser for the first time this week,
  closing caveats that had been open since Week 3/5.
- A real schema-drift check run (`quality.fingerprint.check_schema_drift`)
  against the 3 real `raw_pulls` rows from the Week 1 backfill: zero drift
  detected, confirming balldontlie's `/games` schema was genuinely stable
  across the backfill window — a real (if quiet) result, not fabricated.
- The `ALTER DEFAULT PRIVILEGES FOR ROLE nba` mechanism from Week 1
  genuinely auto-grants `api_reader` `SELECT` on brand-new tables.

**What's still not exercised for real, by design or external constraint:**
- `live_game_flow` (live polling) has never run during a real game window,
  so freshness (<30s target), the `quality/` package's volumetric and
  reconciliation checks (both need `player_game_stats` and/or dual-source
  data that don't exist), and the Live Board's live-game rendering/stale-
  banner behavior are all still unverified against real live data. The
  empty/no-live-games states are confirmed correct; the live-data path
  itself isn't.
- `player_game_stats` is permanently empty on the current balldontlie plan
  (see below) — Historical Explorer's box-score feature is code-complete
  and browser-verified against its own correctly-designed empty state, not
  against real player rows.
- SSE has never been deployed to real Vercel — confirmed working over a
  real local browser `EventSource` connection this week (no console
  errors, correct empty-state rendering), but the Vercel-specific
  streaming/buffering behavior from `docs/prd.md` §13 remains unverified.
- Mobile-breakpoint rendering (375px) could not be visually verified this
  week — a real tooling limitation (this session's browser automation
  viewport stayed pinned at 2000x1120 regardless of `resize_window`), not
  a project gap. Verification here still rests on Week 5's code-level
  responsive-class review (`grid-cols-1 sm:grid-cols-2`, `overflow-x-auto`
  table wrappers).
- `backfill_stats_flow` was run for real (2026-09-02) and correctly got a
  `401 Unauthorized` from balldontlie's `/stats` endpoint — confirmed via
  their docs that player box scores require the paid ALL-STAR tier
  ($9.99/mo+); the free tier only covers "Basic" data access. **Decision:
  not paying for a higher tier** — an accepted, documented limitation.

**Per `docs/prd.md` §12, all 6 weeks are now complete.**

---

## Timeline

### Scaffolding (2026-08-31)

Initial repo structure: `db/`, `ingestion/`, `dbt/`, `api/`, `web/` as five
independent `uv`/`npm` projects, each with a passing smoke test. Root-level
`docker-compose.yml` (Postgres 16 + Redis 7), `.env.example`, `Makefile`,
GitHub Actions CI. Everything at this stage was a stub matching the PRD's
interface names — no real logic yet. Full detail in
`docs/superpowers/plans/2026-08-31-project-scaffolding.md`.

### Week 1 — Foundations & historical backfill (2026-09-01)

First use of the boss/employee multi-agent workflow: a "boss" agent per
subsystem reviews and merges "employee" agents' independent PRs before a
human sign-off gate at the integration branch → `main` merge. Three teams,
run mostly in sequence since `db-foundations` blocks the other two:

- **`db-foundations`** — new `db/` package: SQLAlchemy models + hand-written
  Alembic migrations for the Bronze/Meta tables (`raw_pulls`,
  `schema_change_log`, `quality_metrics`, `source_conflicts`), plus the
  least-privilege Postgres roles (`ingestion_writer`, `api_reader`) with
  grants. `ingestion`/`api` wired to prefer role-scoped DSNs with fallback
  to the admin `DATABASE_URL`.
- **`ingestion`** — real `BallDontLieClient` (pagination via
  `meta.next_cursor`), a resumable `backfill_flow` built around
  `@runtime_checkable` Protocol-based dependency injection (required because
  Prefect builds a Pydantic parameter schema from flow type hints at
  decoration time), and player-name normalization
  (`normalize_player_key`/`clean_display_name`) for cross-season matching.
- **`dbt`** — real `stg_games`/`games` and `stg_player_game_stats`/
  `player_game_stats` models, parsing `raw_pulls.payload` JSONB directly,
  deduplicated via `row_number() over (partition by <id> order by
  pulled_at desc)` since Bronze is append-only.

Full detail: `docs/superpowers/plans/2026-09-01-week2-live-ingestion-quality-gate.md`
references the Week 1 pattern; see project memory / PR history (#1–#6) for
the literal Week 1 PRs.

### Week 2 — Live ingestion & the quality gate (2026-09-01)

Two boss teams, fully parallel this time (no shared-foundation dependency
like Week 1's `db-foundations`):

- **`live-ingestion`** — `PublicFeedClient` (the second, ESPN-shaped data
  source), and a real `live_game_flow`: one poll cycle against both sources,
  writing Bronze `RawPull`s and a new `LiveGameState` (Silver) row per game.
- **`quality-gate`** — new shared `quality/` package (pre-scaffolded once to
  avoid four employees colliding on `uv init`): schema fingerprinting
  (diff-based drift detection), volumetric checks (exactly 2 teams, sane
  player-row counts per game), hand-implemented PSI statistical drift
  (verified against real numeric thresholds, not just "it runs"), and
  cross-source field-level reconciliation ("primary source wins", with the
  "corroborated by a third check" refinement explicitly deferred).

**Cross-cutting bug found and fixed:** every service's default
`DATABASE_URL` used a bare `postgresql://` scheme, which SQLAlchemy
resolves to the **psycopg2** dialect — but only `psycopg[binary]`
(psycopg3) was installed anywhere. Every real DB connection would have
failed with `ModuleNotFoundError: No module named 'psycopg2'`, invisible to
every test because they all use fakes and never call `create_engine()` for
real. Fixed by switching every default DSN to `postgresql+psycopg://`.
PRs: #7–#15 (`week2/integration` → `main`, PR #15).

### Week 3 — Serving layer & Next.js dashboard v1 (2026-09-01)

Two boss teams, fully parallel:

- **`api-serving`** — real `GET /games`, `/quality`, `/live` (SSE), with
  `slowapi` rate limiting (in-memory, keyed by the validated `X-API-Key`)
  pre-scaffolded once and shared by all three routes. The `/live` employee
  found and worked around a real `TestClient`/`ASGITransport` behavior (it
  fully drains a streaming ASGI app before returning, even for a
  would-be-infinite generator) by making the stream's max-duration an
  overridable FastAPI dependency.
- **`web-bff`** — `/api/games`, `/api/quality` fetch-through routes, a
  Vercel-safe SSE passthrough for `/api/live` (`runtime = "nodejs"`,
  `X-Accel-Buffering: no`, etc. — explicitly flagged as unverifiable
  against real Vercel in a sandbox), and functional (not yet polished)
  `/live` and `/quality` pages.

**Real cross-team bug caught:** a frontend employee built the quality page
against the plan doc's *documented* response shape (`{field, change_type,
detected_at}`), but the actual merged API used `field_name` and included
`old_type`/`new_type`. Neither side's own tests could have caught this —
only a boss reading across both teams' merged branches found it. Also
fixed in this round: the long-standing `web-check` CI failure (missing
`next typegen` before `tsc`). PRs: #16–#23 (`week3/integration` → `main`,
PR #23).

### UI Modernization pass (2026-09-01/02)

Pulled forward from Week 5's PRD scope at the user's explicit request,
using the same boss/employee process with an added twist: every employee
was briefed to use the `ui-ux-pro-max` skill's search tool for their
specific concern (contrast, live-badge accessibility patterns, empty-state
guidance, chart necessity) rather than working from unaided taste.

- Generated and persisted a real design system via
  `ui-ux-pro-max --design-system` — a "Real-Time/Operations" pattern with a
  Glassmorphism style, dark-navy + status-green palette, Fira Code/Fira
  Sans typography (`web/design-system/live-box-score-pipeline/MASTER.md`).
  Initialized `shadcn/ui` (Card, Badge, Table, Skeleton, Separator, Alert,
  Button) as the shared component foundation.
- **`shell`** — remapped every CSS color token to the design system with
  **computed WCAG contrast ratios** (catching two of the design system's
  own suggested colors failing AA and substituting corrected ones), Fira
  font swap, persistent nav + a real landing page.
- **`live-board`** — modern game-card grid, a "LIVE" badge designed
  specifically to avoid `aria-live` spam on every ~5s SSE poll, skeleton
  loading/`Alert` error states, `motion-safe:`-gated transitions.
- **`quality-scorecard`** — KPI cards, a schema-change table with badges
  that vary by icon *and* text (not color alone), a considered decision
  *not* to add a charting dependency yet (the API returns single current
  values, not time series).

**Real bugs caught during review, not just style nits:** a boss found the
loading skeleton was still shaped like the old single-column layout after
a sibling PR introduced a responsive grid (a genuine layout-shift bug); a
different boss cross-checked and fixed a "no color alone" accessibility
gap between two employees' merged work. PRs: #24–#29 (`ui-modernization/*`
teams), integration PR #30.

### Merge to `main` (2026-09-02)

PR #23 (Week 3) squash-merged first. PR #30 (UI modernization) could not be
merged through its own GitHub merge button — PR #23's squash broke commit
ancestry between the two branches, which would have made GitHub try to
re-apply PR #30's *entire* diff (including everything already landed via
#23) instead of just the UI delta. Resolved with a direct `git merge`
(a real three-way merge correctly recognizes "both sides independently
arrived at identical content," unlike a squash-diff-apply), which produced
three expected add/add conflicts resolved by taking the UI-modernization
side (verified byte-identical base content first). PR #30 closed manually
with an explanation. Full 144-test suite + `tsc`/`eslint`/`next build`/
`dbt parse` re-verified clean on the merged result before pushing.

### First real end-to-end verification (2026-09-02)

Tested for the first time on the user's actual machine (Docker Desktop
available there; the entire build above happened in a sandbox with no
Docker access at all). This surfaced several real, previously-unknown
issues — none in the application logic itself, all environmental:

- **A separate, unrelated Docker stack already running on this machine**
  (`shared-backbone-*`/`backbone-*` containers, a different project
  entirely, 8+ days uptime) occupies the exact same default ports this
  project wants: Postgres `5432`, Redis `6379`, API `8000`, web `3000` (and
  `3001`, via its Grafana). Every connection error traced back to this —
  including a confusing one where `curl localhost:8000/health` returned a
  plausible `{"status":"ok"}` from the *other* project's API, which
  happens to also have a `/health` route.
  - **Fix:** made every port configurable rather than fighting over the
    standard ones — `docker-compose.yml` (`POSTGRES_HOST_PORT`,
    `REDIS_HOST_PORT`), `dbt/profiles.yml.example` (same env var, `|
    as_number` cast), and new `Makefile` variables `API_PORT`/`WEB_PORT`.
    This machine now runs Postgres on `5433`, Redis on `6380`, the API on
    `8001`, the web app on `3002`. Defaults are unchanged for CI/anyone
    else.
- **A real Makefile bug**: the `dbt-run`/`dbt-parse` targets never set
  `DBT_PROFILES_DIR`, so dbt would have silently looked in `~/.dbt/`
  instead of the project — never caught earlier because every dbt
  invocation before this was run by hand with the env var set explicitly.
- **A real test-isolation bug**: `ingestion`/`api`'s "falls back to admin
  DSN" config tests only used `monkeypatch.delenv`, which clears
  `os.environ` but not pydantic-settings' separate `.env`-file source. Once
  real per-service `.env` files existed (created for this machine — they
  don't exist in the repo, `pydantic-settings` reads `.env` relative to
  each service's own CWD), the fallback tests started failing because the
  real file value leaked through. Fixed with `Settings(_env_file=None)` in
  those two tests specifically.
- A recurring macOS-specific gotcha (documented in project memory, not
  repeated here in full): editable-install `.pth` files intermittently get
  the hidden-file flag reapplied on this machine (plausibly iCloud Drive's
  Desktop/Documents sync interfering with `~/Documents`-hosted dev tool
  caches) — worked around everywhere with `PYTHONPATH=...` baked into the
  `Makefile` rather than relying on the `.pth` mechanism at all.

**None of the actual application/pipeline code needed a single change** to
get this working — every fix was infrastructure/tooling (ports, Makefile,
test isolation). The pipeline logic itself — balldontlie pagination, dbt's
JSONB parsing and dedup, the API's auth/rate-limiting, the BFF proxy — all
worked correctly on the first real run.

### Week 4 — Security hardening & performance (2026-09-02)

Two boss teams, fully parallel, both branching from the same pre-week4
`main` commit:

- **`week4/security`** — CORS middleware (configurable `ALLOWED_ORIGIN`,
  `GET`-only, `X-API-Key`/`Content-Type` headers only); a real SQL-injection
  audit against `/games?date=` (12 payloads, proven via a
  `_CountingGamesReader` fake asserting the DB reader is never invoked, not
  just "no error thrown"); an auth-bypass suite across every protected
  route (missing/empty/wrong/wrong-case key) plus an API-key-leakage scan;
  a new `audit_log` table/model for manual data-quality overrides;
  `docs/security-audit.md` documenting a real, deliberately-deferred
  low-priority finding (`!=` instead of `hmac.compare_digest` for the API
  key comparison — a timing side-channel, judged low-value to fix given the
  key is a single shared secret, not per-user).
- **`week4/performance`** — a shared, module-level-cached `get_engine()`
  (`pool_size=5, max_overflow=10`) fixing a real bug where `games.py` and
  `live.py` each created a fresh SQLAlchemy `Engine` per request; fail-open
  Redis caching (`cached_json`, catches *all* exceptions and falls through
  to direct compute — a cache outage must never 500 the API) wrapping
  `/games` and `/quality`; new indexes on `quality_metrics(check_name,
  run_at)`, `schema_change_log(detected_at DESC)`,
  `source_conflicts(detected_at DESC)`, plus a dbt-postgres index on
  `games.game_date`; a Locust load test (`api/loadtest/`) for the
  live-game-window read pattern (written but not yet run — needs a
  dedicated session against a live server).

**Integration work (`week4/integration`):** both teams' migrations shared
the same `down_revision` (they branched from the same commit), producing
two independent Alembic heads — resolved via `alembic merge` into a new
merge revision (`84681f65c10a`), verified single-head and a clean
`upgrade head --sql` chain. One real merge conflict in
`db/tests/test_models.py` (both teams appended tests at the same location)
resolved by keeping both teams' tests sequentially. Full suite green:
`db` 16/16, `api` 60/60, `ingestion` 61/61, `quality` 54/54, `dbt parse`
exit 0.

**Went further than sandbox verification this round** — real Postgres/Redis
are reachable on this machine, so instead of stopping at "tests pass and
`--sql` output looks right," the merged migration was actually applied and
every new feature was exercised for real: the migration ran cleanly against
live Postgres (confirming, among other things, that Week 1's
`ALTER DEFAULT PRIVILEGES` role mechanism really does auto-grant new tables
— previously only checked via offline SQL, now proven on `audit_log`);
`dbt run` confirmed the `games.game_date` index is a real index, not just
config that parses; CORS was tested with matching (header present) and
non-matching (header absent) `Origin` headers against a freshly-restarted
API process (an old pre-Week-4 uvicorn process on the same port was killed
first, to rule out `--reload` masking stale behavior across the git branch
switch); caching was confirmed via a real `FLUSHALL` → first request
(populates `games:<date>`, TTL 15s) → second request (key reused) cycle
against Redis on port 6380; rate limiting was confirmed by firing 110 rapid
requests and observing 429s from request 98 onward, consistent with the
configured 100/minute limit. PR #35 (`week4/integration` → `main`) opened
with all of the above as the test plan, awaiting human sign-off.

### Week 5 — UI furnishing, stats ingestion, Historical Explorer (2026-09-02)

Three boss teams, fully parallel, dispatched from a plan
(`docs/superpowers/plans/2026-09-02-week5-ui-furnishing-and-historical-explorer.md`)
that started with two real, scope-changing findings surfaced *before* any
code was written, both resolved by explicit human decision rather than
unilaterally:

- **`player_game_stats` had zero rows and no ingestion path at all** — not
  a "hasn't run yet" gap. `BallDontLieClient` only ever implemented
  `get_games_pages()`; the dbt `stg_player_game_stats`/`player_game_stats`
  models were built in Week 1 against a documented-but-never-implemented
  `/stats` shape. **Decision: add real stats ingestion as a Week 5 team**
  rather than scoping Historical Explorer to games-only.
- **The win-probability stretch model (PRD §10) has no real training
  data** — 0 live-poll runs have ever produced `LiveGameState` time-series
  snapshots, only 26 historical games exist. **Decision: shelve it,
  explicitly not abandoned** — revisit once `live_game_flow` has run for
  real during actual game windows.

**`week5/stats-ingestion`** — `BallDontLieClient.get_stats_pages()` plus a
new, independently-checkpointed, resumable `backfill_stats_flow.py`
(a fresh `@runtime_checkable StatsPageSource` Protocol alongside the
existing `RawPullSink`/`CheckpointStore`, matching `CLAUDE.md`'s Prefect
DI convention). **Real `/stats` shape discovered and a real bug fixed**:
`min` returns a bare minutes string (`"30"`), not `"MM:SS"` as
`stg_player_game_stats.sql` had assumed since Week 1 — fixed with
backward-compatible parsing; the file's header comment updated from
"unvalidated" to "confirmed against a real ingestion path." 69/69
`ingestion` tests passing (61 pre-existing + 8 new).

**`week5/foundation-ux`** — a real, working light/dark theme toggle
(`next-themes`, wired into a new `ThemeProvider`, a new `theme-toggle.tsx`
with an effect-describing `aria-label`) — `.dark` CSS has existed since the
UI modernization pass but nothing ever applied it until now. A
non-destructive "stale" banner on Live Board (60s-no-message threshold,
distinct from the existing hard-error state, screen-reader-restrained the
same way the "LIVE" badge already is). An accessibility/mobile audit using
the `ui-ux-pro-max` skill found one real fix (`scroll-pt-16` for WCAG
2.4.11 "Focus Not Obscured" under the sticky nav) and one deferred finding
(the new toggle's touch target is under the 44px mobile guideline).

**`week5/historical-explorer`** — `GET /games` extended with
`start_date`/`end_date` range filtering (mutually exclusive with the
existing single-`date` param; an inverted range is a `400`, not a silent
empty result). A new `GET /player-stats` endpoint reading the Gold
`player_game_stats` table (filterable by `game_id`/`player_name`, same
auth/rate-limit/cache conventions as every other route) — correctly
returns an empty, calmly-worded result today since the table has no real
rows until `week5/stats-ingestion` is run for real. A new `/explorer` page
(date-range + player-name search, per-game box-score expansion, three
distinct empty/loading states). 76/76 `api` tests passing (60 pre-existing
+ 16 new).

**Real problems this round, all caught and fixed without derailing the
work:**
- A platform-wide rate limit cut off all three boss agents (and two
  in-progress employees) mid-task. Recovered by checking each employee's
  worktree directly on disk for uncommitted-but-real work (nothing was
  lost — `git status`/diff confirmed exactly what existed before
  resuming), then resuming each boss/employee agent via its original
  `agentId` rather than restarting fresh.
- **Boss agents dispatched with `isolation: "worktree"` did not reliably
  land in an isolated worktree** — at least two of the three boss agents'
  first `git checkout -b` ran against the shared main repo checkout
  instead, which is genuinely risky if it collides with the orchestrating
  session's own concurrent git commands. Caught via `git status`/`git
  branch --show-current` on the shared checkout after each incident (found
  it switched to a `week5/*` branch, switched it back to `main`, confirmed
  no uncommitted changes were lost); one boss self-corrected by creating
  its own dedicated worktree mid-run. Worth a closer look before the next
  weekly round — see project memory for the standing note.
- One employee (`theme-toggle-and-stale-state`) briefly ran `npm install`
  against the shared checkout instead of its own worktree; self-caught and
  restored `package.json`/`package-lock.json` there before committing
  anything (verified independently afterward — the shared checkout's
  `git status` showed no drift).
- Two employees independently found and fixed the same class of sandbox
  bug: an incidentally-reachable local Redis on the default port let
  cache-blind tests read stale cross-test values within the cache TTL on a
  fast rerun. Both fixed it the same way — an isolated `fakeredis` client
  per test — without coordinating, since they were on different boss teams.

**Integration:** all three boss branches merged into `week5/integration`
cleanly — no conflicts on `db`/`ingestion`/most of `api`, and `git`'s
three-way merge correctly combined both Team B and Team C's independent
additions to `web/app/components/site-nav.tsx` (the theme toggle and the
new Explorer nav link) without a conflict; verified by reading the merged
file directly rather than trusting the clean exit code. Full verification
on the merged branch: `db` 16/16, `ingestion` 69/69, `api` 76/76, `quality`
54/54, `dbt parse`/`dbt compile --no-populate-cache` both clean, `web`
`tsc`/`eslint`/`next build` all clean. PR #42 (`week5/integration` →
`main`) opened with all of the above as the test plan, awaiting human
sign-off.

### Week 6 — Final QA, real load test, demo, write-up (2026-09-02)

No boss/employee round this week — Week 6 is fundamentally a single
coherent QA/wrap-up pass (end-to-end walkthrough, demo, write-up), not
parallel feature work, so it was done directly against live infra and a
real Chrome browser rather than spinning up another multi-agent round.

**Real browser walkthrough** (first time ever for this project — every
prior "needs a real browser" caveat since Week 3 was closed or narrowed
this week): loaded `/`, `/live`, `/quality`, `/explorer` in an actual
Chrome tab against the locally-running stack. Confirmed real, not
by-inspection: the theme toggle switches and persists across navigation
with genuine WCAG-real contrast (not an inverted palette); Live Board and
Quality Scorecard render their correct empty states with zero console
errors and a clean SSE connection; Historical Explorer loads real games
data, its date-range and player-name search both fire real
`/api/explorer` requests carrying the right query params (verified via
the browser's own network log, not assumed from the code); the box-score
expansion shows its correctly-designed "not available yet" empty state;
keyboard `Tab` navigation genuinely lands focus on real interactive
elements with `:focus-visible` true and an active ring (confirmed via
`getComputedStyle`, not just a screenshot); and the API key never appears
in any network request, response body, or header the browser can see
(`/quality`'s fetch is entirely server-side — zero client-visible API
calls at all for that page). One real tooling limitation hit and
documented rather than worked around: this session's browser automation
viewport stayed pinned at 2000×1120 regardless of `resize_window`, so
mobile-breakpoint rendering could not be visually confirmed this week —
verification there still rests on Week 5's code-level responsive-class
review.

**A real load test found and fixed a genuine bug.** Ran
`api/loadtest/locustfile.py` (written in Week 4, never executed until now)
headless against the live API at 30 and 50 concurrent users — within the
PRD's own "live game window" scenario, not an adversarial load. At the
original `100/minute` shared rate limit, ~48% of otherwise-healthy
requests came back `429` purely from normal app traffic: since every real
caller shares one BFF-held API key by design (`docs/prd.md` §08), that
limit was a global ceiling on *all* end-user traffic combined, not a
per-user allowance — a correct security design whose consequence had
never been load-tested. Fixed by raising it to `600/minute`
(`api/src/api/core/rate_limit.py`, reasoning recorded inline; one test
updated to match). Re-run at both concurrency levels: **zero failures,
aggregate p95 ≈ 23-26ms — about 12x under the PRD's <300ms target**, with
no connection-pool exhaustion. Full write-up with exact per-route numbers
in `docs/performance-loadtest.md`.

**A real (if quiet) quality-check run.** `player_game_stats` being
genuinely empty (see Known Issues) means the volumetric and reconciliation
checks have no real data to run meaningfully against — running them would
have produced an empty/trivial result, not a demonstration, so they
weren't forced. Schema fingerprinting, however, only needs `raw_pulls`
(Bronze), which does have 3 real rows from the Week 1 backfill — ran
`quality.fingerprint.check_schema_drift` for real across all 3, in order.
Result: **zero schema changes detected**, a genuine confirmation that
balldontlie's `/games` schema was stable across the real backfill window.
No drift event occurred to "catch" for the demo (per `docs/prd.md` §12's
own conditional phrasing, "if one occurred during the build") — this is
reported honestly rather than fabricated.

**Demo recorded.** A short GIF (`docs/demo/nba-pipeline-demo.gif`) walking
through the theme toggle, Live Board, Historical Explorer (including a
real box-score expansion), and Quality Scorecard, captured live against
the running stack via Chrome browser automation.

**Write-ups added:** `docs/performance-loadtest.md` (full load-test
report), this Timeline entry, and `README.md`/resume-bullets updates
(§14) with real numbers filled in per `docs/prd.md`'s own request.

---

## Known Issues / Caveats

- `quality/`'s four checks are tested library code, not a running job —
  nothing schedules or invokes `check_schema_drift`, `check_completed_games`,
  `check_weekly_drift`, or `reconcile_games_for_date` on a recurring basis
  yet. Wiring these into a Prefect deployment/schedule is unstarted work,
  not a bug.
- SSE (`/api/live` → the BFF's passthrough → `EventSource` in the browser)
  was confirmed working over a real local `EventSource` connection in
  Week 6 (clean connect, no console errors, correct empty-state rendering
  with no live games) but has still never been deployed to real Vercel.
  The Vercel-specific streaming/timeout behavior from `docs/prd.md` §13
  remains the one part of this risk not yet closed out.
- The UI's light-mode palette and theme toggle were confirmed working in a
  real browser in Week 6 (genuine contrast, not an inverted palette,
  persists across navigation). Mobile-breakpoint rendering (375px)
  specifically was **not** visually confirmed — a real tooling limitation
  hit this week (browser automation's viewport stayed pinned at 2000×1120
  regardless of `resize_window`), not a project gap. Verification there
  still rests on Week 5's code-level responsive-class review.
- Rate limiting (`slowapi`) uses an in-memory store — correct and fully
  tested for a single instance, but would need a shared Redis backend if
  this ever ran on more than one server process. Its threshold was raised
  from 100/minute to 600/minute in Week 6 after a real load test showed
  the original value rejecting ~48% of normal traffic under realistic
  concurrency — see `docs/performance-loadtest.md`.
- The `crc32`-derived synthetic team ID in `quality/volumetric.py` (Gold
  tables have no real integer team ID) is a documented compromise, not a
  long-term design — worth a real `teams` dimension table eventually.
- `docs/prd.md` §12's Week 3 CI bullet ("dbt build on push") is only
  partially true — CI runs `dbt parse` against a real ephemeral Postgres,
  not a full `dbt run`/`dbt test` with seeded data. Worth revisiting once
  there's a sensible way to seed CI's Postgres with representative data.
- **The win-probability stretch model (PRD §10) is deliberately not
  built** — no real time-series training data exists (0 live-poll runs
  have produced `LiveGameState` snapshots; only 26 historical games from a
  3-day backfill window exist). This is a standing decision the user wants
  revisited once `live_game_flow` has actually run during real game
  windows, not a dropped feature.
- **`player_game_stats` is permanently empty on the current API plan.**
  Week 5 built a real, correct ingestion path (`backfill_stats_flow` +
  `BallDontLieClient.get_stats_pages()`), but running it for real
  (2026-09-02) got a genuine `401 Unauthorized` from balldontlie's `/stats`
  endpoint — confirmed via their own docs that player box scores require
  the paid **ALL-STAR** tier ($9.99/mo+), which this project's free-tier
  key doesn't have. `/games` remains free-tier-accessible and works fine.
  **Decision: not paying for a higher tier** — this is an accepted,
  documented limitation, not a bug. Historical Explorer's box-score search
  is code-complete and will show its correctly-designed empty state
  indefinitely unless this is revisited with a paid key.
- Two of Week 5's three boss agents did not reliably land in their own
  isolated worktree despite being dispatched with `isolation: "worktree"`
  — see the Week 5 timeline entry above and project memory for the
  standing note to check before the next weekly round.

## What's Next

**All 6 weeks of `docs/prd.md` §12 are complete as of 2026-09-02.** The
core deliverable — the ingestion/reconciliation/drift-monitoring pipeline
plus a fully furnished dashboard — is built, tested, and now
browser-verified end-to-end. The win-probability stretch model (§10)
remains the one deliberately-deferred PRD item (see Known Issues).

**Two items the user has flagged for later, not yet scheduled:**

- **UI needs another pass.** The user's reaction to the UI modernization
  pass: "too simple," should be "hyper user focused." Week 5 closed the
  PRD's own "fully furnished" checklist (states, theme, a11y, mobile), but
  the user wants more than that checklist delivers. Concrete direction not
  yet gathered — ask what "hyper user focused" means specifically before
  running another boss/employee UI round.
- **A natural-language / AI-assistant interface** — the user wants to
  eventually add a Claude-esque chat interface for asking questions about
  the data in plain language, backed by some form of retrieval (RAG or
  otherwise) over this project's Gold/quality tables. A draft feature
  proposal was written up separately — see `docs/features/ai-assistant-draft.md`
  (deliberately left uncommitted, per the user's instruction) for the
  options considered and what's recommended for in/out of scope.
