import fakeredis
import pytest
import redis
from fastapi.testclient import TestClient

from api.core import cache as cache_module
from api.main import app
from api.routers.player_stats import get_player_stats_reader

API_KEY = "test-service-key"


class FakePlayerStatsReader:
    """Test double for the player-stats-reader DI seam (`PlayerStatsReader`
    protocol).

    Applies the same `game_id` equality / case-insensitive-partial
    `player_name` filtering a real SQL query would, so the filter tests
    exercise real route behavior rather than a pre-filtered fixture. Also
    counts calls so cache tests can prove a hit skips this reader entirely.
    """

    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.call_count = 0
        self.received_game_id: int | None | str = "not-called"
        self.received_player_name: str | None | str = "not-called"

    def list_player_stats(self, game_id: int | None, player_name: str | None) -> list[dict]:
        self.call_count += 1
        self.received_game_id = game_id
        self.received_player_name = player_name

        rows = self.rows
        if game_id is not None:
            rows = [row for row in rows if row["game_id"] == game_id]
        if player_name is not None:
            needle = player_name.lower()
            rows = [
                row
                for row in rows
                if needle in f"{row['player_first_name']} {row['player_last_name']}".lower()
            ]
        return rows


FAKE_STATS = [
    {
        "stat_id": 1,
        "game_id": 100,
        "player_id": 11,
        "player_first_name": "LeBron",
        "player_last_name": "James",
        "team": "Lakers",
        "points": 28,
        "rebounds": 8,
        "assists": 9,
        "steals": 1,
        "blocks": 0,
        "turnovers": 3,
        "minutes_played": "36:12",
    },
    {
        "stat_id": 2,
        "game_id": 100,
        "player_id": 22,
        "player_first_name": "Jayson",
        "player_last_name": "Tatum",
        "team": "Celtics",
        "points": 31,
        "rebounds": 7,
        "assists": 4,
        "steals": 2,
        "blocks": 1,
        "turnovers": 2,
        "minutes_played": "38:45",
    },
    {
        "stat_id": 3,
        "game_id": 101,
        "player_id": 11,
        "player_first_name": "LeBron",
        "player_last_name": "James",
        "team": "Lakers",
        "points": 22,
        "rebounds": 10,
        "assists": 6,
        "steals": 0,
        "blocks": 1,
        "turnovers": 1,
        "minutes_played": "34:02",
    },
]


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("API_SERVICE_KEY", API_KEY)
    # Default every test to its own isolated fake cache backend rather than
    # whatever `get_cache_client()` would otherwise resolve to. This sandbox
    # can have a real, incidentally-reachable Redis on localhost:6379 (see
    # project memory re: an unrelated Docker stack) — without this, a test
    # that doesn't care about caching could still observe a stale value left
    # in that real Redis by an earlier test run within the 15s TTL. Tests
    # that *do* care about caching explicitly install their own
    # `fakeredis.FakeRedis()` (or a broken client) anyway, which simply
    # overrides this default.
    monkeypatch.setattr(cache_module, "get_cache_client", lambda: fakeredis.FakeRedis())
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.pop(get_player_stats_reader, None)


def _override_reader(reader: FakePlayerStatsReader) -> None:
    app.dependency_overrides[get_player_stats_reader] = lambda: reader


def test_list_player_stats_default_returns_all_rows_from_reader(client):
    reader = FakePlayerStatsReader(FAKE_STATS)
    _override_reader(reader)

    resp = client.get("/player-stats/", headers={"X-API-Key": API_KEY})

    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 3
    assert [row["stat_id"] for row in body["data"]] == [1, 2, 3]
    assert reader.received_game_id is None
    assert reader.received_player_name is None


def test_list_player_stats_filters_by_game_id(client):
    reader = FakePlayerStatsReader(FAKE_STATS)
    _override_reader(reader)

    resp = client.get(
        "/player-stats/", params={"game_id": 100}, headers={"X-API-Key": API_KEY}
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 2
    assert {row["stat_id"] for row in body["data"]} == {1, 2}
    assert reader.received_game_id == 100


def test_list_player_stats_filters_by_player_name_case_insensitive_partial(client):
    reader = FakePlayerStatsReader(FAKE_STATS)
    _override_reader(reader)

    resp = client.get(
        "/player-stats/", params={"player_name": "lebron"}, headers={"X-API-Key": API_KEY}
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 2
    assert {row["stat_id"] for row in body["data"]} == {1, 3}
    assert reader.received_player_name == "lebron"


def test_list_player_stats_player_name_matches_partial_substring(client):
    reader = FakePlayerStatsReader(FAKE_STATS)
    _override_reader(reader)

    resp = client.get(
        "/player-stats/", params={"player_name": "tat"}, headers={"X-API-Key": API_KEY}
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 1
    assert body["data"][0]["player_last_name"] == "Tatum"


def test_list_player_stats_empty_result_is_a_normal_200(client, monkeypatch):
    """`player_game_stats` is empty in real Postgres today (a separate Week 5
    team is still building the ingestion path) — this must be a calm, normal
    response, not an error.

    Uses its own isolated fake cache (rather than sharing whatever cache
    backend other tests hit) so this test can't observe a stale cached
    `count` left behind by another test that happens to share the
    unfiltered `?`-less cache key.
    """
    fake = fakeredis.FakeRedis()
    monkeypatch.setattr(cache_module, "get_cache_client", lambda: fake)
    reader = FakePlayerStatsReader([])
    _override_reader(reader)

    resp = client.get("/player-stats/", headers={"X-API-Key": API_KEY})

    assert resp.status_code == 200
    assert resp.json() == {"data": [], "count": 0}


def test_list_player_stats_still_requires_api_key_even_with_reader_overridden(client):
    reader = FakePlayerStatsReader(FAKE_STATS)
    _override_reader(reader)

    resp = client.get("/player-stats/")

    assert resp.status_code == 401


# --- caching (api/src/api/core/cache.py wired into this route) ---


def test_list_player_stats_second_request_is_served_from_cache(client, monkeypatch):
    """A cache hit must skip the underlying `PlayerStatsReader` entirely."""
    fake = fakeredis.FakeRedis()
    monkeypatch.setattr(cache_module, "get_cache_client", lambda: fake)
    reader = FakePlayerStatsReader(FAKE_STATS)
    _override_reader(reader)

    first = client.get("/player-stats/", headers={"X-API-Key": API_KEY})
    second = client.get("/player-stats/", headers={"X-API-Key": API_KEY})

    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert reader.call_count == 1


def test_list_player_stats_filtered_and_unfiltered_do_not_collide_in_cache(client, monkeypatch):
    fake = fakeredis.FakeRedis()
    monkeypatch.setattr(cache_module, "get_cache_client", lambda: fake)
    reader = FakePlayerStatsReader(FAKE_STATS)
    _override_reader(reader)

    unfiltered = client.get("/player-stats/", headers={"X-API-Key": API_KEY})
    filtered = client.get(
        "/player-stats/", params={"game_id": 100}, headers={"X-API-Key": API_KEY}
    )

    assert unfiltered.json()["count"] == 3
    assert filtered.json()["count"] == 2
    assert reader.call_count == 2  # both were misses against distinct keys


def test_list_player_stats_falls_open_when_redis_is_unreachable(client, monkeypatch):
    """The behavior most worth getting right: a broken cache client must
    still yield the correct response, not a 500.
    """

    class _BrokenClient:
        def get(self, key):
            raise redis.exceptions.ConnectionError("connection refused")

        def set(self, key, value, ex=None):
            raise redis.exceptions.ConnectionError("connection refused")

    monkeypatch.setattr(cache_module, "get_cache_client", lambda: _BrokenClient())
    reader = FakePlayerStatsReader(FAKE_STATS)
    _override_reader(reader)

    resp = client.get("/player-stats/", headers={"X-API-Key": API_KEY})

    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 3
    assert reader.call_count == 1
