# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Live Box Score Pipeline & Data Quality Observatory — an NBA data-engineering portfolio project. The centerpiece is ingestion, source reconciliation, and drift monitoring, not the dashboard on top of it. Full spec: `docs/prd.md` (mirrors the canonical PRD artifact linked at its top — re-sync from there if they ever disagree).

## Repo layout

Polyrepo-style monorepo: four independent Python/Node projects, each with its own dependency manifest and deployed separately, plus shared infra at the root.

- `db/` — the schema authority. SQLAlchemy models + hand-written Alembic migrations for the Bronze/Meta tables (`raw_pulls`, `schema_change_log`, `quality_metrics`, `source_conflicts`, `backfill_checkpoints`) and the least-privilege Postgres roles (`ingestion_writer`, `api_reader`). No live-DB autogenerate is used — migrations are written by hand and verified offline via `alembic upgrade head --sql`.
- `ingestion/` — Prefect 3 flows (`backfill_flow`, `live_game_flow`). Imports `db` as an editable path dependency (`uv.sources` in `pyproject.toml`) to write into `raw_pulls`/`backfill_checkpoints`.
- `dbt/` — dbt-core project (`nba_pipeline`), owns the Gold layer. Staging models (`stg_games`, `stg_player_game_stats`) parse `raw_pulls.payload` JSONB directly; marts (`games`, `player_game_stats`) sit on top. dbt creates these tables itself via `dbt run`, independent of `db/`'s Alembic migrations.
- `api/` — FastAPI serving layer. Every route except `/health` is gated behind `require_api_key` (checks `X-API-Key`), and is never called by the browser directly.
- `web/` — Next.js (App Router) BFF on Vercel. Holds the FastAPI API key server-side (`lib/fastapi-client.ts`); the browser only ever talks to `web`'s own domain. Live game state is meant to reach the browser via SSE (FastAPI `StreamingResponse` re-streamed through a Next.js Route Handler) — not yet built; see `docs/prd.md` §04/§11 for the intended pattern and known Vercel streaming gotchas before implementing it.

Data flows Bronze (`raw_pulls`, append-only, written by `ingestion`) → Silver/Gold (`stg_*`/marts, built by `dbt`) → served by `api` → proxied by `web`.

## Config pattern

Every Python service defines its own `Settings(BaseSettings)` in a `config.py`, reading from env vars (`.env`, see root `.env.example` for the full set). `ingestion` and `api` each expose a `runtime_database_url` property that prefers a role-scoped DSN (`INGESTION_DATABASE_URL` / `API_DATABASE_URL`) and falls back to the admin `DATABASE_URL` — use `runtime_database_url`, not `database_url`, for any actual query/write path.

## Testing without live infrastructure

The whole codebase is designed to be verified without a running Postgres or real external API calls, and most day-to-day work here should follow the same pattern:

- **Prefect flows use `@runtime_checkable` Protocol-based dependency injection** (see `ingestion/src/ingestion/flows/backfill_flow.py`: `RawPullSink`, `CheckpointStore`, `GamesPageSource`). This isn't optional style — Prefect builds a Pydantic parameter schema from a flow's type hints at decoration time, so a bare (non-runtime-checkable) `Protocol` crashes at import, and a concrete-class annotation rejects duck-typed test fakes via `isinstance`. New flow parameters that need fakes in tests must follow the same pattern.
- **HTTP clients are tested with mocked responses** (`unittest.mock.patch` on `httpx.get`), never real network calls.
- **Alembic migrations are verified offline**: `alembic upgrade head --sql` / `alembic downgrade base --sql` emit DDL without connecting to a database — read the emitted SQL, don't just check the exit code.
- **dbt is verified with `dbt parse --no-partial-parse`** (safe, no connection needed). Plain `dbt compile` eagerly opens a live Postgres connection to warm its relation cache and will fail with "connection refused" if no DB is reachable — use `dbt compile --no-populate-cache` to get the rendered SQL in `target/compiled/` without a live connection.
- `raw_pulls` is append-only, so staging models always de-duplicate via `row_number() over (partition by <id> order by pulled_at desc)` before anything downstream consumes them — follow this pattern for any new staging model.
- The exact balldontlie `/games` and `/stats` JSON shapes assumed in `dbt/models/staging/*.sql` are documented in each file's header comment but are **not yet validated against real ingested data** — check that comment before trusting a column's extraction path.

## Commands

Bring up shared infra (Postgres 16 + Redis 7):
```bash
cp .env.example .env
make up            # docker compose up -d
make down
make logs
```

Per Python service (`db/`, `ingestion/`, `api/`), from that service's directory:
```bash
uv run pytest -v                       # all tests
uv run pytest tests/test_foo.py::test_name -v   # single test
```

`db/` migrations:
```bash
cd db
uv run alembic upgrade head            # apply, needs a live DB
uv run alembic upgrade head --sql      # offline dry-run, no DB needed
uv run alembic revision -m "message"   # new migration (written by hand, not autogenerated)
```

`dbt/`:
```bash
cd dbt
cp profiles.yml.example profiles.yml   # gitignored; fill in / rely on env vars
uv run dbt deps
uv run dbt parse --no-partial-parse    # validates the DAG, no live DB needed
uv run dbt compile --no-populate-cache # renders SQL without a live connection
uv run dbt run                         # needs a live DB
uv run dbt test                        # needs a live DB
```

`api/`:
```bash
cd api
uv run uvicorn api.main:app --reload
```

`web/`:
```bash
cd web
npm run dev
npx tsc --noEmit
npm run lint
```

CI (`.github/workflows/ci.yml`) runs `ingestion-test`, `api-test`, `db-test` (all `uv run pytest -v`), `web-check` (`tsc` + `eslint`), and `dbt-parse` (against a real `postgres:16-alpine` service container) on every push/PR.
