from datetime import date

from db.models import RawPull
from ingestion.flows.backfill_flow import backfill_flow
from ingestion.flows.live_game_flow import live_game_flow


class _FakeSink:
    def write(self, raw_pull: RawPull) -> None:
        pass


class _FakeCheckpointStore:
    def get_last_pulled_date(self, flow_name: str) -> date | None:
        return None

    def advance(self, flow_name: str, pulled_date: date) -> None:
        pass


class _FakeClient:
    def get_games_pages(self, date_str: str):
        return iter(())


def test_backfill_flow_runs():
    # No real DB/network: sink, checkpoint_store, and client are all injected
    # fakes (see test_backfill_flow.py for the real DI/resumability coverage).
    result = backfill_flow(
        start_date="2024-01-01",
        end_date="2024-01-01",
        sink=_FakeSink(),
        checkpoint_store=_FakeCheckpointStore(),
        client=_FakeClient(),
    )
    assert result == {"dates_processed": 1, "raw_pulls_written": 0}


def test_live_game_flow_runs():
    assert live_game_flow() == {"status": "stub"}
