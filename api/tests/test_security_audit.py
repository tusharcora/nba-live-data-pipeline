"""Adversarial security test suite (docs/prd.md §08's "Definition of done":
"a manual pass attempting SQL injection and auth bypass against every
route"). This module is that pass, encoded as tests that actually run
requests through the FastAPI `TestClient` rather than asserting-by-reading
the route source and trusting it.

Three things this suite proves:

1. SQL-injection-shaped `?date=` values on `GET /games` are rejected with a
   400 by `date.fromisoformat()` (see `api/src/api/routers/games.py`)
   *before* ever reaching a `GamesReader` — proven by asserting the injected
   fake reader's `list_games` is never called for any malicious string, not
   just that the HTTP status code happens to be right. `app.dependency_overrides`
   swaps in a fake reader so this needs no live Postgres — the point is
   proving the validation layer rejects bad input before it ever reaches a
   query, not testing the DB.
2. Every route gated by `require_api_key` (`/games/`, `/quality/`, `/live/`)
   returns 401 for a missing `X-API-Key` header, an empty-string header, a
   wrong value, and the *correct* value in the wrong case (`require_api_key`
   does a plain Python `!=` comparison — see `api/src/api/core/security.py`
   — so a case-only mismatch must still be rejected). The missing-header
   case is already covered per-route by `test_health.py` (`/games/`),
   `test_quality.py`, and `test_live.py`; this suite adds the empty/wrong
   /wrong-case variants those files don't cover.
3. The configured API key never leaks into any response body or header,
   across all three routes, on both an authorized (200) and a rejected
   (401) call — a basic response-inspection check per §08's "the FastAPI
   API key never appears in the browser's network tab or JS bundle".

A dedicated API key (`AUDIT_API_KEY`) keeps this file's ~40-odd requests on
their own slowapi rate-limit bucket, independent of every other test
module's counters — `slowapi`'s in-memory `Limiter` lives for the whole
test session's `app` instance and keys by the `X-API-Key` header value (see
`api/src/api/core/rate_limit.py`'s `_key_by_api_key` and
`test_rate_limit.py`'s docstring for why this isolation matters).
"""

from __future__ import annotations

from datetime import date

import pytest
from fastapi.testclient import TestClient

from api.main import app
from api.routers.games import get_games_reader
from api.routers.live import get_live_state_reader, get_stream_max_duration_seconds
from api.routers.quality import get_quality_reader

AUDIT_API_KEY = "sec-audit-suite-key-8821"


# --- fakes -------------------------------------------------------------

class _CountingGamesReader:
    """Records every call so a test can assert the reader was never reached
    for a rejected input — proving the *validation layer*, not the DB or a
    lucky empty result set, is what's doing the rejecting."""

    def __init__(self) -> None:
        self.calls: list[date | None] = []

    def list_games(self, filter_date: date | None) -> list[dict]:
        self.calls.append(filter_date)
        return []


class _EmptyQualityReader:
    def latest_metric_rows(self):
        return []

    def recent_schema_changes(self, limit):
        return []

    def recent_conflicts(self, limit):
        return 0, []


class _EmptyLiveReader:
    def get_latest_states(self):
        return []


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("API_SERVICE_KEY", AUDIT_API_KEY)
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.pop(get_games_reader, None)
    app.dependency_overrides.pop(get_quality_reader, None)
    app.dependency_overrides.pop(get_live_state_reader, None)
    app.dependency_overrides.pop(get_stream_max_duration_seconds, None)


# --- 1. SQL injection against /games?date= ------------------------------

# A grab-bag of classic tautology, stacked-query, UNION, comment-terminator,
# blind-timing, and non-SQL (XSS, null-byte) adversarial payloads. None of
# these are valid `YYYY-MM-DD` strings, so all of them must be rejected by
# `date.fromisoformat()` regardless of *why* they're malformed.
SQL_INJECTION_DATE_STRINGS = [
    "2024-01-01' OR '1'='1",
    "2024-01-01; DROP TABLE games;--",
    "' UNION SELECT * FROM api_reader--",
    "1' OR '1'='1' --",
    "2024-01-01' AND SLEEP(5)--",
    "2024-01-01/**/OR/**/1=1",
    "'; DROP TABLE games; --",
    "2024-01-01 OR 1=1",
    "2024-01-01' ; SELECT pg_sleep(5); --",
    "<script>alert(1)</script>",
    "2024-01-01\x00",
    "../../etc/passwd",
]


@pytest.mark.parametrize("injection", SQL_INJECTION_DATE_STRINGS)
def test_sql_injection_in_date_param_rejected_before_reaching_reader(client, injection):
    reader = _CountingGamesReader()
    app.dependency_overrides[get_games_reader] = lambda: reader

    resp = client.get(
        "/games/", params={"date": injection}, headers={"X-API-Key": AUDIT_API_KEY}
    )

    assert resp.status_code == 400, (
        f"expected 400 (not {resp.status_code}) for injection string {injection!r} — "
        "a 500 would mean the string reached the DB layer unhandled; a 200 "
        "would mean it was silently accepted as a valid filter"
    )
    assert reader.calls == [], (
        f"GamesReader.list_games was called with {reader.calls!r} for "
        f"injection string {injection!r} — validation must reject before "
        "any query is ever built, not rely on the query itself failing safe"
    )


def test_legitimate_date_still_works_after_injection_sweep(client):
    """Sanity check that the 400s above are actually about the malformed
    input, not a broken fixture that would 400 on anything."""
    reader = _CountingGamesReader()
    app.dependency_overrides[get_games_reader] = lambda: reader

    resp = client.get(
        "/games/", params={"date": "2024-01-01"}, headers={"X-API-Key": AUDIT_API_KEY}
    )

    assert resp.status_code == 200
    assert reader.calls == [date(2024, 1, 1)]


# --- 2. Auth bypass across all three protected routes --------------------

PROTECTED_ROUTES = ["/games/", "/quality/", "/live/"]

# `None` means "don't send the header at all" (already covered per-route by
# the other test modules — repeated here so the full bypass matrix lives in
# one place and is easy to audit at a glance).
AUTH_BYPASS_CASES = [
    ("missing_header", None),
    ("empty_header", ""),
    ("wrong_value", "totally-not-the-real-key"),
    ("wrong_case", AUDIT_API_KEY.upper()),
]


@pytest.mark.parametrize("route", PROTECTED_ROUTES)
@pytest.mark.parametrize(
    "case_name,header_value", AUTH_BYPASS_CASES, ids=[c[0] for c in AUTH_BYPASS_CASES]
)
def test_auth_bypass_attempt_rejected_with_401(client, route, case_name, header_value):
    headers = {} if header_value is None else {"X-API-Key": header_value}

    resp = client.get(route, headers=headers)

    assert resp.status_code == 401, (
        f"{route} should reject {case_name}={header_value!r} with 401, "
        f"got {resp.status_code}"
    )


def test_wrong_case_key_differs_from_configured_key():
    """Guard against a degenerate AUDIT_API_KEY (all-digits/symbols) making
    the wrong_case bypass case above accidentally identical to the real key,
    which would silently turn that parametrized case into a no-op."""
    assert AUDIT_API_KEY.upper() != AUDIT_API_KEY


# --- 3. API key never leaks into a response ------------------------------

def test_api_key_never_appears_in_any_response_body_or_header(client):
    app.dependency_overrides[get_games_reader] = lambda: _CountingGamesReader()
    app.dependency_overrides[get_quality_reader] = lambda: _EmptyQualityReader()
    app.dependency_overrides[get_live_state_reader] = lambda: _EmptyLiveReader()
    app.dependency_overrides[get_stream_max_duration_seconds] = lambda: 0

    responses = [
        # authorized calls (200) — the key must not be echoed back on success
        client.get("/games/", headers={"X-API-Key": AUDIT_API_KEY}),
        client.get("/quality/", headers={"X-API-Key": AUDIT_API_KEY}),
        client.get("/live/", headers={"X-API-Key": AUDIT_API_KEY}),
        # rejected calls (401) — a naive implementation might echo "expected
        # X, got Y" into an error message, which would leak the real key
        client.get("/games/", headers={"X-API-Key": "wrong"}),
        client.get("/quality/"),
        client.get("/live/", headers={"X-API-Key": ""}),
    ]

    for resp in responses:
        assert AUDIT_API_KEY not in resp.text, (
            f"API key leaked into response body for {resp.request.method} "
            f"{resp.request.url}: {resp.text!r}"
        )
        for header_name, header_value in resp.headers.items():
            assert AUDIT_API_KEY not in header_value, (
                f"API key leaked into response header {header_name!r} for "
                f"{resp.request.method} {resp.request.url}: {header_value!r}"
            )
