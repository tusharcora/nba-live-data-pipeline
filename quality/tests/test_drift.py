"""Tests for Population Stability Index drift detection (docs/prd.md §07).

No live DB/network anywhere here -- `compute_psi`/`check_field_drift` are
pure functions tested directly, and `check_weekly_drift` is tested against
in-memory `FakeReader`/`FakeSink` stand-ins for the DI protocols.
"""

import random
from datetime import date, timedelta

from db.models import QualityMetric
from quality.drift import check_field_drift, check_weekly_drift, compute_psi


def _clustered(center: float, n: int, spread: float, seed: int) -> list[float]:
    """Deterministic pseudo-random cluster of `n` points around `center`."""
    rng = random.Random(seed)
    return [center + rng.uniform(-spread, spread) for _ in range(n)]


# ---------------------------------------------------------------------------
# compute_psi -- the numerical core. These assertions are the correctness
# spec: identical/near-identical distributions must score near zero, and an
# obviously-shifted distribution must clear the industry rule-of-thumb
# thresholds (~0.1 moderate, ~0.25 major), not just ">0".
# ---------------------------------------------------------------------------


class TestComputePsiIdenticalDistributions:
    def test_exact_same_list_produces_near_zero_psi(self):
        values = _clustered(center=10.0, n=500, spread=3.0, seed=1)
        psi = compute_psi(values, values, bins=10)
        assert psi < 0.01

    def test_independent_samples_of_same_distribution_produce_near_zero_psi(self):
        # PSI computed from two *independent* finite samples of the same
        # distribution is not exactly 0 -- pure sampling noise contributes
        # roughly (bins - 1) * (1/n_ref + 1/n_cur) in expectation (~0.0009
        # here), so this needs a large-enough n to keep that noise floor
        # comfortably under the 0.01 "near zero" bar; small samples (a few
        # hundred points) can easily produce PSI > 0.01 from noise alone,
        # which is exactly why real PSI monitoring is run on large windows.
        reference = _clustered(center=10.0, n=20000, spread=3.0, seed=1)
        current = _clustered(center=10.0, n=20000, spread=3.0, seed=2)
        psi = compute_psi(reference, current, bins=10)
        assert psi < 0.01


class TestComputePsiShiftedDistributions:
    def test_large_shift_exceeds_major_drift_threshold(self):
        # reference clustered around 10, current clustered around 25 --
        # completely non-overlapping clusters, a textbook "major" shift.
        reference = _clustered(center=10.0, n=500, spread=1.0, seed=1)
        current = _clustered(center=25.0, n=500, spread=1.0, seed=2)
        psi = compute_psi(reference, current, bins=10)
        assert psi > 0.25  # common "major shift" rule-of-thumb threshold

    def test_moderate_shift_exceeds_moderate_drift_threshold(self):
        # smaller shift relative to spread than the "large shift" case above,
        # but still enough of the distribution moves to be flagged.
        reference = _clustered(center=10.0, n=1000, spread=3.0, seed=1)
        current = _clustered(center=13.0, n=1000, spread=3.0, seed=2)
        psi = compute_psi(reference, current, bins=10)
        assert psi > 0.1  # common "moderate shift" rule-of-thumb threshold


class TestComputePsiDegenerateInputs:
    def test_empty_reference_returns_zero(self):
        assert compute_psi([], [1.0, 2.0, 3.0]) == 0.0

    def test_empty_current_returns_zero(self):
        assert compute_psi([1.0, 2.0, 3.0], []) == 0.0

    def test_both_empty_returns_zero(self):
        assert compute_psi([], []) == 0.0

    def test_all_identical_reference_values_returns_zero(self):
        # A constant reference distribution has 1 distinct value -- there is
        # no way to derive `bins` meaningful quantile edges from it.
        assert compute_psi([5.0] * 100, [5.0, 6.0, 100.0]) == 0.0

    def test_fewer_distinct_reference_values_than_bins_returns_zero(self):
        # Only 3 distinct reference values but the default bins=10 -- can't
        # carve 10 meaningful quantile buckets out of 3 distinct values.
        reference = [1.0, 2.0, 3.0] * 20
        assert compute_psi(reference, [1.0, 2.0, 3.0], bins=10) == 0.0

    def test_reference_with_exactly_bins_distinct_values_does_not_raise(self):
        reference = [float(v) for v in range(1, 11)]  # exactly 10 distinct
        current = [float(v) for v in range(1, 11)]
        psi = compute_psi(reference, current, bins=10)
        assert psi >= 0.0
        assert psi < 0.01  # identical sets -> ~0 drift

    def test_current_with_values_outside_reference_range_does_not_raise(self):
        reference = _clustered(center=10.0, n=200, spread=2.0, seed=1)
        current = [1000.0, -1000.0, 500.0]
        # Should not raise (out-of-range values fall into the outermost
        # bins rather than being rejected) and should register real drift.
        psi = compute_psi(reference, current, bins=10)
        assert psi > 0.25


# ---------------------------------------------------------------------------
# check_field_drift -- wraps compute_psi into a QualityMetric row.
# ---------------------------------------------------------------------------


class TestCheckFieldDrift:
    def test_returns_quality_metric_with_expected_shape(self):
        # Large-enough n (see comment on the compute_psi sampling-noise test
        # above) that two independent same-distribution samples still land
        # comfortably under the "near zero" bar.
        reference = _clustered(center=10.0, n=20000, spread=2.0, seed=1)
        current = _clustered(center=10.0, n=15000, spread=2.0, seed=2)

        metric = check_field_drift("points", reference, current)

        assert isinstance(metric, QualityMetric)
        assert metric.check_name == "psi_points"
        assert metric.metadata_json == {"reference_n": 20000, "current_n": 15000}
        assert float(metric.metric_value) < 0.01

    def test_shifted_field_flags_major_drift(self):
        reference = _clustered(center=10.0, n=300, spread=1.0, seed=1)
        current = _clustered(center=25.0, n=300, spread=1.0, seed=2)

        metric = check_field_drift("points", reference, current)

        assert metric.check_name == "psi_points"
        assert float(metric.metric_value) > 0.25

    def test_degenerate_input_yields_zero_metric_not_a_crash(self):
        metric = check_field_drift("points", [], [1.0, 2.0])
        assert float(metric.metric_value) == 0.0
        assert metric.metadata_json == {"reference_n": 0, "current_n": 2}


# ---------------------------------------------------------------------------
# check_weekly_drift -- orchestration, tested against fakes.
# ---------------------------------------------------------------------------


class FakeNumericSeriesReader:
    """In-memory NumericSeriesReader -- values keyed by (start, end) window."""

    def __init__(self, values_by_window: dict[tuple[date, date], list[float]]) -> None:
        self._values_by_window = values_by_window
        self.calls: list[tuple[str, date, date]] = []

    def get_values(self, field_name: str, start: date, end: date) -> list[float]:
        self.calls.append((field_name, start, end))
        return self._values_by_window[(start, end)]


class FakeQualityMetricSink:
    """In-memory QualityMetricSink -- no DB, just a list."""

    def __init__(self) -> None:
        self.written: list[QualityMetric] = []

    def write(self, metric: QualityMetric) -> None:
        self.written.append(metric)


class TestCheckWeeklyDrift:
    def test_queries_documented_window_boundaries_and_writes_one_metric(self):
        as_of = date(2026, 9, 1)
        reference_window = (as_of - timedelta(days=14), as_of - timedelta(days=7))
        current_window = (as_of - timedelta(days=7), as_of)
        reference_values = _clustered(10.0, 20000, 2.0, seed=1)
        current_values = _clustered(10.0, 20000, 2.0, seed=2)
        reader = FakeNumericSeriesReader(
            {reference_window: reference_values, current_window: current_values}
        )
        sink = FakeQualityMetricSink()

        metric = check_weekly_drift("points", reader, sink, as_of)

        assert reader.calls == [
            ("points", *reference_window),
            ("points", *current_window),
        ]
        assert sink.written == [metric]
        assert metric.check_name == "psi_points"
        assert metric.metadata_json == {
            "reference_n": len(reference_values),
            "current_n": len(current_values),
        }
        assert float(metric.metric_value) < 0.01

    def test_shifted_windows_produce_major_drift_metric(self):
        as_of = date(2026, 9, 1)
        reference_window = (as_of - timedelta(days=14), as_of - timedelta(days=7))
        current_window = (as_of - timedelta(days=7), as_of)
        reference_values = _clustered(10.0, 300, 1.0, seed=1)
        current_values = _clustered(25.0, 300, 1.0, seed=2)
        reader = FakeNumericSeriesReader(
            {reference_window: reference_values, current_window: current_values}
        )
        sink = FakeQualityMetricSink()

        metric = check_weekly_drift("points", reader, sink, as_of)

        assert float(metric.metric_value) > 0.25
