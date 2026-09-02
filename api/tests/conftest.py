"""Shared test fixtures for `api`.

`api.core.cache.get_cache_client()` returns a process-wide singleton pointed
at whatever `REDIS_URL` resolves to (default `redis://localhost:6379/0`). If
a real Redis happens to be reachable in the environment running these tests
(e.g. `make up`'s docker-compose Redis, or any other local Redis on the
default port), route tests that hit `/games` or `/quality` would otherwise
read/write real cache entries and leak state across test cases — exactly
the kind of "invisible until it isn't" bug this cache is meant to avoid
elsewhere. Flush the keys these routes use before and after every test so
the suite behaves identically whether or not a live Redis is present.
"""

from __future__ import annotations

import pytest

from api.core.cache import get_cache_client

_CACHE_KEY_PATTERNS = ("games:*", "quality:scorecard")


def _flush_route_cache_keys() -> None:
    try:
        client = get_cache_client()
        for pattern in _CACHE_KEY_PATTERNS:
            if "*" in pattern:
                for key in client.scan_iter(match=pattern):
                    client.delete(key)
            else:
                client.delete(pattern)
    except Exception:
        # No reachable Redis (the common case in this sandbox) — nothing to
        # flush, and this must never fail a test either way.
        pass


@pytest.fixture(autouse=True)
def _isolated_route_cache():
    _flush_route_cache_keys()
    yield
    _flush_route_cache_keys()
