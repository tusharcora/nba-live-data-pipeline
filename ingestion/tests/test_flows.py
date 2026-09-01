from datetime import date

from db.models import RawPull
from ingestion.flows.backfill_flow import backfill_flow
from ingestion.flows.live_game_flow import live_game_flow


class _FakeRowSink:
    def write(self, row: object) -> None:
        pass


class _FakeScoreboardSource:
    def get_scoreboard(self, date: str) -> dict:
        return {"events": []}


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
    # See test_live_game_flow.py for the real DI/extraction/metric coverage;
    # this just confirms the flow still runs end-to-end with all-fake
    # dependencies now that it's a real implementation, not the week-1 stub.
    result = live_game_flow(
        date="2024-01-01",
        raw_pull_sink=_FakeSink(),
        live_game_state_sink=_FakeRowSink(),
        quality_metric_sink=_FakeRowSink(),
        balldontlie_client=_FakeClient(),
        public_feed_client=_FakeScoreboardSource(),
    )
    assert result == {"raw_pulls_written": 1, "live_game_states_written": 0}
