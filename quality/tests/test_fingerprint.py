from datetime import datetime, timezone

import pytest

from db.models import SchemaChangeLog
from quality.fingerprint import (
    check_schema_drift,
    diff_fingerprints,
    fingerprint_payload,
)

# ---------------------------------------------------------------------------
# fingerprint_payload
# ---------------------------------------------------------------------------

FINGERPRINT_CASES = [
    pytest.param(
        {"data": [{"id": 1, "name": "Lakers"}], "meta": {"next_cursor": None}},
        {"data.0.id": "int", "data.0.name": "str"},
        id="flat_record_with_null_meta_field_skipped",
    ),
    pytest.param(
        {
            "data": [{"id": 1, "home_team": {"full_name": "Lakers", "id": 2}}],
            "meta": {},
        },
        {
            "data.0.id": "int",
            "data.0.home_team.full_name": "str",
            "data.0.home_team.id": "int",
        },
        id="nested_object_flattened_with_dot_paths",
    ),
    pytest.param(
        {"data": [{"id": 1, "note": None}], "meta": {}},
        {"data.0.id": "int"},
        id="null_valued_field_skipped_entirely",
    ),
    pytest.param(
        {
            "data": [{"id": 1, "score": 3.5, "active": True, "name": "x"}],
            "meta": {},
        },
        {
            "data.0.id": "int",
            "data.0.score": "float",
            "data.0.active": "bool",
            "data.0.name": "str",
        },
        id="multiple_field_types",
    ),
    pytest.param(
        {"data": [], "meta": {}},
        {},
        id="empty_data_list_has_no_representative_record",
    ),
    pytest.param(
        {"data": [{"id": 1}], "meta": {"next_cursor": 125}},
        {"data.0.id": "int", "meta.next_cursor": "int"},
        id="meta_fields_are_also_fingerprinted",
    ),
]


@pytest.mark.parametrize("payload,expected", FINGERPRINT_CASES)
def test_fingerprint_payload(payload, expected):
    assert fingerprint_payload(payload) == expected


# ---------------------------------------------------------------------------
# diff_fingerprints
# ---------------------------------------------------------------------------


def test_diff_fingerprints_detects_added_field():
    changes = diff_fingerprints("balldontlie", "games", {}, {"id": "int"})

    assert len(changes) == 1
    change = changes[0]
    assert isinstance(change, SchemaChangeLog)
    assert change.source == "balldontlie"
    assert change.endpoint == "games"
    assert change.field_name == "id"
    assert change.change_type == "added"
    assert change.old_type is None
    assert change.new_type == "int"


def test_diff_fingerprints_detects_removed_field():
    changes = diff_fingerprints("balldontlie", "games", {"id": "int"}, {})

    assert len(changes) == 1
    change = changes[0]
    assert change.field_name == "id"
    assert change.change_type == "removed"
    assert change.old_type == "int"
    assert change.new_type is None


def test_diff_fingerprints_detects_type_changed_field():
    changes = diff_fingerprints(
        "balldontlie", "games", {"id": "int"}, {"id": "str"}
    )

    assert len(changes) == 1
    change = changes[0]
    assert change.field_name == "id"
    assert change.change_type == "type_changed"
    assert change.old_type == "int"
    assert change.new_type == "str"


def test_diff_fingerprints_no_changes_returns_empty_list():
    fingerprint = {"id": "int", "name": "str"}

    changes = diff_fingerprints("balldontlie", "games", fingerprint, fingerprint)

    assert changes == []


def test_diff_fingerprints_handles_mixed_changes_together():
    old = {"id": "int", "removed_field": "str", "same": "bool"}
    new = {"id": "str", "added_field": "float", "same": "bool"}

    changes = diff_fingerprints("balldontlie", "games", old, new)

    by_field = {c.field_name: c for c in changes}
    assert set(by_field) == {"id", "removed_field", "added_field"}
    assert by_field["id"].change_type == "type_changed"
    assert by_field["removed_field"].change_type == "removed"
    assert by_field["added_field"].change_type == "added"


# ---------------------------------------------------------------------------
# check_schema_drift orchestration (fakes, no DB)
# ---------------------------------------------------------------------------


class FakeLookup:
    """In-memory PriorPayloadLookup — no DB."""

    def __init__(self, previous_payload: dict | None) -> None:
        self._previous_payload = previous_payload
        self.calls: list[tuple[str, str, datetime]] = []

    def get_previous_payload(
        self, source: str, endpoint: str, before: datetime
    ) -> dict | None:
        self.calls.append((source, endpoint, before))
        return self._previous_payload


class FakeSink:
    """In-memory SchemaChangeSink — no DB, just a list of write_many calls."""

    def __init__(self) -> None:
        self.write_many_calls: list[list[SchemaChangeLog]] = []

    def write_many(self, changes: list[SchemaChangeLog]) -> None:
        self.write_many_calls.append(changes)


def test_check_schema_drift_first_ever_pull_returns_no_changes_without_error():
    lookup = FakeLookup(previous_payload=None)
    sink = FakeSink()

    result = check_schema_drift(
        "balldontlie", "games", {"data": [{"id": 1}], "meta": {}}, lookup, sink
    )

    assert result == []
    assert sink.write_many_calls == []


def test_check_schema_drift_writes_and_returns_detected_changes():
    lookup = FakeLookup(previous_payload={"data": [{"id": 1}], "meta": {}})
    sink = FakeSink()

    result = check_schema_drift(
        "balldontlie",
        "games",
        {"data": [{"id": 1, "name": "Lakers"}], "meta": {}},
        lookup,
        sink,
    )

    assert len(result) == 1
    assert result[0].field_name == "data.0.name"
    assert result[0].change_type == "added"
    assert sink.write_many_calls == [result]


def test_check_schema_drift_no_drift_does_not_call_sink():
    payload = {"data": [{"id": 1}], "meta": {}}
    lookup = FakeLookup(previous_payload=payload)
    sink = FakeSink()

    result = check_schema_drift("balldontlie", "games", payload, lookup, sink)

    assert result == []
    assert sink.write_many_calls == []
