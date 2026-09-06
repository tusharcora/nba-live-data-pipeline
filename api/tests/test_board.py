from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from api.main import app
from api.routers.board import (
    et_today_bounds,
    get_board_reader,
)
from api.routers.games import get_games_reader
from api.routers.quality import get_quality_reader

API_KEY = "test-service-key"

client = TestClient(app)


@pytest.fixture(autouse=True)
def _api_service_key(monkeypatch):
    """Every other router's test file sets this per-test via monkeypatch
    (see test_games.py, test_quality.py, test_live.py) since
    `require_api_key` reads a fresh `Settings()` per request rather than a
    cached value — without it, `X-API-Key: test-service-key` never matches
    the default empty `api_service_key` and every request 401s regardless
    of the header sent.
    """
    monkeypatch.setenv("API_SERVICE_KEY", API_KEY)


def _state(game_id, source, home_score, away_score, status, pulled_at,
           home_team=None, away_team=None, scheduled_start=None, period=None, clock=None):
    return SimpleNamespace(
        game_id=game_id, source=source, home_score=home_score, away_score=away_score,
        status=status, pulled_at=pulled_at, home_team=home_team, away_team=away_team,
        scheduled_start=scheduled_start, period=period, clock=clock,
    )


class FakeBoardReader:
    def __init__(self, today_states=(), history_by_game=None):
        self._today_states = list(today_states)
        self._history_by_game = history_by_game or {}

    def latest_per_source_today(self, start_utc, end_utc):
        return self._today_states

    def nba_stats_history_today(self, game_id, start_utc, end_utc, limit):
        return self._history_by_game.get(game_id, [])[:limit]


class FakeGamesReader:
    def __init__(self, rows=()):
        self._rows = list(rows)

    def list_games(self, filter_date, start_date=None, end_date=None, game_id=None, team_names=None):
        return self._rows


class FakeQualityReader:
    def recent_conflicts_for_game(self, game_id, window_seconds):
        return []


def _override(today_states=(), history_by_game=None, historical_rows=()):
    app.dependency_overrides[get_board_reader] = lambda: FakeBoardReader(
        today_states, history_by_game
    )
    app.dependency_overrides[get_games_reader] = lambda: FakeGamesReader(historical_rows)
    app.dependency_overrides[get_quality_reader] = lambda: FakeQualityReader()


def _clear_overrides():
    app.dependency_overrides.pop(get_board_reader, None)
    app.dependency_overrides.pop(get_games_reader, None)
    app.dependency_overrides.pop(get_quality_reader, None)


def test_et_today_bounds_late_night_et_game_groups_correctly():
    """A game at 10pm ET on Jan 1 is 3am UTC on Jan 2 — must still fall
    inside "Jan 1"'s ET bounds, not get pushed into "Jan 2" by a naive
    UTC-day grouping.
    """
    now_utc = datetime(2026, 1, 2, 2, 0, 0, tzinfo=timezone.utc)  # 9pm ET Jan 1
    start, end = et_today_bounds(now_utc)

    ten_pm_et_game = datetime(2026, 1, 2, 3, 0, 0, tzinfo=timezone.utc)  # 10pm ET Jan 1
    assert start <= ten_pm_et_game < end

    next_day_game = datetime(2026, 1, 2, 10, 0, 0, tzinfo=timezone.utc)  # 5am ET Jan 2
    assert not (start <= next_day_game < end)


def test_board_requires_api_key():
    resp = client.get("/board/")
    assert resp.status_code == 401


def test_board_live_game_includes_commentary():
    now = datetime(2026, 1, 1, 20, 0, 0, tzinfo=timezone.utc)
    today_states = [
        _state(1, "nba_stats", 91, 88, "in_progress", now,
               home_team="Miami Heat", away_team="Boston Celtics", period=3, clock="4:12"),
        _state(1, "balldontlie", 91, 88, "3rd Qtr", now),
    ]
    history = {1: [today_states[0]]}
    _override(today_states=today_states, history_by_game=history)
    try:
        resp = client.get("/board/", headers={"X-API-Key": API_KEY})
        assert resp.status_code == 200
        rows = resp.json()["data"]
        row = next(r for r in rows if r["game_id"] == 1)
        assert row["status"] == "live"
        assert row["home_team"] == "Miami Heat"
        assert row["commentary"]["kind"] == "leader"
        assert row["commentary"]["text"] == "Miami Heat leads by 3"
    finally:
        _clear_overrides()


def test_board_scheduled_game_has_no_commentary():
    now = datetime(2026, 1, 1, 20, 0, 0, tzinfo=timezone.utc)
    start = datetime(2026, 1, 2, 0, 30, 0, tzinfo=timezone.utc)
    today_states = [
        _state(2, "nba_stats", 0, 0, "scheduled", now,
               home_team="Dallas Mavericks", away_team="Minnesota Timberwolves",
               scheduled_start=start),
    ]
    _override(today_states=today_states, history_by_game={2: today_states})
    try:
        resp = client.get("/board/", headers={"X-API-Key": API_KEY})
        row = next(r for r in resp.json()["data"] if r["game_id"] == 2)
        assert row["status"] == "scheduled"
        assert row["commentary"] is None
        assert row["scheduled_start"] == start.isoformat()
    finally:
        _clear_overrides()


def test_board_falls_back_to_secondary_source_when_nba_stats_missing():
    now = datetime(2026, 1, 1, 20, 0, 0, tzinfo=timezone.utc)
    today_states = [_state(3, "balldontlie", 50, 48, "2nd Qtr", now)]
    _override(today_states=today_states)
    try:
        resp = client.get("/board/", headers={"X-API-Key": API_KEY})
        row = next(r for r in resp.json()["data"] if r["game_id"] == 3)
        assert row["home_score"] == 50
        assert row["commentary"] is None
    finally:
        _clear_overrides()


def test_board_includes_historical_rows_not_in_todays_set():
    historical_rows = [
        {
            "game_id": 999,
            "home_team": "Golden State Warriors",
            "away_team": "Phoenix Suns",
            "home_score": 118,
            "away_score": 109,
            "source_pulled_at": datetime(2025, 12, 1, tzinfo=timezone.utc),
        }
    ]
    _override(historical_rows=historical_rows)
    try:
        resp = client.get("/board/", headers={"X-API-Key": API_KEY})
        rows = resp.json()["data"]
        row = next(r for r in rows if r["game_id"] == 999)
        assert row["status"] == "final"
        assert row["home_score"] == 118
        assert row["commentary"] is None
    finally:
        _clear_overrides()


def test_board_excludes_historical_row_already_covered_by_todays_set():
    now = datetime(2026, 1, 1, 20, 0, 0, tzinfo=timezone.utc)
    today_states = [_state(999, "nba_stats", 118, 109, "final", now,
                            home_team="Golden State Warriors", away_team="Phoenix Suns")]
    historical_rows = [
        {
            "game_id": 999, "home_team": "Golden State Warriors", "away_team": "Phoenix Suns",
            "home_score": 118, "away_score": 109, "source_pulled_at": now,
        }
    ]
    _override(today_states=today_states, historical_rows=historical_rows)
    try:
        resp = client.get("/board/", headers={"X-API-Key": API_KEY})
        rows = resp.json()["data"]
        assert len([r for r in rows if r["game_id"] == 999]) == 1
    finally:
        _clear_overrides()
