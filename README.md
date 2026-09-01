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

```bash
cp .env.example .env        # fill in BALLDONTLIE_API_KEY and API_SERVICE_KEY
make up                     # starts Postgres + Redis
cd ingestion && uv run pytest
cd api && uv run pytest && uv run uvicorn api.main:app --reload
cd web && npm run dev
```

`make down` stops the compose stack; `make logs` tails it.

## Status

Scaffolding only — see `docs/superpowers/plans/2026-08-31-project-scaffolding.md`
for what's stubbed vs. real, and the PRD's week-by-week plan for what's next.
