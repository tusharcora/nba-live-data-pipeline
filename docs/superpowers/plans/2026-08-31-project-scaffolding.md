# Project Scaffolding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the empty-but-runnable skeleton of the Live Box Score Pipeline & Data Quality Observatory — five independently-deployable components (ingestion, dbt, api, web, infra) that boot and pass a smoke check, with no business logic yet.

**Architecture:** Polyrepo-style monorepo. Four independent Python/Node projects (`ingestion/`, `dbt/`, `api/`, `web/`) each with their own dependency manifest (matches the PRD's separately-deployable services), plus root-level `docker-compose.yml` (Postgres + Redis) and `.github/workflows/ci.yml`. Bronze/Silver/Gold naming and the `raw_pulls` / `games` / `quality_metrics` etc. table names from the PRD data model are reflected in directory and stub names so week-1 work has an obvious place to land.

**Tech Stack:** Python 3.13 + uv (ingestion: Prefect 3; api: FastAPI + SQLAlchemy; dbt: dbt-core + dbt-postgres), Node 20 + Next.js 14 (App Router, TypeScript) for the web BFF, Postgres 16 + Redis 7 via Docker Compose.

**Spec:** PRD artifact — https://claude.ai/code/artifact/1f4076ad-1c3c-403a-b3a5-d987db3f10d0 (full text also read into this session; see `docs/prd.md` for the section this plan implements — Week 1 "Foundations" line items plus the architecture diagram's five nodes).

## Global Constraints

- Warehouse is Postgres, not DuckDB (PRD §05: concurrent live-poller + API writers).
- No raw SQL string-building anywhere — SQLAlchemy ORM/parameterized queries only (PRD §08).
- FastAPI never faces the browser directly; only the Next.js BFF calls it (PRD §08, §11).
- Least-privilege DB roles (`ingestion_writer`, `api_reader`) are set up "from day one," not retrofitted (PRD §12, Week 1).
- Bronze layer (`raw_pulls`) is append-only/immutable (PRD §04).
- Secrets only via environment variables, never committed (PRD §08) — `.env` stays gitignored, only `.env.example` is tracked.

---

### Task 1: Repo root — git, Docker Compose, env, docs

**Files:**
- Create: `.gitignore`
- Create: `.env.example`
- Create: `docker-compose.yml`
- Create: `README.md`
- Create: `Makefile`
- Create: `docs/prd.md`

**Interfaces:**
- Produces: `DATABASE_URL`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `REDIS_URL` env var names — every later service's config reads these exact names.
- Produces: Postgres reachable at `localhost:5432` once `docker compose up -d` runs; Redis at `localhost:6379`.

- [x] **Step 1: Write `.gitignore`** covering Python (`__pycache__/`, `.venv/`, `*.egg-info/`), Node (`node_modules/`, `.next/`), env files (`.env`, `!.env.example`), dbt (`dbt_packages/`, `target/`, `logs/`), and OS cruft (`.DS_Store`).
- [x] **Step 2: Write `.env.example`** with `POSTGRES_USER=nba`, `POSTGRES_PASSWORD=nba`, `POSTGRES_DB=nba`, `DATABASE_URL=postgresql://nba:nba@localhost:5432/nba`, `REDIS_URL=redis://localhost:6379/0`, `BALLDONTLIE_API_KEY=`, `API_SERVICE_KEY=` (the key the BFF sends to FastAPI).
- [x] **Step 3: Write `docker-compose.yml`** with `postgres:16-alpine` (named volume, healthcheck via `pg_isready`) and `redis:7-alpine` services, both reading `POSTGRES_*` from `.env`.
- [x] **Step 4: Verify compose file is valid** — run `docker compose config --quiet` (no `.env` needed yet since defaults are inline); fix any YAML errors.
- [x] **Step 5: Write root `README.md`** with the five-component layout, the PRD link, and `make up` / `make down` quickstart.
- [x] **Step 6: Write `Makefile`** with `up` (`docker compose up -d`), `down` (`docker compose down`), `ps`, `logs` targets.
- [x] **Step 7: Save `docs/prd.md`** — the full PRD content (already read into this session from the artifact) as a durable local reference, so the plan's spec pointer resolves even offline.
- [x] **Step 8: Commit** — `git add .gitignore .env.example docker-compose.yml README.md Makefile docs/prd.md && git commit -m "chore: scaffold repo root, compose stack, and PRD reference"`

---

### Task 2: `ingestion/` — Prefect flows package

**Files:**
- Create: `ingestion/pyproject.toml`
- Create: `ingestion/src/ingestion/__init__.py`
- Create: `ingestion/src/ingestion/config.py`
- Create: `ingestion/src/ingestion/sources/__init__.py`
- Create: `ingestion/src/ingestion/sources/balldontlie.py`
- Create: `ingestion/src/ingestion/sources/public_feed.py`
- Create: `ingestion/src/ingestion/flows/__init__.py`
- Create: `ingestion/src/ingestion/flows/backfill_flow.py`
- Create: `ingestion/src/ingestion/flows/live_game_flow.py`
- Test: `ingestion/tests/test_flows.py`

**Interfaces:**
- Produces: `Settings` class in `config.py` (reads `DATABASE_URL`, `BALLDONTLIE_API_KEY` from env via `pydantic-settings`) — `api/` will define its own copy since the two services deploy independently, but the field names must match Task 1's env vars.
- Produces: `backfill_flow()` and `live_game_flow()` — Prefect `@flow`-decorated stub functions in their respective files, each currently just logging and returning `{"status": "stub"}`. Later weeks fill in real bodies; the names and no-arg signatures are load-bearing for Task 1's Prefect deployment config, if one is added later.

- [x] **Step 1: `uv init --package` the subproject** — run `cd ingestion && uv init --package --name ingestion --python 3.13` then `uv add prefect pydantic-settings httpx sqlalchemy psycopg[binary]` and `uv add --dev pytest`.
- [x] **Step 2: Write `config.py`** — a `pydantic-settings` `BaseSettings` subclass named `Settings` with fields `database_url: str`, `balldontlie_api_key: str = ""`, reading from env (`model_config = SettingsConfigDict(env_file=".env")`).
- [x] **Step 3: Write `sources/balldontlie.py` and `sources/public_feed.py`** — each a thin class (`BallDontLieClient`, `PublicFeedClient`) with an `__init__(self, base_url: str)` and a stub method (`get_games(self, date: str) -> list[dict]`) that raises `NotImplementedError("wired in week 1")`. This is where PRD §03's two sources plug in.
- [x] **Step 4: Write `flows/backfill_flow.py` and `flows/live_game_flow.py`** — each imports `from prefect import flow`, defines `@flow` def `backfill_flow()` / `live_game_flow()` that logs via `prefect.get_run_logger()` and returns `{"status": "stub"}`.
- [x] **Step 5: Write the failing test** in `ingestion/tests/test_flows.py`:
  ```python
  from ingestion.flows.backfill_flow import backfill_flow
  from ingestion.flows.live_game_flow import live_game_flow

  def test_backfill_flow_runs():
      assert backfill_flow() == {"status": "stub"}

  def test_live_game_flow_runs():
      assert live_game_flow() == {"status": "stub"}
  ```
- [x] **Step 6: Run it** — `cd ingestion && uv run pytest -v`. Expected: 2 passed (this confirms Prefect's flow decorator, the package layout, and the src-layout import path all actually work together, which is the real risk in a scaffold).
- [x] **Step 7: Commit** — `git add ingestion && git commit -m "chore: scaffold ingestion package with stub Prefect flows"`

---

### Task 3: `dbt/` — medallion project skeleton

**Files:**
- Create: `dbt/pyproject.toml`
- Create: `dbt/dbt_project.yml`
- Create: `dbt/packages.yml`
- Create: `dbt/profiles.yml.example`
- Create: `dbt/models/staging/_staging.yml`
- Create: `dbt/models/staging/stg_games.sql`
- Create: `dbt/models/marts/_marts.yml`
- Create: `dbt/models/marts/games.sql`

**Interfaces:**
- Consumes: nothing yet (no `raw_pulls` table exists until Task 2's flows actually write to Postgres in week 1) — models below are intentionally trivial placeholders (`select 1 as id`), not real transforms.
- Produces: `dbt_project.yml` with `name: nba_pipeline`, `profile: nba_pipeline` — `profiles.yml.example`'s top-level key must match this `profile` value exactly, or every dbt command fails with "profile not found."

- [x] **Step 1: `uv init` the subproject** — `cd dbt && uv init --name dbt-project --python 3.13` then `uv add dbt-core dbt-postgres`.
- [x] **Step 2: Write `dbt_project.yml`** — `name: 'nba_pipeline'`, `profile: 'nba_pipeline'`, `model-paths: ["models"]`, and a `models: nba_pipeline: staging: +materialized: view` / `marts: +materialized: table` config (matches PRD §04's Silver=view-ish staging, Gold=table marts split).
- [x] **Step 3: Write `packages.yml`** with `dbt_utils` (`dbt-labs/dbt_utils`, version `">=1.1.0"`) — needed later for surrogate keys on the reconciled grain tables.
- [x] **Step 4: Write `profiles.yml.example`** — a `nba_pipeline:` profile, `target: dev`, Postgres connection reading `{{ env_var('DATABASE_URL') }}`-style vars matching Task 1's `.env.example` names (host/user/password/dbname broken out, since dbt's `postgres` connector doesn't take a single DSN).
- [x] **Step 5: Write one placeholder staging + one marts model** — `stg_games.sql` (`select 1 as id, 'stub' as note`) with a matching `_staging.yml` schema file documenting the (future) column; `games.sql` in marts selecting from `{{ ref('stg_games') }}`. This exercises the `ref()` DAG wiring PRD §04 depends on, without needing a real source yet.
- [x] **Step 6: Verify the DAG parses** — `cd dbt && uv run dbt deps && uv run dbt parse --profiles-dir . --profile nba_pipeline` is not runnable without a live Postgres and a real (non-`.example`) `profiles.yml`, so instead run `uv run dbt parse --no-partial-parse` after copying `profiles.yml.example` to a git-ignored `profiles.yml` pointed at `localhost:5432` (Task 1's compose stack, started via `make up`). Expected: `Found 2 models... Done.` with no compilation errors. If Postgres isn't up yet, run `make up` first.
- [x] **Step 7: Commit** — `git add dbt && git commit -m "chore: scaffold dbt medallion project with placeholder staging/marts models"` (profiles.yml itself stays untracked per `.gitignore`).

---

### Task 4: `api/` — FastAPI serving layer

**Files:**
- Create: `api/pyproject.toml`
- Create: `api/src/api/__init__.py`
- Create: `api/src/api/main.py`
- Create: `api/src/api/core/__init__.py`
- Create: `api/src/api/core/config.py`
- Create: `api/src/api/core/security.py`
- Create: `api/src/api/routers/__init__.py`
- Create: `api/src/api/routers/games.py`
- Create: `api/src/api/routers/live.py`
- Create: `api/src/api/routers/quality.py`
- Test: `api/tests/test_health.py`

**Interfaces:**
- Produces: `app` — the FastAPI instance in `main.py`, mounting `games.router`, `live.router`, `quality.router` under `/games`, `/live`, `/quality` (exact paths PRD §11 says the BFF calls), plus an unauthenticated `GET /health`.
- Produces: `require_api_key` — a FastAPI `Depends`-compatible callable in `core/security.py`, checking `X-API-Key` against `Settings.api_service_key`; every router in this task takes it as a dependency except `/health`. This is the PRD §08 control other services rely on existing before real endpoints land.

- [x] **Step 1: `uv init --package` the subproject** — `cd api && uv init --package --name api --python 3.13` then `uv add fastapi "uvicorn[standard]" sqlalchemy "psycopg[binary]" pydantic-settings` and `uv add --dev pytest httpx`.
- [x] **Step 2: Write `core/config.py`** — `Settings(BaseSettings)` with `database_url: str`, `api_service_key: str = ""`, `redis_url: str = ""`.
- [x] **Step 3: Write `core/security.py`**:
  ```python
  from fastapi import Header, HTTPException, status
  from api.core.config import Settings

  def require_api_key(x_api_key: str = Header(default="")) -> None:
      settings = Settings()
      if not settings.api_service_key or x_api_key != settings.api_service_key:
          raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid or missing API key")
  ```
- [x] **Step 4: Write the three routers** (`games.py`, `live.py`, `quality.py`) — each an `APIRouter()` with one `GET "/"` route depending on `require_api_key`, returning `{"data": [], "note": "stub"}`.
- [x] **Step 5: Write `main.py`** — construct `app = FastAPI(title="Live Box Score Pipeline API")`, `include_router` for all three with their prefixes/tags, and a plain `@app.get("/health")` returning `{"status": "ok"}` with no auth dependency.
- [x] **Step 6: Write the failing test** in `api/tests/test_health.py`:
  ```python
  from fastapi.testclient import TestClient
  from api.main import app

  client = TestClient(app)

  def test_health_is_public():
      resp = client.get("/health")
      assert resp.status_code == 200
      assert resp.json() == {"status": "ok"}

  def test_games_requires_api_key():
      resp = client.get("/games/")
      assert resp.status_code == 401
  ```
- [x] **Step 7: Run it** — `cd api && uv run pytest -v`. Expected: 2 passed. This is the real scaffold risk worth catching now: that the auth dependency actually blocks unauthenticated requests, before any real endpoint logic is built on top of it.
- [x] **Step 8: Commit** — `git add api && git commit -m "chore: scaffold FastAPI service with stub routers and API-key auth gate"`

---

### Task 5: `web/` — Next.js BFF

**Files:**
- Create: `web/` (via `create-next-app`, TypeScript + App Router + Tailwind, no `src/` dir needed but keep default)
- Modify: `web/.env.local.example`
- Create: `web/app/api/health/route.ts`
- Create: `web/lib/fastapi-client.ts`

**Interfaces:**
- Produces: `fetchFromApi(path: string, init?: RequestInit)` in `lib/fastapi-client.ts` — a server-only helper (never imported by a client component) that reads `process.env.FASTAPI_BASE_URL` and `process.env.API_SERVICE_KEY`, attaches `X-API-Key`, and is what every future BFF route (`/api/games`, `/api/live`, `/api/quality`) will call instead of talking to FastAPI ad hoc.

- [x] **Step 1: Scaffold the app** — `npx create-next-app@latest web --typescript --tailwind --eslint --app --no-src-dir --import-alias "@/*" --use-npm` (non-interactive flags avoid the prompt wizard).
- [x] **Step 2: Write `web/.env.local.example`** with `FASTAPI_BASE_URL=http://localhost:8000` and `API_SERVICE_KEY=` (must match Task 4's `api_service_key` value once both are set locally).
- [x] **Step 3: Write `lib/fastapi-client.ts`**:
  ```typescript
  const BASE_URL = process.env.FASTAPI_BASE_URL ?? "http://localhost:8000";
  const API_KEY = process.env.API_SERVICE_KEY ?? "";

  export async function fetchFromApi(path: string, init: RequestInit = {}) {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { ...init.headers, "X-API-Key": API_KEY },
    });
    if (!res.ok) {
      throw new Error(`FastAPI ${path} responded ${res.status}`);
    }
    return res.json();
  }
  ```
- [x] **Step 4: Write `app/api/health/route.ts`** — a Next.js Route Handler that calls `fetchFromApi("/health")` and returns its JSON, proving the BFF pattern end-to-end without exposing `API_SERVICE_KEY` to the browser:
  ```typescript
  import { NextResponse } from "next/server";
  import { fetchFromApi } from "@/lib/fastapi-client";

  export async function GET() {
    try {
      const data = await fetchFromApi("/health");
      return NextResponse.json(data);
    } catch (err) {
      return NextResponse.json({ status: "unreachable" }, { status: 502 });
    }
  }
  ```
- [x] **Step 5: Verify it builds** — `cd web && npx tsc --noEmit && npm run lint`. Expected: no type errors, no lint errors. (`npm run build` also works but is slower; type-check + lint is enough to catch scaffold mistakes.)
- [x] **Step 6: Commit** — `git add web && git commit -m "chore: scaffold Next.js BFF with server-only FastAPI client and health passthrough route"`

---

### Task 6: CI skeleton

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `ingestion/`, `api/` (`uv run pytest`), `dbt/` (`dbt parse`, no live DB in CI yet — deferred to when Postgres-in-CI is worth the complexity), `web/` (`npm run lint`, `npx tsc --noEmit`) from Tasks 2-5.

- [x] **Step 1: Write `.github/workflows/ci.yml`** — one workflow, four jobs (`ingestion-test`, `api-test`, `web-check`, `dbt-parse`), each `on: [push, pull_request]`, using `astral-sh/setup-uv@v3` for the Python jobs and `actions/setup-node@v4` for the web job. Each job runs the exact command verified in Steps 6/7/6 of Tasks 2/4/5, plus `dbt parse` for the dbt job (using SQLite... no — dbt requires the adapter; since there's no live Postgres in CI yet, this job just runs `uv run dbt deps` and `uv run dbt parse --profiles-dir .` against a minimal in-workflow `profiles.yml` pointing at a `postgres:16-alpine` service container, matching `docker-compose.yml`'s image so the two never drift).
- [x] **Step 2: Sanity-check the YAML locally** — `python3 -c "import yaml, sys; yaml.safe_load(open('.github/workflows/ci.yml'))"` (no `act` dependency required for a scaffold; full validation happens on first real push).
- [x] **Step 3: Commit** — `git add .github && git commit -m "chore: add CI skeleton for all four services"`
