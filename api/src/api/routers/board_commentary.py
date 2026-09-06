"""Rule-based commentary for one live game — a single templated line
driven entirely by real signals already in this pipeline
(`live_game_state`, `source_conflicts`), never free-form or LLM-generated.
See docs/superpowers/specs/2026-09-06-recent-games-board-and-commentator-design.md
§6 for the full design and priority rationale.

Commentary text uses full team names (e.g. "Miami Heat on a 7-0 run"),
not 3-letter abbreviations — abbreviation lookup
(`TEAM_NAME_TO_ABBREVIATION`) is a frontend-only concern, and duplicating
that 30-team table in Python purely for commentary-string cosmetics isn't
worth the maintenance burden. A deliberate, disclosed simplification.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Protocol

MIN_RUN_POINTS = 6
STALE_THRESHOLD_SECONDS = 45
CONFLICT_DISPLAY_WINDOW_SECONDS = 300

CommentaryKind = Literal["conflict", "stale", "run", "leader"]


@dataclass(frozen=True)
class Commentary:
    text: str
    kind: CommentaryKind


class _StateLike(Protocol):
    """Structural shape this module actually reads off a `LiveGameState`
    (or a test double) — kept narrow and local rather than importing the
    ORM model, since every function here is pure and DB-agnostic."""

    home_score: int | None
    away_score: int | None
    pulled_at: datetime
    home_team: str | None
    away_team: str | None


class _ConflictLike(Protocol):
    field_name: str
    secondary_source: str
    detected_at: datetime


def _age_seconds(pulled_at: datetime, now: datetime) -> float:
    return (now - pulled_at).total_seconds()


def _check_conflict(
    nba_stats_latest: _StateLike,
    other_sources_latest: Mapping[str, _StateLike],
    conflicts: Sequence[_ConflictLike],
    now: datetime,
) -> Commentary | None:
    """A `source_conflicts` row for this game, still within the display
    window, AND the two sources' *current* latest values for that same
    field still actually differ — re-checked against `nba_stats_latest`/
    `other_sources_latest` directly rather than trusting the conflict
    row's own (potentially stale) snapshot values, so a disagreement that
    self-corrected on a later poll stops outranking live commentary
    immediately rather than lingering for the rest of the display window.
    """
    field_values = {
        "home_score": nba_stats_latest.home_score,
        "away_score": nba_stats_latest.away_score,
    }

    for conflict in conflicts:
        if _age_seconds(conflict.detected_at, now) > CONFLICT_DISPLAY_WINDOW_SECONDS:
            continue
        secondary = other_sources_latest.get(conflict.secondary_source)
        if secondary is None:
            continue
        current_primary_value = field_values.get(conflict.field_name)
        current_secondary_value = getattr(secondary, conflict.field_name, None)
        if current_primary_value is None or current_secondary_value is None:
            continue
        if current_primary_value != current_secondary_value:
            return Commentary(f"Source conflict · {conflict.field_name}", "conflict")

    return None


def _check_stale(
    nba_stats_latest: _StateLike,
    other_sources_latest: Mapping[str, _StateLike],
    now: datetime,
) -> Commentary | None:
    """`nba_stats` itself lagging is checked first — it's the canonical
    display source, so a stale `nba_stats` row means the visible
    score/clock may already be outdated. A lagging secondary source is a
    lower-stakes reconciliation note, checked only if nba_stats is fresh.
    Either case requires at least one *other* source to be current — a
    whole-pipeline outage isn't a "this feed is delayed" call the
    commentator can meaningfully make per game.
    """
    nba_stats_age = _age_seconds(nba_stats_latest.pulled_at, now)
    fresh_others = [
        state
        for state in other_sources_latest.values()
        if _age_seconds(state.pulled_at, now) <= STALE_THRESHOLD_SECONDS
    ]
    if nba_stats_age > STALE_THRESHOLD_SECONDS and fresh_others:
        return Commentary("Feed stale · nba_stats delayed", "stale")

    if nba_stats_age <= STALE_THRESHOLD_SECONDS:
        for source, state in other_sources_latest.items():
            if _age_seconds(state.pulled_at, now) > STALE_THRESHOLD_SECONDS:
                return Commentary(f"Feed stale · {source} delayed", "stale")

    return None


def _detect_run(nba_stats_history: Sequence[_StateLike]) -> Commentary | None:
    """Infers a scoring run from cumulative score snapshots (no
    play-by-play exists) — see design §6.2. `nba_stats_history` must be
    newest-first. Walks backward accumulating each side's score delta
    between consecutive snapshots; the streak breaks the moment the
    *other* side's score also increases.
    """
    if len(nba_stats_history) < 2:
        return None

    newest = nba_stats_history[0]
    if newest.home_score is None or newest.away_score is None:
        return None

    home_run_points = 0
    away_run_points = 0
    current = newest
    for previous in nba_stats_history[1:]:
        if previous.home_score is None or previous.away_score is None:
            break
        home_delta = current.home_score - previous.home_score
        away_delta = current.away_score - previous.away_score
        if home_delta > 0 and away_delta > 0:
            break
        if home_delta <= 0 and away_delta <= 0:
            break
        home_run_points += max(home_delta, 0)
        away_run_points += max(away_delta, 0)
        current = previous

    if home_run_points >= MIN_RUN_POINTS:
        return Commentary(f"{newest.home_team} on a {home_run_points}-0 run", "run")
    if away_run_points >= MIN_RUN_POINTS:
        return Commentary(f"{newest.away_team} on a {away_run_points}-0 run", "run")
    return None


def _leader_margin(nba_stats_latest: _StateLike) -> Commentary:
    home = nba_stats_latest.home_score or 0
    away = nba_stats_latest.away_score or 0
    if home == away:
        return Commentary("Tied", "leader")
    if home > away:
        return Commentary(f"{nba_stats_latest.home_team} leads by {home - away}", "leader")
    return Commentary(f"{nba_stats_latest.away_team} leads by {away - home}", "leader")


def compute_commentary(
    nba_stats_history: Sequence[_StateLike],
    other_sources_latest: Mapping[str, _StateLike],
    conflicts: Sequence[_ConflictLike],
    now: datetime,
) -> Commentary | None:
    """One commentary line for a live game, highest-priority signal wins:
    source conflict > feed stale > scoring run > leader margin. See
    design §6.1. `nba_stats_history` must be newest-first; an empty
    history (no nba_stats row for this game) returns `None`.
    """
    if not nba_stats_history:
        return None
    nba_stats_latest = nba_stats_history[0]

    return (
        _check_conflict(nba_stats_latest, other_sources_latest, conflicts, now)
        or _check_stale(nba_stats_latest, other_sources_latest, now)
        or _detect_run(nba_stats_history)
        or _leader_margin(nba_stats_latest)
    )
