from datetime import date

import pytest

from db.models import RawPull
from ingestion.flows.backfill_nba_stats_flow import (
    CHECKPOINT_FLOW_NAME,
    backfill_nba_stats_flow,
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
            self._checkpoints[CHECKPOINT_FLOW_NAME] = initial

    def get_last_pulled_date(self, flow_name: str) -> date | None:
        return self._checkpoints.get(flow_name)

    def advance(self, flow_name: str, pulled_date: date) -> None:
        self._checkpoints[flow_name] = pulled_date


class FakeNBAGameSource:
    """In-memory NBAGameSource -- no network, no nba_api."""

    def __init__(
        self,
        games_by_season: dict[str, list[dict]],
        boxscores_by_game_id: dict[str, list[dict]] | None = None,
        raise_for_game_id: str | None = None,
    ) -> None:
        self._games_by_season = games_by_season
        self._boxscores_by_game_id = boxscores_by_game_id or {}
        self._raise_for_game_id = raise_for_game_id
        self.requested_seasons: list[str] = []
        self.requested_boxscore_ids: list[str] = []

    def get_games_for_season(self, season: str) -> list[dict]:
        self.requested_seasons.append(season)
        return self._games_by_season.get(season, [])

    def get_boxscore(self, nba_game_id: str) -> list[dict]:
        self.requested_boxscore_ids.append(nba_game_id)
        if nba_game_id == self._raise_for_game_id:
            raise RuntimeError("simulated 403 from stats.nba.com")
        return self._boxscores_by_game_id.get(nba_game_id, [])


def test_backfill_nba_stats_flow_writes_game_and_boxscore_and_advances_checkpoint():
    sink = FakeSink()
    checkpoint_store = FakeCheckpointStore()
    client = FakeNBAGameSource(
        games_by_season={
            "1996-97": [
                {
                    "game_id": 100_029_600_001,
                    "nba_game_id": "0029600001",
                    "game_date": "1996-11-01",
                    "season": 1996,
                    "postseason": False,
                    "status": "Final",
                    "home_team": "Boston Celtics",
                    "home_score": 107,
                    "away_team": "Chicago Bulls",
                    "away_score": 98,
                }
            ]
        },
        boxscores_by_game_id={
            "0029600001": [
                {"PLAYER_NAME": "Michael Jordan", "PTS": 30, "player_key": "michael jordan"}
            ]
        },
    )

    result = backfill_nba_stats_flow(
        start_season=1996,
        end_season=1996,
        sink=sink,
        checkpoint_store=checkpoint_store,
        client=client,
    )

    assert result == {
        "seasons_processed": 1,
        "dates_processed": 1,
        "games_written": 1,
        "raw_pulls_written": 2,
    }
    assert client.requested_seasons == ["1996-97"]
    assert client.requested_boxscore_ids == ["0029600001"]

    assert len(sink.written) == 2
    game_pull, boxscore_pull = sink.written
    assert game_pull.source == "nba_stats"
    assert game_pull.endpoint == "game"
    assert game_pull.payload == {
        "game_id": 100_029_600_001,
        "game_date": "1996-11-01",
        "season": 1996,
        "postseason": False,
        "status": "Final",
        "home_team": "Boston Celtics",
        "away_team": "Chicago Bulls",
        "home_score": 107,
        "away_score": 98,
    }
    assert boxscore_pull.source == "nba_stats"
    assert boxscore_pull.endpoint == "boxscore_traditional"
    assert boxscore_pull.payload == {
        "game_id": 100_029_600_001,
        "player_stats": [
            {"PLAYER_NAME": "Michael Jordan", "PTS": 30, "player_key": "michael jordan"}
        ],
    }
    assert checkpoint_store.get_last_pulled_date(CHECKPOINT_FLOW_NAME) == date(1996, 11, 1)


def test_backfill_nba_stats_flow_does_not_advance_checkpoint_on_mid_date_failure():
    """A box-score fetch that raises mid-date (simulating a 403/CAPTCHA
    block) must propagate, naming the failing game, and must NOT advance
    the checkpoint past the last fully-completed date."""
    sink = FakeSink()
    checkpoint_store = FakeCheckpointStore(initial=date(1996, 10, 31))
    client = FakeNBAGameSource(
        games_by_season={
            "1996-97": [
                {
                    "game_id": 1, "nba_game_id": "G1", "game_date": "1996-11-01",
                    "season": 1996, "postseason": False, "status": "Final",
                    "home_team": "A", "home_score": 100, "away_team": "B", "away_score": 90,
                },
                {
                    "game_id": 2, "nba_game_id": "G2", "game_date": "1996-11-01",
                    "season": 1996, "postseason": False, "status": "Final",
                    "home_team": "C", "home_score": 95, "away_team": "D", "away_score": 88,
                },
            ]
        },
        boxscores_by_game_id={"G1": [{"PLAYER_NAME": "X"}]},
        raise_for_game_id="G2",
    )

    with pytest.raises(RuntimeError, match="G2"):
        backfill_nba_stats_flow(
            start_season=1996,
            end_season=1996,
            sink=sink,
            checkpoint_store=checkpoint_store,
            client=client,
        )

    assert checkpoint_store.get_last_pulled_date(CHECKPOINT_FLOW_NAME) == date(1996, 10, 31)
    # G1's game+boxscore rows, and G2's game row (written before its
    # boxscore call raised), are already in sink -- that's fine, raw_pulls
    # is append-only; what matters is the checkpoint doesn't move.
    assert len(sink.written) == 3


def test_backfill_nba_stats_flow_skips_dates_already_covered_by_checkpoint():
    sink = FakeSink()
    checkpoint_store = FakeCheckpointStore(initial=date(1996, 11, 1))
    client = FakeNBAGameSource(
        games_by_season={
            "1996-97": [
                {
                    "game_id": 1, "nba_game_id": "G1", "game_date": "1996-11-01",
                    "season": 1996, "postseason": False, "status": "Final",
                    "home_team": "A", "home_score": 100, "away_team": "B", "away_score": 90,
                },
                {
                    "game_id": 2, "nba_game_id": "G2", "game_date": "1996-11-02",
                    "season": 1996, "postseason": False, "status": "Final",
                    "home_team": "C", "home_score": 95, "away_team": "D", "away_score": 88,
                },
            ]
        },
        boxscores_by_game_id={"G2": [{"PLAYER_NAME": "Y"}]},
    )

    result = backfill_nba_stats_flow(
        start_season=1996,
        end_season=1996,
        sink=sink,
        checkpoint_store=checkpoint_store,
        client=client,
    )

    assert result["dates_processed"] == 1
    assert client.requested_boxscore_ids == ["G2"]
    assert checkpoint_store.get_last_pulled_date(CHECKPOINT_FLOW_NAME) == date(1996, 11, 2)


def test_backfill_nba_stats_flow_requests_every_season_in_range():
    sink = FakeSink()
    checkpoint_store = FakeCheckpointStore()
    client = FakeNBAGameSource(games_by_season={})

    backfill_nba_stats_flow(
        start_season=1996,
        end_season=1998,
        sink=sink,
        checkpoint_store=checkpoint_store,
        client=client,
    )

    assert client.requested_seasons == ["1996-97", "1997-98", "1998-99"]


def test_backfill_nba_stats_flow_rejects_end_season_before_start_season():
    sink = FakeSink()
    checkpoint_store = FakeCheckpointStore()
    client = FakeNBAGameSource(games_by_season={})

    with pytest.raises(ValueError, match="end_season"):
        backfill_nba_stats_flow(
            start_season=2000,
            end_season=1999,
            sink=sink,
            checkpoint_store=checkpoint_store,
            client=client,
        )


def test_backfill_nba_stats_flow_uses_independent_checkpoint_from_other_backfills():
    sink = FakeSink()
    checkpoint_store = FakeCheckpointStore()
    checkpoint_store.advance("backfill_flow", date(2024, 5, 5))
    checkpoint_store.advance("backfill_stats", date(2024, 6, 6))
    client = FakeNBAGameSource(games_by_season={"1996-97": []})

    backfill_nba_stats_flow(
        start_season=1996,
        end_season=1996,
        sink=sink,
        checkpoint_store=checkpoint_store,
        client=client,
    )

    assert checkpoint_store.get_last_pulled_date("backfill_flow") == date(2024, 5, 5)
    assert checkpoint_store.get_last_pulled_date("backfill_stats") == date(2024, 6, 6)
    assert checkpoint_store.get_last_pulled_date(CHECKPOINT_FLOW_NAME) is None
