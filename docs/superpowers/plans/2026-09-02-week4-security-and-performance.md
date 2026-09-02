# Week 4 Implementation Plan — Security Hardening & Performance Pass

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development — one fresh specialized subagent ("employee") per task below, reviewed and merged by a "boss" subagent per team before human sign-off, exactly as executed for Weeks 1-3 and the UI modernization pass. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/prd.md` §12 Week 4 against the actual gaps found by auditing the codebase (not a generic security/perf checklist): no CORS middleware exists on FastAPI at all, no dependency/secret scanning runs in CI, no DB indexes exist on any Gold or Meta table despite date-filtered and "latest-N" query patterns already in production code, and Redis has been provisioned since Week 1 but never actually used by anything.

**Architecture:** Two boss teams, fully parallel — security work (CORS, scanning, audit) and performance work (caching, indexing, load testing) touch almost entirely disjoint files, with one narrow overlap called out explicitly below (both teams' employees may want to touch `api/src/api/main.py`).

**Tech Stack:** `starlette.middleware.cors.CORSMiddleware` (already a FastAPI dependency, no new package), `pip-audit`/`npm audit` (CI only), `gitleaks` (CI only, via its GitHub Action), Redis via the already-present `redis` Python client (need to add it — currently only `REDIS_URL` config exists, no client library), Alembic for new Meta-table indexes, dbt's `+indexes:` config for Gold-table indexes, and `locust` (pure Python, easier to review/extend than `k6` given this is a Python-heavy codebase) for the load test.

**Spec:** `docs/prd.md` §08 (security — read the "Definition of done" checklist, it's the actual acceptance bar), §09 (performance targets: freshness <30s, API p95 <300ms, reconciliation accuracy >99%, uptime 99%+), §12 Week 4 bullets.

## Global Constraints

- No live Postgres/Redis/network in this sandbox — same as every prior week. Verify with fakes/mocks/offline checks; the human running this on their own machine (which has live infra working, confirmed 2026-09-02) is who actually proves the load test hits its targets and CORS behaves against a real browser.
- Every existing test suite (144 tests as of this writing) must keep passing — none of this week's work should require touching existing route logic, only adding middleware/caching/indexes around it.
- CORS lockdown must not break the BFF — the allowed origin needs to be configurable (an env var, not hardcoded), since the BFF's actual deployed origin isn't known yet (local dev uses whatever port `web-dev` runs on, which is itself now configurable per `docs/PROGRESS.md`'s port-conflict fixes).
- Redis caching must fail open, not closed — if Redis is unreachable, routes must still serve from Postgres directly (never turn a cache outage into a 500). This directly contradicts naive caching-library defaults; call it out explicitly to whichever employee builds this.
- Employee branch names use a hyphen after the boss name (`week4/security-cors-and-dependency-scanning`, not a nested slash) — same git ref constraint as every prior week.

---

## Team A: `week4/security` (2 employees)

### Employee A1: `cors-and-dependency-scanning`

**Files:** Modify `api/src/api/main.py`, `api/src/api/core/config.py`; Test: `api/tests/test_cors.py`. Modify `.github/workflows/ci.yml` (add jobs, don't touch existing ones).

**Task:**
1. Add `CORSMiddleware` to `api/src/api/main.py`, restricted to a single configurable allowed origin — add `allowed_origin: str = "http://localhost:3000"` to `api/src/api/core/config.py`'s `Settings`, and wire `app.add_middleware(CORSMiddleware, allow_origins=[Settings().allowed_origin], allow_methods=["GET"], allow_headers=["X-API-Key", "Content-Type"])`. Every route here is `GET`-only today (confirm this by reading the three routers before hardcoding the method list) — don't allow more than what's actually used.
2. Write `test_cors.py`: use `TestClient` to confirm a request with an `Origin` header matching `allowed_origin` gets the right `Access-Control-Allow-Origin` response header, and a request with a different `Origin` does NOT get that header (FastAPI's CORS middleware doesn't reject the request outright for simple requests — the browser is what enforces the block based on the missing header — so assert on the header's absence/presence, not a status code).
3. Add a `dependency-audit` job to `.github/workflows/ci.yml`: for each of `db`/`ingestion`/`api`/`quality`, run `uv run pip-audit` (add `pip-audit` as a dev dependency in each, or run it via `uvx pip-audit` to avoid touching every `pyproject.toml` — your call, document which you chose and why); for `web`, add `npm audit --audit-level=high` as a step in the existing `web-check` job (don't create a whole new job for one line). Don't fail the whole CI run on pre-existing vulnerabilities you can't fix this week — run the audit and report findings in your PR, and only make the CI job fail on *new* findings if you can cheaply distinguish that (a baseline/ignore-file approach); if that's not cheap, just add the job as informational (`continue-on-error: true`) and say so explicitly in your PR rather than silently making it a hard gate that could block unrelated future PRs on an old third-party CVE nobody's addressed.
4. Add a `gitleaks` step to CI using the official `gitleaks/gitleaks-action` GitHub Action (pin an exact version tag, don't use a floating `@master`/`@latest`).

**Skills for this task:** superpowers:test-driven-development for the CORS header test. Use superpowers:verification-before-completion — run the new CI YAML through a YAML validity check (`python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"`, using a venv that actually has `pyyaml` — e.g. any of the four services' `.venv`) before claiming it's correct, since you can't actually run GitHub Actions locally to confirm the jobs execute.

### Employee A2: `injection-audit-and-audit-log`

**Files:** Test: `api/tests/test_security_audit.py` (new). Create: `db/migrations/versions/<rev>_create_audit_log_table.py`, modify `db/src/db/models.py`, `db/tests/test_models.py`. Create: `docs/security-audit.md`.

**Task:**
1. Write `api/tests/test_security_audit.py` — a suite of adversarial tests against the existing three routers, proving (not asserting-by-inspection, actually running) that:
   - SQL injection via the `?date=` query param on `/games` is rejected (e.g. `?date=2024-01-01' OR '1'='1`, `?date=2024-01-01; DROP TABLE games;--`) — the route already validates via `date.fromisoformat()` raising `HTTPException(400)` on parse failure per `api/src/api/routers/games.py`; confirm this actually blocks every injection string you try, don't just trust it does.
   - Every route except `/health` returns `401` with a missing `X-API-Key` header, an empty one, and a wrong one (not just "no header" — the existing `test_health.py`/router-specific tests may already cover the missing case; add the empty-string and wrong-value cases if they're not already covered, don't duplicate what exists).
   - The API key never appears in any response body or header (a basic response-inspection test — grep the full response object for the configured `api_service_key` value across all three routes).
2. Add a new `AuditLog` table to `db/src/db/models.py` (Meta layer, per `docs/prd.md` §08's "Audit log table for any manual write/override"): `id` (pk), `actor` (str, not null — who/what performed the action), `action` (str, not null), `detail` (JSONB, nullable), `created_at` (timestamptz, not null, server default now()). Hand-write the Alembic migration chaining after the current head, matching the existing migrations' style, including the `ingestion_writer`/`api_reader` grants (this table is written by whichever process performs a manual override — for now, grant `INSERT, SELECT` to `ingestion_writer` as the more privileged of the two roles, since there's no manual-override feature built yet to know its actual actor identity; note this in a migration comment as provisional). Add a structural test to `db/tests/test_models.py`.
3. Write `docs/security-audit.md` documenting the pass per `docs/prd.md` §08's "Definition of done": what was tested, what passed, what's still open (e.g., TLS is a deployment-time concern not applicable to local dev; note it as deferred, not done). This is the resume-worthy "ran a manual security review" artifact the PRD explicitly calls for — write it like a real audit report, not a checklist with checkmarks and no detail.

**Skills for this task:** superpowers:test-driven-development for the adversarial test suite — table-driven tests over a list of injection strings/bad-header variants read better than one test per case. superpowers:systematic-debugging if any existing route doesn't behave as expected once you actually test it adversarially rather than trusting the code read-through.

---

## Team B: `week4/performance` (2 employees)

### Employee B1: `caching-and-indexes`

**Files:** Create: `api/src/api/core/cache.py`. Modify `api/src/api/routers/games.py`, `api/src/api/routers/quality.py`, `api/src/api/core/config.py`, `api/pyproject.toml` (add `redis` client dependency). Create: `db/migrations/versions/<rev>_add_meta_table_indexes.py`. Modify `dbt/models/marts/games.yml`, `dbt/models/marts/player_game_stats.yml` (or `.sql` files, whichever dbt's Postgres index config actually requires — check dbt-postgres's docs/existing model config syntax for `+indexes:` before assuming the exact key placement).

**Task:**
1. Add `redis` (the Python client) as a real dependency of `api/` (currently only `REDIS_URL` exists as an unused config value). Build a small `api/src/api/core/cache.py`: a `get_cache_client()` returning a `redis.Redis` instance from `Settings().redis_url`, and a `cached_json(key: str, ttl_seconds: int, compute: Callable[[], dict]) -> dict` helper — **must fail open**: wrap the Redis read/write in try/except, falling through to calling `compute()` directly (uncached) on *any* Redis error (connection refused, timeout, etc.), not just returning a 500. Log the failure at a level that won't spam production logs on a truly-down Redis (e.g. don't log on every single request if Redis has been down for an hour — a simple "log once, then suppress for N seconds" pattern is enough, don't over-engineer a circuit breaker for this).
2. Apply `cached_json` to `GET /games` (TTL ~15s — this data changes as slowly as the backfill/live flows run) and `GET /quality` (TTL ~30s) — cache key should incorporate the query params that affect the response (e.g. `games:{date or 'recent'}`) so a `?date=` filter doesn't collide with the unfiltered response in the cache.
3. Write tests with a fake/mock Redis client (or a real `fakeredis` dependency if you judge that's cleaner than hand-rolling a fake — your call) proving: (a) a cache hit skips calling the underlying reader, (b) a cache miss calls it and populates the cache, (c) **a Redis connection error still returns the correct data** (the fail-open behavior specifically — this is the one behavior most worth testing here, since it's invisible until Redis is actually down).
4. Add indexes: `db/migrations` — a new migration adding indexes on `quality_metrics(check_name, run_at)`, `schema_change_log(detected_at)`, `source_conflicts(detected_at)` (matching the actual query patterns already in `api/src/api/routers/quality.py` — read that file to confirm the exact columns/ordering used, e.g. `ORDER BY ... DESC LIMIT N` benefits from a descending index). For the dbt-owned Gold tables (`games`, `player_game_stats`), add an index on `games.game_date` (the `/games?date=` filter's actual predicate) via dbt's Postgres-specific `indexes` model config — verify the exact YAML/config key against `dbt/.venv`'s installed `dbt-postgres` adapter docs or by testing it with `dbt run` if you have a way to check syntax validity without a live DB (e.g. `dbt compile` and reading the generated post-hook SQL), since getting this config key wrong would silently no-op rather than error loudly.

**Skills for this task:** superpowers:test-driven-development for the cache fail-open behavior specifically — write that test first, since it's the one most likely to be silently wrong. superpowers:systematic-debugging if the dbt index config doesn't produce the SQL you expect.

### Employee B2: `connection-pooling-and-load-test`

**Files:** Modify `api/src/api/routers/games.py`, `api/src/api/routers/quality.py`, `api/src/api/routers/live.py` (or wherever each creates its `Engine` — consolidate into one shared engine-factory helper if they don't already share one, since tuning pool settings in three separate places invites drift). Create: `api/loadtest/locustfile.py`, `api/loadtest/README.md`.

**Task:**
1. Read how each of the three routers currently constructs its SQLAlchemy `Engine`/session (they were built by three different employees in Week 3 and may not be consistent). Consolidate connection-pool configuration into one place if they're not already sharing an engine — `pool_size` and `max_overflow` should be explicit, sensibly small values (e.g. `pool_size=5, max_overflow=10` — this is a low-traffic portfolio project's API, not a production system needing hundreds of connections; document why you picked whatever numbers you pick, don't cargo-cult a large default). Note in your PR whether true `pgbouncer` (a separate proxy process) is worth adding this week — per `docs/prd.md` §09, it's listed as a nice-to-have alongside caching/indexing, not a hard requirement, and given this project's actual traffic profile (a solo portfolio project, not real production load), recommend against standing up a whole extra service for it now unless you find a concrete reason to.
2. Write `api/loadtest/locustfile.py` using `locust` (add as a dev dependency): simulate the "live game window" scenario from `docs/prd.md` §09 — concurrent requests to `/games`, `/quality`, and connections to `/live` (SSE — locust can open and briefly hold a streaming connection; don't try to fully simulate long-lived SSE semantics, a connect-and-read-a-few-events pattern is enough), all authenticated with a configurable API key (read from an env var, never hardcode a real one). Write `api/loadtest/README.md` explaining how to run it (`locust -f loadtest/locustfile.py --host http://localhost:8001` or whatever port the human's actually running on — reference `docs/PROGRESS.md`'s port-configurability notes rather than assuming 8000) and what to look for (p95 latency < 300ms per `docs/prd.md` §09).
3. **You cannot actually run this against a live server in this sandbox** — no Docker, no running API process. Verify what you can: the locustfile at least imports and parses correctly (`uv run python -c "import loadtest.locustfile"` or equivalent), and its logic is sound by reading it carefully. Say so explicitly and prominently in your PR — this is exactly the kind of task where the human (who has live infra working) needs to actually run it once to get real numbers; don't claim performance targets are met without that run having happened.

**Skills for this task:** superpowers:verification-before-completion — be explicit and honest about the boundary between "the code is correct by inspection" and "the performance target is actually met," since this task can't produce the latter kind of evidence in this sandbox.

---

## Verification (both bosses, before reporting to the human)

- `api`: `uv run pytest -v` (existing 18 + new CORS/security-audit/cache tests). Confirm the fail-open Redis behavior test specifically passes.
- `db`: `uv run pytest -v` (existing 11 + new `AuditLog` test) and `uv run alembic upgrade head --sql` (confirm both new migrations — audit log table, Meta-table indexes — chain correctly after the current head and emit sane DDL).
- CI YAML: both bosses independently validate `.github/workflows/ci.yml` parses as valid YAML and re-read the new jobs for sense (a job that's supposed to run `pip-audit` against four different services needs four different working directories, for instance — an easy copy-paste mistake to catch only by actually reading it).
- Neither boss can verify against a live Postgres, live Redis, real GitHub Actions execution, or real load — say so plainly in the final report, same as every prior week's "needs live infra" caveats, but this week that infra is one message away (the human's machine) rather than fully unavailable — flag load-test results and CORS-against-a-real-browser as things worth the human actually running once merged.

## Execution Handoff

Both boss branches are created and their teams dispatched in parallel immediately after this plan is saved, matching every prior week. The human sign-off gate remains the final merge into `main`.
