from db.models import (
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


# --- Week 4 performance pass: hot-path indexes on the three Meta tables ---
#
# These are pure Alembic DDL in
# db/migrations/versions/fca5b54cdf40_add_meta_table_indexes_for_hot_query_.py
# (verified offline via `alembic upgrade head --sql`), but each is also
# declared in `__table_args__` on its ORM model (same pattern as
# `RawPull`/`LiveGameState` above) so it shows up in `__table__.indexes` and
# can be asserted here without a live database.


def test_quality_metrics_has_check_name_run_at_index():
    index_columns = {
        tuple(col.name for col in index.columns)
        for index in QualityMetric.__table__.indexes
    }
    assert ("check_name", "run_at") in index_columns


def test_schema_change_log_has_detected_at_index():
    indexes = list(SchemaChangeLog.__table__.indexes)
    assert len(indexes) == 1
    index = indexes[0]
    assert index.name == "ix_schema_change_log_detected_at"
    # The index is on `detected_at` in descending order, matching
    # `ORDER BY detected_at DESC LIMIT N` in
    # api/src/api/routers/quality.py's `recent_schema_changes`.
    (expr,) = index.expressions
    assert str(expr) == "detected_at DESC"


def test_source_conflicts_has_detected_at_index():
    indexes = list(SourceConflict.__table__.indexes)
    assert len(indexes) == 1
    index = indexes[0]
    assert index.name == "ix_source_conflicts_detected_at"
    # Same descending-index shape as schema_change_log, matching
    # `recent_conflicts`'s `ORDER BY detected_at DESC LIMIT N`.
    (expr,) = index.expressions
    assert str(expr) == "detected_at DESC"
