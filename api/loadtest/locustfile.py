"""Locust load test simulating the "live game window" scenario from
`docs/prd.md` §09: concurrent authenticated readers hitting `/games` and
`/quality` while a smaller number of viewers hold open `/live` SSE
connections, during a window when a game is actually in progress.

Run (see `README.md` for the full explanation):

    cd api
    API_SERVICE_KEY=<your local .env's API_SERVICE_KEY> \
        uv run locust -f loadtest/locustfile.py --host http://localhost:8001

**This file has NOT been run against a live server in this sandbox** — there
is no Docker, no live Postgres, and no running `uvicorn` process available
here. It has only been verified to import cleanly and been read carefully
for logical correctness. See `README.md`'s "Verification status" section
before trusting any numbers this produces without having actually run it.

Auth: the API key is read from the `API_SERVICE_KEY` environment variable
at process start — never hardcode a real key value here. If the env var is
unset, `on_start` raises immediately so a misconfigured run fails loudly
(as 401s on every request) rather than silently producing a useless
"100% failure" report that looks like a server problem.
"""

from __future__ import annotations

import os

from locust import HttpUser, between, task

# The BFF's server-side header name (see `api/src/api/core/security.py`'s
# `require_api_key`) — never hardcode the actual key value, only its name.
API_KEY_HEADER = "X-API-Key"
API_KEY_ENV_VAR = "API_SERVICE_KEY"

# How many SSE `data:` events to read off `/live` before disconnecting.
# `/live` is a long-lived stream (up to `MAX_STREAM_DURATION_SECONDS` = 4h
# server-side) — fully simulating that per simulated user would mean each
# Locust "user" pins one connection open for hours, which defeats the point
# of a load test that's supposed to run in a few minutes and measure p95
# latency across many *requests*. Instead this treats a `/live` visit as
# "connect, read a handful of events, disconnect" — enough to exercise the
# connection-acceptance and first-few-poll-iterations path (the part that
# actually touches the DB and the pool this PR tunes) without the test
# itself becoming a long-running process.
SSE_EVENTS_TO_READ = 3

# Default line length for iterating a `requests` streaming response.
SSE_READ_CHUNK_SIZE = 512


def _require_api_key() -> str:
    key = os.environ.get(API_KEY_ENV_VAR, "")
    if not key:
        raise RuntimeError(
            f"{API_KEY_ENV_VAR} is not set. Export it before running locust, e.g.:\n"
            f'  {API_KEY_ENV_VAR}="<your local API key>" uv run locust -f loadtest/locustfile.py ...\n'
            "Never hardcode the real key value in this file."
        )
    return key


class LiveGameWindowUser(HttpUser):
    """Simulates one dashboard viewer during a live game window.

    Weighted tasks approximate a viewer whose dashboard is polling `/games`
    and `/quality` periodically while a `/live` SSE connection (opened once
    per weighted task pick, then closed after a few events) represents the
    live-score panel. `wait_time` between tasks approximates a real
    dashboard's poll cadence rather than hammering the API in a tight loop,
    which would test something other than the "live game window" scenario
    the PRD actually describes.
    """

    # 1-5s between tasks per simulated user — a real dashboard polls
    # periodically, it doesn't fire requests back-to-back with zero delay.
    wait_time = between(1, 5)

    def on_start(self) -> None:
        api_key = _require_api_key()
        self.client.headers.update({API_KEY_HEADER: api_key})

    @task(5)
    def get_games(self) -> None:
        """`GET /games` — no date filter, the "recent games" default path."""
        self.client.get("/games/", name="/games")

    @task(2)
    def get_games_for_date(self) -> None:
        """`GET /games?date=...` — the filtered path, a distinct cache key
        and query plan from the unfiltered default (see `api/src/api/core/
        cache.py` on the sibling `caching-and-indexes` branch, which keys
        its cache on exactly this distinction).
        """
        self.client.get("/games/?date=2024-01-15", name="/games?date=...")

    @task(5)
    def get_quality(self) -> None:
        """`GET /quality` — the drift/agreement scorecard."""
        self.client.get("/quality/", name="/quality")

    @task(1)
    def watch_live(self) -> None:
        """`GET /live` — open the SSE stream, read a few events, disconnect.

        Deliberately not a full streaming simulation (see
        `SSE_EVENTS_TO_READ`'s docstring above) — this measures the cost of
        *accepting* a live connection and serving its first few polls under
        concurrent load, which is what actually touches the shared
        connection pool this PR tunes. Locust's `catch_response` lets this
        task report its own success/failure/timing distinctly from a
        default streaming request, whose "response time" would otherwise be
        however long the connection happened to stay open.
        """
        events_read = 0
        with self.client.get(
            "/live/",
            name="/live (connect + first events)",
            stream=True,
            catch_response=True,
        ) as response:
            if response.status_code != 200:
                response.failure(f"unexpected status {response.status_code}")
                return
            try:
                for line in response.iter_lines(chunk_size=SSE_READ_CHUNK_SIZE):
                    if line and line.startswith(b"data:"):
                        events_read += 1
                        if events_read >= SSE_EVENTS_TO_READ:
                            break
            except Exception as exc:  # noqa: BLE001 - report as a locust failure, not a crash
                response.failure(f"error reading SSE stream: {exc}")
                return
            if events_read == 0:
                response.failure("no SSE events received before giving up")
            else:
                response.success()
