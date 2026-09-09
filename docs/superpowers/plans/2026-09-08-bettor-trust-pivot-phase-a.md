# Bettor-Trust Pivot — Phase A (Steps 1-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make NL search answers and the `/quality` page surface real known
score disagreements between sources instead of silently picking one
number, and reposition `/quality` and the homepage for a bettor audience
— all code-complete and tested against fakes, with zero dependency on
real live game data existing yet.

**Architecture:** A new small pure-function module
(`api/src/api/routers/game_conflict.py`) bridges Gold `games`' id space
back to `source_conflicts`' nba_stats-native id space, reusing the
existing `quality.reconciliation.match_games_by_team_overlap` heuristic
for the one case (balldontlie-sourced games) with no deterministic
mapping. Two existing NL-search tool endpoints
(`get_game_result`/`get_player_stats` in `query_tools.py`) call it and
attach an optional `data_confidence` object directly onto the game
row(s) they already return — no new top-level response field, no schema
migration. On the frontend, that field flows to the LLM for free (the
raw tool JSON already passes through unfiltered); a small UI badge
surfaces it visually, and a new "recent catches" feed on `/quality`
(reframed as "Trust Center") turns the same already-fetched
schema-change/conflict data into a human-readable list.

**Tech Stack:** FastAPI + SQLAlchemy (Core for Gold tables, ORM for Meta
tables) on the backend; Next.js/React + Vitest on the frontend. No new
dependencies.

**Spec:** `docs/superpowers/specs/2026-09-08-bettor-trust-pivot-design.md`
(§4, §5, §6, §9 — read before starting; this plan implements exactly the
"Now, no calendar dependency" items from §9's revised sequencing and
explicitly does NOT implement §9's step 3, the real live-game-window
verification).

## Global Constraints

- No odds/lines data source — box-score/live-state only (spec §1).
- No self-healing repair loop, source-reliability scoring, public
  distribution mechanism, or API productization/billing — all explicitly
  out of scope for this phase (spec §3, §8).
- `source_conflicts.field_name` can only ever be `"home_score"` or
  `"away_score"` in production — `ingestion/flows/live_game_flow.py::reconcile_live_states`
  only ever compares those two fields (see its own docstring). Do not
  build any per-player-stat (points/rebounds/etc.) conflict detection —
  there is no code path that could ever produce one.
- `data_confidence` is an **optional** field, present only when a real
  conflict is found — never `null`, never an empty object, absent
  entirely otherwise (matches this project's existing "absent means
  nothing to report" convention).
- This plan does not require a running Postgres to write or unit-test
  the pure-function logic; it does require the existing local Postgres +
  Redis (`make up`) and `uv run pytest` / `npm run test` (vitest) to run
  the full suites before each task's commit.
- Every new/modified Python file: run `uv run pytest -v` in `api/`
  (and `quality/` where relevant) before committing. Every new/modified
  TypeScript file: run `npx vitest run` in `web/` before committing.

---

### Task 1: `game_conflict.py` — pure conflict-resolution module

**Files:**
- Create: `api/src/api/routers/game_conflict.py`
- Test: `api/tests/test_game_conflict.py`

**Interfaces:**
- Produces: `NBA_GAME_ID_OFFSET: int`, `SCORE_FIELDS: tuple[str, str]`,
  `DataConfidence` dataclass with `.to_dict() -> dict`,
  `et_day_bounds(day: date) -> tuple[datetime, datetime]`,
  `resolve_nba_stats_game_id(gold_game_id: int, home_team: str, away_team: str, nba_stats_candidates: Sequence[_NbaStatsCandidateLike]) -> int | None`,
  `find_score_conflict(conflicts: Sequence[_ConflictLike]) -> DataConfidence | None`,
  `load_score_conflict(engine: Engine, game_id: int, game_date: date, home_team: str, away_team: str) -> dict | None`
  — all consumed by Task 2.

- [ ] **Step 0: Add `quality` as an editable dependency of `api`**

`api/pyproject.toml` currently depends on `db`, `fastapi`, `psycopg`,
`pydantic-settings`, `redis`, `slowapi`, `sqlalchemy`, `uvicorn` —
**not** `quality`. This module needs
`quality.reconciliation.match_games_by_team_overlap`, so add the same
editable path dependency `ingestion/pyproject.toml` already uses for the
identical purpose. In `api/pyproject.toml`, add `"quality",` to the
`dependencies` list (alongside the existing `"db"` entry) and add to
`[tool.uv.sources]`:

```toml
[tool.uv.sources]
db = { path = "../db", editable = true }
quality = { path = "../quality", editable = true }
```

Then, from `api/`:

```bash
cd api && uv sync
```

**Known gotcha in this sandbox** (see project memory): `uv sync`/`uv add`
for a new editable path dependency can generate a `.pth` file under
`.venv/lib/python3.13/site-packages/` with macOS's `UF_HIDDEN` flag set,
which Python's `site.py` silently skips — causing a `ModuleNotFoundError: No module named 'quality'`
even though `uv sync` reported success, and the hidden flag can
re-appear on a subsequent `uv run` even after being cleared once. If the
import fails after `uv sync` succeeds, check the real flag (not `ls -lO`,
which can misreport it) and clear it in the **same command** as the next
test run:

```bash
stat -f "%f %N" api/.venv/lib/python3.13/site-packages/*.pth
# Any value with the 32768 bit set is hidden regardless of what ls -lO shows.
find api/.venv/lib/python3.13/site-packages -name "*.pth" -exec chflags nohidden {} \; && cd api && uv run pytest tests/test_game_conflict.py -v
```

- [ ] **Step 1: Write the failing tests for the pure functions**

```python
# api/tests/test_game_conflict.py
from dataclasses import dataclass
from datetime import date, datetime, timezone

import pytest

from api.routers.game_conflict import (
    NBA_GAME_ID_OFFSET,
    DataConfidence,
    et_day_bounds,
    find_score_conflict,
    resolve_nba_stats_game_id,
)


@dataclass
class FakeCandidate:
    game_id: int
    home_team: str | None
    away_team: str | None


@dataclass
class FakeConflict:
    field_name: str
    primary_source: str
    primary_value: str | None
    secondary_source: str
    secondary_value: str | None


def test_et_day_bounds_spans_one_full_utc_day_pair():
    start_utc, end_utc = et_day_bounds(date(2026, 1, 15))
    assert (end_utc - start_utc).total_seconds() == 24 * 3600
    assert start_utc.tzinfo is timezone.utc
    # ET is UTC-5 in January (standard time, no DST) -- midnight ET is 05:00 UTC.
    assert start_utc.hour == 5
    assert start_utc.day == 15


def test_resolve_nba_stats_game_id_nba_api_offset_is_deterministic():
    gold_id = NBA_GAME_ID_OFFSET + 22500123
    # No candidates needed at all for the offset case -- it's pure arithmetic.
    result = resolve_nba_stats_game_id(gold_id, "Lakers", "Celtics", [])
    assert result == 22500123


def test_resolve_nba_stats_game_id_balldontlie_matches_by_team_overlap():
    gold_id = 987654  # balldontlie-native, well below the offset
    candidates = [
        FakeCandidate(game_id=22500999, home_team="Lakers", away_team="Celtics"),
        FakeCandidate(game_id=22500888, home_team="Warriors", away_team="Suns"),
    ]
    result = resolve_nba_stats_game_id(gold_id, "Celtics", "Lakers", candidates)
    assert result == 22500999


def test_resolve_nba_stats_game_id_balldontlie_no_match_returns_none():
    gold_id = 987654
    candidates = [FakeCandidate(game_id=22500888, home_team="Warriors", away_team="Suns")]
    assert resolve_nba_stats_game_id(gold_id, "Celtics", "Lakers", candidates) is None


def test_resolve_nba_stats_game_id_balldontlie_ambiguous_returns_none():
    gold_id = 987654
    # Two candidates on the same day sharing a team name -- can't safely pick one.
    candidates = [
        FakeCandidate(game_id=1, home_team="Lakers", away_team="Nets"),
        FakeCandidate(game_id=2, home_team="Lakers", away_team="Bulls"),
    ]
    result = resolve_nba_stats_game_id(gold_id, "Lakers", "Nets", candidates)
    assert result == 1  # first team-overlap match wins -- matches the reused
    # matcher's own documented first-claim behavior, not true ambiguity
    # detection. Documented here, not silently assumed.


def test_resolve_nba_stats_game_id_ignores_candidates_missing_team_names():
    gold_id = 987654
    candidates = [FakeCandidate(game_id=1, home_team=None, away_team=None)]
    assert resolve_nba_stats_game_id(gold_id, "Lakers", "Nets", candidates) is None


def test_find_score_conflict_returns_first_score_field_match():
    conflicts = [
        FakeConflict(
            field_name="home_score",
            primary_source="balldontlie",
            primary_value="103",
            secondary_source="nba_stats",
            secondary_value="101",
        )
    ]
    result = find_score_conflict(conflicts)
    assert result == DataConfidence(
        field="home_score",
        note="balldontlie and nba_stats disagree on home score; showing balldontlie's number.",
        primary_source="balldontlie",
        primary_value="103",
        secondary_source="nba_stats",
        secondary_value="101",
    )


def test_find_score_conflict_ignores_non_score_fields():
    # Documents the Global Constraints invariant: this should never happen
    # in production, but the function must not misbehave if it did.
    conflicts = [
        FakeConflict(
            field_name="period",
            primary_source="nba_stats",
            primary_value="3",
            secondary_source="balldontlie",
            secondary_value="4",
        )
    ]
    assert find_score_conflict(conflicts) is None


def test_find_score_conflict_empty_returns_none():
    assert find_score_conflict([]) is None


def test_data_confidence_to_dict_shape():
    dc = DataConfidence(
        field="away_score",
        note="x",
        primary_source="balldontlie",
        primary_value="1",
        secondary_source="nba_stats",
        secondary_value="2",
    )
    assert dc.to_dict() == {
        "field": "away_score",
        "note": "x",
        "primary_source": "balldontlie",
        "primary_value": "1",
        "secondary_source": "nba_stats",
        "secondary_value": "2",
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_game_conflict.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'api.routers.game_conflict'`

- [ ] **Step 3: Write the module**

```python
# api/src/api/routers/game_conflict.py
"""Resolves whether a Gold `games` row has a known score disagreement in
`source_conflicts`, for use by `query_tools.py`'s `get_game_result`/
`get_player_stats` (docs/superpowers/specs/2026-09-08-bettor-trust-pivot-design.md §4/§9).

`source_conflicts.game_id` is always nba_stats's own raw (unoffset) id --
written by `ingestion/flows/live_game_flow.py::reconcile_live_states`,
which only ever compares `home_score`/`away_score` (see that function's
own docstring -- no other field_name can appear in production).

Gold `games.game_id` is one of two disjoint id spaces with no `source`
column to distinguish them: balldontlie's native id, or an nba_api id
offset by `NBA_GAME_ID_OFFSET`. This module bridges Gold's id back to
nba_stats's raw id space so a conflict lookup is possible at all --
deterministic for nba_api-sourced games (subtract the offset, matching
`board.py`'s existing convention), team-overlap-matched for
balldontlie-sourced games (there is no persisted mapping for those; see
`quality.reconciliation.match_games_by_team_overlap`, the same heuristic
already used to match nba_api games onto balldontlie's Gold rows during
backfill).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Protocol
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from quality.reconciliation import match_games_by_team_overlap

# Matches ingestion/src/ingestion/sources/nba_stats.py's NBA_GAME_ID_OFFSET
# and api/src/api/routers/board.py's own copy of the same constant --
# duplicated rather than imported since `api` has no dependency on
# `ingestion`, same rationale board.py already documents for its own copy.
NBA_GAME_ID_OFFSET = 100_000_000_000

ET_ZONE = ZoneInfo("America/New_York")

# The only two field_names reconcile_live_states can ever write -- see
# this module's docstring. A row with any other field_name would be a
# bug elsewhere, not a case this function needs to handle.
SCORE_FIELDS = ("home_score", "away_score")


@dataclass(frozen=True)
class DataConfidence:
    field: str
    note: str
    primary_source: str
    primary_value: str | None
    secondary_source: str
    secondary_value: str | None

    def to_dict(self) -> dict:
        return {
            "field": self.field,
            "note": self.note,
            "primary_source": self.primary_source,
            "primary_value": self.primary_value,
            "secondary_source": self.secondary_source,
            "secondary_value": self.secondary_value,
        }


class _NbaStatsCandidateLike(Protocol):
    game_id: int
    home_team: str | None
    away_team: str | None


class _ConflictLike(Protocol):
    field_name: str
    primary_source: str
    primary_value: str | None
    secondary_source: str
    secondary_value: str | None


def et_day_bounds(day: date) -> tuple[datetime, datetime]:
    """UTC `[start, end)` bounds for one ET calendar day. Parallels
    `board.py`'s `et_today_bounds`, parameterized by an explicit date
    instead of "now" -- `get_game_result`/`get_player_stats` resolve
    historical games, not just today's, so "today" isn't the right frame.
    """
    start_et = datetime(day.year, day.month, day.day, tzinfo=ET_ZONE)
    end_et = start_et + timedelta(days=1)
    return start_et.astimezone(timezone.utc), end_et.astimezone(timezone.utc)


def resolve_nba_stats_game_id(
    gold_game_id: int,
    home_team: str,
    away_team: str,
    nba_stats_candidates: Sequence[_NbaStatsCandidateLike],
) -> int | None:
    """Gold `games.game_id` -> nba_stats's raw id space, or `None` if
    there's no reliable match. `nba_stats_candidates` should already be
    scoped by the caller to the game's own date (see `load_score_conflict`)
    -- this function does no date filtering itself, matching
    `match_games_by_team_overlap`'s own existing convention.
    """
    if gold_game_id >= NBA_GAME_ID_OFFSET:
        return gold_game_id - NBA_GAME_ID_OFFSET

    secondary_games = [
        (str(c.game_id), {c.home_team, c.away_team}, {"game_id": c.game_id})
        for c in nba_stats_candidates
        if c.home_team is not None and c.away_team is not None
    ]
    matches = match_games_by_team_overlap(
        primary_games=[(str(gold_game_id), {home_team, away_team}, {})],
        secondary_games=secondary_games,
    )
    if len(matches) != 1:
        return None
    _, _, secondary_fields = matches[0]
    return secondary_fields["game_id"]


def find_score_conflict(conflicts: Sequence[_ConflictLike]) -> DataConfidence | None:
    """The first conflict in `conflicts` scoped to a real score field, or
    `None`. `conflicts` is expected to already be scoped to one resolved
    nba_stats `game_id` by the caller -- this stays a pure, DB-free
    function so the display-copy logic is unit-testable without a
    database (see Task 1's tests)."""
    for conflict in conflicts:
        if conflict.field_name not in SCORE_FIELDS:
            continue
        readable_field = conflict.field_name.replace("_", " ")
        return DataConfidence(
            field=conflict.field_name,
            note=(
                f"{conflict.primary_source} and {conflict.secondary_source} "
                f"disagree on {readable_field}; showing "
                f"{conflict.primary_source}'s number."
            ),
            primary_source=conflict.primary_source,
            primary_value=conflict.primary_value,
            secondary_source=conflict.secondary_source,
            secondary_value=conflict.secondary_value,
        )
    return None


def load_score_conflict(
    engine: Engine,
    game_id: int,
    game_date: date,
    home_team: str,
    away_team: str,
) -> dict | None:
    """Full DB-backed resolution: Gold game -> nba_stats id ->
    `source_conflicts` -> a `data_confidence` dict, or `None`. Shared by
    both `GameResultToolReader` and `PlayerStatsToolReader`'s SQLAlchemy
    implementations (Task 2) so this query logic exists exactly once.

    Uses ORM models (`LiveGameState`, `SourceConflict`) via a `Session`,
    same as `board.py`/`quality.py` -- `query_tools.py`'s own Core-based
    reflection is only used for the dbt-owned `games`/`player_game_stats`
    tables, not these ORM-modeled Meta/Silver ones.

    Not directly unit-tested here (no live-DB unit tests exist anywhere
    in this codebase per CLAUDE.md's testing philosophy) -- the tricky
    logic it calls (`resolve_nba_stats_game_id`, `find_score_conflict`)
    is covered by Task 1's pure-function tests; this function's own thin
    SQLAlchemy glue is exercised at the route level via
    `GameResultToolReader`/`PlayerStatsToolReader` fakes (Task 2) and,
    ultimately, only fully proven by a real run (spec §9 step 3).
    """
    from db.models import LiveGameState, SourceConflict  # local: avoids a hard

    # import-time dependency on `db` for callers that only need the pure
    # functions above (e.g. Task 1's tests).

    start_utc, end_utc = et_day_bounds(game_date)
    with Session(engine) as session:
        candidates = session.scalars(
            select(LiveGameState).where(
                LiveGameState.source == "nba_stats",
                LiveGameState.pulled_at >= start_utc,
                LiveGameState.pulled_at < end_utc,
            )
        ).all()
        nba_stats_id = resolve_nba_stats_game_id(game_id, home_team, away_team, candidates)
        if nba_stats_id is None:
            return None
        conflicts = session.scalars(
            select(SourceConflict).where(SourceConflict.game_id == str(nba_stats_id))
        ).all()

    result = find_score_conflict(conflicts)
    return result.to_dict() if result is not None else None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_game_conflict.py -v`
Expected: 10 passed

- [ ] **Step 5: Run the full `api` suite to confirm no regressions**

Run: `cd api && uv run pytest -v`
Expected: all existing tests still pass (this is a new, self-contained
module — nothing else imports it yet)

- [ ] **Step 6: Commit**

```bash
git add api/pyproject.toml api/uv.lock api/src/api/routers/game_conflict.py api/tests/test_game_conflict.py
git commit -m "feat(api): add game_conflict module resolving Gold games to source_conflicts"
```

---

### Task 2: Wire `game_conflict` into `get_game_result`/`get_player_stats`

**Files:**
- Modify: `api/src/api/routers/query_tools.py` (both Protocols, both
  SQLAlchemy classes, both route functions)
- Modify: `api/tests/test_query_tools.py` (both existing fakes)
- Test: `api/tests/test_query_tools.py` (new cases)

**Interfaces:**
- Consumes: `load_score_conflict` from Task 1.
- Produces: `GameResultToolReader.find_score_conflict(game_id: int, game_date: date, home_team: str, away_team: str) -> dict | None`
  and the identical method on `PlayerStatsToolReader` — both routes'
  responses gain an optional `data_confidence` key on the relevant row(s).

- [ ] **Step 1: Write the failing tests**

Add to `api/tests/test_query_tools.py` (near the existing
`FakeGameResultToolReader`/`FakePlayerStatsToolReader` classes — extend
both fakes in place, don't duplicate them):

```python
# In FakePlayerStatsToolReader.__init__, add a new optional param:
#     def __init__(self, player_rows=None, games_by_id=None, conflicts_by_game_id=None):
#         ...
#         self.conflicts_by_game_id = conflicts_by_game_id or {}
#
# And add the new method:
#     def find_score_conflict(self, game_id, game_date, home_team, away_team):
#         return self.conflicts_by_game_id.get(game_id)

# In FakeGameResultToolReader.__init__, add the same param/method shape:
#     def __init__(self, games=None, player_rows=None, conflicts_by_game_id=None):
#         ...
#         self.conflicts_by_game_id = conflicts_by_game_id or {}
#
#     def find_score_conflict(self, game_id, game_date, home_team, away_team):
#         return self.conflicts_by_game_id.get(game_id)

SAMPLE_CONFLICT = {
    "field": "home_score",
    "note": "balldontlie and nba_stats disagree on home score; showing balldontlie's number.",
    "primary_source": "balldontlie",
    "primary_value": "103",
    "secondary_source": "nba_stats",
    "secondary_value": "101",
}


def test_get_game_result_attaches_data_confidence_when_conflict_exists():
    # FAKE_GAMES[0]: game_id=1, 2024-01-03, Los Angeles Lakers @ Boston
    # Celtics (home_team="Los Angeles Lakers", away_team="Boston Celtics").
    reader = FakeGameResultToolReader(conflicts_by_game_id={1: SAMPLE_CONFLICT})
    app.dependency_overrides[get_game_result_tool_reader] = lambda: reader
    try:
        response = client.get(
            "/tools/game-result",
            params={"team_a": "Lakers", "team_b": "Celtics", "date": "2024-01-03"},
            headers=AUTH_HEADERS,
        )
    finally:
        app.dependency_overrides.pop(get_game_result_tool_reader, None)
    body = response.json()
    assert body["status"] == "ok"
    assert body["data"]["game"]["data_confidence"] == SAMPLE_CONFLICT


def test_get_game_result_omits_data_confidence_when_no_conflict():
    reader = FakeGameResultToolReader()  # conflicts_by_game_id defaults to {}
    app.dependency_overrides[get_game_result_tool_reader] = lambda: reader
    try:
        response = client.get(
            "/tools/game-result",
            params={"team_a": "Lakers", "team_b": "Celtics", "date": "2024-01-03"},
            headers=AUTH_HEADERS,
        )
    finally:
        app.dependency_overrides.pop(get_game_result_tool_reader, None)
    body = response.json()
    assert "data_confidence" not in body["data"]["game"]


def test_get_player_stats_attaches_data_confidence_per_row():
    # FAKE_PLAYER_STATS has LeBron James rows on both game_id=1 (stat_id=1)
    # and game_id=2 (stat_id=3) -- a real two-game result set, so this
    # test can assert the flag lands on exactly one of the two rows.
    reader = FakePlayerStatsToolReader(conflicts_by_game_id={1: SAMPLE_CONFLICT})
    app.dependency_overrides[get_player_stats_tool_reader] = lambda: reader
    try:
        response = client.get(
            "/tools/player-stats",
            params={"player_name": "LeBron James"},
            headers=AUTH_HEADERS,
        )
    finally:
        app.dependency_overrides.pop(get_player_stats_tool_reader, None)
    body = response.json()
    games = body["data"]["games"]
    assert len(games) == 2
    game_1_row = next(g for g in games if g["game_id"] == 1)
    game_2_row = next(g for g in games if g["game_id"] == 2)
    assert game_1_row["data_confidence"] == SAMPLE_CONFLICT
    assert "data_confidence" not in game_2_row
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/test_query_tools.py -k data_confidence -v`
Expected: FAIL — `find_score_conflict` doesn't exist on either fake or
either real reader/Protocol yet (`AttributeError` or a `TypeError` from
the fake's old `__init__` signature not accepting `conflicts_by_game_id`).

- [ ] **Step 3: Extend both Protocols and SQLAlchemy classes**

In `api/src/api/routers/query_tools.py`, add the import:

```python
from datetime import date as date_type

from api.routers.game_conflict import load_score_conflict
```

(the `date_type` import already exists — only add `load_score_conflict`.)

Extend `GameResultToolReader` (around line 1272):

```python
@runtime_checkable
class GameResultToolReader(Protocol):
    def distinct_team_names(self) -> list[str]: ...

    def get_game_result(
        self, team_a: str, team_b: str, game_date: date_type
    ) -> dict | None: ...

    def get_box_score(self, game_id: int) -> list[dict]: ...

    def find_score_conflict(
        self, game_id: int, game_date: date_type, home_team: str, away_team: str
    ) -> dict | None: ...
```

Add the method to `SQLAlchemyGameResultToolReader`:

```python
    def find_score_conflict(
        self, game_id: int, game_date: date_type, home_team: str, away_team: str
    ) -> dict | None:
        return load_score_conflict(self._engine, game_id, game_date, home_team, away_team)
```

Do the identical two edits for `PlayerStatsToolReader` (around line 255)
and `SQLAlchemyPlayerStatsToolReader` (around line 267) — same method
signature and body, verbatim.

- [ ] **Step 4: Wire into both routes**

In `get_game_result` (around line 1365), after fetching `row`:

```python
    row = reader.get_game_result(resolved_a.name, resolved_b.name, game_date)
    if row is None:
        return _no_match(
            f"No game found between {resolved_a.name} and {resolved_b.name} on {date}."
        )

    confidence = reader.find_score_conflict(
        row["game_id"], game_date, row["home_team"], row["away_team"]
    )
    if confidence is not None:
        row["data_confidence"] = confidence

    box_score = reader.get_box_score(row["game_id"])
```

In the **route function** `get_player_stats` (`@router.get("/player-stats")`,
not `SQLAlchemyPlayerStatsToolReader.get_player_stats`), the real current
body ends with:

```python
    rows = reader.get_player_stats(resolved.name, effective_start, effective_end, limit)
    if not rows:
        return _no_match(
            f"No stats found for {resolved.name} in the given date range."
        )

    # Belt-and-suspenders alongside SQLAlchemyPlayerStatsToolReader's own
    # stringification (see player_stats.py's list_player_stats for the same
    # pattern): applied here too so *every* PlayerStatsToolReader
    # implementation injected via DI -- including test fakes -- returns a
    # JS-safe string stat_id, not just the production SQLAlchemy path.
    for row in rows:
        row["stat_id"] = str(row["stat_id"])

    return _ok({"player_name": resolved.name, "games": rows})
```

Change the final loop and return to:

```python
    for row in rows:
        row["stat_id"] = str(row["stat_id"])
        confidence = reader.find_score_conflict(
            row["game_id"], row["game_date"], row["home_team"], row["away_team"]
        )
        if confidence is not None:
            row["data_confidence"] = confidence

    return _ok({"player_name": resolved.name, "games": rows})
```

- [ ] **Step 5: Update the existing fakes' constructors (per Step 1's note)**

Apply the `conflicts_by_game_id` param + `find_score_conflict` method to
both `FakeGameResultToolReader` and `FakePlayerStatsToolReader` as
described in Step 1.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_query_tools.py -v`
Expected: all pass, including the 3 new `data_confidence` tests

- [ ] **Step 7: Run the full `api` suite**

Run: `cd api && uv run pytest -v`
Expected: all pass (no other route touches these two Protocols)

- [ ] **Step 8: Commit**

```bash
git add api/src/api/routers/query_tools.py api/tests/test_query_tools.py
git commit -m "feat(api): surface known score conflicts on get_game_result/get_player_stats"
```

---

### Task 3: Extract `COMMENTARY_COLOR` into a shared module

**Why now:** `web/app/components/feed-ticket.tsx` and
`web/app/components/board-game-row.tsx` each already declare their own
identical copy of `COMMENTARY_COLOR`. Task 5 needs the same color
mapping in a third file (`search-result-tables.tsx`) — copy-pasting a
third time makes the existing drift worse; extracting now (this file's
two current consumers are a small, mechanical change) is the right time
to fix it, not a detour.

**Files:**
- Create: `web/lib/commentary-tone.ts`
- Modify: `web/app/components/feed-ticket.tsx`
- Modify: `web/app/components/board-game-row.tsx`

**Interfaces:**
- Produces: `COMMENTARY_COLOR: Record<string, string>` — consumed by
  Task 5's new badge.

- [ ] **Step 1: Create the shared module**

```typescript
// web/lib/commentary-tone.ts
//
// Shared color treatment for a live game's rule-based commentary kind
// (api/src/api/routers/board_commentary.py's `CommentaryKind`). Factored
// out of feed-ticket.tsx and board-game-row.tsx, which each declared an
// identical copy of this map -- both keep using it via this import so the
// two never drift again, and search-result-tables.tsx (Task 5) reuses it
// for the NL search conflict badge so the visual language for "sources
// disagree" stays consistent across the live board and search.
export const COMMENTARY_COLOR: Record<string, string> = {
  conflict: "text-pink-600 dark:text-pink-400",
  stale: "text-amber-600 dark:text-amber-500",
  run: "text-amber-600 dark:text-amber-500",
  leader: "text-muted-foreground",
};
```

- [ ] **Step 2: Update both existing consumers**

In `web/app/components/feed-ticket.tsx`, remove the local
`const COMMENTARY_COLOR: Record<string, string> = { ... }` declaration
(lines ~36-41) and add:

```typescript
import { COMMENTARY_COLOR } from "@/lib/commentary-tone";
```

Do the identical removal + import in `web/app/components/board-game-row.tsx`.

- [ ] **Step 3: Run the full web test suite to confirm no regressions**

Run: `cd web && npx vitest run`
Expected: all pass (pure rename/import change, no behavior change)

- [ ] **Step 4: Run typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add web/lib/commentary-tone.ts web/app/components/feed-ticket.tsx web/app/components/board-game-row.tsx
git commit -m "refactor(web): extract COMMENTARY_COLOR into a shared module"
```

---

### Task 4: Add `DataConfidence` type to `GameRow`/`PlayerStatRow`

**Files:**
- Modify: `web/lib/team-names.ts`

**Interfaces:**
- Produces: `DataConfidence` type, `GameRow.data_confidence?: DataConfidence`,
  `PlayerStatRow.data_confidence?: DataConfidence` — consumed by Task 5's
  rendering and automatically visible to the NL search LLM (§ design
  note below — no other frontend file needs to change for the LLM to see
  this field).

**Design note (read before implementing):** `data_confidence` is placed
directly on the shared `GameRow`/`PlayerStatRow` types — not as a new
top-level field on `GameResultResultData`/`PlayerStatsResultData`
(`web/lib/search-result-types.ts`). Both `search-tools.ts`'s
`deriveResultData()` (`game: game as GameRow`, `games: games as PlayerStatRow[]`)
and `normalizeEnvelope()` (`data: candidate.data ?? null`, passed through
unfiltered) already forward the raw backend object with no field
filtering — so nesting the new field inside the row objects that are
already cast/passed straight through means **zero changes are needed to
`search-tools.ts` or `search-result-types.ts`** for the value to reach
both the LLM (via `ToolResultEnvelope.data`) and the UI's typed
`SearchResultData` (via `GameRow`/`PlayerStatRow`). This is a deliberate,
narrower design than an earlier review's suggestion to also touch
`search-result-types.ts`/`deriveResultData()` — verify this reasoning
against the real current code before implementing if either file has
changed since this plan was written.

- [ ] **Step 1: Add the type and fields**

In `web/lib/team-names.ts`, after the existing `NBA_GAME_ID_OFFSET`
export and before `GameRow`:

```typescript
/** Mirrors `api/src/api/routers/game_conflict.py`'s `DataConfidence.to_dict()`
 * -- present only on a `GameRow`/`PlayerStatRow` returned by the NL search
 * tool endpoints (`get_game_result`/`get_player_stats`) when a real,
 * logged source disagreement exists for that game's score. Absent
 * (never `null`) on every other row and on every other endpoint's rows. */
export type DataConfidence = {
  field: string;
  note: string;
  primary_source: string;
  primary_value: string | null;
  secondary_source: string;
  secondary_value: string | null;
};
```

Add `data_confidence?: DataConfidence;` as the last field of both
`GameRow` and `PlayerStatRow` (after `source_pulled_at` on `GameRow`,
after the existing last field on `PlayerStatRow`).

- [ ] **Step 2: Run typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no errors (purely additive optional field)

- [ ] **Step 3: Run the full web test suite**

Run: `cd web && npx vitest run`
Expected: all pass

- [ ] **Step 4: Commit**

```bash
git add web/lib/team-names.ts
git commit -m "feat(web): add DataConfidence type to GameRow/PlayerStatRow"
```

---

### Task 5: Render the confidence badge in search results

**Files:**
- Modify: `web/app/components/sections/search-result-tables.tsx`
  (`GameMatchupCard`)
- Modify: `web/lib/box-score.tsx` (`BoxScoreTable`'s game-context "Result"
  cell)
- Test: `web/app/components/sections/search-result-tables.test.tsx`

**Interfaces:**
- Consumes: `COMMENTARY_COLOR` (Task 3), `GameRow.data_confidence`/
  `PlayerStatRow.data_confidence` (Task 4).

- [ ] **Step 1: Write the failing test**

Add to `web/app/components/sections/search-result-tables.test.tsx`
(check the existing file's imports/render-helper conventions first and
match them — the shape below assumes React Testing Library, matching
this project's other component tests):

```typescript
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SearchResultDataView } from "@/app/components/sections/search-result-tables";
import type { SearchResultData } from "@/lib/search-result-types";

const GAME_RESULT_WITH_CONFLICT: SearchResultData = {
  type: "game_result",
  payload: {
    game: {
      game_id: 1,
      game_date: "2024-10-22",
      season: 2024,
      status: "Final",
      postseason: false,
      home_team: "Los Angeles Lakers",
      away_team: "Boston Celtics",
      home_score: 103,
      away_score: 101,
      source_pulled_at: "2024-10-23T00:00:00Z",
      data_confidence: {
        field: "home_score",
        note: "balldontlie and nba_stats disagree on home score; showing balldontlie's number.",
        primary_source: "balldontlie",
        primary_value: "103",
        secondary_source: "nba_stats",
        secondary_value: "101",
      },
    },
    boxScore: [],
  },
};

describe("SearchResultDataView conflict badge", () => {
  it("shows a data-confidence note when the game carries one", () => {
    render(<SearchResultDataView resultData={GAME_RESULT_WITH_CONFLICT} />);
    expect(
      screen.getByText(/balldontlie and nba_stats disagree on home score/i)
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run search-result-tables.test.tsx -t "data-confidence"`
Expected: FAIL — the note text isn't rendered anywhere yet

- [ ] **Step 3: Add the badge to `GameMatchupCard`**

In `web/app/components/sections/search-result-tables.tsx`, add the
import:

```typescript
import { COMMENTARY_COLOR } from "@/lib/commentary-tone";
```

Modify `GameMatchupCard` (around line 46) to render the note when present,
right after the existing score row inside `<CardContent>`:

```typescript
function GameMatchupCard({ game }: { game: GameRow }) {
  const awayAbbreviation = TEAM_NAME_TO_ABBREVIATION[game.away_team] ?? game.away_team;
  const homeAbbreviation = TEAM_NAME_TO_ABBREVIATION[game.home_team] ?? game.home_team;
  return (
    <Card className="gap-3">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="font-geist-mono text-xs font-medium tracking-wide text-muted-foreground">
          {formatGameDate(game.game_date)}
          {game.postseason ? " · Postseason" : ""}
        </CardTitle>
        <Badge variant={game.status.toLowerCase() === "final" ? "secondary" : "outline"}>
          {game.status.charAt(0).toUpperCase() + game.status.slice(1)}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 font-geist-mono text-sm">
          <TeamLink
            abbreviation={awayAbbreviation}
            className={cn(
              "-mx-1 -my-0.5 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-muted",
              scoreColorClass(game.away_score, game.home_score)
            )}
          >
            <TeamLogo src={teamLogoUrlFromName(game.away_team)} alt="" />
            {game.away_team}
          </TeamLink>
          <span
            className={cn(
              "text-lg font-semibold tabular-nums",
              scoreColorClass(game.away_score, game.home_score)
            )}
          >
            {displayScore(game.away_score)}
          </span>
          <span className="text-muted-foreground">@</span>
          <TeamLink
            abbreviation={homeAbbreviation}
            className={cn(
              "-mx-1 -my-0.5 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-muted",
              scoreColorClass(game.home_score, game.away_score)
            )}
          >
            <TeamLogo src={teamLogoUrlFromName(game.home_team)} alt="" />
            {game.home_team}
          </TeamLink>
          <span
            className={cn(
              "text-lg font-semibold tabular-nums",
              scoreColorClass(game.home_score, game.away_score)
            )}
          >
            {displayScore(game.home_score)}
          </span>
        </div>
        {game.data_confidence && (
          <p className={cn("text-xs", COMMENTARY_COLOR.conflict)}>
            {game.data_confidence.note}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
```

The only changes from the current file: `<CardContent>` gains
`className="flex flex-col gap-2"` (was previously unstyled/default), and
the new `{game.data_confidence && (...)}` block is added as
`<CardContent>`'s second child, after the existing score `<div>`.
Everything inside that `<div>` is unchanged from the current file.

- [ ] **Step 4: Add the same treatment to `BoxScoreTable`'s Result cell**

In `web/lib/box-score.tsx`, import `COMMENTARY_COLOR` from
`@/lib/commentary-tone`, and in the `showGameContext` Result `<TableCell>`
(around line 312-343), add a small inline indicator after the two
`TeamLink`s, inside the same flex row:

```typescript
{showGameContext && (
  <TableCell className="whitespace-nowrap">
    <div className="flex items-center gap-2 font-geist-mono text-sm">
      <TeamLink
        abbreviation={TEAM_NAME_TO_ABBREVIATION[row.away_team] ?? row.away_team}
        className={cn(
          "-mx-1 -my-0.5 flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-muted",
          scoreColorClass(row.away_score, row.home_score)
        )}
      >
        <TeamLogo src={teamLogoUrlFromName(row.away_team)} alt="" />
        <span>
          {TEAM_NAME_TO_ABBREVIATION[row.away_team] ?? row.away_team}{" "}
          {displayScore(row.away_score)}
        </span>
      </TeamLink>
      <span className="text-muted-foreground">@</span>
      <TeamLink
        abbreviation={TEAM_NAME_TO_ABBREVIATION[row.home_team] ?? row.home_team}
        className={cn(
          "-mx-1 -my-0.5 flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-muted",
          scoreColorClass(row.home_score, row.away_score)
        )}
      >
        <TeamLogo src={teamLogoUrlFromName(row.home_team)} alt="" />
        <span>
          {TEAM_NAME_TO_ABBREVIATION[row.home_team] ?? row.home_team}{" "}
          {displayScore(row.home_score)}
        </span>
      </TeamLink>
      {row.data_confidence && (
        <span
          className={cn("text-xs", COMMENTARY_COLOR.conflict)}
          title={row.data_confidence.note}
        >
          ⚠
        </span>
      )}
    </div>
  </TableCell>
)}
```

Everything above the new `{row.data_confidence && (...)}` block is
unchanged from the current file — only that final `<span>` is new.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd web && npx vitest run search-result-tables.test.tsx -t "data-confidence"`
Expected: PASS

- [ ] **Step 6: Run the full web test suite and typecheck**

Run: `cd web && npx vitest run && npx tsc --noEmit`
Expected: all pass, no type errors

- [ ] **Step 7: Commit**

```bash
git add web/app/components/sections/search-result-tables.tsx web/app/components/sections/search-result-tables.test.tsx web/lib/box-score.tsx
git commit -m "feat(web): show a badge when a search result carries a known score conflict"
```

---

### Task 6: Instruct the search LLM to state known conflicts

**Files:**
- Modify: `web/lib/search-loop.ts`
- Test: `web/lib/search-loop.test.ts`

**Interfaces:**
- No new exports — this task adds one `SYSTEM_PROMPT` bullet and one
  regression test confirming the data actually reaches the model (the
  prompt wording itself is not unit-testable against a fake LLM client,
  since the fake always returns whatever canned response a test gives
  it regardless of prompt content).

- [ ] **Step 1: Write the failing test**

Add to `web/lib/search-loop.test.ts`, near the other `OK_RESULT`-based
tests:

```typescript
const OK_RESULT_WITH_CONFIDENCE: ToolResultEnvelope = {
  status: "ok",
  table: "games",
  date_range: "2024-10-22 to 2024-10-22",
  data: {
    game: {
      game_id: 1,
      home_team: "Los Angeles Lakers",
      away_team: "Boston Celtics",
      home_score: 103,
      away_score: 101,
      data_confidence: {
        field: "home_score",
        note: "balldontlie and nba_stats disagree on home score; showing balldontlie's number.",
        primary_source: "balldontlie",
        primary_value: "103",
        secondary_source: "nba_stats",
        secondary_value: "101",
      },
    },
    box_score: [],
  },
  resultData: null,
  candidates: null,
  message: null,
};

it("threads a tool result's data_confidence through to the model's context", async () => {
  const llmClient = fakeLlmClient(
    toolCallResponse("get_game_result", { team_a: "Lakers", team_b: "Celtics", date: "2024-10-22" }),
    finalResponse("Lakers beat Celtics 103-101 -- sources disagree on the home score."),
  );
  const callTool = vi.fn().mockResolvedValueOnce(OK_RESULT_WITH_CONFIDENCE);

  await runSearchLoop({ question: "What was the score?", llmClient, callTool });

  // runSearchLoop calls llmClient.send({systemPrompt, tools, history})
  // once per iteration with the full accumulated history so far. The
  // second call (index 1) is the one made after the first iteration's
  // tool dispatch pushed a `{role: "tool_results", results}` entry onto
  // history -- assert the raw data_confidence payload reached it, proving
  // nothing upstream (search-tools.ts's envelope construction) silently
  // drops the field before the model ever sees it.
  const send = llmClient.send as ReturnType<typeof vi.fn>;
  const secondCallArgs = send.mock.calls[1][0];
  const serializedHistory = JSON.stringify(secondCallArgs.history);
  expect(serializedHistory).toContain("data_confidence");
  expect(serializedHistory).toContain("balldontlie and nba_stats disagree");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run search-loop.test.ts -t "threads a tool result"`
Expected: This may actually PASS immediately, since `data` is already
passed through unfiltered by `search-tools.ts` (see Task 4's design
note) and `search-loop.ts`'s `history.push({role: "tool_results", results})`
already forwards the full envelope. If it passes without any production
code change, that confirms the design note's claim — proceed to Step 3
(the prompt change) anyway, since the goal of this task is the model
*using* the data, not just receiving it; leave this test in place as a
permanent regression guard either way.

- [ ] **Step 3: Add the system prompt rule**

In `web/lib/search-loop.ts`, add a new bullet to `SYSTEM_PROMPT` (insert
it right after the existing "Only report facts returned by your tools"
bullet, before the "no_match" bullet):

```
- If a tool result's data includes a "data_confidence" object on a game, state the disagreement plainly in your answer using its "note" field's information (name both sources and both values) rather than presenting only the primary source's number as uncontested fact.
```

- [ ] **Step 4: Run the full web test suite**

Run: `cd web && npx vitest run`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add web/lib/search-loop.ts web/lib/search-loop.test.ts
git commit -m "feat(web): instruct search LLM to state known score conflicts"
```

---

### Task 7: Fix the `field_name`/`field` key bug in the conflicts table

**Files:**
- Modify: `web/app/quality/quality-shared.tsx` (`Conflict` type,
  `CONFLICT_KNOWN_KEYS`)
- Modify: `web/app/quality/quality-tables.tsx` (`ConflictColumn`,
  `SortableHead` column prop, the rendered cell)

**Why:** `api/src/api/routers/quality.py::_serialize_conflict` emits
`field_name`; the frontend's `Conflict` type and `SortableConflictsTable`
both read `field` — so the Field column always renders "–" in production
today. This also widens `Conflict`'s typed fields so Task 8's
recent-catches feed can read `primary_source`/`secondary_source` without
relying on the untyped catch-all (and without the `resolution` field
being mistaken for a source name — `resolution` is the winning *value*,
not a source label; see `quality/reconciliation.py`).

**No dedicated test added for this task**: this directory has no
existing component test coverage at all (confirmed — no `*.test.tsx`
files under `web/app/quality/`), and adding a full render-test suite for
previously-untested code is out of scope for a targeted rename fix. The
corrected `Conflict` type and field name are exercised end-to-end by
Task 8's `buildRecentCatches` tests, which do get real unit tests.

- [ ] **Step 1: Widen the `Conflict` type**

In `web/app/quality/quality-shared.tsx`, replace:

```typescript
export type Conflict = {
  game_id?: string;
  field?: string;
  detected_at?: string;
  [key: string]: unknown;
};
```

with:

```typescript
export type Conflict = {
  id?: number;
  game_id?: string;
  field_name?: string;
  primary_source?: string;
  primary_value?: string | null;
  secondary_source?: string;
  secondary_value?: string | null;
  resolution?: string;
  detected_at?: string;
  [key: string]: unknown;
};
```

Update `CONFLICT_KNOWN_KEYS` (used by `conflictDetails` to decide what's
"already shown elsewhere" vs. dumped into the Details column's raw JSON):

```typescript
export const CONFLICT_KNOWN_KEYS = new Set(["game_id", "field_name", "detected_at"]);
```

(Deliberately still excludes `primary_source`/`primary_value`/
`secondary_source`/`secondary_value`/`resolution`/`id` — those stay in
the Details column's JSON dump for now; promoting them to dedicated
table columns is a further UI change out of scope for this bug fix.)

- [ ] **Step 2: Fix the table's column key and rendering**

In `web/app/quality/quality-tables.tsx`, change:

```typescript
type ConflictColumn = "game_id" | "field" | "detected_at";
```

to:

```typescript
type ConflictColumn = "game_id" | "field_name" | "detected_at";
```

Change the header (around line 345):

```typescript
<SortableHead label="Field" column="field_name" sort={sort} onSort={handleSort} />
```

Change the cell (around line 361-363):

```typescript
<TableCell className="font-mono text-foreground">
  {conflict.field_name ?? "–"}
</TableCell>
```

- [ ] **Step 3: Run the full web test suite and typecheck**

Run: `cd web && npx vitest run && npx tsc --noEmit`
Expected: all pass, no type errors

- [ ] **Step 4: Manual sanity check**

Run: `cd web && npm run dev`, navigate to `/quality`, confirm the page
still renders without runtime errors (the Field column will still show
"–" until real conflict rows exist — that's expected and correct, per
spec §9's calendar-gate finding; the point of this task is that the
column reads the *correct* key, not that it displays real data yet).

- [ ] **Step 5: Commit**

```bash
git add web/app/quality/quality-shared.tsx web/app/quality/quality-tables.tsx
git commit -m "fix(web): correct field_name/field key mismatch in the conflicts table"
```

---

### Task 8: "Recent catches" feed + Trust Center reframe

**Files:**
- Modify: `web/app/quality/quality-shared.tsx` (new `buildRecentCatches`,
  `RecentCatchesFeed`, `RecentCatch` type)
- Modify: `web/app/components/sections/quality-section.tsx` (wire in the
  new feed, rewrite heading/copy)
- Modify: `web/app/components/jump-links.tsx` (nav label)
- Test: `web/app/quality/quality-shared.test.ts` (new file — pure
  function, no component rendering needed)

**Interfaces:**
- Consumes: `Conflict`, `SchemaChange` types (Task 7's corrected
  `Conflict`).
- Produces: `RecentCatch` type, `buildRecentCatches(schemaChanges: SchemaChange[], conflicts: Conflict[]) -> RecentCatch[]`,
  `RecentCatchesFeed` component — consumed by `quality-section.tsx`.

- [ ] **Step 1: Write the failing tests**

```typescript
// web/app/quality/quality-shared.test.ts
import { describe, expect, it } from "vitest";

import { buildRecentCatches } from "@/app/quality/quality-shared";
import type { Conflict, SchemaChange } from "@/app/quality/quality-shared";

const ADDED: SchemaChange = {
  id: 1,
  source: "nba_stats",
  endpoint: "live_scoreboard",
  field_name: "possession_arrow",
  change_type: "added",
  old_type: null,
  new_type: "string",
  detected_at: "2026-01-01T00:00:00Z",
};

const REMOVED: SchemaChange = {
  id: 2,
  source: "balldontlie",
  endpoint: "games",
  field_name: "attendance",
  change_type: "removed",
  old_type: "integer",
  new_type: null,
  detected_at: "2026-01-03T00:00:00Z",
};

const TYPE_CHANGED: SchemaChange = {
  id: 3,
  source: "nba_stats",
  endpoint: "boxscore",
  field_name: "minutes",
  change_type: "type_changed",
  old_type: "string",
  new_type: "integer",
  detected_at: "2026-01-02T00:00:00Z",
};

const CONFLICT: Conflict = {
  id: 1,
  game_id: "22500123",
  field_name: "home_score",
  primary_source: "balldontlie",
  primary_value: "103",
  secondary_source: "nba_stats",
  secondary_value: "101",
  resolution: "103",
  detected_at: "2026-01-04T00:00:00Z",
};

describe("buildRecentCatches", () => {
  it("sorts all entries newest-first across both sources", () => {
    const result = buildRecentCatches([ADDED, REMOVED, TYPE_CHANGED], [CONFLICT]);
    expect(result.map((r) => r.detected_at)).toEqual([
      "2026-01-04T00:00:00Z",
      "2026-01-03T00:00:00Z",
      "2026-01-02T00:00:00Z",
      "2026-01-01T00:00:00Z",
    ]);
  });

  it("marks a removed field as critical severity, added as info, type_changed as warning", () => {
    const result = buildRecentCatches([ADDED, REMOVED, TYPE_CHANGED], []);
    const bySeverity = Object.fromEntries(result.map((r) => [r.id, r.severity]));
    expect(bySeverity["schema-1"]).toBe("info");
    expect(bySeverity["schema-2"]).toBe("critical");
    expect(bySeverity["schema-3"]).toBe("warning");
  });

  it("builds conflict copy from primary_source, not resolution", () => {
    const result = buildRecentCatches([], [CONFLICT]);
    // resolution ("103") is the winning VALUE, not a source name -- the
    // copy must never say "resolved using 103".
    expect(result[0].message).toContain("resolved using balldontlie");
    expect(result[0].message).not.toContain("resolved using 103");
  });

  it("returns an empty array for no data", () => {
    expect(buildRecentCatches([], [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run quality-shared.test.ts`
Expected: FAIL — `buildRecentCatches` doesn't exist yet

- [ ] **Step 3: Implement `buildRecentCatches` and `RecentCatchesFeed`**

Add to `web/app/quality/quality-shared.tsx` (after the existing
`schemaChangeBadgeVisual` function; add `import { cn } from "@/lib/utils";`
to the file's imports):

```typescript
export type RecentCatch = {
  id: string;
  detected_at: string;
  message: string;
  severity: "info" | "warning" | "critical";
};

function schemaChangeCatchMessage(change: SchemaChange): string {
  switch (change.change_type) {
    case "added":
      return `${change.source} added a new field ("${change.field_name}") to its ${change.endpoint} feed — no action needed.`;
    case "removed":
      return `${change.source} removed the field "${change.field_name}" from its ${change.endpoint} feed — this can break downstream parsing if anything still expects it.`;
    case "type_changed":
      return `${change.source} changed the type of "${change.field_name}" in its ${change.endpoint} feed (${change.old_type ?? "unknown"} → ${change.new_type ?? "unknown"}).`;
    default:
      return `${change.source} changed "${change.field_name}" in its ${change.endpoint} feed.`;
  }
}

function schemaChangeSeverity(changeType: string): RecentCatch["severity"] {
  if (changeType === "removed") return "critical";
  if (changeType === "type_changed") return "warning";
  return "info";
}

function conflictCatchMessage(conflict: Conflict): string {
  const game = conflict.game_id ?? "a game";
  const field = (conflict.field_name ?? "a field").replace(/_/g, " ");
  const primary = conflict.primary_source ?? "the primary source";
  const secondary = conflict.secondary_source ?? "a secondary source";
  // Built from primary_source, never `resolution` -- resolution holds the
  // winning VALUE, not a source name (quality/reconciliation.py).
  return `Detected a ${field} disagreement between ${primary} and ${secondary} on game ${game} — resolved using ${primary}.`;
}

/** Merges schema-change and conflict events into one reverse-chronological
 * feed for the Trust Center's headline "what have we caught" view --
 * both inputs already come from the same `GET /quality` response
 * (`schema_changes`, `conflicts.recent`); this is a pure frontend merge,
 * no new API call. */
export function buildRecentCatches(
  schemaChanges: SchemaChange[],
  conflicts: Conflict[]
): RecentCatch[] {
  const schemaCatches: RecentCatch[] = schemaChanges.map((change) => ({
    id: `schema-${change.id}`,
    detected_at: change.detected_at,
    message: schemaChangeCatchMessage(change),
    severity: schemaChangeSeverity(change.change_type),
  }));
  const conflictCatches: RecentCatch[] = conflicts.map((conflict, idx) => ({
    id: `conflict-${conflict.id ?? idx}`,
    detected_at: conflict.detected_at ?? "",
    message: conflictCatchMessage(conflict),
    severity: "warning",
  }));
  return [...schemaCatches, ...conflictCatches].sort((a, b) =>
    b.detected_at.localeCompare(a.detected_at)
  );
}

const SEVERITY_DOT: Record<RecentCatch["severity"], string> = {
  info: "bg-muted-foreground",
  warning: "bg-amber-500",
  critical: "bg-destructive",
};

export function RecentCatchesFeed({ catches }: { catches: RecentCatch[] }) {
  if (catches.length === 0) {
    return (
      <EmptySectionState message="No schema changes or source disagreements caught yet. This feed fills in as the pipeline runs." />
    );
  }
  return (
    <ul className="flex flex-col gap-3">
      {catches.slice(0, 10).map((item) => (
        <li
          key={item.id}
          className="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3"
        >
          <span
            aria-hidden="true"
            className={cn("mt-1 size-2 shrink-0 rounded-full", SEVERITY_DOT[item.severity])}
          />
          <div className="flex flex-col gap-1">
            <p className="text-sm text-foreground">{item.message}</p>
            <p className="text-xs text-muted-foreground">{item.detected_at}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run quality-shared.test.ts`
Expected: 4 passed

- [ ] **Step 5: Wire the feed into the page and rewrite copy**

In `web/app/components/sections/quality-section.tsx`, add to imports:

```typescript
import {
  buildRecentCatches,
  EmptySectionState,
  formatValue,
  RecentCatchesFeed,
  type QualityResponse,
} from "@/app/quality/quality-shared";
```

Change the heading block (around line 154-156):

```typescript
<h1 className="font-heading text-2xl font-bold tracking-wide text-foreground uppercase">
  Trust Center
</h1>
<p className="max-w-2xl text-sm text-muted-foreground">
  Every score comes from two independent sources. When they don&apos;t
  match, you see it here — not a quietly-picked number.
</p>
```

The existing code is one `{result.ok && (<>...</>)}` fragment containing
multiple `<section>`s (starting with "Quality metrics"). Add the new
section as the **first child inside that same fragment**, immediately
after the `<>` and before the existing "Quality metrics" `<section>`:

```typescript
{result.ok && (
  <>
    <section className="flex flex-col gap-3">
      <h3 className="text-lg font-medium text-foreground">Recent catches</h3>
      <RecentCatchesFeed
        catches={buildRecentCatches(
          result.data.quality.schema_changes,
          result.data.quality.conflicts.recent
        )}
      />
    </section>

    <section className="flex flex-col gap-3">
      <h3 className="text-lg font-medium text-foreground">
        Quality metrics
      </h3>
      {/* ... existing "Quality metrics" section content, unchanged ... */}
    </section>
    {/* ... every other existing section in the fragment, unchanged ... */}
  </>
)}
```

Do not duplicate the `{result.ok && ...}` condition — there is exactly
one such block in the file, and the new section is a new sibling
`<section>` inside its existing fragment, not a second conditional.

- [ ] **Step 6: Rename the nav entry**

In `web/app/components/jump-links.tsx`, change:

```typescript
{ href: "/quality", label: "Quality" },
```

to:

```typescript
{ href: "/quality", label: "Trust Center" },
```

- [ ] **Step 7: Run the full web test suite and typecheck**

Run: `cd web && npx vitest run && npx tsc --noEmit`
Expected: all pass, no type errors

- [ ] **Step 8: Manual sanity check**

Run: `cd web && npm run dev`, navigate to `/quality`, confirm: the nav
now says "Trust Center", the page heading and copy match Step 5, and a
"Recent catches" section renders the calm empty state (expected — no
real data yet, per spec §9) above the existing metrics/tables.

- [ ] **Step 9: Commit**

```bash
git add web/app/quality/quality-shared.tsx web/app/quality/quality-shared.test.ts web/app/components/sections/quality-section.tsx web/app/components/jump-links.tsx
git commit -m "feat(web): add Trust Center reframe with a recent-catches feed"
```

---

### Task 9: Homepage hero rewrite

**Files:**
- Modify: `web/app/page.tsx`

**Interfaces:** None — presentational only, no new exports.

- [ ] **Step 1: Rewrite the page**

```typescript
import Link from "next/link";

import { Separator } from "@/components/ui/separator";

import { RecentGamesBoard } from "./components/recent-games-board";
import { SiteHeader } from "./components/site-header";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col">
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6">
        <SiteHeader current="/" />

        <section className="flex flex-col gap-2">
          <h2 className="max-w-2xl font-heading text-2xl font-bold tracking-wide text-foreground uppercase sm:text-3xl">
            We tell you when the data disagrees with itself.
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Every score comes from two independent sources. When they
            don&apos;t match, you see it — not a quietly-picked number.{" "}
            <Link href="/quality" className="underline underline-offset-2 hover:text-foreground">
              See what we&apos;ve caught
            </Link>
            .
          </p>
        </section>

        <section aria-label="Recent games">
          <RecentGamesBoard />
        </section>

        <Separator />

        <footer className="flex flex-col gap-3 text-sm text-muted-foreground">
          <p className="max-w-2xl leading-6">
            Two independent sources feed every NBA game through a
            Bronze/Silver/Gold warehouse, and every disagreement between them
            is logged, not silently resolved.
          </p>
          <p>
            Built on Prefect, dbt, FastAPI, and Next.js — a medallion pipeline
            from raw pulls to a reconciled, drift-monitored warehouse.
          </p>
        </footer>
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Run the full web test suite and typecheck**

Run: `cd web && npx vitest run && npx tsc --noEmit`
Expected: all pass, no type errors

- [ ] **Step 3: Manual sanity check**

Run: `cd web && npm run dev`, navigate to `/`, confirm the new hero
renders above the game board and the "See what we've caught" link
navigates to `/quality` (Trust Center).

- [ ] **Step 4: Commit**

```bash
git add web/app/page.tsx
git commit -m "feat(web): rewrite homepage hero for the bettor-trust pitch"
```

---

## What this plan does not do (by design — see spec §9)

No task here runs `live_game_flow` against real games, verifies a real
`source_conflicts` row ever gets created, or confirms the search/Trust
Center features actually surface a *real* conflict end-to-end. That step
is calendar-gated to preseason (~mid-October 2026 per the spec) and is
tracked separately — do not add it to this plan's scope.
