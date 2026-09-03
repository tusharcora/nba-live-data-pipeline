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


class FakeExistingGamesReader:
    """In-memory ExistingGamesReader — stands in for the Gold `games` table."""

    def __init__(self, games_by_date: dict[date, list[tuple[int, set[str]]]]) -> None:
        self._games_by_date = games_by_date
        self.requested_dates: list[date] = []

    def get_games_for_date(self, game_date: date) -> list[tuple[int, set[str]]]:
        self.requested_dates.append(game_date)
        return self._games_by_date.get(game_date, [])


class FakeNBAGameSource:
    """In-memory NBAGameSource — no network, no nba_api."""

    def __init__(
        self,
        games_by_date: dict[str, list[dict]],
        boxscores_by_game_id: dict[str, list[dict]] | None = None,
        raise_for_game_id: str | None = None,
    ) -> None:
        self._games_by_date = games_by_date
        self._boxscores_by_game_id = boxscores_by_game_id or {}
        self._raise_for_game_id = raise_for_game_id
        self.requested_dates: list[str] = []
        self.requested_boxscore_ids: list[str] = []

    def get_games_for_date(self, date_str: str) -> list[dict]:
        self.requested_dates.append(date_str)
        return self._games_by_date.get(date_str, [])

    def get_boxscore(self, nba_game_id: str) -> list[dict]:
        self.requested_boxscore_ids.append(nba_game_id)
        if nba_game_id == self._raise_for_game_id:
            raise RuntimeError("simulated 403 from stats.nba.com")
        return self._boxscores_by_game_id.get(nba_game_id, [])


def test_backfill_nba_stats_flow_writes_matched_games_and_advances_checkpoint():
    """A balldontlie game and an NBA.com game sharing a team name match, and
    the resulting Bronze payload carries balldontlie's game_id directly."""
    sink = FakeSink()
    checkpoint_store = FakeCheckpointStore()
    existing_games_reader = FakeExistingGamesReader(
        {date(2024, 1, 1): [(15908, {"Atlanta Hawks", "Boston Celtics"})]}
    )
    client = FakeNBAGameSource(
        games_by_date={
            "2024-01-01": [
                {
                    "game_id": "0022300500",
                    "team_names": {"Atlanta Hawks", "Boston Celtics"},
                }
            ]
        },
        boxscores_by_game_id={
            "0022300500": [
                {
                    "PLAYER_NAME": "Trae Young",
                    "PTS": 25,
                    "player_key": "trae young",
                }
            ]
        },
    )

    result = backfill_nba_stats_flow(
        start_date="2024-01-01",
        end_date="2024-01-01",
        sink=sink,
        checkpoint_store=checkpoint_store,
        existing_games_reader=existing_games_reader,
        client=client,
    )

    assert result == {
        "dates_processed": 1,
        "raw_pulls_written": 1,
        "games_matched": 1,
        "games_unmatched": 0,
    }
    assert client.requested_boxscore_ids == ["0022300500"]

    assert len(sink.written) == 1
    raw_pull = sink.written[0]
    assert raw_pull.source == "nba_stats"
    assert raw_pull.endpoint == "boxscore_traditional"
    # balldontlie's own game_id is carried directly — no cross-source id
    # translation needed downstream.
    assert raw_pull.payload == {
        "balldontlie_game_id": 15908,
        "player_stats": [
            {"PLAYER_NAME": "Trae Young", "PTS": 25, "player_key": "trae young"}
        ],
    }

    assert checkpoint_store.get_last_pulled_date(CHECKPOINT_FLOW_NAME) == date(
        2024, 1, 1
    )


def test_backfill_nba_stats_flow_skips_unmatched_nba_game_without_fabricating_id():
    """An NBA.com game with no balldontlie team-name overlap is skipped —
    never written with a null/fabricated balldontlie_game_id."""
    sink = FakeSink()
    checkpoint_store = FakeCheckpointStore()
    existing_games_reader = FakeExistingGamesReader(
        {date(2024, 1, 1): [(15908, {"Atlanta Hawks", "Boston Celtics"})]}
    )
    client = FakeNBAGameSource(
        games_by_date={
            "2024-01-01": [
                {
                    "game_id": "0022300999",
                    "team_names": {"Miami Heat", "Orlando Magic"},
                }
            ]
        },
        boxscores_by_game_id={"0022300999": [{"PLAYER_NAME": "Jimmy Butler"}]},
    )

    result = backfill_nba_stats_flow(
        start_date="2024-01-01",
        end_date="2024-01-01",
        sink=sink,
        checkpoint_store=checkpoint_store,
        existing_games_reader=existing_games_reader,
        client=client,
    )

    assert result == {
        "dates_processed": 1,
        "raw_pulls_written": 0,
        "games_matched": 0,
        "games_unmatched": 1,
    }
    assert sink.written == []
    # The unmatched game's box score is never even fetched.
    assert client.requested_boxscore_ids == []
    assert checkpoint_store.get_last_pulled_date(CHECKPOINT_FLOW_NAME) == date(
        2024, 1, 1
    )


def test_backfill_nba_stats_flow_does_not_advance_checkpoint_on_mid_date_failure():
    """A box-score fetch that raises mid-date (simulating a 403/CAPTCHA
    block) must propagate, naming the failing date/game, and must NOT
    advance the checkpoint past the last fully-completed date."""
    sink = FakeSink()
    checkpoint_store = FakeCheckpointStore(initial=date(2023, 12, 31))
    existing_games_reader = FakeExistingGamesReader(
        {
            date(2024, 1, 1): [
                (1, {"Atlanta Hawks", "Boston Celtics"}),
                (2, {"Miami Heat", "Orlando Magic"}),
            ]
        }
    )
    client = FakeNBAGameSource(
        games_by_date={
            "2024-01-01": [
                {"game_id": "G1", "team_names": {"Atlanta Hawks", "Boston Celtics"}},
                {"game_id": "G2", "team_names": {"Miami Heat", "Orlando Magic"}},
            ]
        },
        boxscores_by_game_id={"G1": [{"PLAYER_NAME": "Trae Young"}]},
        raise_for_game_id="G2",
    )

    with pytest.raises(RuntimeError, match="G2"):
        backfill_nba_stats_flow(
            end_date="2024-01-01",
            sink=sink,
            checkpoint_store=checkpoint_store,
            existing_games_reader=existing_games_reader,
            client=client,
        )

    # The checkpoint stays at the last fully-completed date (2023-12-31),
    # never advancing into the date that partially failed.
    assert checkpoint_store.get_last_pulled_date(CHECKPOINT_FLOW_NAME) == date(
        2023, 12, 31
    )
    # G1's box score was already written before G2 raised — that's fine
    # (raw_pulls is append-only); what matters is the checkpoint doesn't move.
    assert len(sink.written) == 1
    assert sink.written[0].payload["balldontlie_game_id"] == 1


def test_backfill_nba_stats_flow_requires_start_date_on_first_run():
    sink = FakeSink()
    checkpoint_store = FakeCheckpointStore()
    existing_games_reader = FakeExistingGamesReader({})
    client = FakeNBAGameSource(games_by_date={})

    with pytest.raises(ValueError):
        backfill_nba_stats_flow(
            end_date="2024-01-02",
            sink=sink,
            checkpoint_store=checkpoint_store,
            existing_games_reader=existing_games_reader,
            client=client,
        )


def test_backfill_nba_stats_flow_uses_independent_checkpoint_from_other_backfills():
    sink = FakeSink()
    checkpoint_store = FakeCheckpointStore()
    checkpoint_store.advance("backfill_flow", date(2024, 5, 5))
    checkpoint_store.advance("backfill_stats", date(2024, 6, 6))
    existing_games_reader = FakeExistingGamesReader({date(2024, 1, 1): []})
    client = FakeNBAGameSource(games_by_date={"2024-01-01": []})

    result = backfill_nba_stats_flow(
        start_date="2024-01-01",
        end_date="2024-01-01",
        sink=sink,
        checkpoint_store=checkpoint_store,
        existing_games_reader=existing_games_reader,
        client=client,
    )

    assert result == {
        "dates_processed": 1,
        "raw_pulls_written": 0,
        "games_matched": 0,
        "games_unmatched": 0,
    }
    assert checkpoint_store.get_last_pulled_date("backfill_flow") == date(2024, 5, 5)
    assert checkpoint_store.get_last_pulled_date("backfill_stats") == date(2024, 6, 6)
    assert checkpoint_store.get_last_pulled_date(CHECKPOINT_FLOW_NAME) == date(
        2024, 1, 1
    )
