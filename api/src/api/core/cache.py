"""Fail-open Redis caching for hot read paths (`GET /games`, `GET /quality`).

Redis has been provisioned since Week 1 (`Settings().redis_url`) but never
actually used by any code — this module is the first consumer.

Per `docs/prd.md` §09 and the Week 4 performance plan, caching here must
**fail open**: if Redis is unreachable or misbehaving for any reason
(connection refused, timeout, a bad `REDIS_URL`, whatever), a route must
still serve the correct data straight from Postgres. A cache outage must
never become a 500 — that would make the API *less* reliable than having no
cache at all, which defeats the entire point of adding one to a read path
that's otherwise fine without it.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from typing import Any

import redis

from api.core.config import Settings

logger = logging.getLogger(__name__)

_client: redis.Redis | None = None

# "Log once, then suppress for N seconds" — enough to avoid spamming
# production logs if Redis is down for an extended stretch, without
# building a full circuit breaker for what is a best-effort cache.
_LOG_SUPPRESS_SECONDS = 60.0
_last_logged_at: float = 0.0


def get_cache_client() -> redis.Redis:
    """Lazily-built, process-wide `redis.Redis` client from `Settings().redis_url`.

    Constructing a `redis.Redis` client never itself opens a socket (the
    client connects lazily on first command) so this alone can't raise a
    connection error — that only ever surfaces inside `cached_json`'s
    try/except, which is where fail-open behavior lives.

    Falls back to the same default `.env.example` documents
    (`redis://localhost:6379/0`) when `redis_url` is unset, so a missing
    config value degrades to "probably not reachable" (caught and handled
    below) rather than a `from_url` parse error on an empty string.
    """
    global _client
    if _client is None:
        url = Settings().redis_url or "redis://localhost:6379/0"
        _client = redis.Redis.from_url(
            url,
            socket_connect_timeout=0.5,
            socket_timeout=0.5,
        )
    return _client


def _log_failure_once(exc: Exception) -> None:
    global _last_logged_at
    now = time.monotonic()
    if now - _last_logged_at >= _LOG_SUPPRESS_SECONDS:
        logger.warning(
            "Cache unavailable, falling back to direct read (uncached): %r", exc
        )
        _last_logged_at = now


def cached_json(
    key: str,
    ttl_seconds: int,
    compute: Callable[[], dict[str, Any]],
    client: redis.Redis | None = None,
) -> dict[str, Any]:
    """Cache-aside read-through around `compute`.

    On a cache hit, returns the previously-cached value without calling
    `compute`. On a miss, calls `compute()`, stores its result under `key`
    for `ttl_seconds`, and returns it.

    Fails open: the Redis read and the Redis write are each wrapped so that
    *any* exception raised by the client (connection refused, timeout, a
    protocol error, anything) is caught, logged (rate-limited), and treated
    as "no cache available right now" — `compute()` is still called and its
    result still returned, uncached. This function must never let a Redis
    problem propagate out as an error response. `except Exception` (rather
    than the narrower `redis.RedisError`) is deliberate here: a cache is
    only worth having if literally nothing it can do ever breaks the route
    it's wrapping.
    """
    try:
        cache = client if client is not None else get_cache_client()
        cached_value = cache.get(key)
    except Exception as exc:  # noqa: BLE001 - fail-open by design, see docstring
        _log_failure_once(exc)
        return compute()

    if cached_value is not None:
        try:
            return json.loads(cached_value)
        except (TypeError, ValueError) as exc:
            # Corrupt/unexpected cache payload — treat like a miss rather
            # than raising, so a bad cached blob can't take the route down.
            _log_failure_once(exc)

    result = compute()

    try:
        cache.set(key, json.dumps(result, default=str), ex=ttl_seconds)
    except Exception as exc:  # noqa: BLE001 - fail-open by design, see docstring
        _log_failure_once(exc)

    return result
