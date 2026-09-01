from datetime import datetime, timezone
from types import SimpleNamespace

from fastapi.testclient import TestClient

from api.main import app
from api.routers.quality import get_quality_reader

API_KEY = "test-quality-key"

client = TestClient(app)


def _metric(check_name, value, run_at, metadata=None):
    return SimpleNamespace(
        check_name=check_name, run_at=run_at, metric_value=value, metadata_json=metadata
    )


def _schema_change(
    id_, source, endpoint, field_name, change_type, old_type, new_type, detected_at
):
    return SimpleNamespace(
        id=id_,
        source=source,
        endpoint=endpoint,
        field_name=field_name,
        change_type=change_type,
        old_type=old_type,
        new_type=new_type,
        detected_at=detected_at,
    )


def _conflict(
    id_,
    game_id,
    field_name,
    primary_source,
    primary_value,
    secondary_source,
    secondary_value,
    resolution,
    detected_at,
):
    return SimpleNamespace(
        id=id_,
        game_id=game_id,
        field_name=field_name,
        primary_source=primary_source,
        primary_value=primary_value,
        secondary_source=secondary_source,
        secondary_value=secondary_value,
        resolution=resolution,
        detected_at=detected_at,
    )


class FakeQualityReader:
    """Test double for the DB-reading seam — hands back canned rows, no DB involved."""

    def __init__(self, metric_rows=(), schema_changes=(), conflicts_total=0, conflicts_recent=()):
        self._metric_rows = list(metric_rows)
        self._schema_changes = list(schema_changes)
        self._conflicts_total = conflicts_total
        self._conflicts_recent = list(conflicts_recent)

    def latest_metric_rows(self):
        return self._metric_rows

    def recent_schema_changes(self, limit):
        return self._schema_changes[:limit]

    def recent_conflicts(self, limit):
        return self._conflicts_total, self._conflicts_recent[:limit]


def _override_reader(reader):
    app.dependency_overrides[get_quality_reader] = lambda: reader


def _clear_override():
    app.dependency_overrides.pop(get_quality_reader, None)


def test_quality_requires_api_key():
    resp = client.get("/quality/")
    assert resp.status_code == 401


def test_quality_returns_assembled_scorecard_shape(monkeypatch):
    monkeypatch.setenv("API_SERVICE_KEY", API_KEY)
    run_at = datetime(2026, 8, 30, 12, 0, tzinfo=timezone.utc)
    detected_at_schema = datetime(2026, 8, 29, 9, 0, tzinfo=timezone.utc)
    detected_at_conflict = datetime(2026, 8, 28, 6, 0, tzinfo=timezone.utc)

    reader = FakeQualityReader(
        metric_rows=[
            _metric("cross_source_agreement", 0.987, run_at, {"field": "points"}),
        ],
        schema_changes=[
            _schema_change(
                1,
                "balldontlie",
                "/games",
                "status",
                "type_change",
                "string",
                "enum",
                detected_at_schema,
            ),
        ],
        conflicts_total=42,
        conflicts_recent=[
            _conflict(
                7,
                "0022500001",
                "home_score",
                "balldontlie",
                "101",
                "nba_stats",
                "100",
                "primary_wins",
                detected_at_conflict,
            ),
        ],
    )
    _override_reader(reader)
    try:
        resp = client.get("/quality/", headers={"X-API-Key": API_KEY})
    finally:
        _clear_override()

    assert resp.status_code == 200
    assert resp.json() == {
        "metrics": [
            {
                "check_name": "cross_source_agreement",
                "value": 0.987,
                "run_at": "2026-08-30T12:00:00+00:00",
                "metadata": {"field": "points"},
            }
        ],
        "schema_changes": [
            {
                "id": 1,
                "source": "balldontlie",
                "endpoint": "/games",
                "field_name": "status",
                "change_type": "type_change",
                "old_type": "string",
                "new_type": "enum",
                "detected_at": "2026-08-29T09:00:00+00:00",
            }
        ],
        "conflicts": {
            "total": 42,
            "recent": [
                {
                    "id": 7,
                    "game_id": "0022500001",
                    "field_name": "home_score",
                    "primary_source": "balldontlie",
                    "primary_value": "101",
                    "secondary_source": "nba_stats",
                    "secondary_value": "100",
                    "resolution": "primary_wins",
                    "detected_at": "2026-08-28T06:00:00+00:00",
                }
            ],
        },
    }


def test_quality_dedups_to_latest_row_per_check_name(monkeypatch):
    monkeypatch.setenv("API_SERVICE_KEY", API_KEY)
    older = _metric(
        "null_rate_points", 0.10, datetime(2026, 8, 1, tzinfo=timezone.utc)
    )
    newer = _metric(
        "null_rate_points", 0.05, datetime(2026, 8, 2, tzinfo=timezone.utc)
    )
    other_check = _metric(
        "psi_pace", 0.02, datetime(2026, 8, 1, tzinfo=timezone.utc)
    )

    reader = FakeQualityReader(metric_rows=[older, newer, other_check])
    _override_reader(reader)
    try:
        resp = client.get("/quality/", headers={"X-API-Key": API_KEY})
    finally:
        _clear_override()

    assert resp.status_code == 200
    metrics = resp.json()["metrics"]
    by_check = {m["check_name"]: m for m in metrics}
    assert len(metrics) == 2
    assert by_check["null_rate_points"]["value"] == 0.05
    assert by_check["null_rate_points"]["run_at"] == "2026-08-02T00:00:00+00:00"
