from datetime import date

import fakeredis
import pytest
import redis
from fastapi.testclient import TestClient

from api.core import cache as cache_module
from api.main import app
from api.routers.games import get_games_reader

API_KEY = "test-service-key"


class FakeGamesReader:
    """Test double for the games-reader DI seam (`GamesReader` protocol).

    Records the `filter_date`/`start_date`/`end_date`/`game_id`/`team_names`
    it was called with so tests can assert the route passes the parsed
    query params through correctly, and applies the same
    date-equality/range/id/team-membership filtering a real SQL `WHERE`
    clause would, so the filter tests exercise real route behavior rather
    than a pre-filtered fixture. Also counts calls so cache tests can prove
    a hit skips this reader entirely.
    """

    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.received_filter_date: date | None | str = "not-called"
        self.received_start_date: date | None | str = "not-called"
        self.received_end_date: date | None | str = "not-called"
        self.received_game_id: int | None | str = "not-called"
        self.received_team_names: list[str] | None | str = "not-called"
        self.call_count = 0

    def list_games(
        self,
        filter_date: date | None,
        start_date: date | None = None,
        end_date: date | None = None,
        game_id: int | None = None,
        team_names: list[str] | None = None,
    ) -> list[dict]:
        self.call_count += 1
        self.received_filter_date = filter_date
        self.received_start_date = start_date
        self.received_end_date = end_date
        self.received_game_id = game_id
        self.received_team_names = team_names

        rows = self.rows
        if filter_date is not None:
            rows = [row for row in rows if row["game_date"] == filter_date]
        elif start_date is not None or end_date is not None:
            if start_date is not None:
                rows = [row for row in rows if row["game_date"] >= start_date]
            if end_date is not None:
                rows = [row for row in rows if row["game_date"] <= end_date]

        if game_id is not None:
            rows = [row for row in rows if row["game_id"] == game_id]
        if team_names:
            rows = [
                row
                for row in rows
                if row["home_team"] in team_names or row["away_team"] in team_names
            ]
        return rows


FAKE_ROWS = [
    {
        "game_id": 1,
        "game_date": date(2026, 1, 2),
        "season": 2025,
        "status": "Final",
        "postseason": False,
        "home_team": "Lakers",
        "away_team": "Celtics",
        "home_score": 110,
        "away_score": 108,
        "source_pulled_at": "2026-01-02T23:00:00",
    },
    {
        "game_id": 2,
        "game_date": date(2026, 1, 1),
        "season": 2025,
        "status": "Final",
        "postseason": False,
        "home_team": "Warriors",
        "away_team": "Suns",
        "home_score": 99,
        "away_score": 101,
        "source_pulled_at": "2026-01-01T23:00:00",
    },
]


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("API_SERVICE_KEY", API_KEY)
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.pop(get_games_reader, None)


def _override_reader(reader: FakeGamesReader) -> None:
    app.dependency_overrides[get_games_reader] = lambda: reader


def test_list_games_default_returns_all_rows_from_reader(client):
    reader = FakeGamesReader(FAKE_ROWS)
    _override_reader(reader)

    resp = client.get("/games/", headers={"X-API-Key": API_KEY})

    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 2
    assert [row["game_id"] for row in body["data"]] == [1, 2]
    assert body["data"][0]["home_team"] == "Lakers"
    assert reader.received_filter_date is None


def test_list_games_filters_by_date_query_param(client):
    reader = FakeGamesReader(FAKE_ROWS)
    _override_reader(reader)

    resp = client.get(
        "/games/", params={"date": "2026-01-01"}, headers={"X-API-Key": API_KEY}
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 1
    assert body["data"][0]["game_id"] == 2
    assert reader.received_filter_date == date(2026, 1, 1)


def test_list_games_filters_by_game_id(client):
    """The game detail page's lookup -- an exact match, independent of any
    date filter."""
    reader = FakeGamesReader(FAKE_ROWS)
    _override_reader(reader)

    resp = client.get(
        "/games/", params={"game_id": 2}, headers={"X-API-Key": API_KEY}
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 1
    assert body["data"][0]["home_team"] == "Warriors"
    assert reader.received_game_id == 2


def test_list_games_filters_by_team_matches_home_or_away(client):
    """The team detail page's lookup -- matches whichever side (home or
    away) the team played on, and accepts multiple repeated `team` values
    for a franchise's historical name variants."""
    reader = FakeGamesReader(FAKE_ROWS)
    _override_reader(reader)

    resp = client.get(
        "/games/",
        params={"team": ["Lakers", "Suns"]},
        headers={"X-API-Key": API_KEY},
    )

    assert resp.status_code == 200
    body = resp.json()
    # Row 1 (Lakers home) matches via "Lakers"; row 2 (Suns away) matches
    # via "Suns" -- both real matches, not both matching the same name.
    assert body["count"] == 2
    assert {row["game_id"] for row in body["data"]} == {1, 2}
    assert reader.received_team_names == ["Lakers", "Suns"]


def test_list_games_rejects_malformed_date(client):
    reader = FakeGamesReader(FAKE_ROWS)
    _override_reader(reader)

    resp = client.get(
        "/games/", params={"date": "not-a-date"}, headers={"X-API-Key": API_KEY}
    )

    assert resp.status_code == 400


def test_list_games_filters_by_date_range(client):
    reader = FakeGamesReader(FAKE_ROWS)
    _override_reader(reader)

    resp = client.get(
        "/games/",
        params={"start_date": "2026-01-01", "end_date": "2026-01-01"},
        headers={"X-API-Key": API_KEY},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 1
    assert body["data"][0]["game_id"] == 2
    assert reader.received_start_date == date(2026, 1, 1)
    assert reader.received_end_date == date(2026, 1, 1)
    assert reader.received_filter_date is None


def test_list_games_rejects_malformed_start_date(client):
    reader = FakeGamesReader(FAKE_ROWS)
    _override_reader(reader)

    resp = client.get(
        "/games/", params={"start_date": "not-a-date"}, headers={"X-API-Key": API_KEY}
    )

    assert resp.status_code == 400


def test_list_games_rejects_malformed_end_date(client):
    reader = FakeGamesReader(FAKE_ROWS)
    _override_reader(reader)

    resp = client.get(
        "/games/", params={"end_date": "not-a-date"}, headers={"X-API-Key": API_KEY}
    )

    assert resp.status_code == 400


def test_list_games_rejects_start_date_after_end_date(client):
    """`start_date > end_date` is explicitly rejected with a 400 rather than
    silently returning an empty result — this project chose "loud" here so a
    caller-side date-arithmetic bug surfaces immediately instead of looking
    like "no games happened".
    """
    reader = FakeGamesReader(FAKE_ROWS)
    _override_reader(reader)

    resp = client.get(
        "/games/",
        params={"start_date": "2026-01-02", "end_date": "2026-01-01"},
        headers={"X-API-Key": API_KEY},
    )

    assert resp.status_code == 400
    assert reader.received_filter_date == "not-called"  # never reached the reader


def test_list_games_rejects_date_combined_with_start_date(client):
    """`date` and `start_date`/`end_date` are mutually exclusive filter
    modes — combining them is rejected with a 400 rather than one silently
    winning, so a caller never gets a surprising precedence rule.
    """
    reader = FakeGamesReader(FAKE_ROWS)
    _override_reader(reader)

    resp = client.get(
        "/games/",
        params={"date": "2026-01-01", "start_date": "2026-01-01"},
        headers={"X-API-Key": API_KEY},
    )

    assert resp.status_code == 400
    assert reader.received_filter_date == "not-called"


def test_list_games_rejects_date_combined_with_end_date(client):
    reader = FakeGamesReader(FAKE_ROWS)
    _override_reader(reader)

    resp = client.get(
        "/games/",
        params={"date": "2026-01-01", "end_date": "2026-01-02"},
        headers={"X-API-Key": API_KEY},
    )

    assert resp.status_code == 400


def test_list_games_still_requires_api_key_even_with_reader_overridden(client):
    reader = FakeGamesReader(FAKE_ROWS)
    _override_reader(reader)

    resp = client.get("/games/")

    assert resp.status_code == 401


# --- caching (api/src/api/core/cache.py wired into this route) ---


def test_list_games_second_request_is_served_from_cache(client, monkeypatch):
    """A cache hit must skip the underlying `GamesReader` entirely."""
    fake = fakeredis.FakeRedis()
    monkeypatch.setattr(cache_module, "get_cache_client", lambda: fake)
    reader = FakeGamesReader(FAKE_ROWS)
    _override_reader(reader)

    first = client.get("/games/", headers={"X-API-Key": API_KEY})
    second = client.get("/games/", headers={"X-API-Key": API_KEY})

    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert reader.call_count == 1


def test_list_games_date_filter_does_not_collide_with_unfiltered_cache_entry(client, monkeypatch):
    """`?date=` and the unfiltered/"recent" response must be cached separately."""
    fake = fakeredis.FakeRedis()
    monkeypatch.setattr(cache_module, "get_cache_client", lambda: fake)
    reader = FakeGamesReader(FAKE_ROWS)
    _override_reader(reader)

    unfiltered = client.get("/games/", headers={"X-API-Key": API_KEY})
    filtered = client.get(
        "/games/", params={"date": "2026-01-01"}, headers={"X-API-Key": API_KEY}
    )

    assert unfiltered.json()["count"] == 2
    assert filtered.json()["count"] == 1
    assert reader.call_count == 2  # both were misses against distinct keys


def test_list_games_range_filter_does_not_collide_with_single_date_cache_entry(client, monkeypatch):
    """`?start_date=&end_date=` and `?date=` must be cached separately even
    when they'd otherwise resolve to overlapping data.
    """
    fake = fakeredis.FakeRedis()
    monkeypatch.setattr(cache_module, "get_cache_client", lambda: fake)
    reader = FakeGamesReader(FAKE_ROWS)
    _override_reader(reader)

    single_date = client.get(
        "/games/", params={"date": "2026-01-01"}, headers={"X-API-Key": API_KEY}
    )
    ranged = client.get(
        "/games/",
        params={"start_date": "2026-01-01", "end_date": "2026-01-01"},
        headers={"X-API-Key": API_KEY},
    )

    assert single_date.json()["count"] == 1
    assert ranged.json()["count"] == 1
    assert reader.call_count == 2  # both were misses against distinct keys


def test_list_games_falls_open_when_redis_is_unreachable(client, monkeypatch):
    """The behavior most worth getting right: a broken cache client must
    still yield the correct response, not a 500.
    """

    class _BrokenClient:
        def get(self, key):
            raise redis.exceptions.ConnectionError("connection refused")

        def set(self, key, value, ex=None):
            raise redis.exceptions.ConnectionError("connection refused")

    monkeypatch.setattr(cache_module, "get_cache_client", lambda: _BrokenClient())
    reader = FakeGamesReader(FAKE_ROWS)
    _override_reader(reader)

    resp = client.get("/games/", headers={"X-API-Key": API_KEY})

    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 2
    assert [row["game_id"] for row in body["data"]] == [1, 2]
    assert reader.call_count == 1
