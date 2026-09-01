import asyncio
import json
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from api.main import app
from api.routers.live import (
    get_live_state_reader,
    get_stream_max_duration_seconds,
    live_event_generator,
)

API_KEY = "test-service-key"


class FakeReader:
    """Test double for the LiveStateReader DI seam.

    `polls` is a list of "what get_latest_states() should return on the Nth
    call" — lets a test assert the generator re-queries on every loop
    iteration rather than caching the first result.
    """

    def __init__(self, polls: list[list[object]]) -> None:
        self._polls = list(polls)
        self.call_count = 0

    def get_latest_states(self):
        row = self._polls[self.call_count] if self.call_count < len(self._polls) else []
        self.call_count += 1
        return row


class FakeRow:
    """Stand-in for a `db.models.LiveGameState` row — same attributes, no ORM/DB."""

    def __init__(
        self,
        game_id,
        source,
        pulled_at,
        home_score,
        away_score,
        period,
        clock,
        status,
    ):
        self.game_id = game_id
        self.source = source
        self.pulled_at = pulled_at
        self.home_score = home_score
        self.away_score = away_score
        self.period = period
        self.clock = clock
        self.status = status


class FakeDisconnect:
    """Returns a preset sequence of booleans across successive awaits."""

    def __init__(self, values: list[bool]) -> None:
        self._values = list(values)
        self.call_count = 0

    async def __call__(self) -> bool:
        value = self._values[self.call_count] if self.call_count < len(self._values) else True
        self.call_count += 1
        return value


class FakeSleep:
    """No-op stand-in for asyncio.sleep — records the durations it was asked for."""

    def __init__(self) -> None:
        self.calls: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.calls.append(seconds)


ROW_1 = FakeRow(
    game_id=1,
    source="balldontlie",
    pulled_at=datetime(2026, 1, 1, 20, 0, 0, tzinfo=timezone.utc),
    home_score=10,
    away_score=8,
    period=1,
    clock="10:15",
    status="in_progress",
)

ROW_2 = FakeRow(
    game_id=1,
    source="balldontlie",
    pulled_at=datetime(2026, 1, 1, 20, 5, 0, tzinfo=timezone.utc),
    home_score=14,
    away_score=10,
    period=1,
    clock="7:02",
    status="in_progress",
)


async def _collect(generator, count: int) -> list[str]:
    events = []
    for _ in range(count):
        events.append(await generator.__anext__())
    return events


def test_yields_sse_formatted_event_per_poll_with_injected_reader_and_sleep():
    reader = FakeReader(polls=[[ROW_1], [ROW_2]])
    disconnect = FakeDisconnect([False, False, False])
    sleep = FakeSleep()

    generator = live_event_generator(
        reader=reader,
        is_disconnected=disconnect,
        sleep=sleep,
        interval_seconds=5,
    )

    events = asyncio.run(_collect(generator, 2))

    expected_first = "data: " + json.dumps(
        {
            "data": [
                {
                    "game_id": 1,
                    "source": "balldontlie",
                    "pulled_at": "2026-01-01T20:00:00+00:00",
                    "home_score": 10,
                    "away_score": 8,
                    "period": 1,
                    "clock": "10:15",
                    "status": "in_progress",
                }
            ]
        }
    ) + "\n\n"
    expected_second = "data: " + json.dumps(
        {
            "data": [
                {
                    "game_id": 1,
                    "source": "balldontlie",
                    "pulled_at": "2026-01-01T20:05:00+00:00",
                    "home_score": 14,
                    "away_score": 10,
                    "period": 1,
                    "clock": "7:02",
                    "status": "in_progress",
                }
            ]
        }
    ) + "\n\n"

    assert events == [expected_first, expected_second]
    assert reader.call_count == 2
    # Only one sleep has actually run: sleep happens *after* a yield, so the
    # second `sleep(5)` (following event 2) hasn't executed yet at the point
    # only 2 events have been pulled from the generator.
    assert sleep.calls == [5]


def test_re_polls_the_reader_on_every_iteration_not_just_once():
    reader = FakeReader(polls=[[], [ROW_1], []])
    disconnect = FakeDisconnect([False, False, False, True])
    sleep = FakeSleep()

    generator = live_event_generator(
        reader=reader, is_disconnected=disconnect, sleep=sleep, interval_seconds=1
    )

    events = asyncio.run(_collect(generator, 3))

    assert json.loads(events[0][len("data: "):])["data"] == []
    assert json.loads(events[1][len("data: "):])["data"][0]["game_id"] == 1
    assert json.loads(events[2][len("data: "):])["data"] == []
    assert reader.call_count == 3


def test_stops_looping_once_client_disconnects():
    reader = FakeReader(polls=[[ROW_1], [ROW_2]])
    disconnect = FakeDisconnect([False, True])
    sleep = FakeSleep()

    generator = live_event_generator(
        reader=reader, is_disconnected=disconnect, sleep=sleep, interval_seconds=5
    )

    events = asyncio.run(_collect_all(generator))

    assert len(events) == 1
    assert reader.call_count == 1
    assert sleep.calls == [5]


async def _collect_all(generator) -> list[str]:
    events = []
    async for event in generator:
        events.append(event)
    return events


def test_stops_looping_once_max_duration_elapses_even_if_never_disconnected():
    reader = FakeReader(polls=[[ROW_1], [ROW_1], [ROW_1], [ROW_1]])
    disconnect = FakeDisconnect([False, False, False, False])
    sleep = FakeSleep()

    generator = live_event_generator(
        reader=reader,
        is_disconnected=disconnect,
        sleep=sleep,
        interval_seconds=10,
        max_duration_seconds=25,
    )

    events = asyncio.run(_collect_all(generator))

    # elapsed starts at 0: yields at 0s, 10s, 20s (all < 25s cutoff), then the
    # loop condition fails before a 4th poll (30s >= 25s).
    assert len(events) == 3
    assert reader.call_count == 3


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("API_SERVICE_KEY", API_KEY)
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.pop(get_live_state_reader, None)
    app.dependency_overrides.pop(get_stream_max_duration_seconds, None)


def test_live_route_requires_api_key(client):
    resp = client.get("/live/")
    assert resp.status_code == 401


def test_live_route_streams_sse_with_no_cache_header(client):
    # NOTE on why max_duration is forced to 0 here rather than just opening
    # the stream and reading the first chunk: both Starlette's TestClient
    # (portal.call(self.app, ...)) and httpx's ASGITransport
    # (await self.app(...)) fully run the ASGI app coroutine to completion
    # *before* handing back any response object at all, `client.stream(...)`
    # included — there is no way to observe headers "as they arrive" without
    # the whole app call finishing first. A real (non-test) SSE connection
    # never returns from that coroutine until disconnect/cutoff, so driving
    # this route through either test transport unmodified hangs for the
    # entire max-duration cutoff. Forcing `max_duration_seconds=0` makes the
    # generator's `while elapsed < max_duration_seconds` loop condition false
    # on the very first check, so it yields zero events and the app call
    # returns immediately — while `StreamingResponse` has still already sent
    # `http.response.start` with the real status/headers before ever
    # touching the (empty) body iterator, so this still exercises the actual
    # route wiring (rate limiter, dependencies, headers) for real.
    app.dependency_overrides[get_live_state_reader] = lambda: FakeReader(polls=[[]])
    app.dependency_overrides[get_stream_max_duration_seconds] = lambda: 0

    with client.stream("GET", "/live/", headers={"X-API-Key": API_KEY}) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        assert resp.headers["cache-control"] == "no-cache"
