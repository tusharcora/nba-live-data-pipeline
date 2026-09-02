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

## Current Status (2026-09-01)

Weeks 1–3 of the PRD plan are built and merged to `main`, plus a UI
modernization pass pulled forward from Week 5's scope. As of tonight, this
has been run **end-to-end against real infrastructure for the first time**
(everything before this was built and tested in a sandbox with no Docker
access) — real Postgres, real Redis, a real balldontlie API pull, a real
dbt build, and both the FastAPI service and the Next.js frontend running
locally and serving real data.

**What's confirmed working right now, with real data, not mocks:**
- `make up` → `make migrate` → `make dbt-run` → real schema, roles, and Gold
  tables in Postgres.
- A real historical backfill (`ingestion/flows/backfill_flow.py`) against
  balldontlie's live API — the assumed JSON shape in `stg_games.sql`
  (flagged "unverified" since Week 1) is now confirmed byte-for-byte correct.
- `GET /games`, `/games?date=...`, `/quality` all serving real data with
  real API-key enforcement (`401` without a key).
- The Next.js app (`/`, `/live`, `/quality`) rendering for real, including
  the BFF proxy routes reaching FastAPI correctly.

**What's not yet exercised for real:**
- `live_game_flow` (live polling) and the `quality/` package's four checks
  (fingerprinting, volumetric, PSI drift, reconciliation) are fully built
  and unit-tested, but nothing schedules or invokes them on a recurring
  basis yet — they're tested libraries, not running jobs.
- SSE streaming (`/api/live`) has never been opened in a real browser or
  deployed to real Vercel — the code follows the documented Vercel-safe
  pattern, but that's still unverified in practice.
- The UI's light-mode palette and the glassmorphism/blur visual treatment
  have never been looked at in a real browser (only `next build` output
  and computed contrast ratios were checked).

**Next up per `docs/prd.md` §12:** Week 4 — security hardening & performance
pass (CORS lockdown, secrets audit, `pip-audit`/`npm audit`, load testing).

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

---

## Known Issues / Caveats

- `quality/`'s four checks are tested library code, not a running job —
  nothing schedules or invokes `check_schema_drift`, `check_completed_games`,
  `check_weekly_drift`, or `reconcile_games_for_date` on a recurring basis
  yet. Wiring these into a Prefect deployment/schedule is unstarted work,
  not a bug.
- SSE (`/api/live` → the BFF's passthrough → `EventSource` in the browser)
  has never been exercised end-to-end in a real browser, and never
  deployed to real Vercel. The code follows the documented pattern from
  `docs/prd.md` §13, but the Vercel-specific streaming/timeout behavior is
  unverified in practice — this is explicitly called out in the PRD as a
  Week-3 risk that needs a real deployment to close out.
- The UI's light-mode palette is a correct-by-computation *derivation* from
  the design system's dark-native palette (WCAG ratios check out), but
  nobody has looked at it rendered. Same for the glassmorphism/blur visual
  treatment generally.
- Rate limiting (`slowapi`) uses an in-memory store — correct and fully
  tested for a single instance, but would need a shared Redis backend if
  this ever ran on more than one server process.
- The `crc32`-derived synthetic team ID in `quality/volumetric.py` (Gold
  tables have no real integer team ID) is a documented compromise, not a
  long-term design — worth a real `teams` dimension table eventually.
- `docs/prd.md` §12's Week 3 CI bullet ("dbt build on push") is only
  partially true — CI runs `dbt parse` against a real ephemeral Postgres,
  not a full `dbt run`/`dbt test` with seeded data. Worth revisiting once
  there's a sensible way to seed CI's Postgres with representative data.

## What's Next

Per `docs/prd.md` §12, **Week 4 — Security hardening & performance pass**:
full pass against the §08 security checklist (CORS lockdown, secrets
audit, `pip-audit`/`npm audit` clean, manual injection/auth-bypass test),
Redis cache in front of hot endpoints, DB indexing/connection pooling, and
a load test against the live-game-window scenario to confirm the p95/
freshness SLAs from §09. (Started 2026-09-02.)

**Beyond Week 4, two items the user has flagged for later, not yet scheduled:**

- **UI needs another pass.** The user's reaction to the current UI
  modernization pass: "too simple," should be "hyper user focused." The
  first pass deliberately targeted Week 3's bar (functional, not fully
  polished — see `docs/prd.md` §11), so this isn't a regression, but the
  user wants more than Week 5's standard "fully furnished" checklist
  eventually delivers. Concrete direction not yet gathered — ask what
  "hyper user focused" means specifically before running another
  boss/employee UI round.
- **A natural-language / AI-assistant interface** — the user wants to
  eventually add a Claude-esque chat interface for asking questions about
  the data in plain language, backed by some form of retrieval (RAG or
  otherwise) over this project's Gold/quality tables. A draft feature
  proposal was requested and is being written up separately — see
  `docs/features/ai-assistant-draft.md` once it exists (or the project
  memory pointer if this file hasn't been created yet) for the options
  considered and what's recommended for in/out of scope.
