from datetime import date

import pytest

from db.models import QualityMetric, SourceConflict
from quality.reconciliation import (
    match_games_by_team_overlap,
    reconcile_game,
    reconcile_games_for_date,
)


class TestReconcileGame:
    """Table-driven tests for the pure `reconcile_game` primary-source-wins rule."""

    def test_all_fields_matching_yields_no_conflicts_and_full_agreement(self):
        conflicts, agreement_rate = reconcile_game(
            game_id="game-1",
            primary_source="balldontlie",
            primary_fields={"home_score": "100", "away_score": "98", "status": "Final"},
            secondary_source="espn",
            secondary_fields={"home_score": "100", "away_score": "98", "status": "Final"},
        )

        assert conflicts == []
        assert agreement_rate == 1.0

    def test_one_conflicting_field_among_several_matching(self):
        conflicts, agreement_rate = reconcile_game(
            game_id="game-2",
            primary_source="balldontlie",
            primary_fields={"home_score": "100", "away_score": "98", "status": "Final"},
            secondary_source="espn",
            secondary_fields={"home_score": "101", "away_score": "98", "status": "Final"},
        )

        assert len(conflicts) == 1
        conflict = conflicts[0]
        assert isinstance(conflict, SourceConflict)
        assert conflict.game_id == "game-2"
        assert conflict.field_name == "home_score"
        assert conflict.primary_source == "balldontlie"
        assert conflict.primary_value == "100"
        assert conflict.secondary_source == "espn"
        assert conflict.secondary_value == "101"
        # primary source wins: resolution takes the primary value.
        assert conflict.resolution == "100"
        # 3 comparable fields, 1 conflict -> 2/3 agreement.
        assert agreement_rate == pytest.approx(2 / 3)

    def test_field_present_only_on_one_side_is_excluded_from_comparison(self):
        conflicts, agreement_rate = reconcile_game(
            game_id="game-3",
            primary_source="balldontlie",
            primary_fields={"home_score": "100", "period": "4"},
            secondary_source="espn",
            secondary_fields={"home_score": "100", "status": "Final"},
        )

        # Only "home_score" is present on both sides; "period" and "status"
        # are excluded entirely (not conflicts, not part of the denominator).
        assert conflicts == []
        assert agreement_rate == 1.0

    def test_zero_comparable_fields_yields_full_agreement_by_convention(self):
        conflicts, agreement_rate = reconcile_game(
            game_id="game-4",
            primary_source="balldontlie",
            primary_fields={"period": "4"},
            secondary_source="espn",
            secondary_fields={"status": "Final"},
        )

        assert conflicts == []
        assert agreement_rate == 1.0


class TestMatchGamesByTeamOverlap:
    """The date+team-overlap game-matching heuristic (unvalidated against real
    dual-source data — see the module docstring and PR notes)."""

    def test_matches_games_with_identical_team_name_sets(self):
        primary_games = [("p1", {"Boston Celtics", "Miami Heat"}, {"home_score": "100"})]
        secondary_games = [
            ("s1", {"Boston Celtics", "Miami Heat"}, {"home_score": "100"})
        ]

        matched = match_games_by_team_overlap(primary_games, secondary_games)

        assert matched == [("p1", {"home_score": "100"}, {"home_score": "100"})]

    def test_matches_games_with_partially_overlapping_team_names(self):
        # A naming variant on one team ("LA Clippers" vs "Los Angeles
        # Clippers") still matches because the other team name overlaps.
        primary_games = [
            ("p1", {"Los Angeles Clippers", "Denver Nuggets"}, {"home_score": "90"})
        ]
        secondary_games = [("s1", {"LA Clippers", "Denver Nuggets"}, {"home_score": "90"})]

        matched = match_games_by_team_overlap(primary_games, secondary_games)

        assert matched == [("p1", {"home_score": "90"}, {"home_score": "90"})]

    def test_no_overlap_yields_no_match(self):
        primary_games = [("p1", {"Boston Celtics", "Miami Heat"}, {"home_score": "100"})]
        secondary_games = [
            ("s1", {"Golden State Warriors", "LA Lakers"}, {"home_score": "115"})
        ]

        matched = match_games_by_team_overlap(primary_games, secondary_games)

        assert matched == []

    def test_each_secondary_game_is_matched_at_most_once(self):
        # Two primary games should not both claim the same secondary game.
        primary_games = [
            ("p1", {"Boston Celtics", "Miami Heat"}, {"home_score": "100"}),
            ("p2", {"Boston Celtics", "Chicago Bulls"}, {"home_score": "90"}),
        ]
        secondary_games = [("s1", {"Boston Celtics", "Miami Heat"}, {"home_score": "100"})]

        matched = match_games_by_team_overlap(primary_games, secondary_games)

        assert len(matched) == 1
        assert matched[0][0] == "p1"


class FakeDualSourceReader:
    def __init__(self, matched_games):
        self._matched_games = matched_games

    def get_matched_games(self, as_of):
        return self._matched_games


class FakeReconciliationSink:
    def __init__(self):
        self.written_conflicts: list[SourceConflict] = []
        self.written_metrics: list[QualityMetric] = []

    def write_conflicts(self, conflicts):
        self.written_conflicts.extend(conflicts)

    def write_metric(self, metric):
        self.written_metrics.append(metric)


class TestReconcileGamesForDate:
    def test_orchestration_writes_conflicts_and_returns_aggregate_metric(self):
        as_of = date(2026, 1, 15)
        matched_games = [
            (
                "game-1",
                {"home_score": "100", "away_score": "98"},
                {"home_score": "100", "away_score": "98"},
            ),
            (
                "game-2",
                {"home_score": "110", "away_score": "90"},
                {"home_score": "111", "away_score": "90"},
            ),
        ]
        reader = FakeDualSourceReader(matched_games)
        sink = FakeReconciliationSink()

        metric = reconcile_games_for_date(as_of, reader, sink, primary_source="balldontlie")

        # game-1: 2/2 agree, game-2: 1/2 agree -> 3/4 overall.
        assert len(sink.written_conflicts) == 1
        assert sink.written_conflicts[0].game_id == "game-2"
        assert sink.written_conflicts[0].field_name == "home_score"

        assert isinstance(metric, QualityMetric)
        assert metric.check_name == "cross_source_agreement_rate"
        assert metric.metric_value == pytest.approx(3 / 4)
        assert metric.metadata_json == {"games_compared": 2, "date": str(as_of)}
        assert sink.written_metrics == [metric]

    def test_no_matched_games_yields_full_agreement_and_no_conflicts(self):
        as_of = date(2026, 1, 15)
        reader = FakeDualSourceReader([])
        sink = FakeReconciliationSink()

        metric = reconcile_games_for_date(as_of, reader, sink)

        assert sink.written_conflicts == []
        assert metric.metric_value == 1.0
        assert metric.metadata_json == {"games_compared": 0, "date": str(as_of)}
