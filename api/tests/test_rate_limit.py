"""Boss-level verification: rate limiting is actually enforced, not just decorated.

None of the three employee PRs (games/quality/live) wrote a test that drives
a route past `DEFAULT_RATE_LIMIT` and checks for a `429` — each one only
confirmed the `@limiter.limit(...)` decorator and `require_api_key` dependency
were present/wired. `slowapi`'s default limiter uses an in-memory store, so
unlike a real Postgres/Redis dependency, actual enforcement *can* be verified
in this sandbox with no external services — this test does that, using
`/games/` (with `get_games_reader` overridden to a trivial fake) as the
route under test, since which route is used doesn't matter: all three routers
share the same `limiter`/`DEFAULT_RATE_LIMIT` from `api.core.rate_limit`.

`slowapi`'s `Limiter` keeps its counters in a process-wide, in-memory store
for the lifetime of the app object, keyed by `_key_by_api_key` (the
`X-API-Key` header). This test uses its own dedicated API key so its request
volume can't bleed into (or be affected by) any other test's count against
`DEFAULT_RATE_LIMIT`.
"""

from fastapi.testclient import TestClient

from api.main import app
from api.routers.games import get_games_reader

RATE_LIMIT_TEST_API_KEY = "test-rate-limit-key"


class _EmptyGamesReader:
    def list_games(self, filter_date, start_date=None, end_date=None):
        return []


def test_rate_limit_is_actually_enforced_with_429(monkeypatch):
    """Hit /games/ well past the 600/minute default limit and confirm a 429.

    `DEFAULT_RATE_LIMIT` is "600/minute" (`api/src/api/core/rate_limit.py`,
    raised from an original 100/minute after a real load test showed that
    value rejecting ~48% of normal traffic under realistic concurrency,
    since every caller shares one global budget via the single BFF key).
    A dedicated API key keeps this test's ~610 requests isolated from every
    other test's rate-limit counter (`_key_by_api_key` keys on `X-API-Key`).
    """
    monkeypatch.setenv("API_SERVICE_KEY", RATE_LIMIT_TEST_API_KEY)
    app.dependency_overrides[get_games_reader] = lambda: _EmptyGamesReader()
    try:
        with TestClient(app) as client:
            headers = {"X-API-Key": RATE_LIMIT_TEST_API_KEY}
            statuses = [
                client.get("/games/", headers=headers).status_code for _ in range(610)
            ]
    finally:
        app.dependency_overrides.pop(get_games_reader, None)

    ok_count = statuses.count(200)
    rate_limited_count = statuses.count(429)

    # The first 600 requests within the window succeed; anything past that
    # is rejected with 429 — enforcement, not just decoration.
    assert ok_count == 600, f"expected exactly 600 requests to succeed, got {ok_count}"
    assert rate_limited_count > 0, "expected at least one 429 once the limit was exceeded"
    assert ok_count + rate_limited_count == len(statuses)
    # Once limited, every subsequent request in this window stays limited.
    assert statuses[-1] == 429
