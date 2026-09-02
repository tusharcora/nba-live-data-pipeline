from datetime import date

import pytest

from db.models import RawPull
from ingestion.flows.backfill_stats_flow import (
    STATS_CHECKPOINT_FLOW_NAME,
    backfill_stats_flow,
)


class FakeSink:
    """In-memory RawPullSink — no DB, just a list."""

    def __init__(self) -> None:
        self.written: list[RawPull] = []

    def write(self, raw_pull: RawPull) -> None:
        self.written.append(raw_pull)


class FakeCheckpointStore:
    """In-memory CheckpointStore — no DB, just a dict."""

    def __init__(self, initial: date | None = None) -> None:
        self._checkpoints: dict[str, date] = {}
        if initial is not None:
            self._checkpoints[STATS_CHECKPOINT_FLOW_NAME] = initial

    def get_last_pulled_date(self, flow_name: str) -> date | None:
        return self._checkpoints.get(flow_name)

    def advance(self, flow_name: str, pulled_date: date) -> None:
        self._checkpoints[flow_name] = pulled_date


class FakeStatsClient:
    """In-memory BallDontLieClient.get_stats_pages stand-in — no network."""

    def __init__(self, pages_by_date: dict[str, list[dict]]) -> None:
        self._pages_by_date = pages_by_date
        self.requested_dates: list[str] = []

    def get_stats_pages(self, date_str: str):
        self.requested_dates.append(date_str)
        yield from self._pages_by_date.get(date_str, [])


def _one_page_per_date(*dates: str) -> dict[str, list[dict]]:
    return {
        d: [{"data": [{"id": d, "pts": 10}], "meta": {"next_cursor": None}}]
        for d in dates
    }


def test_backfill_stats_flow_writes_raw_pulls_and_advances_checkpoint():
    sink = FakeSink()
    checkpoint_store = FakeCheckpointStore()
    client = FakeStatsClient(_one_page_per_date("2024-01-01", "2024-01-02"))

    result = backfill_stats_flow(
        start_date="2024-01-01",
        end_date="2024-01-02",
        sink=sink,
        checkpoint_store=checkpoint_store,
        client=client,
    )

    assert result == {"dates_processed": 2, "raw_pulls_written": 2}
    assert client.requested_dates == ["2024-01-01", "2024-01-02"]

    assert len(sink.written) == 2
    for raw_pull in sink.written:
        assert raw_pull.source == "balldontlie"
        assert raw_pull.endpoint == "stats"
    # Bronze is a raw capture layer — each page's payload is written
    # unmodified, exactly as returned by the source.
    assert sink.written[0].payload == {
        "data": [{"id": "2024-01-01", "pts": 10}],
        "meta": {"next_cursor": None},
    }
    assert sink.written[1].payload == {
        "data": [{"id": "2024-01-02", "pts": 10}],
        "meta": {"next_cursor": None},
    }

    assert checkpoint_store.get_last_pulled_date(
        STATS_CHECKPOINT_FLOW_NAME
    ) == date(2024, 1, 2)


def test_backfill_stats_flow_resumes_from_existing_checkpoint():
    """A checkpoint already at day 1 means only day 2 gets (re)processed."""
    sink = FakeSink()
    checkpoint_store = FakeCheckpointStore(initial=date(2024, 1, 1))
    client = FakeStatsClient(_one_page_per_date("2024-01-01", "2024-01-02"))

    result = backfill_stats_flow(
        start_date="2024-01-01",  # ignored: checkpoint takes precedence
        end_date="2024-01-02",
        sink=sink,
        checkpoint_store=checkpoint_store,
        client=client,
    )

    assert result == {"dates_processed": 1, "raw_pulls_written": 1}
    assert client.requested_dates == ["2024-01-02"]
    assert len(sink.written) == 1
    assert sink.written[0].payload == {
        "data": [{"id": "2024-01-02", "pts": 10}],
        "meta": {"next_cursor": None},
    }
    assert checkpoint_store.get_last_pulled_date(
        STATS_CHECKPOINT_FLOW_NAME
    ) == date(2024, 1, 2)


def test_backfill_stats_flow_requires_start_date_on_first_run():
    sink = FakeSink()
    checkpoint_store = FakeCheckpointStore()
    client = FakeStatsClient({})

    with pytest.raises(ValueError):
        backfill_stats_flow(
            end_date="2024-01-02",
            sink=sink,
            checkpoint_store=checkpoint_store,
            client=client,
        )


def test_backfill_stats_flow_uses_independent_checkpoint_from_games_backfill():
    """Stats and games backfills must not share a checkpoint row."""
    sink = FakeSink()
    # A games backfill checkpoint under the OTHER flow name should have no
    # effect on the stats flow's resumability.
    checkpoint_store = FakeCheckpointStore()
    checkpoint_store.advance("backfill_flow", date(2024, 1, 5))
    client = FakeStatsClient(_one_page_per_date("2024-01-01"))

    result = backfill_stats_flow(
        start_date="2024-01-01",
        end_date="2024-01-01",
        sink=sink,
        checkpoint_store=checkpoint_store,
        client=client,
    )

    assert result == {"dates_processed": 1, "raw_pulls_written": 1}
    assert checkpoint_store.get_last_pulled_date("backfill_flow") == date(
        2024, 1, 5
    )
    assert checkpoint_store.get_last_pulled_date(
        STATS_CHECKPOINT_FLOW_NAME
    ) == date(2024, 1, 1)
