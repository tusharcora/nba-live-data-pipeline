from datetime import date

import pytest

from db.models import QualityMetric
from quality.volumetric import (
    GoldReader,
    QualityMetricSink,
    check_completed_games,
    check_game_volumetrics,
)

GAME_ID = 42


class FakeGoldReader:
    """In-memory GoldReader — no DB, just a canned list of games."""

    def __init__(self, games: list[tuple[int, set[int], dict[int, int]]]) -> None:
        self._games = games
        self.requested_as_of: date | None = None

    def get_completed_games_with_player_counts(
        self, as_of: date
    ) -> list[tuple[int, set[int], dict[int, int]]]:
        self.requested_as_of = as_of
        return self._games


class FakeQualityMetricSink:
    """In-memory QualityMetricSink — no DB, just a list."""

    def __init__(self) -> None:
        self.written: list[QualityMetric] = []

    def write_many(self, metrics: list[QualityMetric]) -> None:
        self.written.extend(metrics)


# --- table-driven boundary-value tests for the pure check ------------------
#
# case_name, team_ids, player_row_count_by_team, expect_pass, reason_substrings
# reason_substrings is empty for passing cases (failure_reason must be None).
BOUNDARY_CASES = [
    (
        "one_team_fails",
        {1},
        {1: 10},
        False,
        ["expected exactly 2 teams", "found 1"],
    ),
    (
        "two_teams_within_bounds_passes",
        {1, 2},
        {1: 10, 2: 12},
        True,
        [],
    ),
    (
        "three_teams_fails",
        {1, 2, 3},
        {1: 10, 2: 10, 3: 10},
        False,
        ["expected exactly 2 teams", "found 3"],
    ),
    (
        "player_count_below_min_fails",
        {1, 2},
        {1: 7, 2: 10},
        False,
        ["team 1", "7 player rows"],
    ),
    (
        "player_count_at_min_passes",
        {1, 2},
        {1: 8, 2: 8},
        True,
        [],
    ),
    (
        "player_count_within_bounds_passes",
        {1, 2},
        {1: 11, 2: 11},
        True,
        [],
    ),
    (
        "player_count_at_max_passes",
        {1, 2},
        {1: 15, 2: 15},
        True,
        [],
    ),
    (
        "player_count_above_max_fails",
        {1, 2},
        {1: 16, 2: 10},
        False,
        ["team 1", "16 player rows"],
    ),
    (
        "team_missing_from_counts_treated_as_zero_fails",
        {1, 2},
        {1: 10},
        False,
        ["team 2", "0 player rows"],
    ),
]


@pytest.mark.parametrize(
    "case_name, team_ids, player_counts, expect_pass, reason_substrings",
    BOUNDARY_CASES,
    ids=[c[0] for c in BOUNDARY_CASES],
)
def test_check_game_volumetrics_boundary_cases(
    case_name, team_ids, player_counts, expect_pass, reason_substrings
):
    metric = check_game_volumetrics(GAME_ID, team_ids, player_counts)

    assert metric.check_name == "volumetric_game_check"
    assert metric.metadata_json["game_id"] == GAME_ID
    assert set(metric.metadata_json["team_ids"]) == team_ids
    assert metric.metadata_json["player_counts"] == player_counts

    if expect_pass:
        assert metric.metric_value == 1.0
        assert metric.metadata_json["failure_reason"] is None
    else:
        assert metric.metric_value == 0.0
        reason = metric.metadata_json["failure_reason"]
        assert reason is not None
        for substring in reason_substrings:
            assert substring in reason


def test_check_game_volumetrics_respects_custom_bounds():
    passing = check_game_volumetrics(
        GAME_ID,
        {1, 2},
        {1: 5, 2: 5},
        min_players_per_team=5,
        max_players_per_team=5,
    )
    assert passing.metric_value == 1.0
    assert passing.metadata_json["failure_reason"] is None

    failing = check_game_volumetrics(
        GAME_ID,
        {1, 2},
        {1: 6, 2: 5},
        min_players_per_team=5,
        max_players_per_team=5,
    )
    assert failing.metric_value == 0.0
    assert "team 1" in failing.metadata_json["failure_reason"]
    assert "6 player rows" in failing.metadata_json["failure_reason"]


def test_check_game_volumetrics_reports_multiple_out_of_bounds_teams():
    metric = check_game_volumetrics(GAME_ID, {1, 2}, {1: 3, 2: 20})

    reason = metric.metadata_json["failure_reason"]
    assert metric.metric_value == 0.0
    assert "team 1" in reason
    assert "3 player rows" in reason
    assert "team 2" in reason
    assert "20 player rows" in reason


# --- orchestration tests, with fakes for GoldReader/QualityMetricSink ------


def test_check_completed_games_runs_pure_check_per_game_and_writes_via_sink():
    games = [
        (1, {10, 20}, {10: 10, 20: 10}),  # passes
        (2, {30}, {30: 10}),  # fails: only 1 team
    ]
    reader = FakeGoldReader(games)
    sink = FakeQualityMetricSink()
    as_of = date(2026, 1, 1)

    result = check_completed_games(reader, sink, as_of)

    assert len(result) == 2
    assert all(isinstance(m, QualityMetric) for m in result)
    assert result[0].metric_value == 1.0
    assert result[0].metadata_json["game_id"] == 1
    assert result[1].metric_value == 0.0
    assert result[1].metadata_json["game_id"] == 2

    # sink received exactly what was returned, written in one batch call
    assert sink.written == result
    assert reader.requested_as_of == as_of


def test_check_completed_games_with_no_games_writes_nothing():
    reader = FakeGoldReader([])
    sink = FakeQualityMetricSink()

    result = check_completed_games(reader, sink, date(2026, 1, 1))

    assert result == []
    assert sink.written == []


def test_fakes_satisfy_the_runtime_checkable_protocols():
    reader = FakeGoldReader([])
    sink = FakeQualityMetricSink()

    assert isinstance(reader, GoldReader)
    assert isinstance(sink, QualityMetricSink)
