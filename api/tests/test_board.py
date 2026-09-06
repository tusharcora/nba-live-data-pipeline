import asyncio
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from api.main import app
from api.routers.board import (
    board_stream_generator,
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
    """The Gold `games` table's `game_id` for an nba_stats-sourced game is
    offset by `NBA_GAME_ID_OFFSET` relative to `live_game_state`'s unoffset
    nba_api id (see ingestion/src/ingestion/sources/nba_stats.py's
    `offset_game_id` — e.g. nba_api id 22500123 -> Gold id 100022500123).
    Comparing the two id spaces directly (the pre-fix behavior) never
    matched, so a same-day dbt materialization of a finished game would
    render it TWICE — once from today's set, once again from Gold. The
    historical row here uses the correctly-offset id, so the fix must
    recognize it as the same real game and exclude it.
    """
    now = datetime(2026, 1, 1, 20, 0, 0, tzinfo=timezone.utc)
    today_states = [_state(22500123, "nba_stats", 118, 109, "final", now,
                            home_team="Golden State Warriors", away_team="Phoenix Suns")]
    historical_rows = [
        {
            "game_id": 100022500123, "home_team": "Golden State Warriors",
            "away_team": "Phoenix Suns", "home_score": 118, "away_score": 109,
            "source_pulled_at": now,
        }
    ]
    _override(today_states=today_states, historical_rows=historical_rows)
    try:
        resp = client.get("/board/", headers={"X-API-Key": API_KEY})
        rows = resp.json()["data"]
        # The offset Gold row must be excluded (the fix) ...
        assert len([r for r in rows if r["game_id"] == 100022500123]) == 0
        # ... and today's own (unoffset) row is still present exactly once.
        assert len([r for r in rows if r["game_id"] == 22500123]) == 1
    finally:
        _clear_overrides()


def test_board_excludes_historical_row_matching_fallback_only_native_id():
    """A fallback-only today row (no nba_stats source — e.g. balldontlie)
    uses its native id space directly: balldontlie's ids already match
    Gold's directly, so no offset applies. This path worked before the
    id-space fix; this test confirms it still works after.
    """
    now = datetime(2026, 1, 1, 20, 0, 0, tzinfo=timezone.utc)
    today_states = [_state(888, "balldontlie", 118, 109, "Final", now)]
    historical_rows = [
        {
            "game_id": 888, "home_team": "Golden State Warriors",
            "away_team": "Phoenix Suns", "home_score": 118, "away_score": 109,
            "source_pulled_at": now,
        }
    ]
    _override(today_states=today_states, historical_rows=historical_rows)
    try:
        resp = client.get("/board/", headers={"X-API-Key": API_KEY})
        rows = resp.json()["data"]
        assert len([r for r in rows if r["game_id"] == 888]) == 1
    finally:
        _clear_overrides()


def test_board_fallback_status_scheduled_for_not_yet_started_game():
    """A fallback row (no nba_stats coverage) with no scores yet must
    render `scheduled`, not `live` — the pre-fix keyword logic
    (`status not in ("Final", "final")`) mislabeled every non-final status,
    including a genuinely not-yet-started game, as `live`.
    """
    now = datetime(2026, 1, 1, 20, 0, 0, tzinfo=timezone.utc)
    today_states = [_state(5, "balldontlie", None, None, "Scheduled", now)]
    _override(today_states=today_states)
    try:
        resp = client.get("/board/", headers={"X-API-Key": API_KEY})
        row = next(r for r in resp.json()["data"] if r["game_id"] == 5)
        assert row["status"] == "scheduled"
        assert row["commentary"] is None
    finally:
        _clear_overrides()


def test_board_fallback_status_live_with_real_scores():
    now = datetime(2026, 1, 1, 20, 0, 0, tzinfo=timezone.utc)
    today_states = [_state(6, "balldontlie", 50, 48, "3rd Qtr", now)]
    _override(today_states=today_states)
    try:
        resp = client.get("/board/", headers={"X-API-Key": API_KEY})
        row = next(r for r in resp.json()["data"] if r["game_id"] == 6)
        assert row["status"] == "live"
    finally:
        _clear_overrides()


def test_board_fallback_status_final():
    now = datetime(2026, 1, 1, 20, 0, 0, tzinfo=timezone.utc)
    today_states = [_state(7, "balldontlie", 101, 99, "Final", now)]
    _override(today_states=today_states)
    try:
        resp = client.get("/board/", headers={"X-API-Key": API_KEY})
        row = next(r for r in resp.json()["data"] if r["game_id"] == 7)
        assert row["status"] == "final"
    finally:
        _clear_overrides()


def test_board_live_row_source_pulled_at_reflects_nba_stats_freshness():
    """`source_pulled_at` on a live row must reflect nba_stats's own
    freshness (every other field on the row comes from nba_stats), not
    the freshest of any source — otherwise a stale nba_stats score can
    render next to a misleadingly-fresh "as of" timestamp borrowed from a
    secondary source, exactly when a "Feed stale" commentary line fires.
    """
    nba_stats_time = datetime(2026, 1, 1, 20, 0, 0, tzinfo=timezone.utc)
    secondary_time = datetime(2026, 1, 1, 20, 5, 0, tzinfo=timezone.utc)  # fresher
    today_states = [
        _state(8, "nba_stats", 60, 58, "in_progress", nba_stats_time,
               home_team="Denver Nuggets", away_team="Utah Jazz", period=2, clock="5:00"),
        _state(8, "balldontlie", 60, 58, "2nd Qtr", secondary_time),
    ]
    _override(today_states=today_states, history_by_game={8: [today_states[0]]})
    try:
        resp = client.get("/board/", headers={"X-API-Key": API_KEY})
        row = next(r for r in resp.json()["data"] if r["game_id"] == 8)
        assert row["source_pulled_at"] == nba_stats_time.isoformat()
    finally:
        _clear_overrides()


class FakeDisconnect:
    def __init__(self, values):
        self._values = list(values)
        self.call_count = 0

    async def __call__(self) -> bool:
        value = self._values[self.call_count] if self.call_count < len(self._values) else True
        self.call_count += 1
        return value


class FakeSleep:
    def __init__(self) -> None:
        self.calls = []

    async def __call__(self, seconds: float) -> None:
        self.calls.append(seconds)


def test_board_stream_generator_yields_one_event_per_poll():
    now = datetime(2026, 1, 1, 20, 0, 0, tzinfo=timezone.utc)
    today_states = [_state(1, "nba_stats", 91, 88, "in_progress", now,
                            home_team="Miami Heat", away_team="Boston Celtics")]
    board_reader = FakeBoardReader(today_states=today_states, history_by_game={1: today_states})
    quality_reader = FakeQualityReader()

    async def _run():
        events = []
        async for event in board_stream_generator(
            board_reader=board_reader,
            quality_reader=quality_reader,
            is_disconnected=FakeDisconnect([False, True]),
            sleep=FakeSleep(),
            interval_seconds=0,
            max_duration_seconds=10,
            now_fn=lambda: now,
        ):
            events.append(event)
        return events

    events = asyncio.run(_run())

    assert len(events) == 1
    payload = json.loads(events[0].removeprefix("data: ").strip())
    row = payload["data"][0]
    assert row["game_id"] == 1
    assert row["commentary"]["kind"] == "leader"


def test_board_stream_generator_stops_on_disconnect():
    async def _run():
        events = []
        async for event in board_stream_generator(
            board_reader=FakeBoardReader(),
            quality_reader=FakeQualityReader(),
            is_disconnected=FakeDisconnect([True]),
            sleep=FakeSleep(),
        ):
            events.append(event)
        return events

    assert asyncio.run(_run()) == []


def test_board_stream_requires_api_key():
    resp = client.get("/board/stream")
    assert resp.status_code == 401
