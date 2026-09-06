from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from api.routers.board_commentary import compute_commentary

NOW = datetime(2026, 1, 1, 20, 0, 0, tzinfo=timezone.utc)


def _state(home_score, away_score, pulled_at=NOW, home_team="Miami Heat", away_team="Boston Celtics"):
    return SimpleNamespace(
        home_score=home_score,
        away_score=away_score,
        pulled_at=pulled_at,
        home_team=home_team,
        away_team=away_team,
    )


def _conflict(field_name, secondary_source, detected_at=NOW):
    return SimpleNamespace(
        field_name=field_name, secondary_source=secondary_source, detected_at=detected_at
    )


def test_leader_margin_is_the_fallback():
    history = [_state(91, 88)]
    result = compute_commentary(history, {}, [], NOW)
    assert result.text == "Miami Heat leads by 3"
    assert result.kind == "leader"


def test_tied_score_reports_tied():
    history = [_state(88, 88)]
    result = compute_commentary(history, {}, [], NOW)
    assert result.text == "Tied"
    assert result.kind == "leader"


def test_scoring_run_above_threshold_beats_leader_margin():
    # Home team scores 91->97 (6 pts) across 3 snapshots while away stays 88.
    history = [
        _state(97, 88, pulled_at=NOW),
        _state(94, 88, pulled_at=NOW - timedelta(seconds=5)),
        _state(91, 88, pulled_at=NOW - timedelta(seconds=10)),
    ]
    result = compute_commentary(history, {}, [], NOW)
    assert result.text == "Miami Heat on a 6-0 run"
    assert result.kind == "run"


def test_scoring_run_below_threshold_falls_through_to_leader_margin():
    history = [
        _state(93, 88, pulled_at=NOW),
        _state(91, 88, pulled_at=NOW - timedelta(seconds=5)),
    ]
    result = compute_commentary(history, {}, [], NOW)
    assert result.kind == "leader"
    assert result.text == "Miami Heat leads by 5"


def test_run_streak_breaks_when_other_team_also_scores():
    history = [
        _state(97, 90, pulled_at=NOW),           # away scored here too -> streak stops
        _state(94, 88, pulled_at=NOW - timedelta(seconds=5)),
        _state(91, 88, pulled_at=NOW - timedelta(seconds=10)),
    ]
    result = compute_commentary(history, {}, [], NOW)
    # Only the last (94->97, +3) leg counts once the away score also moves.
    assert result.kind == "leader"


def test_stale_nba_stats_reported_when_a_secondary_source_is_fresh():
    history = [_state(91, 88, pulled_at=NOW - timedelta(seconds=60))]
    other_sources = {"balldontlie": _state(89, 88, pulled_at=NOW)}
    result = compute_commentary(history, other_sources, [], NOW)
    assert result.text == "Feed stale · nba_stats delayed"
    assert result.kind == "stale"


def test_stale_secondary_source_reported_when_nba_stats_is_fresh():
    history = [_state(91, 88, pulled_at=NOW)]
    other_sources = {"balldontlie": _state(89, 88, pulled_at=NOW - timedelta(seconds=60))}
    result = compute_commentary(history, other_sources, [], NOW)
    assert result.text == "Feed stale · balldontlie delayed"
    assert result.kind == "stale"


def test_no_staleness_reported_when_everything_is_stale():
    """Whole-pipeline outage isn't a per-game "this feed is delayed" call —
    requires at least one *other* fresh source for the check to fire.
    """
    history = [_state(91, 88, pulled_at=NOW - timedelta(seconds=60))]
    other_sources = {"balldontlie": _state(89, 88, pulled_at=NOW - timedelta(seconds=90))}
    result = compute_commentary(history, other_sources, [], NOW)
    assert result.kind != "stale"


def test_conflict_outranks_run_and_leader_when_values_still_differ():
    history = [_state(91, 88, pulled_at=NOW)]
    other_sources = {"balldontlie": _state(89, 88, pulled_at=NOW)}
    conflicts = [_conflict("home_score", "balldontlie", detected_at=NOW)]
    result = compute_commentary(history, other_sources, conflicts, NOW)
    assert result.text == "Source conflict · home_score"
    assert result.kind == "conflict"


def test_conflict_ignored_once_values_agree_again():
    """Re-checks current values rather than trusting the conflict row's
    old snapshot — a self-corrected disagreement stops outranking live
    commentary immediately.
    """
    history = [_state(91, 88, pulled_at=NOW)]
    other_sources = {"balldontlie": _state(91, 88, pulled_at=NOW)}  # now agrees
    conflicts = [_conflict("home_score", "balldontlie", detected_at=NOW)]
    result = compute_commentary(history, other_sources, conflicts, NOW)
    assert result.kind != "conflict"


def test_conflict_outside_display_window_is_ignored():
    history = [_state(91, 88, pulled_at=NOW)]
    other_sources = {"balldontlie": _state(89, 88, pulled_at=NOW)}
    old_conflict = [_conflict("home_score", "balldontlie", detected_at=NOW - timedelta(seconds=301))]
    result = compute_commentary(history, other_sources, old_conflict, NOW)
    assert result.kind != "conflict"


def test_empty_history_returns_none():
    assert compute_commentary([], {}, [], NOW) is None
