from datetime import date

import pytest

from db.models import RawPull
from ingestion.flows.backfill_flow import CHECKPOINT_FLOW_NAME, backfill_flow


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
            self._checkpoints[CHECKPOINT_FLOW_NAME] = initial

    def get_last_pulled_date(self, flow_name: str) -> date | None:
        return self._checkpoints.get(flow_name)

    def advance(self, flow_name: str, pulled_date: date) -> None:
        self._checkpoints[flow_name] = pulled_date


class FakeClient:
    """In-memory BallDontLieClient stand-in — no network."""

    def __init__(self, pages_by_date: dict[str, list[dict]]) -> None:
        self._pages_by_date = pages_by_date
        self.requested_dates: list[str] = []

    def get_games_pages(self, date_str: str):
        self.requested_dates.append(date_str)
        yield from self._pages_by_date.get(date_str, [])


def _one_page_per_date(*dates: str) -> dict[str, list[dict]]:
    return {
        d: [{"data": [{"id": d}], "meta": {"next_cursor": None}}] for d in dates
    }


def test_backfill_flow_writes_raw_pulls_and_advances_checkpoint():
    sink = FakeSink()
    checkpoint_store = FakeCheckpointStore()
    client = FakeClient(_one_page_per_date("2024-01-01", "2024-01-02"))

    result = backfill_flow(
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
        assert raw_pull.endpoint == "games"
    assert sink.written[0].payload == {
        "data": [{"id": "2024-01-01"}],
        "meta": {"next_cursor": None},
    }
    assert sink.written[1].payload == {
        "data": [{"id": "2024-01-02"}],
        "meta": {"next_cursor": None},
    }

    assert checkpoint_store.get_last_pulled_date(CHECKPOINT_FLOW_NAME) == date(
        2024, 1, 2
    )


def test_backfill_flow_resumes_from_existing_checkpoint():
    """A checkpoint already at day 1 means only day 2 gets (re)processed."""
    sink = FakeSink()
    checkpoint_store = FakeCheckpointStore(initial=date(2024, 1, 1))
    client = FakeClient(_one_page_per_date("2024-01-01", "2024-01-02"))

    result = backfill_flow(
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
        "data": [{"id": "2024-01-02"}],
        "meta": {"next_cursor": None},
    }
    assert checkpoint_store.get_last_pulled_date(CHECKPOINT_FLOW_NAME) == date(
        2024, 1, 2
    )


def test_backfill_flow_requires_start_date_on_first_run():
    sink = FakeSink()
    checkpoint_store = FakeCheckpointStore()
    client = FakeClient({})

    with pytest.raises(ValueError):
        backfill_flow(
            end_date="2024-01-02",
            sink=sink,
            checkpoint_store=checkpoint_store,
            client=client,
        )
