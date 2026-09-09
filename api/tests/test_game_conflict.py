from dataclasses import dataclass
from datetime import date, datetime, timezone

from api.routers.game_conflict import (
    NBA_GAME_ID_OFFSET,
    DataConfidence,
    et_day_bounds,
    resolve_nba_stats_game_id,
    select_score_conflict,
)


@dataclass
class FakeCandidate:
    game_id: int
    home_team: str | None
    away_team: str | None


@dataclass
class FakeConflict:
    field_name: str
    primary_source: str
    primary_value: str | None
    secondary_source: str
    secondary_value: str | None


def test_et_day_bounds_spans_one_full_utc_day_pair():
    start_utc, end_utc = et_day_bounds(date(2026, 1, 15))
    assert (end_utc - start_utc).total_seconds() == 24 * 3600
    assert start_utc.tzinfo is timezone.utc
    # ET is UTC-5 in January (standard time, no DST) -- midnight ET is 05:00 UTC.
    assert start_utc.hour == 5
    assert start_utc.day == 15


def test_resolve_nba_stats_game_id_nba_api_offset_is_deterministic():
    gold_id = NBA_GAME_ID_OFFSET + 22500123
    # No candidates needed at all for the offset case -- it's pure arithmetic.
    result = resolve_nba_stats_game_id(gold_id, "Lakers", "Celtics", [])
    assert result == 22500123


def test_resolve_nba_stats_game_id_balldontlie_matches_by_team_overlap():
    gold_id = 987654  # balldontlie-native, well below the offset
    candidates = [
        FakeCandidate(game_id=22500999, home_team="Lakers", away_team="Celtics"),
        FakeCandidate(game_id=22500888, home_team="Warriors", away_team="Suns"),
    ]
    result = resolve_nba_stats_game_id(gold_id, "Celtics", "Lakers", candidates)
    assert result == 22500999


def test_resolve_nba_stats_game_id_balldontlie_no_match_returns_none():
    gold_id = 987654
    candidates = [FakeCandidate(game_id=22500888, home_team="Warriors", away_team="Suns")]
    assert resolve_nba_stats_game_id(gold_id, "Celtics", "Lakers", candidates) is None


def test_resolve_nba_stats_game_id_balldontlie_shared_team_name_picks_first_match():
    gold_id = 987654
    # Two candidates on the same day sharing a team name -- the matcher
    # doesn't attempt true ambiguity detection, it just claims in order.
    candidates = [
        FakeCandidate(game_id=1, home_team="Lakers", away_team="Nets"),
        FakeCandidate(game_id=2, home_team="Lakers", away_team="Bulls"),
    ]
    result = resolve_nba_stats_game_id(gold_id, "Lakers", "Nets", candidates)
    assert result == 1  # first team-overlap match wins -- matches the reused
    # matcher's own documented first-claim behavior, not true ambiguity
    # detection. Documented here, not silently assumed.


def test_resolve_nba_stats_game_id_ignores_candidates_missing_team_names():
    gold_id = 987654
    candidates = [FakeCandidate(game_id=1, home_team=None, away_team=None)]
    assert resolve_nba_stats_game_id(gold_id, "Lakers", "Nets", candidates) is None


def test_select_score_conflict_returns_first_score_field_match():
    # Production-realistic shape: `reconcile_live_states` always hardcodes
    # primary_source="nba_stats" -- a `primary_source="balldontlie"` row (as
    # this test previously used) can never occur in production. See
    # ingestion/flows/live_game_flow.py::reconcile_live_states.
    conflicts = [
        FakeConflict(
            field_name="home_score",
            primary_source="nba_stats",
            primary_value="101",
            secondary_source="balldontlie",
            secondary_value="103",
        )
    ]
    result = select_score_conflict(conflicts)
    assert result == DataConfidence(
        field="home_score",
        note=(
            "nba_stats and balldontlie disagreed on home score during live "
            "play (nba_stats: 101, balldontlie: 103)."
        ),
        primary_source="nba_stats",
        primary_value="101",
        secondary_source="balldontlie",
        secondary_value="103",
    )


def test_select_score_conflict_note_never_claims_which_number_is_shown():
    # The critical invariant this test pins: the note must never assert
    # which source's value is actually displayed on a historical/Gold
    # answer -- `primary_source` only reflects live reconciliation, not
    # what get_game_result/get_player_stats actually serve for a
    # balldontlie-sourced Gold game. See select_score_conflict's docstring.
    conflicts = [
        FakeConflict(
            field_name="away_score",
            primary_source="nba_stats",
            primary_value="90",
            secondary_source="balldontlie",
            secondary_value="92",
        )
    ]
    result = select_score_conflict(conflicts)
    assert result is not None
    assert "showing" not in result.note


def test_select_score_conflict_most_recent_wins_when_multiple_conflicts_exist():
    # `load_score_conflict`'s query is ordered by detected_at DESC, so by
    # the time conflicts reach this pure function they're already
    # newest-first -- this pins the "most recent wins" contract at the
    # pure-function level (the DB ordering itself isn't unit-testable
    # without a live database).
    conflicts = [
        FakeConflict(
            field_name="home_score",
            primary_source="nba_stats",
            primary_value="101",
            secondary_source="balldontlie",
            secondary_value="103",
        ),
        FakeConflict(
            field_name="home_score",
            primary_source="nba_stats",
            primary_value="99",
            secondary_source="balldontlie",
            secondary_value="98",
        ),
    ]
    result = select_score_conflict(conflicts)
    assert result is not None
    assert result.primary_value == "101"
    assert result.secondary_value == "103"


def test_select_score_conflict_ignores_non_score_fields():
    # Documents the Global Constraints invariant: this should never happen
    # in production, but the function must not misbehave if it did.
    conflicts = [
        FakeConflict(
            field_name="period",
            primary_source="nba_stats",
            primary_value="3",
            secondary_source="balldontlie",
            secondary_value="4",
        )
    ]
    assert select_score_conflict(conflicts) is None


def test_select_score_conflict_empty_returns_none():
    assert select_score_conflict([]) is None


def test_data_confidence_to_dict_shape():
    dc = DataConfidence(
        field="away_score",
        note="x",
        primary_source="nba_stats",
        primary_value="1",
        secondary_source="balldontlie",
        secondary_value="2",
    )
    assert dc.to_dict() == {
        "field": "away_score",
        "note": "x",
        "primary_source": "nba_stats",
        "primary_value": "1",
        "secondary_source": "balldontlie",
        "secondary_value": "2",
    }
