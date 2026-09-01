"""Cross-source reconciliation (docs/prd.md §07 "Cross-source reconciliation").

Week 2 scope implements only the "primary source wins" resolution rule: when
two sources disagree on a field, the primary source's value is taken as the
resolution and a `SourceConflict` row is recorded for visibility.

**Deferred (future work, not implemented here):** the PRD's fuller rule is
"primary source wins unless a third check ... corroborates the secondary" —
i.e. a third independent signal (e.g. a play-by-play event count, or a third
data source) could override the primary source when it backs the secondary
value instead. That corroboration logic needs a third data source/signal we
don't have yet and is intentionally out of scope this week.
"""

from datetime import date
from typing import Protocol, runtime_checkable

from db.models import QualityMetric, SourceConflict


def reconcile_game(
    game_id: str,
    primary_source: str,
    primary_fields: dict[str, str],
    secondary_source: str,
    secondary_fields: dict[str, str],
) -> tuple[list[SourceConflict], float]:
    """Compare one game's fields across two sources; primary source wins.

    Only fields present in *both* `primary_fields` and `secondary_fields` are
    compared — a field present on only one side has nothing to compare
    against, so it is neither a conflict nor part of the agreement-rate
    denominator.

    Returns `(conflicts, agreement_rate)` where `agreement_rate` is the
    fraction of compared fields that agreed. If zero fields were comparable,
    `agreement_rate` is defined as `1.0` (no evidence of disagreement is
    treated as full agreement, not as a failure) — documented here since
    there's no natural ratio for a zero denominator.
    """
    comparable_fields = set(primary_fields) & set(secondary_fields)

    conflicts: list[SourceConflict] = []
    for field_name in comparable_fields:
        primary_value = primary_fields[field_name]
        secondary_value = secondary_fields[field_name]
        if primary_value != secondary_value:
            conflicts.append(
                SourceConflict(
                    game_id=game_id,
                    field_name=field_name,
                    primary_source=primary_source,
                    primary_value=primary_value,
                    secondary_source=secondary_source,
                    secondary_value=secondary_value,
                    resolution=primary_value,
                )
            )

    compared_count = len(comparable_fields)
    if compared_count == 0:
        agreement_rate = 1.0
    else:
        agreement_rate = (compared_count - len(conflicts)) / compared_count

    return conflicts, agreement_rate


def match_games_by_team_overlap(
    primary_games: list[tuple[str, set[str], dict[str, str]]],
    secondary_games: list[tuple[str, set[str], dict[str, str]]],
) -> list[tuple[str, dict[str, str], dict[str, str]]]:
    """Match games across two sources by overlapping team display-name sets.

    Each input is `(game_id, team_names, fields)` for one source, already
    scoped by the caller to a single date (this function does no date
    filtering itself — a `DualSourceReader` production implementation would
    fetch each source's games for `as_of` and pass the resulting lists in
    here). A primary game is matched to the first not-yet-claimed secondary
    game whose team-name set shares at least one name with it, so a naming
    variant on one team (e.g. "LA Clippers" vs. "Los Angeles Clippers")
    still matches as long as the other team's name is spelled identically by
    both sources. Each secondary game is claimed by at most one primary
    game.

    **This is a simple, unvalidated heuristic** — it has not been checked
    against real dual-source data. Known gaps: it silently drops any
    secondary game with zero exact name overlap (e.g. if *both* teams in a
    matchup are spelled differently between sources), it resolves ambiguity
    by primary-list order rather than by best-overlap score, and it does
    nothing to disambiguate two same-day games that happen to share a team
    name misspelling collision. Flagged in the PR as needing
    validation/refinement once real dual-source data exists.
    """
    matched: list[tuple[str, dict[str, str], dict[str, str]]] = []
    claimed_secondary_indices: set[int] = set()

    for primary_game_id, primary_teams, primary_fields in primary_games:
        for index, (_, secondary_teams, secondary_fields) in enumerate(secondary_games):
            if index in claimed_secondary_indices:
                continue
            if primary_teams & secondary_teams:
                matched.append((primary_game_id, primary_fields, secondary_fields))
                claimed_secondary_indices.add(index)
                break

    return matched


@runtime_checkable
class DualSourceReader(Protocol):
    """Injectable source of games matched across the primary/secondary sources.

    **Not solved here:** matching games across two independently-maintained
    sources (which likely use different ID schemes for the same game) is a
    real entity-resolution problem. A production implementation would fetch
    each source's games for `as_of`, extract each game's team display-name
    set, and delegate to `match_games_by_team_overlap` above for the actual
    matching. That heuristic is deliberately simple and has not been
    validated against real dual-source data — flagged prominently for
    follow-up once real data from both sources is available.
    """

    def get_matched_games(
        self, as_of: date
    ) -> list[tuple[str, dict[str, str], dict[str, str]]]: ...


@runtime_checkable
class ReconciliationSink(Protocol):
    """Injectable write path for conflict rows and the aggregate metric."""

    def write_conflicts(self, conflicts: list[SourceConflict]) -> None: ...

    def write_metric(self, metric: QualityMetric) -> None: ...


def reconcile_games_for_date(
    as_of: date,
    reader: DualSourceReader,
    sink: ReconciliationSink,
    primary_source: str = "balldontlie",
    secondary_source: str = "espn",
) -> QualityMetric:
    """Reconcile every matched game pair for `as_of` and record one aggregate metric.

    Runs `reconcile_game` per matched pair from `reader`, writes every
    resulting conflict via `sink`, and returns a single
    `cross_source_agreement_rate` `QualityMetric` summarizing the whole batch
    (agreement is computed over the total comparable-field count across all
    games, not an average of per-game rates, so games with more comparable
    fields weigh proportionally more).

    `secondary_source` defaults to `"espn"` (docs/prd.md §03's public
    live-scoreboard feed) since `DualSourceReader.get_matched_games` returns
    bare `(game_id, primary_fields, secondary_fields)` tuples without a
    per-pair source label — with only one secondary source in play this
    week, a single fixed label is sufficient; a future multi-secondary-source
    design would need the reader to supply the label per pair instead.
    """
    matched_games = reader.get_matched_games(as_of)

    all_conflicts: list[SourceConflict] = []
    total_compared = 0
    total_conflicts = 0

    for game_id, primary_fields, secondary_fields in matched_games:
        conflicts, _ = reconcile_game(
            game_id=game_id,
            primary_source=primary_source,
            primary_fields=primary_fields,
            secondary_source=secondary_source,
            secondary_fields=secondary_fields,
        )
        all_conflicts.extend(conflicts)
        total_compared += len(set(primary_fields) & set(secondary_fields))
        total_conflicts += len(conflicts)

    if total_compared == 0:
        overall_agreement_rate = 1.0
    else:
        overall_agreement_rate = (total_compared - total_conflicts) / total_compared

    sink.write_conflicts(all_conflicts)

    metric = QualityMetric(
        check_name="cross_source_agreement_rate",
        metric_value=overall_agreement_rate,
        metadata_json={"games_compared": len(matched_games), "date": str(as_of)},
    )
    sink.write_metric(metric)

    return metric
