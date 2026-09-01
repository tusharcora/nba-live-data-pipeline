# Live Box Score Pipeline & Data Quality Observatory

An end-to-end data engineering project built on NBA box score and live game
data — the portfolio-differentiating work is the ingestion, reconciliation,
and drift monitoring, not the dashboard on top of it.

Full design doc: [`docs/prd.md`](docs/prd.md) (source: [PRD artifact](https://claude.ai/code/artifact/1f4076ad-1c3c-403a-b3a5-d987db3f10d0)).

## Layout

This is a monorepo of four independently-deployable services plus shared
infra, matching the architecture diagram in the PRD:

| Path         | What it is                                                        |
|--------------|--------------------------------------------------------------------|
| `ingestion/` | Prefect flows — `backfill_flow` (historical) and `live_game_flow` (polling), pulling from two independent sources (balldontlie API + a public live-scoreboard feed) into Postgres Bronze. |
| `dbt/`       | dbt project — Silver (typed/deduped staging) and Gold (`games`, `player_game_stats`) models. |
| `api/`       | FastAPI serving layer — reads Gold + quality tables, API-key auth on every route, never faces the browser directly. |
| `web/`       | Next.js app (Vercel) — the BFF. Holds the FastAPI API key server-side and is the only thing the browser talks to; re-streams FastAPI's live SSE via `EventSource`. |
| `docs/`      | PRD and other design docs. |

## Quickstart

Requires Docker Desktop running, Node 20+, Python 3.13 + [uv](https://docs.astral.sh/uv/), and (optionally, for real data) a free [balldontlie](https://balldontlie.io) API key.

```bash
cp .env.example .env            # fill in BALLDONTLIE_API_KEY and API_SERVICE_KEY (any random string)
make up                         # starts Postgres + Redis
make ps                         # confirm both are healthy

cd db && uv run alembic upgrade head   # creates the schema + least-privilege roles
cd ../dbt && cp profiles.yml.example profiles.yml && uv run dbt deps && uv run dbt run
```

Then, per service (each has its own `uv`/`npm` project — see the table above):

```bash
cd db        && uv run pytest -v      # 11 tests
cd ingestion && uv run pytest -v      # 61 tests
cd api       && uv run pytest -v      # 18 tests (includes real rate-limit enforcement)
cd quality   && uv run pytest -v      # 54 tests
cd dbt       && uv run dbt parse --no-partial-parse
cd web       && npm ci && npx next typegen && npx tsc --noEmit && npm run lint && npm run build
```

To actually run the stack:

```bash
cd api && uv run uvicorn api.main:app --reload --port 8000
cd web && cp .env.local.example .env.local  # set FASTAPI_BASE_URL + API_SERVICE_KEY to match api/.env
     && npm run dev                          # http://localhost:3000, /live, /quality
```

Pull some real historical data before expecting `/games`/`/quality` to show anything (requires `BALLDONTLIE_API_KEY`):

```bash
cd ingestion && uv run python -c "
from ingestion.flows.backfill_flow import backfill_flow
print(backfill_flow(start_date='2024-01-01', end_date='2024-01-03'))
"
cd ../dbt && uv run dbt run   # rebuild Gold tables against the new raw_pulls rows
```

`ingestion` and `api` each prefer their own least-privilege DB role DSN —
`INGESTION_DATABASE_URL` (`ingestion_writer`) and `API_DATABASE_URL`
(`api_reader`) respectively — and fall back to the admin `DATABASE_URL` if unset.

`make down` stops the compose stack; `make logs` tails it. CI (`.github/workflows/ci.yml`) runs all of the above automatically on every push/PR, including `dbt` against a real ephemeral Postgres.

## Status

Weeks 1-3 of the PRD's plan are built and merged (schema/roles, resumable ingestion,
the quality gate, real API endpoints, the Next.js BFF, and a UI pass using
`shadcn/ui` + a persisted `ui-ux-pro-max` design system). See `docs/prd.md` §12 for
the week-by-week plan and what's next (Week 4: security hardening & performance).
Everything was built and tested without a live Postgres/Docker available in the
build environment — this is likely the first time it's been run end-to-end against
real infrastructure, so expect to shake out a few things (see each service's
`CLAUDE.md`-documented "needs live infra to confirm" caveats).
