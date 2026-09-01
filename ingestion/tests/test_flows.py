from ingestion.flows.backfill_flow import backfill_flow
from ingestion.flows.live_game_flow import live_game_flow


def test_backfill_flow_runs():
    assert backfill_flow() == {"status": "stub"}


def test_live_game_flow_runs():
    assert live_game_flow() == {"status": "stub"}
