"""Schema drift detection (docs/prd.md §07 "Schema drift").

Every raw pull is fingerprinted (field names + types); a diff against the
last-known fingerprint for the same `(source, endpoint)` pair is written to
`schema_change_log`. This module is deliberately pure-function-first: the
fingerprinting and diffing logic never touches a database or the network —
DB access is pushed to a thin DI seam (`PriorPayloadLookup`/`SchemaChangeSink`)
at the orchestration edge, following the same pattern as
`ingestion.flows.backfill_flow`.
"""

from datetime import datetime, timezone
from typing import Any, Protocol, runtime_checkable

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from db.models import RawPull, SchemaChangeLog
from quality.config import Settings

Fingerprint = dict[str, str]


def fingerprint_payload(payload: dict) -> Fingerprint:
    """Flatten a raw API response payload into `{dot.path: type_name}`.

    Payloads are always `{"data": [...], "meta": {...}}`-shaped (one raw API
    response page). The whole payload is flattened recursively: dict keys
    extend the dot-path, and a list is represented by its first element only
    (indexed as `.0`) since that's the one "representative record shape" we
    care about for drift detection — e.g. `data.0.home_team.full_name`. An
    empty list has no representative element, so it contributes no fields.
    `None`-valued fields are skipped entirely: a JSON null carries no type
    information, so fingerprinting it as `"NoneType"` would flag every
    legitimately-nullable field as a false-positive type change the moment it
    happens to be populated (or vice versa).
    """
    fingerprint: Fingerprint = {}
    _flatten(payload, "", fingerprint)
    return fingerprint


def _flatten(value: Any, prefix: str, out: Fingerprint) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            path = f"{prefix}.{key}" if prefix else key
            _flatten(child, path, out)
    elif isinstance(value, list):
        if value:
            path = f"{prefix}.0" if prefix else "0"
            _flatten(value[0], path, out)
        # empty list: no representative element, nothing to fingerprint
    elif value is None:
        pass
    else:
        out[prefix] = type(value).__name__


def diff_fingerprints(
    source: str, endpoint: str, old: Fingerprint, new: Fingerprint
) -> list[SchemaChangeLog]:
    """Diff two fingerprints into `SchemaChangeLog` rows.

    Fields only in `new` are "added", fields only in `old` are "removed",
    and fields in both with a different type string are "type_changed".
    Iteration order is sorted by field name for deterministic output.
    """
    changes: list[SchemaChangeLog] = []

    for field in sorted(set(new) - set(old)):
        changes.append(
            SchemaChangeLog(
                source=source,
                endpoint=endpoint,
                field_name=field,
                change_type="added",
                old_type=None,
                new_type=new[field],
            )
        )

    for field in sorted(set(old) - set(new)):
        changes.append(
            SchemaChangeLog(
                source=source,
                endpoint=endpoint,
                field_name=field,
                change_type="removed",
                old_type=old[field],
                new_type=None,
            )
        )

    for field in sorted(set(old) & set(new)):
        if old[field] != new[field]:
            changes.append(
                SchemaChangeLog(
                    source=source,
                    endpoint=endpoint,
                    field_name=field,
                    change_type="type_changed",
                    old_type=old[field],
                    new_type=new[field],
                )
            )

    return changes


@runtime_checkable
class PriorPayloadLookup(Protocol):
    """Injectable read path for the most recent prior payload of a `(source,
    endpoint)` pair — keeps `check_schema_drift` DB-free and testable.

    `@runtime_checkable` isn't required outside a Prefect flow (no Prefect
    involvement here), but is kept for consistency with the rest of the
    codebase's DI-protocol style (see `ingestion.flows.backfill_flow`).
    """

    def get_previous_payload(
        self, source: str, endpoint: str, before: datetime
    ) -> dict | None: ...


@runtime_checkable
class SchemaChangeSink(Protocol):
    """Injectable write path for detected drift rows."""

    def write_many(self, changes: list[SchemaChangeLog]) -> None: ...


def check_schema_drift(
    source: str,
    endpoint: str,
    current_payload: dict,
    lookup: PriorPayloadLookup,
    sink: SchemaChangeSink,
) -> list[SchemaChangeLog]:
    """Fetch the previous payload, diff it against the current one, and
    write+return any detected schema changes.

    `before` is resolved to "now" — `current_payload` is handed in directly
    rather than as an already-persisted `RawPull` row, so there's no
    `pulled_at` of its own to compare against; "the most recent payload
    before now" is the correct prior version to diff against regardless of
    whether the caller has (or hasn't yet) written `current_payload` to
    `raw_pulls`.

    A first-ever pull for a `(source, endpoint)` pair (no prior payload) is
    not an error — it simply produces no changes, since there's nothing to
    diff against yet.
    """
    before = datetime.now(timezone.utc)
    previous_payload = lookup.get_previous_payload(source, endpoint, before)
    if previous_payload is None:
        return []

    old_fingerprint = fingerprint_payload(previous_payload)
    new_fingerprint = fingerprint_payload(current_payload)
    changes = diff_fingerprints(source, endpoint, old_fingerprint, new_fingerprint)

    if changes:
        sink.write_many(changes)

    return changes


class SQLAlchemyPriorPayloadLookup:
    """Production `PriorPayloadLookup`, backed by `raw_pulls`.

    Defaults to a session factory built from `quality.config.Settings().
    runtime_database_url` so a caller can construct this with no arguments in
    production; a `session_factory` can still be injected (e.g. to reuse an
    existing engine, or in an integration test against a real DB).
    """

    def __init__(self, session_factory: sessionmaker[Session] | None = None) -> None:
        self._session_factory = session_factory or sessionmaker(
            bind=create_engine(Settings().runtime_database_url)
        )

    def get_previous_payload(
        self, source: str, endpoint: str, before: datetime
    ) -> dict | None:
        with self._session_factory() as session:
            raw_pull = session.scalar(
                select(RawPull)
                .where(
                    RawPull.source == source,
                    RawPull.endpoint == endpoint,
                    RawPull.pulled_at < before,
                )
                .order_by(RawPull.pulled_at.desc())
                .limit(1)
            )
            return raw_pull.payload if raw_pull is not None else None


class SQLAlchemySchemaChangeSink:
    """Production `SchemaChangeSink`, backed by `schema_change_log`.

    Defaults to a session factory built from `quality.config.Settings().
    runtime_database_url`, same rationale as `SQLAlchemyPriorPayloadLookup`.
    """

    def __init__(self, session_factory: sessionmaker[Session] | None = None) -> None:
        self._session_factory = session_factory or sessionmaker(
            bind=create_engine(Settings().runtime_database_url)
        )

    def write_many(self, changes: list[SchemaChangeLog]) -> None:
        if not changes:
            return
        with self._session_factory() as session:
            session.add_all(changes)
            session.commit()
