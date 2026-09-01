"""Population Stability Index (PSI) drift detection (docs/prd.md §07 "Statistical drift").

Pure-function-first, same pattern as the rest of Week 2's `quality` package:
`compute_psi`/`check_field_drift` are pure (no I/O, easy to unit test
numerically); `check_weekly_drift` is the thin orchestration layer that pulls
real numbers through injected `NumericSeriesReader`/`QualityMetricSink`
protocols so production DB access can be swapped for in-memory fakes in
tests -- no live Postgres anywhere in this sandbox.
"""

import math
from bisect import bisect_right
from datetime import date, timedelta
from typing import Protocol, runtime_checkable

from sqlalchemy import MetaData, Table, create_engine, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from db.models import QualityMetric
from quality.config import Settings

# Floor applied to any bucket's population share before it's used as a PSI
# log/division operand. Without this, a bucket that's empty in one
# distribution but populated in the other produces log(0) or a
# division-by-zero -- exactly the "log-of-zero" edge case PSI is notorious
# for. 1e-4 is the standard industry floor (small enough to barely perturb
# real buckets, large enough to keep the arithmetic finite).
_EPSILON = 1e-4


def _quantile(sorted_values: list[float], q: float) -> float:
    """Linear-interpolation quantile of a pre-sorted list (q in [0, 1])."""
    n = len(sorted_values)
    if n == 1:
        return sorted_values[0]
    idx = q * (n - 1)
    lo = math.floor(idx)
    hi = math.ceil(idx)
    if lo == hi:
        return sorted_values[int(idx)]
    fraction = idx - lo
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * fraction


def _bin_edges(sorted_reference: list[float], bins: int) -> list[float]:
    """`bins - 1` interior cut points at evenly-spaced reference percentiles.

    These implicitly define `bins` buckets: (-inf, e1], (e1, e2], ...,
    (e_{bins-1}, +inf) -- the +/-inf outer bounds mean a `current` value
    outside the reference's observed range still lands in the first/last
    bucket instead of being rejected (see the "large drift" test case where
    an entire shifted cluster falls into a single outer bucket).
    """
    return [_quantile(sorted_reference, i / bins) for i in range(1, bins)]


def _bin_fractions(values: list[float], edges: list[float], bins: int) -> list[float]:
    counts = [0] * bins
    for value in values:
        counts[bisect_right(edges, value)] += 1
    n = len(values)
    return [count / n for count in counts]


def compute_psi(reference: list[float], current: list[float], bins: int = 10) -> float:
    """Standard Population Stability Index between two numeric distributions.

    Bin edges are derived from `reference`'s own quantiles (so each
    reference bucket holds roughly `1/bins` of the reference population),
    then both distributions are binned against those same edges and
    compared bucket-by-bucket:

        psi = sum((current_pct - reference_pct) * ln(current_pct / reference_pct))

    Degenerate inputs are handled by returning 0.0 ("no observable drift")
    rather than raising:
      - either list is empty -- there is nothing to compare, and a scheduled
        quality-check run (e.g. a brand-new season, or a quiet week for a
        rarely-populated field) shouldn't crash just because a window is
        empty.
      - `reference` has fewer distinct values than `bins` -- there aren't
        enough distinct cut points to derive `bins` meaningful quantile
        edges (the extreme case being a constant reference distribution,
        which has only 1 distinct value). Forcing bins out of too few
        distinct values would produce duplicated/degenerate edges and a
        PSI number that doesn't mean what PSI is supposed to mean, so we
        treat "not enough data to bin meaningfully" the same as "no drift"
        rather than fabricating a misleading score.
    """
    if not reference or not current:
        return 0.0

    if len(set(reference)) < bins:
        return 0.0

    sorted_reference = sorted(reference)
    edges = _bin_edges(sorted_reference, bins)

    reference_fractions = _bin_fractions(sorted_reference, edges, bins)
    current_fractions = _bin_fractions(current, edges, bins)

    psi = 0.0
    for reference_pct, current_pct in zip(reference_fractions, current_fractions):
        reference_pct = max(reference_pct, _EPSILON)
        current_pct = max(current_pct, _EPSILON)
        psi += (current_pct - reference_pct) * math.log(current_pct / reference_pct)
    return psi


def check_field_drift(
    field_name: str, reference_values: list[float], current_values: list[float]
) -> QualityMetric:
    """Wrap `compute_psi` into a `quality_metrics` row for one numeric field."""
    psi = compute_psi(reference_values, current_values)
    return QualityMetric(
        check_name=f"psi_{field_name}",
        metric_value=psi,
        metadata_json={
            "reference_n": len(reference_values),
            "current_n": len(current_values),
        },
    )


@runtime_checkable
class NumericSeriesReader(Protocol):
    """Injectable read path for a numeric field's values over a date window."""

    def get_values(self, field_name: str, start: date, end: date) -> list[float]: ...


@runtime_checkable
class QualityMetricSink(Protocol):
    """Injectable write path for `quality_metrics` rows."""

    def write(self, metric: QualityMetric) -> None: ...


class SQLAlchemyPlayerGameStatsReader:
    """Production `NumericSeriesReader`, backed by the Gold `player_game_stats` mart.

    `player_game_stats` (dbt-built, see `dbt/models/marts/player_game_stats.sql`)
    carries no date column of its own -- game dates live on the sibling
    `games` mart -- so this joins the two on `game_id` to filter by
    `games.game_date`. Both tables are reflected via
    `Table(..., autoload_with=engine)` rather than adding new ORM models,
    since `quality` doesn't own the Gold schema (dbt does).
    """

    def __init__(self, engine: Engine | None = None) -> None:
        self._engine = engine or create_engine(Settings().runtime_database_url)

    def get_values(self, field_name: str, start: date, end: date) -> list[float]:
        # A fresh MetaData per call keeps repeated reflection (e.g. the two
        # calls check_weekly_drift makes per run) simple and side-effect-free,
        # at the cost of re-reflecting -- fine for a twice-a-week check, not
        # a hot path.
        metadata = MetaData()
        player_game_stats = Table(
            "player_game_stats", metadata, autoload_with=self._engine
        )
        games = Table("games", metadata, autoload_with=self._engine)

        stmt = (
            select(player_game_stats.c[field_name])
            .select_from(
                player_game_stats.join(
                    games, player_game_stats.c.game_id == games.c.game_id
                )
            )
            .where(games.c.game_date >= start, games.c.game_date < end)
        )
        with self._engine.connect() as connection:
            values = connection.execute(stmt).scalars().all()
        return [float(value) for value in values if value is not None]


class SQLAlchemyQualityMetricSink:
    """Production `QualityMetricSink`, one session per write (mirrors
    `ingestion.flows.backfill_flow.SQLAlchemyRawPullSink`'s commit-per-write
    pattern, so a single failed write can't roll back an earlier one)."""

    def __init__(self, session_factory: sessionmaker[Session] | None = None) -> None:
        self._session_factory = session_factory or sessionmaker(
            bind=create_engine(Settings().runtime_database_url)
        )

    def write(self, metric: QualityMetric) -> None:
        with self._session_factory() as session:
            session.add(metric)
            session.commit()


def check_weekly_drift(
    field_name: str,
    reader: NumericSeriesReader,
    sink: QualityMetricSink,
    as_of: date,
) -> QualityMetric:
    """Compare a trailing 7-day "current" window against the preceding 7-day
    "reference" window, ending at `as_of`.

    Window boundaries (half-open `[start, end)`, chosen deliberately):
      - reference = [as_of - 14 days, as_of - 7 days)
      - current   = [as_of -  7 days, as_of)

    These are two disjoint, equal-length (7-day) windows immediately
    adjacent to each other, ending at `as_of` -- a natural week-over-week
    drift signal (this week's distribution vs. the week right before it)
    that doesn't require maintaining a long-lived historical baseline
    window separately from the check itself.
    """
    reference_start = as_of - timedelta(days=14)
    reference_end = as_of - timedelta(days=7)
    current_start = as_of - timedelta(days=7)
    current_end = as_of

    reference_values = reader.get_values(field_name, reference_start, reference_end)
    current_values = reader.get_values(field_name, current_start, current_end)

    metric = check_field_drift(field_name, reference_values, current_values)
    sink.write(metric)
    return metric
