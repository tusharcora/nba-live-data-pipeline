# Live Box Score Pipeline & Data Quality Observatory

An end-to-end data engineering project built on NBA box score and live game
data — the portfolio-differentiating work is the ingestion, reconciliation,
and drift monitoring, not the dashboard on top of it.

Full design doc: [`docs/prd.md`](docs/prd.md) (source: [PRD artifact](https://claude.ai/code/artifact/1f4076ad-1c3c-403a-b3a5-d987db3f10d0)). Build history and current status: [`docs/PROGRESS.md`](docs/PROGRESS.md).

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

make migrate                    # creates the schema + least-privilege roles
cd dbt && cp profiles.yml.example profiles.yml && uv run dbt deps && uv run dbt run
```

Then, from the repo root:

```bash
make test-db          # 11 tests
make test-ingestion   # 61 tests
make test-api         # 18 tests (includes real rate-limit enforcement)
make test-quality     # 54 tests
make test-all         # all four of the above
make dbt-parse
cd web && npm ci && npx next typegen && npx tsc --noEmit && npm run lint && npm run build
```

To actually run the stack:

```bash
make api-dev   # FastAPI on :8000
```
```bash
cd web && cp .env.local.example .env.local  # set FASTAPI_BASE_URL + API_SERVICE_KEY to match api/.env
make web-dev                                 # http://localhost:3000, /live, /quality
```

Pull some real historical data before expecting `/games`/`/quality` to show anything (requires `BALLDONTLIE_API_KEY`):

```bash
cd ingestion && PYTHONPATH=src:../db/src uv run python -c "
from ingestion.flows.backfill_flow import backfill_flow
print(backfill_flow(start_date='2024-01-01', end_date='2024-01-03'))
"
make dbt-run   # rebuild Gold tables against the new raw_pulls rows
```

`ingestion` and `api` each prefer their own least-privilege DB role DSN —
`INGESTION_DATABASE_URL` (`ingestion_writer`) and `API_DATABASE_URL`
(`api_reader`) respectively — and fall back to the admin `DATABASE_URL` if unset.

`make down` stops the compose stack; `make logs` tails it. CI (`.github/workflows/ci.yml`) runs all of the above automatically on every push/PR, including `dbt` against a real ephemeral Postgres.

**Why the `make` targets set `PYTHONPATH` explicitly:** `db`/`ingestion`/`api`/`quality` share the `db` package as an editable path dependency, normally made importable via a `.pth` file `uv` writes into each service's venv. On some machines — observed with iCloud Drive's "Desktop & Documents Folders" sync enabled on a project living under `~/Documents` — those `.pth` files intermittently get macOS's hidden file flag reapplied by something outside `uv`'s control, which breaks the import (`ModuleNotFoundError: No module named 'db'`) even though the venv is otherwise fine. `PYTHONPATH` bypasses that fragile file-based mechanism entirely, so the `make` targets set it defensively. If you invoke `uv run` directly instead of through `make` (e.g. for a one-off script, as in the backfill example above), add `PYTHONPATH=src:../db/src` (or just `PYTHONPATH=src` from inside `db/` itself, which has no such dependency) yourself — or diagnose the `.pth` flag directly with `find .venv/lib/python3.13/site-packages -name "*.pth" -exec stat -f "%f %N" {} \;` (a value with the `32768` bit set, e.g. `32832`, means hidden; fix with `chflags nohidden`).

## Status

See [`docs/PROGRESS.md`](docs/PROGRESS.md) for the full build log, current
status, and known caveats — kept up to date as the project develops. Short
version: Weeks 1-3 of `docs/prd.md` §12's plan plus a UI pass are built,
merged, and (as of the last `PROGRESS.md` update) verified end-to-end
against real infrastructure. Week 4 (security hardening & performance) is
next.
