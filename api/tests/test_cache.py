"""Unit tests for `api.core.cache.cached_json` — the fail-open Redis wrapper.

Per docs/superpowers/plans/2026-09-02-week4-security-and-performance.md
(Employee B1), the behavior most worth getting right here is (c): a broken
Redis connection must never turn into a 500, or into any wrong data at all
— the route must transparently fall back to the uncached compute path. That
test is written first and is the most heavily commented of the three.

Uses `fakeredis` for the "Redis is up" hit/miss cases (a real client
interface, not a hand-rolled stub, so we're exercising `cached_json`
against realistic `get`/`set` semantics) and a hand-rolled broken client for
the fail-open case, since fakeredis doesn't simulate a dead connection.
"""

from __future__ import annotations

import json

import fakeredis
import pytest
import redis

from api.core.cache import cached_json


class _CountingCompute:
    """A `compute` callable that records how many times it was invoked.

    Standing in for the "underlying reader" (`GamesReader`/`QualityReader`)
    that `cached_json` should skip calling on a cache hit and must call on
    a cache miss or a Redis failure.
    """

    def __init__(self, result: dict) -> None:
        self.result = result
        self.call_count = 0

    def __call__(self) -> dict:
        self.call_count += 1
        return self.result


class _BrokenRedisClient:
    """Simulates a completely unreachable Redis — every command raises.

    `redis-py` itself raises `redis.exceptions.ConnectionError` (a subclass
    of `redis.RedisError`) for connection-refused/timeout conditions, so
    that's what real production failures look like at this seam.
    """

    def get(self, key):
        raise redis.exceptions.ConnectionError("Error 61 connecting to localhost:6379. Connection refused.")

    def set(self, key, value, ex=None):
        raise redis.exceptions.ConnectionError("Error 61 connecting to localhost:6379. Connection refused.")


@pytest.fixture
def fake_redis():
    client = fakeredis.FakeRedis()
    yield client
    client.flushall()


# --- (c) fail-open on a Redis connection error — the case most worth getting right ---


def test_redis_connection_error_still_returns_correct_data():
    """A Redis connection error must fail open: `compute()` still runs and
    its correct result is still returned — never an exception, never a 500,
    never stale/wrong data silently swapped in.
    """
    compute = _CountingCompute({"data": ["real", "data", "from", "postgres"], "count": 4})

    result = cached_json("some:key", ttl_seconds=15, compute=compute, client=_BrokenRedisClient())

    assert result == {"data": ["real", "data", "from", "postgres"], "count": 4}
    assert compute.call_count == 1


def test_redis_connection_error_on_write_still_returns_correct_data():
    """Even if the read happens to succeed (or is skipped) but the write
    fails, the freshly-computed result must still be returned correctly.
    """

    class _ReadOkWriteBroken:
        def get(self, key):
            return None  # cache miss

        def set(self, key, value, ex=None):
            raise redis.exceptions.ConnectionError("connection reset by peer")

    compute = _CountingCompute({"ok": True})

    result = cached_json("k", ttl_seconds=15, compute=compute, client=_ReadOkWriteBroken())

    assert result == {"ok": True}
    assert compute.call_count == 1


def test_redis_error_does_not_propagate_as_an_exception():
    """Never raise — that's the whole point of failing open."""
    compute = _CountingCompute({"fine": "yes"})

    try:
        result = cached_json("k", ttl_seconds=15, compute=compute, client=_BrokenRedisClient())
    except Exception as exc:  # pragma: no cover - the assertion below is what matters
        pytest.fail(f"cached_json raised instead of failing open: {exc!r}")

    assert result == {"fine": "yes"}


# --- (a) cache hit skips the underlying reader ---


def test_cache_hit_skips_compute(fake_redis):
    fake_redis.set("games:recent", json.dumps({"data": [{"game_id": 1}], "count": 1}))
    compute = _CountingCompute({"data": ["should", "not", "be", "returned"], "count": 4})

    result = cached_json("games:recent", ttl_seconds=15, compute=compute, client=fake_redis)

    assert result == {"data": [{"game_id": 1}], "count": 1}
    assert compute.call_count == 0


# --- (b) cache miss calls the reader and populates the cache ---


def test_cache_miss_calls_compute_and_populates_cache(fake_redis):
    compute = _CountingCompute({"data": [{"game_id": 2}], "count": 1})

    result = cached_json("games:recent", ttl_seconds=15, compute=compute, client=fake_redis)

    assert result == {"data": [{"game_id": 2}], "count": 1}
    assert compute.call_count == 1

    # And it's actually in the cache now, under the right key and TTL.
    stored = fake_redis.get("games:recent")
    assert stored is not None
    assert json.loads(stored) == {"data": [{"game_id": 2}], "count": 1}
    ttl = fake_redis.ttl("games:recent")
    assert 0 < ttl <= 15


def test_second_call_after_miss_is_a_hit_and_skips_compute_again(fake_redis):
    """End-to-end sanity check tying (a) and (b) together against one
    fakeredis instance: miss then populate, then a second call for the same
    key is a hit that does not call compute again.
    """
    compute = _CountingCompute({"data": [{"game_id": 3}], "count": 1})

    first = cached_json("games:2026-01-01", ttl_seconds=15, compute=compute, client=fake_redis)
    second = cached_json("games:2026-01-01", ttl_seconds=15, compute=compute, client=fake_redis)

    assert first == second == {"data": [{"game_id": 3}], "count": 1}
    assert compute.call_count == 1


def test_different_keys_do_not_collide(fake_redis):
    """Cache keys must incorporate the query params that affect the
    response — e.g. `/games` (unfiltered) vs `/games?date=...` (filtered)
    must not share a cache entry.
    """
    recent_compute = _CountingCompute({"data": ["recent"], "count": 1})
    filtered_compute = _CountingCompute({"data": ["2026-01-01-only"], "count": 1})

    recent = cached_json("games:recent", ttl_seconds=15, compute=recent_compute, client=fake_redis)
    filtered = cached_json(
        "games:2026-01-01", ttl_seconds=15, compute=filtered_compute, client=fake_redis
    )

    assert recent == {"data": ["recent"], "count": 1}
    assert filtered == {"data": ["2026-01-01-only"], "count": 1}
    assert recent_compute.call_count == 1
    assert filtered_compute.call_count == 1


def test_corrupt_cache_value_falls_back_to_compute_instead_of_raising(fake_redis):
    """A non-JSON value somehow sitting at the key (e.g. a bad manual write)
    must not crash the route — treat it like a miss.
    """
    fake_redis.set("bad:key", b"not-valid-json{{{")
    compute = _CountingCompute({"data": ["recomputed"], "count": 1})

    result = cached_json("bad:key", ttl_seconds=15, compute=compute, client=fake_redis)

    assert result == {"data": ["recomputed"], "count": 1}
    assert compute.call_count == 1
