"""GET /quality — the drift/agreement scorecard (docs/prd.md §07).

Response shape (documented for the `quality-scorecard-ui` frontend PR):

    {
      "metrics": [
        {"check_name": str, "value": float, "run_at": "<isoformat>", "metadata": dict | None}
      ],
      "schema_changes": [
        {
          "id": int, "source": str, "endpoint": str, "field_name": str,
          "change_type": str, "old_type": str | None, "new_type": str | None,
          "detected_at": "<isoformat>"
        }
      ],
      "conflicts": {
        "total": int,
        "recent": [
          {
            "id": int, "game_id": str, "field_name": str,
            "primary_source": str, "primary_value": str | None,
            "secondary_source": str, "secondary_value": str | None,
            "resolution": str, "detected_at": "<isoformat>"
          }
        ]
      }
    }

`metrics` holds the *latest* row per distinct `check_name` from
`quality_metrics` — deduplication happens in Python (see `_latest_per_check`)
over whatever rows the injected `QualityReader` hands back, so it's testable
against fakes without a real database. `schema_changes` is the most recent
`RECENT_SCHEMA_CHANGES_LIMIT` (20) rows from `schema_change_log`. `conflicts`
is a total count plus the most recent `RECENT_CONFLICTS_LIMIT` (10) rows from
`source_conflicts`.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from typing import Protocol

from fastapi import APIRouter, Depends, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from db.models import QualityMetric, SchemaChangeLog, SourceConflict

from api.core.db import get_engine
from api.core.rate_limit import DEFAULT_RATE_LIMIT, limiter
from api.core.security import require_api_key

router = APIRouter(prefix="/quality", tags=["quality"], dependencies=[Depends(require_api_key)])

RECENT_SCHEMA_CHANGES_LIMIT = 20
RECENT_CONFLICTS_LIMIT = 10


class QualityReader(Protocol):
    """Seam for the DB-reading part of /quality — swap for a fake in tests.

    `latest_metric_rows` intentionally returns *raw*, possibly duplicated
    (per `check_name`) rows — the route itself reduces them to one row per
    check via `_latest_per_check`, so that reduction is exercised by feeding
    a fake reader duplicate rows in tests, not baked into the fake.
    """

    def latest_metric_rows(self) -> Sequence[QualityMetric]: ...

    def recent_schema_changes(self, limit: int) -> Sequence[SchemaChangeLog]: ...

    def recent_conflicts(self, limit: int) -> tuple[int, Sequence[SourceConflict]]:
        """Returns (total conflict count, most recent `limit` conflicts)."""
        ...


class SqlAlchemyQualityReader:
    """Real implementation — reads `api`'s own ORM models via a SQLAlchemy session."""

    def __init__(self, session: Session):
        self._session = session

    def latest_metric_rows(self) -> Sequence[QualityMetric]:
        return self._session.execute(select(QualityMetric)).scalars().all()

    def recent_schema_changes(self, limit: int) -> Sequence[SchemaChangeLog]:
        stmt = select(SchemaChangeLog).order_by(SchemaChangeLog.detected_at.desc()).limit(limit)
        return self._session.execute(stmt).scalars().all()

    def recent_conflicts(self, limit: int) -> tuple[int, Sequence[SourceConflict]]:
        total = self._session.execute(
            select(func.count()).select_from(SourceConflict)
        ).scalar_one()
        stmt = select(SourceConflict).order_by(SourceConflict.detected_at.desc()).limit(limit)
        recent = self._session.execute(stmt).scalars().all()
        return total, recent


def get_quality_reader() -> Iterator[QualityReader]:
    """Default (real) dependency — overridden with a fake in tests."""
    with Session(get_engine()) as session:
        yield SqlAlchemyQualityReader(session)


def _latest_per_check(rows: Sequence[QualityMetric]) -> list[QualityMetric]:
    """Reduce arbitrarily-ordered, possibly-duplicated rows to one per check_name."""
    latest: dict[str, QualityMetric] = {}
    for row in rows:
        current = latest.get(row.check_name)
        if current is None or row.run_at > current.run_at:
            latest[row.check_name] = row
    return [latest[name] for name in sorted(latest)]


def _serialize_metric(row: QualityMetric) -> dict:
    return {
        "check_name": row.check_name,
        "value": float(row.metric_value),
        "run_at": row.run_at.isoformat(),
        "metadata": row.metadata_json,
    }


def _serialize_schema_change(row: SchemaChangeLog) -> dict:
    return {
        "id": row.id,
        "source": row.source,
        "endpoint": row.endpoint,
        "field_name": row.field_name,
        "change_type": row.change_type,
        "old_type": row.old_type,
        "new_type": row.new_type,
        "detected_at": row.detected_at.isoformat(),
    }


def _serialize_conflict(row: SourceConflict) -> dict:
    return {
        "id": row.id,
        "game_id": row.game_id,
        "field_name": row.field_name,
        "primary_source": row.primary_source,
        "primary_value": row.primary_value,
        "secondary_source": row.secondary_source,
        "secondary_value": row.secondary_value,
        "resolution": row.resolution,
        "detected_at": row.detected_at.isoformat(),
    }


@router.get("/")
@limiter.limit(DEFAULT_RATE_LIMIT)
def get_quality_metrics(
    request: Request,
    reader: QualityReader = Depends(get_quality_reader),
) -> dict:
    """Drift/agreement scorecard data — see module docstring for the exact shape."""
    metrics = _latest_per_check(reader.latest_metric_rows())
    schema_changes = reader.recent_schema_changes(RECENT_SCHEMA_CHANGES_LIMIT)
    total_conflicts, recent_conflicts = reader.recent_conflicts(RECENT_CONFLICTS_LIMIT)

    return {
        "metrics": [_serialize_metric(m) for m in metrics],
        "schema_changes": [_serialize_schema_change(s) for s in schema_changes],
        "conflicts": {
            "total": total_conflicts,
            "recent": [_serialize_conflict(c) for c in recent_conflicts],
        },
    }
