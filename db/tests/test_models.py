from db.models import (
    AuditLog,
    Base,
    BackfillCheckpoint,
    LiveGameState,
    QualityMetric,
    RawPull,
    SchemaChangeLog,
    SourceConflict,
)


def _column_names(model) -> set[str]:
    return {column.name for column in model.__table__.columns}


def test_expected_tables_present():
    assert sorted(t.name for t in Base.metadata.sorted_tables) == [
        "audit_log",
        "backfill_checkpoints",
        "live_game_state",
        "quality_metrics",
        "raw_pulls",
        "schema_change_log",
        "source_conflicts",
    ]


def test_raw_pull_table():
    assert RawPull.__tablename__ == "raw_pulls"
    assert _column_names(RawPull) == {
        "id",
        "source",
        "endpoint",
        "pulled_at",
        "payload",
    }


def test_raw_pull_has_source_pulled_at_index():
    index_columns = {
        tuple(col.name for col in index.columns)
        for index in RawPull.__table__.indexes
    }
    assert ("source", "pulled_at") in index_columns


def test_schema_change_log_table():
    assert SchemaChangeLog.__tablename__ == "schema_change_log"
    assert _column_names(SchemaChangeLog) == {
        "id",
        "source",
        "endpoint",
        "field_name",
        "change_type",
        "old_type",
        "new_type",
        "detected_at",
    }


def test_quality_metric_table():
    assert QualityMetric.__tablename__ == "quality_metrics"
    assert _column_names(QualityMetric) == {
        "id",
        "check_name",
        "run_at",
        "metric_value",
        "metadata",
    }
    # Python attribute is `metadata_json` (DeclarativeBase reserves `metadata`);
    # it must map to the actual DB column named `metadata`.
    assert QualityMetric.metadata_json.property.columns[0].name == "metadata"


def test_backfill_checkpoint_table():
    assert BackfillCheckpoint.__tablename__ == "backfill_checkpoints"
    assert _column_names(BackfillCheckpoint) == {
        "id",
        "flow_name",
        "last_pulled_date",
        "updated_at",
    }


def test_backfill_checkpoint_flow_name_is_unique():
    # SQLAlchemyCheckpointStore assumes exactly one row per flow_name (it
    # selects, then inserts-or-updates that single row) — enforce it at the
    # schema level too, not just in application code.
    assert BackfillCheckpoint.__table__.columns["flow_name"].unique is True


def test_live_game_state_table():
    assert LiveGameState.__tablename__ == "live_game_state"
    assert _column_names(LiveGameState) == {
        "id",
        "game_id",
        "source",
        "pulled_at",
        "home_score",
        "away_score",
        "period",
        "clock",
        "status",
    }


def test_live_game_state_nullability_and_types():
    columns = {col.name: col for col in LiveGameState.__table__.columns}
    assert columns["game_id"].nullable is False
    assert columns["source"].nullable is False
    assert columns["pulled_at"].nullable is False
    assert columns["status"].nullable is False
    assert columns["home_score"].nullable is True
    assert columns["away_score"].nullable is True
    assert columns["period"].nullable is True
    assert columns["clock"].nullable is True
    # game_id is a bigint per the plan (large external game ids), not a
    # plain 32-bit int.
    assert type(columns["game_id"].type).__name__ == "BigInteger"


def test_live_game_state_has_game_id_pulled_at_index():
    index_columns = {
        tuple(col.name for col in index.columns)
        for index in LiveGameState.__table__.indexes
    }
    assert ("game_id", "pulled_at") in index_columns


def test_source_conflict_table():
    assert SourceConflict.__tablename__ == "source_conflicts"
    assert _column_names(SourceConflict) == {
        "id",
        "game_id",
        "field_name",
        "primary_source",
        "primary_value",
        "secondary_source",
        "secondary_value",
        "resolution",
        "detected_at",
    }


def test_audit_log_table():
    assert AuditLog.__tablename__ == "audit_log"
    assert _column_names(AuditLog) == {
        "id",
        "actor",
        "action",
        "detail",
        "created_at",
    }


def test_audit_log_nullability():
    columns = {col.name: col for col in AuditLog.__table__.columns}
    assert columns["actor"].nullable is False
    assert columns["action"].nullable is False
    assert columns["created_at"].nullable is False
    # `detail` is the one nullable column — a manual override may or may
    # not have extra context worth recording.
    assert columns["detail"].nullable is True
