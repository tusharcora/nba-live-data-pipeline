# Load test — "live game window" scenario

Simulates `docs/prd.md` §09's load-test requirement: concurrent dashboard
viewers polling `/games` and `/quality` while a smaller number hold open
`/live` SSE connections, approximating traffic during an actual live game
window (as opposed to steady idle background load, which this API never
really has much of).

## Verification status — read this before trusting any numbers

**This load test has not been run against a live server.** The sandbox this
PR was built in has no Docker, no live Postgres, and no running `uvicorn`
process. What *has* been verified here:

- `loadtest/locustfile.py` imports cleanly (`uv run python -c "import
  sys; sys.path.insert(0, 'loadtest'); import locustfile"`) and Locust
  itself recognizes the `LiveGameWindowUser` class (`uv run locust -f
  loadtest/locustfile.py --list`).
- The route paths (`/games/`, `/quality/`, `/live/`), the auth header name
  (`X-API-Key`), and the response shapes referenced in comments were
  cross-checked against the actual router source
  (`api/src/api/routers/games.py`, `quality.py`, `live.py`), not assumed.
- The logic was read through carefully by eye: task weights, the SSE
  read-a-few-events-then-disconnect approach, and the `on_start` API-key
  check.

**What has NOT been verified, and needs a real run:** whether the API
actually holds p95 < 300ms under this load, whether the connection pool
sized in `api/src/api/core/db.py` (`pool_size=5, max_overflow=10`) is
sufficient or a bottleneck at whatever concurrency you choose to run this
at, and whether the `/live` SSE task behaves as expected against a real
streaming response (locally mocked/unit-tested SSE behavior in
`api/tests/test_live.py` is not the same as a real network round-trip).
**Run this once against a real server before treating any of this as
confirmed** — see `docs/PROGRESS.md`'s note on this machine's actual ports
(Postgres `5433`, Redis `6380`, API `8001`, web `3002` — defaults are
`5432`/`6379`/`8000`/`3000` for CI/other machines).

## Prerequisites

- A running API (`cd api && uv run uvicorn api.main:app --reload`) with a
  live Postgres reachable via `runtime_database_url`. Check which port
  your local `docker compose` mapped the API to before assuming `8000` —
  `docs/PROGRESS.md` documents a port-conflict fix that makes every port
  configurable per machine (`API_PORT` in the root `Makefile`); this
  particular dev machine runs the API on `8001`.
- `API_SERVICE_KEY` set to whatever `api_service_key` your local API's
  `.env` is configured with (same value `require_api_key` checks against).
  **Never commit this value or hardcode it anywhere in the locustfile.**

## Running it

```bash
cd api
API_SERVICE_KEY="<your local api_service_key>" \
    uv run locust -f loadtest/locustfile.py --host http://localhost:8001
```

Then open the Locust web UI (defaults to `http://localhost:8089`) and start
a run — pick a user count and spawn rate that approximates the traffic
you're trying to model (there is no fixed "correct" number for a solo
portfolio project; something like 20-50 concurrent simulated users is a
reasonable starting point for "a live game window with several dashboard
tabs open").

To run headless (no web UI, useful for a quick CI-style smoke run or a
scripted comparison across pool-size settings):

```bash
API_SERVICE_KEY="<your local api_service_key>" \
    uv run locust -f loadtest/locustfile.py --host http://localhost:8001 \
    --headless --users 30 --spawn-rate 5 --run-time 2m
```

## What to look for

Per `docs/prd.md` §09's performance target: **API p95 latency < 300ms.**

- In the web UI, watch the "Response Times" chart's 95th-percentile column
  per endpoint (`/games`, `/games?date=...`, `/quality`, `/live (connect +
  first events)`) — Locust reports this live and in the final summary
  table (headless mode prints the same table to stdout at the end of the
  run, and `--csv=<prefix>` will write it to files for later comparison).
- `/games` and `/quality` are the endpoints the p95 target most directly
  applies to (they're the request/response, page-load-shaped routes).
  `/live`'s reported "response time" here is connect-plus-a-few-events, not
  a full session — a slow number there points at connection setup or the
  first DB query being slow, not at the full streaming session's health.
- Watch the failure count as much as the latency numbers — a fail-open
  cache miss or a connection-pool exhaustion under load (`QueuePool limit
  of size 5 overflow 10 reached` in the API's logs) would show up as
  request failures or timeouts here, not just slower p95. If you see pool
  exhaustion at a concurrency level you consider realistic, that's the
  concrete signal to revisit `pool_size`/`max_overflow` in
  `api/src/api/core/db.py` — see that file's docstring for the current
  reasoning and why pgbouncer specifically was not added this week.
- If `/quality` or `/games` numbers look concerning, cross-check against
  the sibling `caching-and-indexes` branch's work (Redis caching + new
  indexes) once both are merged — this PR's connection pooling and that
  PR's caching/indexing both affect the same p95 number, and it's worth
  re-running this load test after both land rather than judging either one
  in isolation.
