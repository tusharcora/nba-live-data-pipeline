# Recent Games Board & Commentator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the homepage's historical-only `RecentGamesBoard` with a unified live/scheduled/final board plus a rule-based commentary line per live game, and retire the separate `/live` page.

**Architecture:** A new `nba_stats` live ingestion source (nba_api's live scoreboard) becomes canonical for team identity/schedule/status; a per-poll team-name matching step remaps `balldontlie`/`public_feed` rows onto its game_id space so cross-source comparisons are meaningful; a new `/board` API layer merges today's live state with the historical Gold table and computes commentary from real drift/staleness signals; the frontend renders one unified row list plus a new per-game live view.

**Tech Stack:** Python (Prefect flow, FastAPI, SQLAlchemy, Alembic), Next.js/React (App Router, SSE via `EventSource`), `nba_api`.

**Spec:** `docs/superpowers/specs/2026-09-06-recent-games-board-and-commentator-design.md`

## Global Constraints

- Every Python HTTP-ish client is tested with fakes, no real network/DB (`db-test`/`ingestion-test`/`api-test` CI jobs run `uv run pytest -v` per service). `nba_stats`'s client is the one documented exception to `httpx.get` mocking (see `CLAUDE.md`, updated already) — its tests fake the wrapper object itself.
- Alembic migrations are hand-written and verified offline via `alembic upgrade head --sql` / `alembic downgrade base --sql` — never live-DB autogenerate.
- `web/` has no unit test runner — verification there is `npx tsc --noEmit`, `npm run lint`, and a manual dev-server pass (per root `CLAUDE.md` and this repo's UI-change convention).
- Commentary text uses full team names (e.g. "Miami Heat on a 7-0 run"), not 3-letter abbreviations like the reference mockup — abbreviation lookup (`TEAM_NAME_TO_ABBREVIATION`) is frontend-only, and duplicating that 30-team table in Python purely for commentary-string cosmetics isn't worth the maintenance burden. Documented as a deliberate, disclosed simplification, not an oversight.
- `ingestion/pyproject.toml` gains `quality` as a new editable path dependency (mirroring the existing `db` dependency) so `live_game_flow` can reuse `quality.reconciliation.reconcile_game` rather than reimplementing the primary-source-wins comparison rule.
- A new ingestion module is named `nba_live.py`, not `nba_stats.py` — `ingestion/src/ingestion/sources/nba_stats.py` already exists (the historical, local-only, human-run `NBAStatsClient` wrapping `nba_api.stats.*` for `backfill_nba_stats_flow.py`). The **data** written by the new live source still uses `source="nba_stats"` as its label (matching the spec's naming decision) — only the file path differs, to avoid colliding with existing production code.

---

## Task 1: `LiveGameState`/`SourceConflict` schema changes

**Files:**
- Modify: `db/src/db/models.py`
- Modify: `db/tests/test_models.py`
- Create: `db/migrations/versions/e17c4a92b6d1_add_live_game_state_team_schedule_and_.py`

**Interfaces:**
- Produces: `LiveGameState.home_team: str | None`, `.away_team: str | None`, `.scheduled_start: datetime | None` — consumed by ingestion (Task 3) and the API board layer (Task 9-10).
- Produces: composite index `ix_source_conflicts_game_id_detected_at` on `source_conflicts(game_id, detected_at)` — backs `QualityReader.recent_conflicts_for_game` (Task 7).

- [ ] **Step 1: Add the new columns and index to the ORM models**

In `db/src/db/models.py`, extend `LiveGameState`:

```python
class LiveGameState(Base):
    """Silver layer: one row per poll per game while a game is live.

    Time-series score/clock state, per source — `source` distinguishes which
    of the (now three) data sources a given snapshot came from, since each
    is polled independently and none overwrites another (reconciliation
    across sources happens downstream, not here).
    """

    __tablename__ = "live_game_state"
    __table_args__ = (
        Index("ix_live_game_state_game_id_pulled_at", "game_id", "pulled_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    source: Mapped[str] = mapped_column(String, nullable=False)
    pulled_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    home_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    away_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    period: Mapped[int | None] = mapped_column(Integer, nullable=True)
    clock: Mapped[str | None] = mapped_column(String, nullable=True)
    status: Mapped[str] = mapped_column(String, nullable=False)
    # Only ever populated by source="nba_stats" rows (nba_api's live
    # scoreboard) -- balldontlie/public_feed rows leave these NULL. See
    # docs/superpowers/specs/2026-09-06-recent-games-board-and-commentator-design.md
    # §4.2.
    home_team: Mapped[str | None] = mapped_column(String, nullable=True)
    away_team: Mapped[str | None] = mapped_column(String, nullable=True)
    scheduled_start: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
```

And extend `SourceConflict.__table_args__`:

```python
class SourceConflict(Base):
    """Meta layer: one row per field-level disagreement between two data sources."""

    __tablename__ = "source_conflicts"
    __table_args__ = (
        # Matches `recent_conflicts`'s `ORDER BY detected_at DESC LIMIT N` in
        # api/src/api/routers/quality.py.
        Index("ix_source_conflicts_detected_at", desc("detected_at")),
        # Backs `QualityReader.recent_conflicts_for_game` (api/src/api/
        # routers/quality.py) at the per-poll, per-live-game cadence the
        # board commentary engine needs it at.
        Index("ix_source_conflicts_game_id_detected_at", "game_id", desc("detected_at")),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[str] = mapped_column(String, nullable=False)
    field_name: Mapped[str] = mapped_column(String, nullable=False)
    primary_source: Mapped[str] = mapped_column(String, nullable=False)
    primary_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    secondary_source: Mapped[str] = mapped_column(String, nullable=False)
    secondary_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    resolution: Mapped[str] = mapped_column(String, nullable=False)
    detected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
```

- [ ] **Step 2: Update `db/tests/test_models.py` for the new columns/index**

Replace `test_live_game_state_table`, extend `test_live_game_state_nullability_and_types`, add a new column set, and replace `test_source_conflicts_has_detected_at_index`:

```python
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
        "home_team",
        "away_team",
        "scheduled_start",
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
    assert columns["home_team"].nullable is True
    assert columns["away_team"].nullable is True
    assert columns["scheduled_start"].nullable is True
    # game_id is a bigint per the plan (large external game ids), not a
    # plain 32-bit int.
    assert type(columns["game_id"].type).__name__ == "BigInteger"


def test_source_conflicts_has_detected_at_indexes():
    index_names = {index.name for index in SourceConflict.__table__.indexes}
    assert index_names == {
        "ix_source_conflicts_detected_at",
        "ix_source_conflicts_game_id_detected_at",
    }

    by_name = {index.name: index for index in SourceConflict.__table__.indexes}

    (expr,) = by_name["ix_source_conflicts_detected_at"].expressions
    assert str(expr) == "detected_at DESC"

    game_id_index = by_name["ix_source_conflicts_game_id_detected_at"]
    column_names = [col.name for col in game_id_index.columns]
    assert column_names == ["game_id"]
    # Second key is the DESC expression, not a plain column.
    assert len(game_id_index.expressions) == 2
    assert str(game_id_index.expressions[1]) == "detected_at DESC"
```

Delete the old `test_source_conflicts_has_detected_at_index` function it replaces.

- [ ] **Step 3: Run the model tests**

Run: `cd db && uv run pytest tests/test_models.py -v`
Expected: PASS (11+ tests, including the two you just changed/added).

- [ ] **Step 4: Write the Alembic migration**

Create `db/migrations/versions/e17c4a92b6d1_add_live_game_state_team_schedule_and_.py`:

```python
"""add live_game_state team/schedule columns and source_conflicts game_id index

Revision ID: e17c4a92b6d1
Revises: 20a909ed3f0d
Create Date: 2026-09-06 12:00:00.000000

Adds the columns needed for the unified Recent Games board's live rows and
the index needed for its per-game conflict lookup (docs/superpowers/specs/
2026-09-06-recent-games-board-and-commentator-design.md §4.2, §5.2):

- `live_game_state.home_team` / `.away_team` / `.scheduled_start` — only
  ever populated by `source="nba_stats"` rows; every other source's rows
  leave these NULL.
- `source_conflicts(game_id, detected_at DESC)` — backs
  `QualityReader.recent_conflicts_for_game`'s per-game, per-poll lookup,
  alongside the existing `source_conflicts(detected_at DESC)` index that
  serves the unfiltered "most recent N" scorecard query.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e17c4a92b6d1'
down_revision: Union[str, Sequence[str], None] = '20a909ed3f0d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("live_game_state", sa.Column("home_team", sa.String(), nullable=True))
    op.add_column("live_game_state", sa.Column("away_team", sa.String(), nullable=True))
    op.add_column(
        "live_game_state",
        sa.Column("scheduled_start", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_source_conflicts_game_id_detected_at",
        "source_conflicts",
        ["game_id", sa.text("detected_at DESC")],
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        "ix_source_conflicts_game_id_detected_at", table_name="source_conflicts"
    )
    op.drop_column("live_game_state", "scheduled_start")
    op.drop_column("live_game_state", "away_team")
    op.drop_column("live_game_state", "home_team")
```

- [ ] **Step 5: Verify the migration offline**

Run: `cd db && uv run alembic upgrade head --sql | tail -30`
Expected: emitted DDL includes `ALTER TABLE live_game_state ADD COLUMN home_team VARCHAR`, `... away_team VARCHAR`, `... scheduled_start TIMESTAMP WITH TIME ZONE`, and `CREATE INDEX ix_source_conflicts_game_id_detected_at ON source_conflicts (game_id, detected_at DESC)`.

Run: `cd db && uv run alembic downgrade base --sql | grep -i "source_conflicts\|live_game_state"`
Expected: the downgrade DDL drops the index and the three columns, no errors.

- [ ] **Step 6: Commit**

```bash
git add db/src/db/models.py db/tests/test_models.py db/migrations/versions/e17c4a92b6d1_add_live_game_state_team_schedule_and_.py
git commit -m "db: add live_game_state team/schedule columns, source_conflicts game_id index"
```

---

## Task 2: `nba_live.py` — the live scoreboard client

**Files:**
- Create: `ingestion/src/ingestion/sources/nba_live.py`
- Create: `ingestion/tests/test_nba_live_client.py`
- Modify: `ingestion/pyproject.toml`

**Interfaces:**
- Produces: `NbaLiveScoreboardClient.get_scoreboard() -> dict` — consumed by Task 6's flow wiring.
- Produces: `quality` as an importable package inside `ingestion` (editable path dependency) — consumed by Task 5.

- [ ] **Step 1: Add `quality` as an ingestion dependency**

In `ingestion/pyproject.toml`, add to `dependencies` and `[tool.uv.sources]`:

```toml
dependencies = [
    "db",
    "httpx>=0.28.1",
    "nba_api",
    "prefect>=3.8.4",
    "psycopg[binary]>=3.3.5",
    "pydantic-settings>=2.15.0",
    "quality",
    "sqlalchemy>=2.0.52",
]

[project.scripts]
ingestion = "ingestion:main"

[build-system]
requires = ["uv_build>=0.11.33,<0.12.0"]
build-backend = "uv_build"

[dependency-groups]
dev = [
    "pytest>=9.1.1",
]

[tool.uv.sources]
db = { path = "../db", editable = true }
quality = { path = "../quality", editable = true }
```

- [ ] **Step 2: Sync the dependency**

Run: `cd ingestion && uv sync`
Expected: resolves and installs `quality` as an editable local package alongside `db`, no errors.

- [ ] **Step 3: Write the client**

Create `ingestion/src/ingestion/sources/nba_live.py`:

```python
"""nba_api's **live** scoreboard (`nba_api.live.nba.endpoints.scoreboard`)
— a different part of the `nba_api` package from the **historical**
`stats.nba.com` endpoints `ingestion/src/ingestion/sources/nba_stats.py`
wraps for `backfill_nba_stats_flow.py`.

That distinction matters for two reasons:

1. **File naming.** `nba_stats.py` already exists (the historical, local-
   only, human-run `NBAStatsClient`). This module is named `nba_live.py`
   to avoid colliding with it. The *data* this module writes still uses
   `source="nba_stats"` as its label (see `live_game_flow.py`) — only the
   file path differs.
2. **Deployability.** `nba_stats.py`'s module docstring documents
   `stats.nba.com` as sitting behind Akamai bot protection that blocks
   datacenter/cloud IPs, making that client "local-only, human-run,
   never scheduled, never CI, never a Prefect deployment." The live
   scoreboard endpoint targets a *different* NBA.com property
   (`cdn.nba.com`'s live-data JSON feed, not `stats.nba.com`), which is
   widely used unauthenticated from cloud/CI environments in the `nba_api`
   community without the same IP-blocking issue. **This is an assumption,
   not yet verified against a real request from this project's own
   deployment environment** — flagged per this codebase's "ASSUMED shape,
   not yet verified" convention (see `extract_balldontlie_live_states`'s
   docstring for the precedent). Confirm with a real call from the actual
   Prefect deployment target before relying on a scheduled cadence.

Real payload shape is ASSUMED per `nba_api`'s documented `ScoreBoard`
contract (`get_dict()["scoreboard"]["games"]`), not yet verified against a
live response:

    {
      "scoreboard": {
        "gameDate": "2026-09-06",
        "games": [
          {
            "gameId": "0022500123",
            "gameStatus": 1 | 2 | 3,   # 1=scheduled, 2=live, 3=final
            "gameStatusText": "7:30 pm ET" | "Qtr 3 4:12" | "Final" | ...,
            "gameTimeUTC": "2026-09-07T00:30:00Z",
            "period": 0,
            "gameClock": "",
            "homeTeam": {"teamCity": "Los Angeles", "teamName": "Lakers", "score": 0},
            "awayTeam": {"teamCity": "Boston", "teamName": "Celtics", "score": 0}
          },
          ...
        ]
      }
    }
"""

from __future__ import annotations

from nba_api.live.nba.endpoints import scoreboard


class NbaLiveScoreboardClient:
    """Wraps `nba_api`'s live scoreboard for dependency injection.

    No API key, no date parameter — the live scoreboard is always
    "today" (NBA.com's own notion of today) by construction.
    """

    def get_scoreboard(self) -> dict:
        return scoreboard.ScoreBoard().get_dict()
```

- [ ] **Step 4: Write the client test**

Create `ingestion/tests/test_nba_live_client.py`:

```python
from unittest.mock import MagicMock, patch

from ingestion.sources.nba_live import NbaLiveScoreboardClient


def test_get_scoreboard_returns_the_underlying_dict():
    """Patches the `ScoreBoard` class itself, not `httpx.get` — `nba_api`
    makes its own HTTP calls internally, so this is the one documented
    exception to this project's usual httpx-mocking convention (see
    `CLAUDE.md` and `nba_live.py`'s module docstring).
    """
    fake_board = MagicMock()
    fake_board.get_dict.return_value = {
        "scoreboard": {"gameDate": "2026-09-06", "games": []}
    }

    with patch(
        "ingestion.sources.nba_live.scoreboard.ScoreBoard", return_value=fake_board
    ):
        result = NbaLiveScoreboardClient().get_scoreboard()

    assert result == {"scoreboard": {"gameDate": "2026-09-06", "games": []}}
```

- [ ] **Step 5: Run it**

Run: `cd ingestion && uv run pytest tests/test_nba_live_client.py -v`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add ingestion/pyproject.toml ingestion/uv.lock ingestion/src/ingestion/sources/nba_live.py ingestion/tests/test_nba_live_client.py
git commit -m "ingestion: add nba_live client for nba_api's live scoreboard"
```

---

## Task 3: Extract `LiveGameState` rows from the nba_stats scoreboard payload

**Files:**
- Modify: `ingestion/src/ingestion/flows/live_game_flow.py`
- Modify: `ingestion/tests/test_live_game_flow.py`

**Interfaces:**
- Consumes: nba_stats scoreboard payload shape from Task 2's docstring.
- Produces: `extract_nba_stats_live_states(payload: dict) -> list[LiveGameState]` — consumed by Task 6.

- [ ] **Step 1: Write the failing tests**

Add to `ingestion/tests/test_live_game_flow.py` (near the other `extract_*` tests):

```python
from ingestion.flows.live_game_flow import extract_nba_stats_live_states


def _nba_stats_scoreboard() -> dict:
    return {
        "scoreboard": {
            "gameDate": "2026-09-06",
            "games": [
                {
                    "gameId": "0022500123",
                    "gameStatus": 2,
                    "gameStatusText": "Qtr 3 4:12",
                    "gameTimeUTC": "2026-09-06T23:30:00Z",
                    "period": 3,
                    "gameClock": "PT04M12.00S",
                    "homeTeam": {"teamCity": "Miami", "teamName": "Heat", "score": 91},
                    "awayTeam": {"teamCity": "Boston", "teamName": "Celtics", "score": 88},
                },
                {
                    "gameId": "0022500124",
                    "gameStatus": 1,
                    "gameStatusText": "7:30 pm ET",
                    "gameTimeUTC": "2026-09-07T00:30:00Z",
                    "period": 0,
                    "gameClock": "",
                    "homeTeam": {"teamCity": "Minnesota", "teamName": "Timberwolves", "score": 0},
                    "awayTeam": {"teamCity": "Dallas", "teamName": "Mavericks", "score": 0},
                },
                {
                    "gameId": "0022500125",
                    "gameStatus": 3,
                    "gameStatusText": "Final",
                    "gameTimeUTC": "2026-09-06T19:00:00Z",
                    "period": 4,
                    "gameClock": "",
                    "homeTeam": {"teamCity": "Golden State", "teamName": "Warriors", "score": 118},
                    "awayTeam": {"teamCity": "Phoenix", "teamName": "Suns", "score": 109},
                },
                {
                    "gameId": "0022500126",
                    "gameStatus": 1,
                    "gameStatusText": "Postponed",
                    "gameTimeUTC": "2026-09-07T00:00:00Z",
                    "period": 0,
                    "gameClock": "",
                    "homeTeam": {"teamCity": "Denver", "teamName": "Nuggets", "score": 0},
                    "awayTeam": {"teamCity": "Utah", "teamName": "Jazz", "score": 0},
                },
            ],
        }
    }


def test_extract_nba_stats_live_states_normalizes_team_names_and_scores():
    states = extract_nba_stats_live_states(_nba_stats_scoreboard())

    live = next(s for s in states if s.game_id == 22500123)
    assert live.source == "nba_stats"
    assert live.home_team == "Miami Heat"
    assert live.away_team == "Boston Celtics"
    assert live.home_score == 91
    assert live.away_score == 88
    assert live.period == 3
    assert live.status == "in_progress"


def test_extract_nba_stats_live_states_scheduled_game_has_start_time_no_score_yet():
    states = extract_nba_stats_live_states(_nba_stats_scoreboard())

    scheduled = next(s for s in states if s.game_id == 22500124)
    assert scheduled.status == "scheduled"
    assert scheduled.scheduled_start.isoformat() == "2026-09-07T00:30:00+00:00"
    assert scheduled.home_score == 0


def test_extract_nba_stats_live_states_final_game():
    states = extract_nba_stats_live_states(_nba_stats_scoreboard())

    final = next(s for s in states if s.game_id == 22500125)
    assert final.status == "final"
    assert final.home_score == 118
    assert final.away_score == 109


def test_extract_nba_stats_live_states_postponed_regardless_of_game_status_code():
    """gameStatus=1 alone would normally mean "scheduled" -- the postponement
    keyword in gameStatusText overrides that, matching the substring-based
    postponed/cancelled/suspended/delayed detection this codebase already
    uses in `web/lib/live-status.ts`'s retiring `getStatusPresentation`.
    """
    states = extract_nba_stats_live_states(_nba_stats_scoreboard())

    postponed = next(s for s in states if s.game_id == 22500126)
    assert postponed.status == "postponed"


def test_extract_nba_stats_live_states_empty_games():
    assert extract_nba_stats_live_states({"scoreboard": {"games": []}}) == []
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ingestion && uv run pytest tests/test_live_game_flow.py -k nba_stats_live_states -v`
Expected: FAIL — `extract_nba_stats_live_states` not defined.

- [ ] **Step 3: Implement it**

In `ingestion/src/ingestion/flows/live_game_flow.py`, add near the other `extract_*` functions:

```python
_NBA_STATS_STATUS_BY_CODE = {1: "scheduled", 2: "in_progress", 3: "final"}

_POSTPONEMENT_KEYWORDS = ("postpon", "cancel", "suspend", "delay")


def _normalize_nba_stats_status(game_status: int, game_status_text: str) -> str:
    """gameStatus (1/2/3) maps to scheduled/in_progress/final, but a
    postponement/cancellation is signaled through `gameStatusText`
    regardless of the numeric code (ASSUMED — see module docstring in
    `nba_live.py`), so that keyword check runs first and overrides the
    numeric mapping. Matches the substring-based detection style already
    used by `web/lib/live-status.ts`'s retiring `getStatusPresentation`.
    """
    lowered = game_status_text.lower()
    if any(keyword in lowered for keyword in _POSTPONEMENT_KEYWORDS):
        return "postponed"
    return _NBA_STATS_STATUS_BY_CODE.get(game_status, "scheduled")


def extract_nba_stats_live_states(payload: dict) -> list[LiveGameState]:
    """Extract one `LiveGameState` per game from nba_api's live scoreboard
    payload. ASSUMED shape — see `nba_live.py`'s module docstring; NOT yet
    verified against a real response.

    `status` is normalized to exactly one of "scheduled" / "in_progress" /
    "final" / "postponed" (not nba_api's raw `gameStatusText`) so
    `api/src/api/routers/board.py`'s status derivation is a direct 1:1
    lookup rather than a second round of substring matching.

    `game_id` strips leading zeros from nba_api's own string game id
    (e.g. "0022500123" -> 22500123) via a plain `int()` cast — this is a
    *different* id space from balldontlie's/public_feed's own native ids;
    see `match_game_ids_by_team_overlap` for how those get reconciled onto
    this one.
    """
    games = payload.get("scoreboard", {}).get("games", [])
    states = []
    for game in games:
        home = game.get("homeTeam", {})
        away = game.get("awayTeam", {})
        status = _normalize_nba_stats_status(
            game.get("gameStatus", 1), game.get("gameStatusText", "")
        )
        game_time = game.get("gameTimeUTC")
        states.append(
            LiveGameState(
                game_id=int(game["gameId"]),
                source="nba_stats",
                home_score=home.get("score"),
                away_score=away.get("score"),
                period=game.get("period"),
                clock=game.get("gameClock") or None,
                status=status,
                home_team=f"{home['teamCity']} {home['teamName']}" if home else None,
                away_team=f"{away['teamCity']} {away['teamName']}" if away else None,
                scheduled_start=(
                    datetime.fromisoformat(game_time) if game_time else None
                ),
            )
        )
    return states
```

- [ ] **Step 4: Run to verify pass**

Run: `cd ingestion && uv run pytest tests/test_live_game_flow.py -k nba_stats_live_states -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add ingestion/src/ingestion/flows/live_game_flow.py ingestion/tests/test_live_game_flow.py
git commit -m "ingestion: extract LiveGameState rows from the nba_stats scoreboard"
```

---

## Task 4: Team-name extraction and cross-source game_id matching

**Files:**
- Modify: `ingestion/src/ingestion/flows/live_game_flow.py`
- Modify: `ingestion/tests/test_live_game_flow.py`

**Interfaces:**
- Produces: `extract_balldontlie_team_names(payload) -> dict[int, set[str]]`, `extract_public_feed_team_names(payload) -> dict[int, set[str]]`, `match_game_ids_by_team_overlap(canonical, other) -> dict[int, int]`, `remap_game_ids(states, id_map) -> list[LiveGameState]` — all consumed by Task 6.

- [ ] **Step 1: Write the failing tests**

Add to `ingestion/tests/test_live_game_flow.py`:

```python
from ingestion.flows.live_game_flow import (
    extract_balldontlie_team_names,
    extract_public_feed_team_names,
    match_game_ids_by_team_overlap,
    remap_game_ids,
)


def test_extract_balldontlie_team_names():
    page = {
        "data": [
            {
                "id": 15908,
                "home_team": {"full_name": "Miami Heat"},
                "visitor_team": {"full_name": "Boston Celtics"},
            }
        ]
    }

    assert extract_balldontlie_team_names(page) == {
        15908: {"Miami Heat", "Boston Celtics"}
    }


def test_extract_balldontlie_team_names_missing_team_data_is_skipped():
    assert extract_balldontlie_team_names({"data": [{"id": 1}]}) == {1: set()}


def test_extract_public_feed_team_names():
    scoreboard = {
        "events": [
            {
                "id": "401584793",
                "competitions": [
                    {
                        "competitors": [
                            {"homeAway": "home", "team": {"displayName": "Miami Heat"}},
                            {"homeAway": "away", "team": {"displayName": "Boston Celtics"}},
                        ]
                    }
                ],
            }
        ]
    }

    assert extract_public_feed_team_names(scoreboard) == {
        401584793: {"Miami Heat", "Boston Celtics"}
    }


def test_match_game_ids_by_team_overlap_matches_on_shared_team_name():
    canonical = {22500123: {"Miami Heat", "Boston Celtics"}, 22500124: {"LA Lakers", "Denver Nuggets"}}
    other = {15908: {"Miami Heat", "Boston Celtics"}}

    assert match_game_ids_by_team_overlap(canonical, other) == {15908: 22500123}


def test_match_game_ids_by_team_overlap_no_overlap_is_unmatched():
    canonical = {22500123: {"Miami Heat", "Boston Celtics"}}
    other = {99: {"Some Other Team", "Another Team"}}

    assert match_game_ids_by_team_overlap(canonical, other) == {}


def test_match_game_ids_by_team_overlap_each_canonical_claimed_at_most_once():
    canonical = {22500123: {"Miami Heat", "Boston Celtics"}}
    other = {1: {"Miami Heat"}, 2: {"Miami Heat"}}

    matches = match_game_ids_by_team_overlap(canonical, other)
    assert len(matches) == 1
    assert set(matches.values()) == {22500123}


def test_remap_game_ids_rewrites_matched_ids_leaves_unmatched_alone():
    states = [
        LiveGameState(game_id=15908, source="balldontlie", status="in_progress"),
        LiveGameState(game_id=999, source="balldontlie", status="in_progress"),
    ]

    remap_game_ids(states, {15908: 22500123})

    assert states[0].game_id == 22500123
    assert states[1].game_id == 999
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ingestion && uv run pytest tests/test_live_game_flow.py -k "team_names or match_game_ids or remap_game_ids" -v`
Expected: FAIL — none of the four functions are defined.

- [ ] **Step 3: Implement them**

In `ingestion/src/ingestion/flows/live_game_flow.py`, add:

```python
def extract_balldontlie_team_names(payload: dict) -> dict[int, set[str]]:
    """`{game_id: {home_full_name, away_full_name}}` from a balldontlie
    `/games` page — used only for cross-source game matching
    (`match_game_ids_by_team_overlap`), not persisted. ASSUMED shape per
    `dbt/models/staging/stg_games.sql`'s documented `home_team.full_name`/
    `visitor_team.full_name` fields, not yet verified against real data.
    A game missing team data contributes an empty set, never crashes.
    """
    result: dict[int, set[str]] = {}
    for game in payload.get("data", []):
        names = set()
        home_name = game.get("home_team", {}).get("full_name")
        away_name = game.get("visitor_team", {}).get("full_name")
        if home_name:
            names.add(home_name)
        if away_name:
            names.add(away_name)
        result[game["id"]] = names
    return result


def extract_public_feed_team_names(payload: dict) -> dict[int, set[str]]:
    """`{game_id: {home_displayName, away_displayName}}` from a
    `PublicFeedClient.get_scoreboard()` response — same competition-parsing
    shape as `extract_public_feed_live_states`, used only for cross-source
    game matching, not persisted.
    """
    result: dict[int, set[str]] = {}
    for event in payload.get("events", []):
        competitions = event.get("competitions") or [{}]
        competitors = competitions[0].get("competitors", [])
        names = {
            c["team"]["displayName"]
            for c in competitors
            if c.get("team", {}).get("displayName")
        }
        result[int(event["id"])] = names
    return result


def match_game_ids_by_team_overlap(
    canonical_teams: dict[int, set[str]], other_teams: dict[int, set[str]]
) -> dict[int, int]:
    """Match each `other`-source game_id to the canonical (nba_stats)
    game_id whose team-name set it overlaps, so cross-source rows for the
    same real game can be written under one shared `game_id`.

    Team-name-set overlap, not exact full-game match, so a naming variant
    on one team (e.g. "LA Clippers" vs "Los Angeles Clippers") still
    matches as long as the other team's name is spelled identically by
    both sources — same heuristic and caveats as
    `quality.reconciliation.match_games_by_team_overlap`, reimplemented
    here (rather than reused) because that function returns matched field
    *values*, not the secondary game's own id, which is exactly what
    remapping needs. A canonical game is claimed by at most one `other`
    game.
    """
    matches: dict[int, int] = {}
    claimed_canonical: set[int] = set()

    for other_id, other_names in other_teams.items():
        for canonical_id, canonical_names in canonical_teams.items():
            if canonical_id in claimed_canonical:
                continue
            if other_names & canonical_names:
                matches[other_id] = canonical_id
                claimed_canonical.add(canonical_id)
                break

    return matches


def remap_game_ids(
    states: list[LiveGameState], id_map: dict[int, int]
) -> list[LiveGameState]:
    """Rewrite each state's `game_id` to its matched canonical id, in
    place. A state whose `game_id` has no entry in `id_map` (this source
    reported a game nba_stats didn't cover this poll) keeps its own
    native id — orphaned but harmless: it simply won't be picked up by
    any board row's merge, rather than being dropped or written under a
    wrong game.
    """
    for state in states:
        state.game_id = id_map.get(state.game_id, state.game_id)
    return states
```

- [ ] **Step 4: Run to verify pass**

Run: `cd ingestion && uv run pytest tests/test_live_game_flow.py -k "team_names or match_game_ids or remap_game_ids" -v`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add ingestion/src/ingestion/flows/live_game_flow.py ingestion/tests/test_live_game_flow.py
git commit -m "ingestion: match and remap balldontlie/public_feed game_ids onto nba_stats"
```

---

## Task 5: 3-way score reconciliation

**Files:**
- Modify: `ingestion/src/ingestion/flows/live_game_flow.py`
- Modify: `ingestion/tests/test_live_game_flow.py`

**Interfaces:**
- Consumes: `quality.reconciliation.reconcile_game` (pure, already exists, unchanged).
- Produces: `reconcile_live_states(nba_stats_states, balldontlie_states, public_feed_states) -> list[SourceConflict]` — consumed by Task 6. States passed in must already have matching `game_id`s (post-remap, per Task 4).

- [ ] **Step 1: Write the failing tests**

Add to `ingestion/tests/test_live_game_flow.py`:

```python
from db.models import SourceConflict
from ingestion.flows.live_game_flow import reconcile_live_states


def test_reconcile_live_states_flags_disagreeing_scores():
    nba_stats_states = [
        LiveGameState(game_id=1, source="nba_stats", home_score=91, away_score=88, status="in_progress")
    ]
    balldontlie_states = [
        LiveGameState(game_id=1, source="balldontlie", home_score=89, away_score=88, status="3rd Qtr")
    ]

    conflicts = reconcile_live_states(nba_stats_states, balldontlie_states, [])

    assert len(conflicts) == 1
    conflict = conflicts[0]
    assert isinstance(conflict, SourceConflict)
    assert conflict.game_id == "1"
    assert conflict.field_name == "home_score"
    assert conflict.primary_source == "nba_stats"
    assert conflict.primary_value == "91"
    assert conflict.secondary_source == "balldontlie"
    assert conflict.secondary_value == "89"


def test_reconcile_live_states_agreeing_scores_yield_no_conflicts():
    nba_stats_states = [
        LiveGameState(game_id=1, source="nba_stats", home_score=91, away_score=88, status="in_progress")
    ]
    balldontlie_states = [
        LiveGameState(game_id=1, source="balldontlie", home_score=91, away_score=88, status="3rd Qtr")
    ]

    assert reconcile_live_states(nba_stats_states, balldontlie_states, []) == []


def test_reconcile_live_states_never_compares_status_field():
    """status vocabularies differ by source design (nba_api's normalized
    tokens vs. balldontlie's raw strings vs. ESPN's STATUS_* constants) —
    comparing it would flag a "conflict" every single poll for reasons
    that have nothing to do with real disagreement.
    """
    nba_stats_states = [
        LiveGameState(game_id=1, source="nba_stats", home_score=91, away_score=88, status="in_progress")
    ]
    balldontlie_states = [
        LiveGameState(game_id=1, source="balldontlie", home_score=91, away_score=88, status="3rd Qtr")
    ]

    assert reconcile_live_states(nba_stats_states, balldontlie_states, []) == []


def test_reconcile_live_states_checks_both_secondary_sources_independently():
    nba_stats_states = [
        LiveGameState(game_id=1, source="nba_stats", home_score=91, away_score=88, status="in_progress")
    ]
    balldontlie_states = [
        LiveGameState(game_id=1, source="balldontlie", home_score=89, away_score=88, status="3rd Qtr")
    ]
    public_feed_states = [
        LiveGameState(game_id=1, source="public_feed", home_score=91, away_score=90, status="STATUS_IN_PROGRESS")
    ]

    conflicts = reconcile_live_states(nba_stats_states, balldontlie_states, public_feed_states)

    fields_by_secondary = {c.secondary_source: c.field_name for c in conflicts}
    assert fields_by_secondary == {"balldontlie": "home_score", "public_feed": "away_score"}


def test_reconcile_live_states_skips_games_with_no_secondary_row():
    nba_stats_states = [
        LiveGameState(game_id=1, source="nba_stats", home_score=91, away_score=88, status="in_progress")
    ]

    assert reconcile_live_states(nba_stats_states, [], []) == []


def test_reconcile_live_states_skips_games_with_no_scores_yet():
    nba_stats_states = [
        LiveGameState(game_id=1, source="nba_stats", home_score=None, away_score=None, status="scheduled")
    ]
    balldontlie_states = [
        LiveGameState(game_id=1, source="balldontlie", home_score=None, away_score=None, status="Scheduled")
    ]

    assert reconcile_live_states(nba_stats_states, balldontlie_states, []) == []
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ingestion && uv run pytest tests/test_live_game_flow.py -k reconcile_live_states -v`
Expected: FAIL — `reconcile_live_states` not defined.

- [ ] **Step 3: Implement it**

In `ingestion/src/ingestion/flows/live_game_flow.py`, add the import and the function:

```python
from quality.reconciliation import reconcile_game
```

```python
def _score_fields(state: LiveGameState) -> dict[str, str]:
    """`home_score`/`away_score` as comparable strings, omitting a field
    that's still `None` (nothing to compare yet, e.g. before tip-off).
    `status` is deliberately excluded — see `reconcile_live_states`.
    """
    fields: dict[str, str] = {}
    if state.home_score is not None:
        fields["home_score"] = str(state.home_score)
    if state.away_score is not None:
        fields["away_score"] = str(state.away_score)
    return fields


def reconcile_live_states(
    nba_stats_states: list[LiveGameState],
    balldontlie_states: list[LiveGameState],
    public_feed_states: list[LiveGameState],
) -> list[SourceConflict]:
    """3-way reconciliation for one poll: nba_stats as primary against each
    secondary source independently (2 pairwise comparisons per game_id,
    not a true 3-way merge) — the same "primary source wins" rule as
    `quality.reconciliation.reconcile_game`, invoked twice. Only
    `home_score`/`away_score` are ever compared — `status` strings differ
    by source vocabulary (nba_api's normalized tokens vs. balldontlie's
    raw strings vs. ESPN's STATUS_* constants) and comparing them would
    flag a false "conflict" on every single poll, flooding the quality
    scorecard with noise that has nothing to do with a real disagreement.

    Assumes every state's `game_id` has already been remapped onto
    nba_stats's canonical id space (`remap_game_ids`) — a game_id shared
    across the three lists is only meaningful once that's happened.
    """
    balldontlie_by_id = {s.game_id: s for s in balldontlie_states}
    public_feed_by_id = {s.game_id: s for s in public_feed_states}

    conflicts: list[SourceConflict] = []
    for nba_state in nba_stats_states:
        primary_fields = _score_fields(nba_state)
        if not primary_fields:
            continue

        for secondary_source, lookup in (
            ("balldontlie", balldontlie_by_id),
            ("public_feed", public_feed_by_id),
        ):
            secondary_state = lookup.get(nba_state.game_id)
            if secondary_state is None:
                continue
            secondary_fields = _score_fields(secondary_state)
            if not secondary_fields:
                continue
            game_conflicts, _ = reconcile_game(
                game_id=str(nba_state.game_id),
                primary_source="nba_stats",
                primary_fields=primary_fields,
                secondary_source=secondary_source,
                secondary_fields=secondary_fields,
            )
            conflicts.extend(game_conflicts)

    return conflicts
```

- [ ] **Step 4: Run to verify pass**

Run: `cd ingestion && uv run pytest tests/test_live_game_flow.py -k reconcile_live_states -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add ingestion/src/ingestion/flows/live_game_flow.py ingestion/tests/test_live_game_flow.py
git commit -m "ingestion: 3-way score reconciliation (nba_stats primary) for live polls"
```

---

## Task 6: Wire nba_stats into `live_game_flow` end-to-end

**Files:**
- Modify: `ingestion/src/ingestion/flows/live_game_flow.py`
- Modify: `ingestion/tests/test_live_game_flow.py`

**Interfaces:**
- Consumes: everything from Tasks 2-5.
- Produces: `live_game_flow(..., nba_stats_client=..., conflict_sink=...)` — the flow's new full contract. No other module calls this yet (Prefect deployment scheduling is out of scope, matching this flow's existing "not a real-time loop" scope note).

- [ ] **Step 1: Update the existing flow tests for the new contract**

Every existing test in `ingestion/tests/test_live_game_flow.py` that calls `live_game_flow(...)` must now also pass `nba_stats_client=...` — the flow's default constructs a real `NbaLiveScoreboardClient()` otherwise, which would make these tests hit a real network call.

Add a fake near the other fakes:

```python
class FakeNbaLiveScoreboardClient:
    def __init__(self, scoreboard: dict | None = None) -> None:
        self._scoreboard = scoreboard or {"scoreboard": {"games": []}}
        self.call_count = 0

    def get_scoreboard(self) -> dict:
        self.call_count += 1
        return self._scoreboard
```

Update every existing call site (`test_live_game_flow_writes_raw_pull_for_each_source`, `test_live_game_flow_extracts_live_game_state_rows_from_both_sources`, `test_live_game_flow_writes_poll_lag_metric_exactly_once`, `test_live_game_flow_requests_both_sources_with_the_given_date`, `test_live_game_flow_handles_multiple_balldontlie_pages`) to add `nba_stats_client=FakeNbaLiveScoreboardClient(), conflict_sink=FakeRowSink(),` to the call, and update the assertions that count sources/pulls/states to include `"nba_stats"` and the +1 raw pull.

For example, `test_live_game_flow_writes_raw_pull_for_each_source` becomes:

```python
def test_live_game_flow_writes_raw_pull_for_each_source():
    raw_pull_sink = FakeRawPullSink()
    live_game_state_sink = FakeRowSink()
    quality_metric_sink = FakeRowSink()

    live_game_flow(
        date="2026-09-01",
        raw_pull_sink=raw_pull_sink,
        live_game_state_sink=live_game_state_sink,
        quality_metric_sink=quality_metric_sink,
        conflict_sink=FakeRowSink(),
        balldontlie_client=FakeBallDontLieClient(_balldontlie_pages()),
        public_feed_client=FakeScoreboardSource(_public_feed_scoreboard()),
        nba_stats_client=FakeNbaLiveScoreboardClient(),
    )

    assert len(raw_pull_sink.written) == 3
    sources = {rp.source for rp in raw_pull_sink.written}
    assert sources == {"balldontlie", "public_feed", "nba_stats"}

    bdl_pull = next(rp for rp in raw_pull_sink.written if rp.source == "balldontlie")
    assert bdl_pull.endpoint == "games"
    assert bdl_pull.payload == _balldontlie_pages()[0]

    pf_pull = next(rp for rp in raw_pull_sink.written if rp.source == "public_feed")
    assert pf_pull.endpoint == "scoreboard"
    assert pf_pull.payload == _public_feed_scoreboard()

    ns_pull = next(rp for rp in raw_pull_sink.written if rp.source == "nba_stats")
    assert ns_pull.endpoint == "scoreboard"
```

`test_live_game_flow_extracts_live_game_state_rows_from_both_sources` becomes (renamed for accuracy):

```python
def test_live_game_flow_extracts_live_game_state_rows_from_all_sources():
    live_game_state_sink = FakeRowSink()

    live_game_flow(
        date="2026-09-01",
        raw_pull_sink=FakeRawPullSink(),
        live_game_state_sink=live_game_state_sink,
        quality_metric_sink=FakeRowSink(),
        conflict_sink=FakeRowSink(),
        balldontlie_client=FakeBallDontLieClient(_balldontlie_pages()),
        public_feed_client=FakeScoreboardSource(_public_feed_scoreboard()),
        nba_stats_client=FakeNbaLiveScoreboardClient(),
    )

    assert len(live_game_state_sink.written) == 2
    sources = {row.source for row in live_game_state_sink.written}
    assert sources == {"balldontlie", "public_feed"}
    for row in live_game_state_sink.written:
        assert isinstance(row, LiveGameState)
```

(Sources stay `{"balldontlie", "public_feed"}` here since the default `FakeNbaLiveScoreboardClient()` returns zero games — add one more test for the nba_stats-present case:)

```python
def test_live_game_flow_writes_nba_stats_rows_when_present():
    live_game_state_sink = FakeRowSink()

    live_game_flow(
        date="2026-09-01",
        raw_pull_sink=FakeRawPullSink(),
        live_game_state_sink=live_game_state_sink,
        quality_metric_sink=FakeRowSink(),
        conflict_sink=FakeRowSink(),
        balldontlie_client=FakeBallDontLieClient([]),
        public_feed_client=FakeScoreboardSource({"events": []}),
        nba_stats_client=FakeNbaLiveScoreboardClient(_nba_stats_scoreboard()),
    )

    sources = {row.source for row in live_game_state_sink.written}
    assert sources == {"nba_stats"}
    assert len(live_game_state_sink.written) == 4  # every game in _nba_stats_scoreboard()


def test_live_game_flow_matches_and_writes_conflicts_across_sources():
    conflict_sink = FakeRowSink()

    live_game_flow(
        date="2026-09-01",
        raw_pull_sink=FakeRawPullSink(),
        live_game_state_sink=FakeRowSink(),
        quality_metric_sink=FakeRowSink(),
        conflict_sink=conflict_sink,
        balldontlie_client=FakeBallDontLieClient(
            [
                {
                    "data": [
                        {
                            "id": 15908,
                            "status": "3rd Qtr",
                            "home_team_score": 89,
                            "visitor_team_score": 88,
                            "home_team": {"full_name": "Miami Heat"},
                            "visitor_team": {"full_name": "Boston Celtics"},
                        }
                    ],
                    "meta": {"next_cursor": None},
                }
            ]
        ),
        public_feed_client=FakeScoreboardSource({"events": []}),
        nba_stats_client=FakeNbaLiveScoreboardClient(
            {
                "scoreboard": {
                    "games": [
                        {
                            "gameId": "0022500123",
                            "gameStatus": 2,
                            "gameStatusText": "Qtr 3 4:12",
                            "gameTimeUTC": "2026-09-06T23:30:00Z",
                            "period": 3,
                            "gameClock": "PT04M12.00S",
                            "homeTeam": {"teamCity": "Miami", "teamName": "Heat", "score": 91},
                            "awayTeam": {"teamCity": "Boston", "teamName": "Celtics", "score": 88},
                        }
                    ]
                }
            }
        ),
    )

    assert len(conflict_sink.written) == 1
    conflict = conflict_sink.written[0]
    assert conflict.game_id == "22500123"
    assert conflict.field_name == "home_score"
    assert conflict.primary_source == "nba_stats"
    assert conflict.secondary_source == "balldontlie"
```

Update `test_live_game_flow_writes_poll_lag_metric_exactly_once` and `test_live_game_flow_requests_both_sources_with_the_given_date` to add the two new params and, in the former, bump `result["raw_pulls_written"]` to `3` and `result["live_game_states_written"]` to `2`.

Update `test_live_game_flow_handles_multiple_balldontlie_pages`'s assertions: `result["raw_pulls_written"] == 4` (2 balldontlie pages + 1 public_feed + 1 nba_stats) and add the two new params.

- [ ] **Step 2: Run to verify the new/updated tests fail**

Run: `cd ingestion && uv run pytest tests/test_live_game_flow.py -v`
Expected: FAIL on the updated assertion counts and the two brand-new tests (flow doesn't accept the new params yet).

- [ ] **Step 3: Implement the flow changes**

In `ingestion/src/ingestion/flows/live_game_flow.py`, update the imports and signature:

```python
from ingestion.sources.nba_live import NbaLiveScoreboardClient
```

```python
@runtime_checkable
class LiveScoreboardSource(Protocol):
    """Injectable nba_stats (nba_api live scoreboard) client — matches
    `NbaLiveScoreboardClient.get_scoreboard() -> dict`. No `date` param,
    unlike `ScoreboardSource` above: nba_api's live scoreboard is always
    "today" (ET) by construction, with no historical/date-scoped mode.
    """

    def get_scoreboard(self) -> dict: ...
```

```python
@flow(name="live-game-flow")
def live_game_flow(
    date: str,
    raw_pull_sink: RawPullSink | None = None,
    live_game_state_sink: RowSink | None = None,
    quality_metric_sink: RowSink | None = None,
    conflict_sink: RowSink | None = None,
    balldontlie_client: GamesPageSource | None = None,
    public_feed_client: ScoreboardSource | None = None,
    nba_stats_client: LiveScoreboardSource | None = None,
) -> dict:
    """One live-poll cycle against all three data sources (docs/prd.md
    §12; docs/superpowers/specs/2026-09-06-recent-games-board-and-
    commentator-design.md §4).

    1. Pulls nba_stats's live scoreboard first — canonical for team
       identity this poll (see `match_game_ids_by_team_overlap`) — then
       balldontlie's `/games` pages and ESPN's scoreboard, writing each as
       its own Bronze `RawPull`.
    2. Extracts one Silver `LiveGameState` row per game from each source,
       matches balldontlie's/public_feed's game ids onto nba_stats's
       canonical id space by team-name overlap, and remaps them
       accordingly before writing (an unmatched row keeps its native id,
       orphaned but harmless).
    3. Reconciles nba_stats's scores against each secondary source
       (`reconcile_live_states`) and writes any resulting
       `SourceConflict` rows via `conflict_sink`.
    4. Writes exactly one freshness `QualityMetric`, unchanged from before.

    All sinks and source clients are injected; production code gets real
    implementations by default, tests pass in-memory fakes.
    """
    logger = get_run_logger()
    poll_started_at = datetime.now(timezone.utc)

    session_factory: sessionmaker[Session] | None = None
    if (
        raw_pull_sink is None
        or live_game_state_sink is None
        or quality_metric_sink is None
        or conflict_sink is None
    ):
        session_factory = sessionmaker(bind=create_engine(Settings().runtime_database_url))
    raw_pull_sink = raw_pull_sink or SQLAlchemyRawPullSink(session_factory)  # type: ignore[arg-type]
    live_game_state_sink = live_game_state_sink or SQLAlchemyRowSink(session_factory)  # type: ignore[arg-type]
    quality_metric_sink = quality_metric_sink or SQLAlchemyRowSink(session_factory)  # type: ignore[arg-type]
    conflict_sink = conflict_sink or SQLAlchemyRowSink(session_factory)  # type: ignore[arg-type]
    balldontlie_client = balldontlie_client or BallDontLieClient(
        api_key=Settings().balldontlie_api_key
    )
    public_feed_client = public_feed_client or PublicFeedClient(
        base_url=Settings().public_feed_base_url
    )
    nba_stats_client = nba_stats_client or NbaLiveScoreboardClient()

    raw_pulls_written = 0
    live_game_states_written = 0

    nba_stats_payload = nba_stats_client.get_scoreboard()
    raw_pull_sink.write(
        RawPull(source="nba_stats", endpoint="scoreboard", payload=nba_stats_payload)
    )
    raw_pulls_written += 1
    nba_stats_states = extract_nba_stats_live_states(nba_stats_payload)
    nba_stats_team_names = {
        state.game_id: {state.home_team, state.away_team}
        for state in nba_stats_states
        if state.home_team and state.away_team
    }

    balldontlie_states: list[LiveGameState] = []
    balldontlie_team_names: dict[int, set[str]] = {}
    for page in balldontlie_client.get_games_pages(date):
        raw_pull_sink.write(RawPull(source="balldontlie", endpoint="games", payload=page))
        raw_pulls_written += 1
        balldontlie_states.extend(extract_balldontlie_live_states(page))
        balldontlie_team_names.update(extract_balldontlie_team_names(page))

    public_feed_payload = public_feed_client.get_scoreboard(date)
    raw_pull_sink.write(
        RawPull(source="public_feed", endpoint="scoreboard", payload=public_feed_payload)
    )
    raw_pulls_written += 1
    public_feed_states = extract_public_feed_live_states(public_feed_payload)
    public_feed_team_names = extract_public_feed_team_names(public_feed_payload)

    remap_game_ids(
        balldontlie_states,
        match_game_ids_by_team_overlap(nba_stats_team_names, balldontlie_team_names),
    )
    remap_game_ids(
        public_feed_states,
        match_game_ids_by_team_overlap(nba_stats_team_names, public_feed_team_names),
    )

    for state in (*nba_stats_states, *balldontlie_states, *public_feed_states):
        live_game_state_sink.write(state)
        live_game_states_written += 1

    for conflict in reconcile_live_states(nba_stats_states, balldontlie_states, public_feed_states):
        conflict_sink.write(conflict)

    poll_lag_seconds = (datetime.now(timezone.utc) - poll_started_at).total_seconds()
    quality_metric_sink.write(
        QualityMetric(
            check_name="live_poll_lag_seconds",
            metric_value=poll_lag_seconds,
            metadata_json={"date": date},
        )
    )

    logger.info(
        "live_game_flow: %s (%d raw_pulls, %d live_game_state rows, poll_lag=%.3fs)",
        date,
        raw_pulls_written,
        live_game_states_written,
        poll_lag_seconds,
    )

    return {
        "raw_pulls_written": raw_pulls_written,
        "live_game_states_written": live_game_states_written,
    }
```

- [ ] **Step 4: Run the full ingestion test suite**

Run: `cd ingestion && uv run pytest -v`
Expected: PASS, all tests green (existing + new).

- [ ] **Step 5: Commit**

```bash
git add ingestion/src/ingestion/flows/live_game_flow.py ingestion/tests/test_live_game_flow.py
git commit -m "ingestion: wire nba_stats as a third live source into live_game_flow"
```

---

## Task 7: `QualityReader.recent_conflicts_for_game`

**Files:**
- Modify: `api/src/api/routers/quality.py`
- Modify: `api/tests/test_quality.py`

**Interfaces:**
- Produces: `QualityReader.recent_conflicts_for_game(game_id: str, window_seconds: int) -> Sequence[SourceConflict]` — consumed by Task 9's commentary lookup.

- [ ] **Step 1: Write the failing test**

Add to `api/tests/test_quality.py`, alongside `FakeQualityReader` (extend the fake) and its own test near the other reader-shape tests. First extend `FakeQualityReader`:

```python
class FakeQualityReader:
    def __init__(
        self,
        metric_rows=(),
        schema_changes=(),
        conflicts_total=0,
        conflicts_recent=(),
        history_rows=(),
        conflicts_by_game=(),
    ):
        self._metric_rows = list(metric_rows)
        self._schema_changes = list(schema_changes)
        self._conflicts_total = conflicts_total
        self._conflicts_recent = list(conflicts_recent)
        self._history_rows = list(history_rows)
        self._conflicts_by_game = list(conflicts_by_game)
        self.call_count = 0
        self.history_call_count = 0

    def latest_metric_rows(self):
        self.call_count += 1
        return self._metric_rows

    def recent_schema_changes(self, limit):
        return self._schema_changes[:limit]

    def recent_conflicts(self, limit):
        return self._conflicts_total, self._conflicts_recent[:limit]

    def metric_history(self, check_name):
        self.history_call_count += 1
        return [row for row in self._history_rows if row.check_name == check_name]

    def recent_conflicts_for_game(self, game_id, window_seconds):
        return [c for c in self._conflicts_by_game if c.game_id == game_id]
```

Add the protocol-shape test:

```python
def test_recent_conflicts_for_game_filters_by_game_id():
    conflict_for_game_1 = _conflict(
        1, "1", "home_score", "nba_stats", "91", "balldontlie", "89", "91",
        datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    conflict_for_game_2 = _conflict(
        2, "2", "home_score", "nba_stats", "80", "balldontlie", "79", "80",
        datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    reader = FakeQualityReader(conflicts_by_game=[conflict_for_game_1, conflict_for_game_2])

    result = reader.recent_conflicts_for_game("1", window_seconds=300)

    assert result == [conflict_for_game_1]
```

This test exercises the fake's contract (what Task 9's board tests will rely on) — the *real* `SqlAlchemyQualityReader` implementation isn't independently unit-tested against a live DB, matching this file's existing convention (every other `SqlAlchemyQualityReader` method is only exercised indirectly through route tests with a fake reader).

- [ ] **Step 2: Run to verify it currently fails**

Run: `cd api && uv run pytest tests/test_quality.py -k recent_conflicts_for_game -v`
Expected: FAIL — `FakeQualityReader.recent_conflicts_for_game` doesn't exist yet (you just added it above, so actually this step confirms it now exists and passes; if you're following strict TDD, write the test first against the *unmodified* fake, watch it fail with `AttributeError`, then add the method).

- [ ] **Step 3: Add the method to the real `QualityReader` Protocol and implementation**

In `api/src/api/routers/quality.py`, add the import and extend the Protocol/implementation:

```python
from datetime import datetime, timedelta, timezone
```

```python
class QualityReader(Protocol):
    ...

    def recent_conflicts_for_game(
        self, game_id: str, window_seconds: int
    ) -> Sequence[SourceConflict]:
        """Every `source_conflicts` row for `game_id` detected within the
        last `window_seconds`, any order — backs the board commentary
        engine's per-game conflict check (`board_commentary.py`)."""
        ...
```

```python
class SqlAlchemyQualityReader:
    ...

    def recent_conflicts_for_game(
        self, game_id: str, window_seconds: int
    ) -> Sequence[SourceConflict]:
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=window_seconds)
        stmt = select(SourceConflict).where(
            SourceConflict.game_id == game_id,
            SourceConflict.detected_at >= cutoff,
        )
        return self._session.execute(stmt).scalars().all()
```

- [ ] **Step 4: Run the full quality test file**

Run: `cd api && uv run pytest tests/test_quality.py -v`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add api/src/api/routers/quality.py api/tests/test_quality.py
git commit -m "api: add QualityReader.recent_conflicts_for_game"
```

---

## Task 8: `board_commentary.py` — the commentary engine

**Files:**
- Create: `api/src/api/routers/board_commentary.py`
- Create: `api/tests/test_board_commentary.py`

**Interfaces:**
- Produces: `Commentary(text: str, kind: CommentaryKind)`, `compute_commentary(nba_stats_history, other_sources_latest, conflicts, now) -> Commentary | None`, constants `MIN_RUN_POINTS`, `STALE_THRESHOLD_SECONDS`, `CONFLICT_DISPLAY_WINDOW_SECONDS` — consumed by Task 9/10's board merge.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_board_commentary.py`:

```python
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from api.routers.board_commentary import compute_commentary

NOW = datetime(2026, 1, 1, 20, 0, 0, tzinfo=timezone.utc)


def _state(home_score, away_score, pulled_at=NOW, home_team="Miami Heat", away_team="Boston Celtics"):
    return SimpleNamespace(
        home_score=home_score,
        away_score=away_score,
        pulled_at=pulled_at,
        home_team=home_team,
        away_team=away_team,
    )


def _conflict(field_name, secondary_source, detected_at=NOW):
    return SimpleNamespace(
        field_name=field_name, secondary_source=secondary_source, detected_at=detected_at
    )


def test_leader_margin_is_the_fallback():
    history = [_state(91, 88)]
    result = compute_commentary(history, {}, [], NOW)
    assert result.text == "Miami Heat leads by 3"
    assert result.kind == "leader"


def test_tied_score_reports_tied():
    history = [_state(88, 88)]
    result = compute_commentary(history, {}, [], NOW)
    assert result.text == "Tied"
    assert result.kind == "leader"


def test_scoring_run_above_threshold_beats_leader_margin():
    # Home team scores 91->97 (6 pts) across 3 snapshots while away stays 88.
    history = [
        _state(97, 88, pulled_at=NOW),
        _state(94, 88, pulled_at=NOW - timedelta(seconds=5)),
        _state(91, 88, pulled_at=NOW - timedelta(seconds=10)),
    ]
    result = compute_commentary(history, {}, [], NOW)
    assert result.text == "Miami Heat on a 6-0 run"
    assert result.kind == "run"


def test_scoring_run_below_threshold_falls_through_to_leader_margin():
    history = [
        _state(93, 88, pulled_at=NOW),
        _state(91, 88, pulled_at=NOW - timedelta(seconds=5)),
    ]
    result = compute_commentary(history, {}, [], NOW)
    assert result.kind == "leader"
    assert result.text == "Miami Heat leads by 5"


def test_run_streak_breaks_when_other_team_also_scores():
    history = [
        _state(97, 90, pulled_at=NOW),           # away scored here too -> streak stops
        _state(94, 88, pulled_at=NOW - timedelta(seconds=5)),
        _state(91, 88, pulled_at=NOW - timedelta(seconds=10)),
    ]
    result = compute_commentary(history, {}, [], NOW)
    # Only the last (94->97, +3) leg counts once the away score also moves.
    assert result.kind == "leader"


def test_stale_nba_stats_reported_when_a_secondary_source_is_fresh():
    history = [_state(91, 88, pulled_at=NOW - timedelta(seconds=60))]
    other_sources = {"balldontlie": _state(89, 88, pulled_at=NOW)}
    result = compute_commentary(history, other_sources, [], NOW)
    assert result.text == "Feed stale · nba_stats delayed"
    assert result.kind == "stale"


def test_stale_secondary_source_reported_when_nba_stats_is_fresh():
    history = [_state(91, 88, pulled_at=NOW)]
    other_sources = {"balldontlie": _state(89, 88, pulled_at=NOW - timedelta(seconds=60))}
    result = compute_commentary(history, other_sources, [], NOW)
    assert result.text == "Feed stale · balldontlie delayed"
    assert result.kind == "stale"


def test_no_staleness_reported_when_everything_is_stale():
    """Whole-pipeline outage isn't a per-game "this feed is delayed" call —
    requires at least one *other* fresh source for the check to fire.
    """
    history = [_state(91, 88, pulled_at=NOW - timedelta(seconds=60))]
    other_sources = {"balldontlie": _state(89, 88, pulled_at=NOW - timedelta(seconds=90))}
    result = compute_commentary(history, other_sources, [], NOW)
    assert result.kind != "stale"


def test_conflict_outranks_run_and_leader_when_values_still_differ():
    history = [_state(91, 88, pulled_at=NOW)]
    other_sources = {"balldontlie": _state(89, 88, pulled_at=NOW)}
    conflicts = [_conflict("home_score", "balldontlie", detected_at=NOW)]
    result = compute_commentary(history, other_sources, conflicts, NOW)
    assert result.text == "Source conflict · home_score"
    assert result.kind == "conflict"


def test_conflict_ignored_once_values_agree_again():
    """Re-checks current values rather than trusting the conflict row's
    old snapshot — a self-corrected disagreement stops outranking live
    commentary immediately.
    """
    history = [_state(91, 88, pulled_at=NOW)]
    other_sources = {"balldontlie": _state(91, 88, pulled_at=NOW)}  # now agrees
    conflicts = [_conflict("home_score", "balldontlie", detected_at=NOW)]
    result = compute_commentary(history, other_sources, conflicts, NOW)
    assert result.kind != "conflict"


def test_conflict_outside_display_window_is_ignored():
    history = [_state(91, 88, pulled_at=NOW)]
    other_sources = {"balldontlie": _state(89, 88, pulled_at=NOW)}
    old_conflict = [_conflict("home_score", "balldontlie", detected_at=NOW - timedelta(seconds=301))]
    result = compute_commentary(history, other_sources, old_conflict, NOW)
    assert result.kind != "conflict"


def test_empty_history_returns_none():
    assert compute_commentary([], {}, [], NOW) is None
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && uv run pytest tests/test_board_commentary.py -v`
Expected: FAIL — `api.routers.board_commentary` doesn't exist.

- [ ] **Step 3: Implement `board_commentary.py`**

Create `api/src/api/routers/board_commentary.py`:

```python
"""Rule-based commentary for one live game — a single templated line
driven entirely by real signals already in this pipeline
(`live_game_state`, `source_conflicts`), never free-form or LLM-generated.
See docs/superpowers/specs/2026-09-06-recent-games-board-and-commentator-design.md
§6 for the full design and priority rationale.

Commentary text uses full team names (e.g. "Miami Heat on a 7-0 run"),
not 3-letter abbreviations — abbreviation lookup
(`TEAM_NAME_TO_ABBREVIATION`) is a frontend-only concern, and duplicating
that 30-team table in Python purely for commentary-string cosmetics isn't
worth the maintenance burden. A deliberate, disclosed simplification.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Protocol

MIN_RUN_POINTS = 6
STALE_THRESHOLD_SECONDS = 45
CONFLICT_DISPLAY_WINDOW_SECONDS = 300

CommentaryKind = Literal["conflict", "stale", "run", "leader"]


@dataclass(frozen=True)
class Commentary:
    text: str
    kind: CommentaryKind


class _StateLike(Protocol):
    """Structural shape this module actually reads off a `LiveGameState`
    (or a test double) — kept narrow and local rather than importing the
    ORM model, since every function here is pure and DB-agnostic."""

    home_score: int | None
    away_score: int | None
    pulled_at: datetime
    home_team: str | None
    away_team: str | None


class _ConflictLike(Protocol):
    field_name: str
    secondary_source: str
    detected_at: datetime


def _age_seconds(pulled_at: datetime, now: datetime) -> float:
    return (now - pulled_at).total_seconds()


def _check_conflict(
    nba_stats_latest: _StateLike,
    other_sources_latest: Mapping[str, _StateLike],
    conflicts: Sequence[_ConflictLike],
    now: datetime,
) -> Commentary | None:
    """A `source_conflicts` row for this game, still within the display
    window, AND the two sources' *current* latest values for that same
    field still actually differ — re-checked against `nba_stats_latest`/
    `other_sources_latest` directly rather than trusting the conflict
    row's own (potentially stale) snapshot values, so a disagreement that
    self-corrected on a later poll stops outranking live commentary
    immediately rather than lingering for the rest of the display window.
    """
    field_values = {
        "home_score": nba_stats_latest.home_score,
        "away_score": nba_stats_latest.away_score,
    }

    for conflict in conflicts:
        if _age_seconds(conflict.detected_at, now) > CONFLICT_DISPLAY_WINDOW_SECONDS:
            continue
        secondary = other_sources_latest.get(conflict.secondary_source)
        if secondary is None:
            continue
        current_primary_value = field_values.get(conflict.field_name)
        current_secondary_value = getattr(secondary, conflict.field_name, None)
        if current_primary_value is None or current_secondary_value is None:
            continue
        if current_primary_value != current_secondary_value:
            return Commentary(f"Source conflict · {conflict.field_name}", "conflict")

    return None


def _check_stale(
    nba_stats_latest: _StateLike,
    other_sources_latest: Mapping[str, _StateLike],
    now: datetime,
) -> Commentary | None:
    """`nba_stats` itself lagging is checked first — it's the canonical
    display source, so a stale `nba_stats` row means the visible
    score/clock may already be outdated. A lagging secondary source is a
    lower-stakes reconciliation note, checked only if nba_stats is fresh.
    Either case requires at least one *other* source to be current — a
    whole-pipeline outage isn't a "this feed is delayed" call the
    commentator can meaningfully make per game.
    """
    nba_stats_age = _age_seconds(nba_stats_latest.pulled_at, now)
    fresh_others = [
        state
        for state in other_sources_latest.values()
        if _age_seconds(state.pulled_at, now) <= STALE_THRESHOLD_SECONDS
    ]
    if nba_stats_age > STALE_THRESHOLD_SECONDS and fresh_others:
        return Commentary("Feed stale · nba_stats delayed", "stale")

    if nba_stats_age <= STALE_THRESHOLD_SECONDS:
        for source, state in other_sources_latest.items():
            if _age_seconds(state.pulled_at, now) > STALE_THRESHOLD_SECONDS:
                return Commentary(f"Feed stale · {source} delayed", "stale")

    return None


def _detect_run(nba_stats_history: Sequence[_StateLike]) -> Commentary | None:
    """Infers a scoring run from cumulative score snapshots (no
    play-by-play exists) — see design §6.2. `nba_stats_history` must be
    newest-first. Walks backward accumulating each side's score delta
    between consecutive snapshots; the streak breaks the moment the
    *other* side's score also increases.
    """
    if len(nba_stats_history) < 2:
        return None

    newest = nba_stats_history[0]
    if newest.home_score is None or newest.away_score is None:
        return None

    home_run_points = 0
    away_run_points = 0
    current = newest
    for previous in nba_stats_history[1:]:
        if previous.home_score is None or previous.away_score is None:
            break
        home_delta = current.home_score - previous.home_score
        away_delta = current.away_score - previous.away_score
        if home_delta > 0 and away_delta > 0:
            break
        if home_delta <= 0 and away_delta <= 0:
            break
        home_run_points += max(home_delta, 0)
        away_run_points += max(away_delta, 0)
        current = previous

    if home_run_points >= MIN_RUN_POINTS:
        return Commentary(f"{newest.home_team} on a {home_run_points}-0 run", "run")
    if away_run_points >= MIN_RUN_POINTS:
        return Commentary(f"{newest.away_team} on a {away_run_points}-0 run", "run")
    return None


def _leader_margin(nba_stats_latest: _StateLike) -> Commentary:
    home = nba_stats_latest.home_score or 0
    away = nba_stats_latest.away_score or 0
    if home == away:
        return Commentary("Tied", "leader")
    if home > away:
        return Commentary(f"{nba_stats_latest.home_team} leads by {home - away}", "leader")
    return Commentary(f"{nba_stats_latest.away_team} leads by {away - home}", "leader")


def compute_commentary(
    nba_stats_history: Sequence[_StateLike],
    other_sources_latest: Mapping[str, _StateLike],
    conflicts: Sequence[_ConflictLike],
    now: datetime,
) -> Commentary | None:
    """One commentary line for a live game, highest-priority signal wins:
    source conflict > feed stale > scoring run > leader margin. See
    design §6.1. `nba_stats_history` must be newest-first; an empty
    history (no nba_stats row for this game) returns `None`.
    """
    if not nba_stats_history:
        return None
    nba_stats_latest = nba_stats_history[0]

    return (
        _check_conflict(nba_stats_latest, other_sources_latest, conflicts, now)
        or _check_stale(nba_stats_latest, other_sources_latest, now)
        or _detect_run(nba_stats_history)
        or _leader_margin(nba_stats_latest)
    )
```

- [ ] **Step 4: Run to verify pass**

Run: `cd api && uv run pytest tests/test_board_commentary.py -v`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add api/src/api/routers/board_commentary.py api/tests/test_board_commentary.py
git commit -m "api: add the rule-based board commentary engine"
```

---

## Task 9: `board.py` — ET-day bounds, `BoardReader`, merge, `GET /board/`

**Files:**
- Create: `api/src/api/routers/board.py`
- Create: `api/tests/test_board.py`

**Interfaces:**
- Consumes: `api.routers.games.GamesReader`/`get_games_reader` (unchanged, reused), `api.routers.quality.QualityReader`/`get_quality_reader` (Task 7), `api.routers.board_commentary.compute_commentary` (Task 8).
- Produces: `et_today_bounds(now_utc) -> tuple[datetime, datetime]`, `BoardReader` Protocol, `compute_board(...) -> list[dict]`, `GET /board/` route — the stream route (Task 10) reuses `compute_board`'s per-game row logic via `_board_row_for_group`.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_board.py`:

```python
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from fastapi.testclient import TestClient

from api.main import app
from api.routers.board import (
    et_today_bounds,
    get_board_reader,
)
from api.routers.games import get_games_reader
from api.routers.quality import get_quality_reader

API_KEY = "test-service-key"

client = TestClient(app)


def _state(game_id, source, home_score, away_score, status, pulled_at,
           home_team=None, away_team=None, scheduled_start=None, period=None, clock=None):
    return SimpleNamespace(
        game_id=game_id, source=source, home_score=home_score, away_score=away_score,
        status=status, pulled_at=pulled_at, home_team=home_team, away_team=away_team,
        scheduled_start=scheduled_start, period=period, clock=clock,
    )


class FakeBoardReader:
    def __init__(self, today_states=(), history_by_game=None):
        self._today_states = list(today_states)
        self._history_by_game = history_by_game or {}

    def latest_per_source_today(self, start_utc, end_utc):
        return self._today_states

    def nba_stats_history_today(self, game_id, start_utc, end_utc, limit):
        return self._history_by_game.get(game_id, [])[:limit]


class FakeGamesReader:
    def __init__(self, rows=()):
        self._rows = list(rows)

    def list_games(self, filter_date, start_date=None, end_date=None, game_id=None, team_names=None):
        return self._rows


class FakeQualityReader:
    def recent_conflicts_for_game(self, game_id, window_seconds):
        return []


def _override(today_states=(), history_by_game=None, historical_rows=()):
    app.dependency_overrides[get_board_reader] = lambda: FakeBoardReader(
        today_states, history_by_game
    )
    app.dependency_overrides[get_games_reader] = lambda: FakeGamesReader(historical_rows)
    app.dependency_overrides[get_quality_reader] = lambda: FakeQualityReader()


def _clear_overrides():
    app.dependency_overrides.pop(get_board_reader, None)
    app.dependency_overrides.pop(get_games_reader, None)
    app.dependency_overrides.pop(get_quality_reader, None)


def test_et_today_bounds_late_night_et_game_groups_correctly():
    """A game at 10pm ET on Jan 1 is 3am UTC on Jan 2 — must still fall
    inside "Jan 1"'s ET bounds, not get pushed into "Jan 2" by a naive
    UTC-day grouping.
    """
    now_utc = datetime(2026, 1, 2, 2, 0, 0, tzinfo=timezone.utc)  # 9pm ET Jan 1
    start, end = et_today_bounds(now_utc)

    ten_pm_et_game = datetime(2026, 1, 2, 3, 0, 0, tzinfo=timezone.utc)  # 10pm ET Jan 1
    assert start <= ten_pm_et_game < end

    next_day_game = datetime(2026, 1, 2, 10, 0, 0, tzinfo=timezone.utc)  # 5am ET Jan 2
    assert not (start <= next_day_game < end)


def test_board_requires_api_key():
    resp = client.get("/board/")
    assert resp.status_code == 401


def test_board_live_game_includes_commentary():
    now = datetime(2026, 1, 1, 20, 0, 0, tzinfo=timezone.utc)
    today_states = [
        _state(1, "nba_stats", 91, 88, "in_progress", now,
               home_team="Miami Heat", away_team="Boston Celtics", period=3, clock="4:12"),
        _state(1, "balldontlie", 91, 88, "3rd Qtr", now),
    ]
    history = {1: [today_states[0]]}
    _override(today_states=today_states, history_by_game=history)
    try:
        resp = client.get("/board/", headers={"X-API-Key": API_KEY})
        assert resp.status_code == 200
        rows = resp.json()["data"]
        row = next(r for r in rows if r["game_id"] == 1)
        assert row["status"] == "live"
        assert row["home_team"] == "Miami Heat"
        assert row["commentary"]["kind"] == "leader"
        assert row["commentary"]["text"] == "Miami Heat leads by 3"
    finally:
        _clear_overrides()


def test_board_scheduled_game_has_no_commentary():
    now = datetime(2026, 1, 1, 20, 0, 0, tzinfo=timezone.utc)
    start = datetime(2026, 1, 2, 0, 30, 0, tzinfo=timezone.utc)
    today_states = [
        _state(2, "nba_stats", 0, 0, "scheduled", now,
               home_team="Dallas Mavericks", away_team="Minnesota Timberwolves",
               scheduled_start=start),
    ]
    _override(today_states=today_states, history_by_game={2: today_states})
    try:
        resp = client.get("/board/", headers={"X-API-Key": API_KEY})
        row = next(r for r in resp.json()["data"] if r["game_id"] == 2)
        assert row["status"] == "scheduled"
        assert row["commentary"] is None
        assert row["scheduled_start"] == start.isoformat()
    finally:
        _clear_overrides()


def test_board_falls_back_to_secondary_source_when_nba_stats_missing():
    now = datetime(2026, 1, 1, 20, 0, 0, tzinfo=timezone.utc)
    today_states = [_state(3, "balldontlie", 50, 48, "2nd Qtr", now)]
    _override(today_states=today_states)
    try:
        resp = client.get("/board/", headers={"X-API-Key": API_KEY})
        row = next(r for r in resp.json()["data"] if r["game_id"] == 3)
        assert row["home_score"] == 50
        assert row["commentary"] is None
    finally:
        _clear_overrides()


def test_board_includes_historical_rows_not_in_todays_set():
    historical_rows = [
        {
            "game_id": 999,
            "home_team": "Golden State Warriors",
            "away_team": "Phoenix Suns",
            "home_score": 118,
            "away_score": 109,
            "source_pulled_at": datetime(2025, 12, 1, tzinfo=timezone.utc),
        }
    ]
    _override(historical_rows=historical_rows)
    try:
        resp = client.get("/board/", headers={"X-API-Key": API_KEY})
        rows = resp.json()["data"]
        row = next(r for r in rows if r["game_id"] == 999)
        assert row["status"] == "final"
        assert row["home_score"] == 118
        assert row["commentary"] is None
    finally:
        _clear_overrides()


def test_board_excludes_historical_row_already_covered_by_todays_set():
    now = datetime(2026, 1, 1, 20, 0, 0, tzinfo=timezone.utc)
    today_states = [_state(999, "nba_stats", 118, 109, "final", now,
                            home_team="Golden State Warriors", away_team="Phoenix Suns")]
    historical_rows = [
        {
            "game_id": 999, "home_team": "Golden State Warriors", "away_team": "Phoenix Suns",
            "home_score": 118, "away_score": 109, "source_pulled_at": now,
        }
    ]
    _override(today_states=today_states, historical_rows=historical_rows)
    try:
        resp = client.get("/board/", headers={"X-API-Key": API_KEY})
        rows = resp.json()["data"]
        assert len([r for r in rows if r["game_id"] == 999]) == 1
    finally:
        _clear_overrides()
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && uv run pytest tests/test_board.py -v`
Expected: FAIL — `api.routers.board` doesn't exist.

- [ ] **Step 3: Implement `board.py`**

Create `api/src/api/routers/board.py`:

```python
"""`GET /board/` — the unified live/scheduled/final-today + historical
board (docs/superpowers/specs/2026-09-06-recent-games-board-and-
commentator-design.md §5.1). Replaces both `GET /games`'s "always final"
homepage usage and `GET /live` (retired — see api/src/api/main.py).
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from typing import Protocol, runtime_checkable
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Request
from sqlalchemy import func, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import sessionmaker

from api.core.cache import cached_json
from api.core.db import get_engine
from api.core.rate_limit import DEFAULT_RATE_LIMIT, limiter
from api.core.security import require_api_key
from api.routers.board_commentary import CONFLICT_DISPLAY_WINDOW_SECONDS, compute_commentary
from api.routers.games import GamesReader, get_games_reader
from api.routers.quality import QualityReader, get_quality_reader
from db.models import LiveGameState

router = APIRouter(prefix="/board", tags=["board"], dependencies=[Depends(require_api_key)])

CACHE_TTL_SECONDS = 15
CACHE_KEY = "board:today"

# How many recent nba_stats rows to fetch per live game for run detection
# (§6.2) — a generous window given polls are infrequent relative to game
# length; bounding it keeps the query and the walk-backward loop cheap.
BOARD_HISTORY_LIMIT = 20

ET_ZONE = ZoneInfo("America/New_York")

# Normalized nba_stats status (Task 3) -> the board's 4-bucket status.
_STATUS_MAP = {
    "scheduled": "scheduled",
    "in_progress": "live",
    "final": "final",
    "postponed": "postponed",
}

_SORT_ORDER = {"live": 0, "final": 1, "scheduled": 2, "postponed": 3}


def et_today_bounds(now_utc: datetime) -> tuple[datetime, datetime]:
    """UTC `[start, end)` bounds for "today" in America/New_York, given
    the current UTC instant. NBA scheduling is ET-native — a 10pm ET
    tip-off (7am UTC the next day) must group under the ET day it's
    scheduled in, not whichever UTC day the wall clock lands on.
    """
    now_et = now_utc.astimezone(ET_ZONE)
    start_et = datetime(now_et.year, now_et.month, now_et.day, tzinfo=ET_ZONE)
    end_et = start_et + timedelta(days=1)
    return start_et.astimezone(timezone.utc), end_et.astimezone(timezone.utc)


@runtime_checkable
class BoardReader(Protocol):
    """Injectable read path for `live_game_state`'s "today" slice."""

    def latest_per_source_today(
        self, start_utc: datetime, end_utc: datetime
    ) -> Sequence[LiveGameState]:
        """Latest row per `(game_id, source)` with `pulled_at` in
        `[start_utc, end_utc)`."""
        ...

    def nba_stats_history_today(
        self, game_id: int, start_utc: datetime, end_utc: datetime, limit: int
    ) -> Sequence[LiveGameState]:
        """Up to `limit` `source="nba_stats"` rows for `game_id` in
        `[start_utc, end_utc)`, newest first — backs run detection."""
        ...


class SQLAlchemyBoardReader:
    """Production `BoardReader`, backed by `db.models.LiveGameState`."""

    def __init__(self, engine: Engine | None = None) -> None:
        self._engine = engine or get_engine()
        self._session_factory = sessionmaker(bind=self._engine)

    def latest_per_source_today(
        self, start_utc: datetime, end_utc: datetime
    ) -> list[LiveGameState]:
        with self._session_factory() as session:
            ranked = (
                select(
                    LiveGameState.id,
                    func.row_number()
                    .over(
                        partition_by=(LiveGameState.game_id, LiveGameState.source),
                        order_by=LiveGameState.pulled_at.desc(),
                    )
                    .label("rn"),
                )
                .where(
                    LiveGameState.pulled_at >= start_utc,
                    LiveGameState.pulled_at < end_utc,
                )
                .subquery()
            )
            stmt = (
                select(LiveGameState)
                .join(ranked, LiveGameState.id == ranked.c.id)
                .where(ranked.c.rn == 1)
            )
            return list(session.scalars(stmt).all())

    def nba_stats_history_today(
        self, game_id: int, start_utc: datetime, end_utc: datetime, limit: int
    ) -> list[LiveGameState]:
        with self._session_factory() as session:
            stmt = (
                select(LiveGameState)
                .where(
                    LiveGameState.game_id == game_id,
                    LiveGameState.source == "nba_stats",
                    LiveGameState.pulled_at >= start_utc,
                    LiveGameState.pulled_at < end_utc,
                )
                .order_by(LiveGameState.pulled_at.desc())
                .limit(limit)
            )
            return list(session.scalars(stmt).all())


def get_board_reader() -> BoardReader:
    """FastAPI dependency seam — overridden with a fake in tests."""
    return SQLAlchemyBoardReader()


def _derive_status(nba_stats_latest: LiveGameState | None) -> str:
    if nba_stats_latest is None:
        return "final"
    return _STATUS_MAP.get(nba_stats_latest.status, "scheduled")


def _serialize_live_row(
    game_id: int, nba_stats_latest: LiveGameState, commentary, freshest_pulled_at: datetime
) -> dict:
    status = _derive_status(nba_stats_latest)
    return {
        "game_id": game_id,
        "status": status,
        "home_team": nba_stats_latest.home_team,
        "away_team": nba_stats_latest.away_team,
        "home_score": nba_stats_latest.home_score,
        "away_score": nba_stats_latest.away_score,
        "period": nba_stats_latest.period,
        "clock": nba_stats_latest.clock,
        "scheduled_start": (
            nba_stats_latest.scheduled_start.isoformat()
            if nba_stats_latest.scheduled_start
            else None
        ),
        "source_pulled_at": freshest_pulled_at.isoformat(),
        "commentary": (
            {"text": commentary.text, "kind": commentary.kind} if commentary else None
        )
        if status == "live"
        else None,
    }


def _serialize_fallback_row(game_id: int, fallback: LiveGameState) -> dict:
    """A game with no nba_stats coverage today — a genuine coverage gap
    (§5.1.1), not a stale poll. Renders with whatever a secondary source
    has, no team names/schedule/commentary.
    """
    return {
        "game_id": game_id,
        "status": "live" if fallback.status not in ("Final", "final") else "final",
        "home_team": None,
        "away_team": None,
        "home_score": fallback.home_score,
        "away_score": fallback.away_score,
        "period": fallback.period,
        "clock": fallback.clock,
        "scheduled_start": None,
        "source_pulled_at": fallback.pulled_at.isoformat(),
        "commentary": None,
    }


def _normalize_historical_row(row: dict) -> dict:
    """A Gold `games` row (the fallback for anything not in today's live
    set, §5.1.2) -> the same unified shape the live rows above produce,
    so the frontend renders every row through one component. Always
    `status: "final"` — everything reaching this fallback is, by
    construction, not in today's live/scheduled/postponed set.
    """
    pulled_at = row.get("source_pulled_at")
    return {
        "game_id": row["game_id"],
        "status": "final",
        "home_team": row["home_team"],
        "away_team": row["away_team"],
        "home_score": row["home_score"],
        "away_score": row["away_score"],
        "period": None,
        "clock": None,
        "scheduled_start": None,
        "source_pulled_at": pulled_at.isoformat() if pulled_at is not None else None,
        "commentary": None,
    }


def _board_row_for_group(
    game_id: int,
    sources: dict[str, LiveGameState],
    board_reader: BoardReader,
    quality_reader: QualityReader,
    start_utc: datetime,
    end_utc: datetime,
    now: datetime,
) -> dict:
    """One board row from a game's per-source latest rows this poll —
    shared by `compute_board` (`GET /board/`) and the stream generator
    (Task 10) so the merge/commentary logic is written exactly once.
    """
    nba_stats_latest = sources.get("nba_stats")
    if nba_stats_latest is None:
        fallback = max(sources.values(), key=lambda s: s.pulled_at)
        return _serialize_fallback_row(game_id, fallback)

    commentary = None
    if _derive_status(nba_stats_latest) == "live":
        history = board_reader.nba_stats_history_today(
            game_id, start_utc, end_utc, BOARD_HISTORY_LIMIT
        )
        conflicts = quality_reader.recent_conflicts_for_game(
            str(game_id), CONFLICT_DISPLAY_WINDOW_SECONDS
        )
        other_latest = {s: state for s, state in sources.items() if s != "nba_stats"}
        commentary = compute_commentary(history, other_latest, conflicts, now)

    freshest = max(sources.values(), key=lambda s: s.pulled_at)
    return _serialize_live_row(game_id, nba_stats_latest, commentary, freshest.pulled_at)


def _group_by_game(states: Sequence[LiveGameState]) -> dict[int, dict[str, LiveGameState]]:
    by_game: dict[int, dict[str, LiveGameState]] = defaultdict(dict)
    for state in states:
        by_game[state.game_id][state.source] = state
    return by_game


def _sort_key(row: dict) -> int:
    return _SORT_ORDER.get(row.get("status", "final"), 4)


def compute_board(
    board_reader: BoardReader,
    games_reader: GamesReader,
    quality_reader: QualityReader,
    now: datetime,
) -> list[dict]:
    start_utc, end_utc = et_today_bounds(now)
    today_states = board_reader.latest_per_source_today(start_utc, end_utc)
    by_game = _group_by_game(today_states)

    today_rows = [
        _board_row_for_group(game_id, sources, board_reader, quality_reader, start_utc, end_utc, now)
        for game_id, sources in by_game.items()
    ]
    today_rows.sort(key=_sort_key)

    today_game_ids = set(by_game.keys())
    historical_rows = [
        _normalize_historical_row(row)
        for row in games_reader.list_games(None)
        if row["game_id"] not in today_game_ids
    ]

    return today_rows + historical_rows


@router.get("/")
@limiter.limit(DEFAULT_RATE_LIMIT)
def get_board(
    request: Request,
    board_reader: BoardReader = Depends(get_board_reader),
    games_reader: GamesReader = Depends(get_games_reader),
    quality_reader: QualityReader = Depends(get_quality_reader),
) -> dict:
    """Unified live/scheduled/final-today + historical board.

    Response shape:
        {"data": [<board row>, ...], "count": <int>}

    Each row: `{game_id, status ("scheduled"|"live"|"final"|"postponed"),
    home_team, away_team, home_score, away_score, period, clock,
    scheduled_start, source_pulled_at, commentary ({text, kind} | null)}`.
    `commentary` is only ever non-null for `status: "live"` rows.
    """

    def _compute() -> dict:
        rows = compute_board(board_reader, games_reader, quality_reader, datetime.now(timezone.utc))
        return {"data": rows, "count": len(rows)}

    return cached_json(CACHE_KEY, CACHE_TTL_SECONDS, _compute)
```

- [ ] **Step 4: Run to verify pass**

Run: `cd api && uv run pytest tests/test_board.py -v`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add api/src/api/routers/board.py api/tests/test_board.py
git commit -m "api: add GET /board, the unified live/scheduled/final-today + historical board"
```

---

## Task 10: `GET /board/stream` — the SSE route

**Files:**
- Modify: `api/src/api/routers/board.py`
- Modify: `api/tests/test_board.py`

**Interfaces:**
- Consumes: `_board_row_for_group`, `_group_by_game`, `_sort_key`, `et_today_bounds`, `BoardReader`, `QualityReader` (all from Task 9, same module).
- Produces: `board_stream_generator(...)` (testable core, same shape as `live.py`'s `live_event_generator`) and the `GET /board/stream` route.

- [ ] **Step 1: Write the failing tests**

Add to `api/tests/test_board.py`:

```python
import asyncio
import json

from api.routers.board import board_stream_generator


class FakeDisconnect:
    def __init__(self, values):
        self._values = list(values)
        self.call_count = 0

    async def __call__(self) -> bool:
        value = self._values[self.call_count] if self.call_count < len(self._values) else True
        self.call_count += 1
        return value


class FakeSleep:
    def __init__(self) -> None:
        self.calls = []

    async def __call__(self, seconds: float) -> None:
        self.calls.append(seconds)


def test_board_stream_generator_yields_one_event_per_poll():
    now = datetime(2026, 1, 1, 20, 0, 0, tzinfo=timezone.utc)
    today_states = [_state(1, "nba_stats", 91, 88, "in_progress", now,
                            home_team="Miami Heat", away_team="Boston Celtics")]
    board_reader = FakeBoardReader(today_states=today_states, history_by_game={1: today_states})
    quality_reader = FakeQualityReader()

    async def _run():
        events = []
        async for event in board_stream_generator(
            board_reader=board_reader,
            quality_reader=quality_reader,
            is_disconnected=FakeDisconnect([False, True]),
            sleep=FakeSleep(),
            interval_seconds=0,
            max_duration_seconds=10,
            now_fn=lambda: now,
        ):
            events.append(event)
        return events

    events = asyncio.run(_run())

    assert len(events) == 1
    payload = json.loads(events[0].removeprefix("data: ").strip())
    row = payload["data"][0]
    assert row["game_id"] == 1
    assert row["commentary"]["kind"] == "leader"


def test_board_stream_generator_stops_on_disconnect():
    async def _run():
        events = []
        async for event in board_stream_generator(
            board_reader=FakeBoardReader(),
            quality_reader=FakeQualityReader(),
            is_disconnected=FakeDisconnect([True]),
            sleep=FakeSleep(),
        ):
            events.append(event)
        return events

    assert asyncio.run(_run()) == []


def test_board_stream_requires_api_key():
    resp = client.get("/board/stream")
    assert resp.status_code == 401
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && uv run pytest tests/test_board.py -k stream -v`
Expected: FAIL — `board_stream_generator` and the route don't exist.

- [ ] **Step 3: Implement the generator and route**

In `api/src/api/routers/board.py`, add imports and the generator/route at the bottom:

```python
import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable

from fastapi.responses import StreamingResponse
```

```python
DEFAULT_STREAM_POLL_INTERVAL_SECONDS = 5.0
# Same rationale as the retired `live.py`'s MAX_STREAM_DURATION_SECONDS —
# bounds worst-case per-connection resource usage, not a real game-length
# expectation.
MAX_STREAM_DURATION_SECONDS = 4 * 60 * 60


async def board_stream_generator(
    board_reader: BoardReader,
    quality_reader: QualityReader,
    is_disconnected: Callable[[], Awaitable[bool]],
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    interval_seconds: float = DEFAULT_STREAM_POLL_INTERVAL_SECONDS,
    max_duration_seconds: float = MAX_STREAM_DURATION_SECONDS,
    now_fn: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
) -> AsyncIterator[str]:
    """The testable core of `GET /board/stream`: poll -> merge -> yield ->
    sleep. Emits only *today's* rows (the set that actually changes) —
    historical rows are static and never part of this stream. Mirrors the
    retired `live.py`'s `live_event_generator` shape.
    """
    elapsed = 0.0
    while elapsed < max_duration_seconds:
        if await is_disconnected():
            return
        now = now_fn()
        start_utc, end_utc = et_today_bounds(now)
        today_states = board_reader.latest_per_source_today(start_utc, end_utc)
        by_game = _group_by_game(today_states)
        rows = [
            _board_row_for_group(game_id, sources, board_reader, quality_reader, start_utc, end_utc, now)
            for game_id, sources in by_game.items()
        ]
        rows.sort(key=_sort_key)
        yield f"data: {json.dumps({'data': rows})}\n\n"
        await sleep(interval_seconds)
        elapsed += interval_seconds


def get_stream_interval_seconds() -> float:
    return DEFAULT_STREAM_POLL_INTERVAL_SECONDS


def get_stream_max_duration_seconds() -> float:
    return MAX_STREAM_DURATION_SECONDS


@router.get("/stream")
@limiter.limit(DEFAULT_RATE_LIMIT)
async def stream_board(
    request: Request,
    board_reader: BoardReader = Depends(get_board_reader),
    quality_reader: QualityReader = Depends(get_quality_reader),
    interval_seconds: float = Depends(get_stream_interval_seconds),
    max_duration_seconds: float = Depends(get_stream_max_duration_seconds),
) -> StreamingResponse:
    """SSE stream of today's board rows — replaces `GET /live`."""
    generator = board_stream_generator(
        board_reader=board_reader,
        quality_reader=quality_reader,
        is_disconnected=request.is_disconnected,
        interval_seconds=interval_seconds,
        max_duration_seconds=max_duration_seconds,
    )
    return StreamingResponse(
        generator,
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache"},
    )
```

- [ ] **Step 4: Run to verify pass**

Run: `cd api && uv run pytest tests/test_board.py -v`
Expected: PASS (10 tests total in this file).

- [ ] **Step 5: Commit**

```bash
git add api/src/api/routers/board.py api/tests/test_board.py
git commit -m "api: add GET /board/stream, the SSE route replacing GET /live"
```

---

## Task 11: Register `board.router`; retire `live.py`

**Files:**
- Modify: `api/src/api/main.py`
- Delete: `api/src/api/routers/live.py`
- Delete: `api/tests/test_live.py`

**Interfaces:**
- Produces: `board.router` mounted at `/board`. `live.router`/`GET /live` no longer exist — nothing else in this codebase calls them after Task 13 (the web BFF's `/api/live` route) is deleted, so removing them now is safe dead-code cleanup, not a breaking change to anything still in use.

- [ ] **Step 1: Register the board router, remove the live router**

In `api/src/api/main.py`:

```python
from api.core.config import Settings
from api.core.rate_limit import limiter
from api.routers import board, games, player_stats, quality, query_tools
```

(remove `live` from that import line), and:

```python
app.include_router(games.router)
app.include_router(board.router)
app.include_router(quality.router)
app.include_router(player_stats.router)
app.include_router(query_tools.router)
```

(remove `app.include_router(live.router)`).

- [ ] **Step 2: Delete the retired files**

```bash
git rm api/src/api/routers/live.py api/tests/test_live.py
```

- [ ] **Step 3: Run the full API test suite**

Run: `cd api && uv run pytest -v`
Expected: PASS — no test references `api.routers.live` anymore (it was only imported by its own now-deleted test file).

- [ ] **Step 4: Commit**

```bash
git add api/src/api/main.py
git commit -m "api: register board router, retire the live router (superseded by /board)"
```

---

## Task 12: `web/lib/board.ts` — shared types, status presentation, formatting

**Files:**
- Create: `web/lib/board.ts`
- Delete (in Task 17, not here — still imported by `LiveBoard.tsx` until then): `web/lib/live-status.ts`

**Interfaces:**
- Produces: `BoardStatus`, `BoardCommentary`, `BoardGameRow` (type), `getStatusPresentation(status)`, `formatFreshness(iso)`, `formatScheduledStart(iso)` — consumed by Tasks 14-16.

- [ ] **Step 1: Write the file**

Create `web/lib/board.ts`:

```ts
// Shared types/formatting for the homepage's unified games board
// (`/api/board`) and the per-game live view (`/live/[gameId]`).

export type BoardStatus = "scheduled" | "live" | "final" | "postponed";

export type BoardCommentaryKind = "conflict" | "stale" | "run" | "leader";

export type BoardCommentary = { text: string; kind: BoardCommentaryKind };

export type BoardGameRow = {
  game_id: number;
  status: BoardStatus;
  home_team: string | null;
  away_team: string | null;
  home_score: number | null;
  away_score: number | null;
  period: number | null;
  clock: string | null;
  scheduled_start: string | null;
  source_pulled_at: string | null;
  commentary: BoardCommentary | null;
};

export type StatusPresentation =
  | { kind: "live"; label: string }
  | { kind: "static"; label: string; variant: "secondary" | "outline" | "destructive" };

/** `/board`'s `status` is already normalized server-side
 * (api/src/api/routers/board.py) to exactly these four values -- no
 * fuzzy substring matching against raw per-source status strings needed
 * here, unlike the retired `/live` SSE stream this replaces. */
export function getStatusPresentation(status: BoardStatus): StatusPresentation {
  switch (status) {
    case "live":
      return { kind: "live", label: "LIVE" };
    case "final":
      return { kind: "static", label: "Final", variant: "secondary" };
    case "scheduled":
      return { kind: "static", label: "Sched", variant: "outline" };
    case "postponed":
      return { kind: "static", label: "Postponed", variant: "destructive" };
  }
}

/** "4s ago" / "2m ago" / "3h ago" -- relocated from the original
 * `recent-games-board.tsx`'s `formatFreshness` so `BoardGameRow` and the
 * per-game feed view can share it. */
export function formatFreshness(iso: string | null): string {
  if (iso === null) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** "2026-09-07T00:30:00+00:00" -> "7:30 PM ET" -- rendered client-side in
 * the viewer's own locale time formatting, but explicitly labeled ET (the
 * league's own scheduling zone) rather than silently converting to the
 * viewer's local zone unlabeled. */
export function formatScheduledStart(iso: string | null): string {
  if (iso === null) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  const time = parsed.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
  return `${time} ET`;
}
```

- [ ] **Step 2: Type-check and lint**

Run: `cd web && npx tsc --noEmit`
Expected: no errors (this file has no consumers yet, so nothing else changes).

Run: `cd web && npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/lib/board.ts
git commit -m "web: add shared board types, status presentation, and formatting"
```

---

## Task 13: BFF proxy routes — `/api/board` and `/api/board/stream`

**Files:**
- Create: `web/app/api/board/route.ts`
- Create: `web/app/api/board/stream/route.ts`

**Interfaces:**
- Consumes: FastAPI's `GET /board/` and `GET /board/stream` (Tasks 9-10).
- Produces: `/api/board` (JSON) and `/api/board/stream` (SSE passthrough) — consumed by Tasks 15-16.

- [ ] **Step 1: Write the JSON proxy**

Create `web/app/api/board/route.ts`, mirroring `web/app/api/games/route.ts`'s pattern:

```ts
import { NextResponse } from "next/server";
import { fetchFromApi } from "@/lib/fastapi-client";

export async function GET() {
  try {
    const data = await fetchFromApi("/board");
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ status: "unreachable" }, { status: 502 });
  }
}
```

- [ ] **Step 2: Write the SSE proxy**

Create `web/app/api/board/stream/route.ts`, mirroring the retiring `web/app/api/live/route.ts`'s Vercel-safe SSE passthrough exactly, pointed at the new upstream path:

```ts
// Vercel-safe SSE passthrough for FastAPI's `GET /board/stream`.
//
// Same reasoning as the retired `app/api/live/route.ts` this replaces:
// `fetchFromApi` (lib/fastapi-client.ts) always calls `.json()`, which
// would try to buffer and parse the entire event-stream body as one JSON
// document -- the opposite of what an SSE proxy needs. This route reads
// the same server-only env vars and sends the same `X-API-Key` header, so
// the API key never reaches the browser (docs/prd.md §08).
//
// Required for the streaming pattern below to actually stream (rather
// than buffer) once deployed to Vercel -- see docs/prd.md §04/§13:
export const runtime = "nodejs";

const BASE_URL = process.env.FASTAPI_BASE_URL ?? "http://localhost:8000";
const API_KEY = process.env.API_SERVICE_KEY ?? "";

export async function GET() {
  let upstream: Response;
  try {
    upstream = await fetch(`${BASE_URL}/board/stream`, {
      headers: { "X-API-Key": API_KEY },
    });
  } catch {
    return new Response("Upstream /board/stream fetch failed", { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    return new Response("Upstream /board/stream unavailable", { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
```

- [ ] **Step 3: Type-check and lint**

Run: `cd web && npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 4: Manually verify against a running API**

With `api`'s dev server running (`cd api && uv run uvicorn api.main:app --reload`) and `web`'s dev server running (`cd web && npm run dev`):

Run: `curl -s http://localhost:3000/api/board | head -c 500`
Expected: JSON with a `data` array (empty or populated depending on local DB state) — not a 502.

Run: `curl -s -N http://localhost:3000/api/board/stream | head -5`
Expected: `data: {...}` lines arriving every ~5s, not a 502 or immediate close.

- [ ] **Step 5: Commit**

```bash
git add web/app/api/board/route.ts web/app/api/board/stream/route.ts
git commit -m "web: add BFF proxy routes for /board and /board/stream"
```

---

## Task 14: `BoardGameRow` component

**Files:**
- Create: `web/app/components/board-game-row.tsx`

**Interfaces:**
- Consumes: `BoardGameRow` type, `getStatusPresentation`, `formatFreshness`, `formatScheduledStart` (Task 12); `TeamLogo`, `teamLogoUrlFromName`, `displayScore`, `TEAM_NAME_TO_ABBREVIATION` (existing, `@/lib/box-score`); `FOCUS_RING` (existing).
- Produces: `<BoardGameRow game={...} />` — consumed by Task 15.

Note on layout: the reference mockup is a single-column row list with an inline "View Feed" button per row, not the original board's two-column list-plus-sidebar layout — the sidebar's job (showing one selected game's detail) is now the new `/live/[gameId]` route's job, so it's dropped entirely rather than kept alongside the new route.

- [ ] **Step 1: Write the component**

Create `web/app/components/board-game-row.tsx`:

```tsx
"use client";

import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type BoardGameRow as BoardGameRowData,
  formatFreshness,
  formatScheduledStart,
  getStatusPresentation,
} from "@/lib/board";
import { displayScore, TEAM_NAME_TO_ABBREVIATION, TeamLogo, teamLogoUrlFromName } from "@/lib/box-score";
import { FOCUS_RING } from "@/lib/focus-ring";
import { cn } from "@/lib/utils";

function abbr(teamName: string | null): string {
  if (!teamName) return "—";
  return TEAM_NAME_TO_ABBREVIATION[teamName] ?? teamName;
}

const COMMENTARY_COLOR: Record<string, string> = {
  conflict: "text-pink-600 dark:text-pink-400",
  stale: "text-amber-600 dark:text-amber-500",
  run: "text-amber-600 dark:text-amber-500",
  leader: "text-muted-foreground",
};

function StatusBadge({ status }: { status: BoardGameRowData["status"] }) {
  const presentation = getStatusPresentation(status);
  if (presentation.kind === "live") {
    return (
      <Badge variant="secondary" className="gap-1.5 border-transparent bg-primary text-primary-foreground">
        <span aria-hidden="true" className="relative flex size-1.5">
          <span className="absolute inline-flex size-full rounded-full bg-primary-foreground/70 motion-safe:animate-ping" />
          <span className="relative inline-flex size-1.5 rounded-full bg-primary-foreground" />
        </span>
        {presentation.label}
      </Badge>
    );
  }
  return <Badge variant={presentation.variant}>{presentation.label}</Badge>;
}

export function BoardGameRow({ game }: { game: BoardGameRowData }) {
  const isGreyed = game.status === "final" || game.status === "postponed";
  const showScore = game.status === "live" || game.status === "final";

  return (
    <div
      className={cn(
        "grid grid-cols-[80px_1fr_auto] items-center gap-4 border-b border-border px-4 py-3 last:border-b-0",
        isGreyed && "opacity-60"
      )}
    >
      <div className="flex flex-col gap-1">
        <StatusBadge status={game.status} />
        {game.status === "live" && (
          <span className="font-mono text-xs text-muted-foreground">
            {game.period ? `Q${game.period}` : ""}
            {game.clock ? ` · ${game.clock}` : ""}
          </span>
        )}
        {game.status === "scheduled" && (
          <span className="font-mono text-xs text-muted-foreground">
            {formatScheduledStart(game.scheduled_start)}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <TeamLogo src={teamLogoUrlFromName(game.away_team ?? "")} alt="" />
          <span className="flex-1 truncate font-medium">{abbr(game.away_team)}</span>
          {showScore && (
            <span className="font-mono text-lg font-bold tabular-nums">
              {displayScore(game.away_score)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <TeamLogo src={teamLogoUrlFromName(game.home_team ?? "")} alt="" />
          <span className="flex-1 truncate font-medium">{abbr(game.home_team)}</span>
          {showScore && (
            <span className="font-mono text-lg font-bold tabular-nums">
              {displayScore(game.home_score)}
            </span>
          )}
        </div>
        {game.commentary && (
          <span className={cn("font-mono text-xs", COMMENTARY_COLOR[game.commentary.kind])}>
            {game.commentary.text}
          </span>
        )}
      </div>

      <div className="flex flex-col items-end gap-1.5">
        <Button
          render={<Link href={`/live/${game.game_id}`} />}
          nativeButton={false}
          size="sm"
          variant="ghost"
          className={cn("border border-border bg-transparent hover:bg-muted/60", FOCUS_RING)}
        >
          View Feed
        </Button>
        <span className="font-mono text-xs text-muted-foreground">
          {formatFreshness(game.source_pulled_at)}
        </span>
      </div>
    </div>
  );
}

export default BoardGameRow;
```

- [ ] **Step 2: Type-check and lint**

Run: `cd web && npx tsc --noEmit && npm run lint`
Expected: no errors (unused-component warnings are fine — Task 15 wires it in next).

- [ ] **Step 3: Commit**

```bash
git add web/app/components/board-game-row.tsx
git commit -m "web: add BoardGameRow, the per-status row for the unified board"
```

---

## Task 15: Rewrite `RecentGamesBoard`

**Files:**
- Modify: `web/app/components/recent-games-board.tsx`

**Interfaces:**
- Consumes: `BoardGameRow` component (Task 14), `/api/board` + `/api/board/stream` (Task 13).
- Produces: the homepage's board — no other component depends on this file's internals (only imported and rendered by the homepage page, unchanged call site).

- [ ] **Step 1: Replace the file's contents**

Replace all of `web/app/components/recent-games-board.tsx` with:

```tsx
"use client";

import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { type BoardGameRow as BoardGameRowData } from "@/lib/board";

import { BoardGameRow } from "./board-game-row";

type ApiList<T> = { data: T[]; count: number };

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; games: BoardGameRowData[] };

const FETCH_ERROR = "Couldn't reach the games service.";

/**
 * Homepage "Recent games" board — a unified list of today's
 * scheduled/live/final games plus the historical tail, replacing the
 * former historical-only board and the separate `/live` page it used to
 * take alongside. Initial paint comes from one `GET /api/board` fetch;
 * an SSE subscription to `/api/board/stream` then patches in updates for
 * today's rows only (historical rows never change once loaded).
 */
export function RecentGamesBoard() {
  const [state, setState] = useState<FetchState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    fetch("/api/board")
      .then((res) => res.json())
      .then((data: ApiList<BoardGameRowData> | null) => {
        if (!cancelled) setState({ status: "loaded", games: data?.data ?? [] });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", message: FETCH_ERROR });
      });

    const source = new EventSource("/api/board/stream");
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as ApiList<BoardGameRowData>;
        const updates = new Map(parsed.data.map((g) => [g.game_id, g]));
        setState((prev) => {
          if (prev.status !== "loaded") return prev;
          return {
            status: "loaded",
            games: prev.games.map((g) => updates.get(g.game_id) ?? g),
          };
        });
      } catch {
        // Malformed tick -- keep showing the last good state.
      }
    };

    return () => {
      cancelled = true;
      source.close();
    };
  }, []);

  if (state.status === "loading") {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <Alert variant="destructive">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>Couldn&apos;t load recent games</AlertTitle>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  }

  if (state.games.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-heading text-lg font-bold tracking-wide text-foreground uppercase">
        Recent games
      </h2>
      <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
        {state.games.map((game) => (
          <BoardGameRow key={game.game_id} game={game} />
        ))}
      </div>
    </div>
  );
}

export default RecentGamesBoard;
```

- [ ] **Step 2: Type-check and lint**

Run: `cd web && npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 3: Manually verify in the browser**

With both dev servers running (`api` and `web`), open `http://localhost:3000/` and confirm:
- The board renders without console errors.
- If any live/scheduled test data exists locally, the correct badge/commentary/freshness render per status; otherwise confirm the historical rows still render exactly as before (greyed final games, "View Feed" linking to `/live/<id>`).

- [ ] **Step 4: Commit**

```bash
git add web/app/components/recent-games-board.tsx
git commit -m "web: rewrite RecentGamesBoard around the unified /board data source"
```

---

## Task 16: New route `/live/[gameId]`

**Files:**
- Create: `web/app/live/[gameId]/page.tsx`
- Create: `web/app/live/[gameId]/GameFeed.tsx`
- Modify: `web/app/components/jump-links.tsx`
- Modify: `web/app/components/site-header.tsx`

**Interfaces:**
- Consumes: `/api/board` + `/api/board/stream` (Task 13), `BoardGameRow` type (Task 12).
- Produces: `/live/<gameId>` — every "View Feed" button (Task 14) already links here.

Note on scope: this links to the existing `/games/[id]` box-score page for the settled box score rather than re-embedding `box-score.tsx`'s table inline — a disclosed simplification; the "feed" view's own job is the live ticker and commentary log, which nothing else in this app provides.

- [ ] **Step 1: Make `SiteHeader`'s `current` prop optional**

`/live/[gameId]` has no corresponding nav entry (it's a per-game page, not a landing page), so `JumpLinks`/`SiteHeader` need to render with nothing marked "current."

In `web/app/components/jump-links.tsx`, change the prop type and remove the `/live` entry (the second part of this edit — dropping `/live` from `LINKS` — belongs here rather than Task 17 since this task is what stops `/live` being a landing page in the first place):

```ts
const LINKS = [
  { href: "/", label: "Home" },
  { href: "/quality", label: "Quality" },
  { href: "/explorer", label: "Explorer" },
  { href: "/search", label: "Search" },
  { href: "/settings", label: "Settings" },
] as const;

export type PageHref = (typeof LINKS)[number]["href"];

export function JumpLinks({ current }: { current?: PageHref }) {
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center gap-2 text-sm">
      {LINKS.map(({ href, label }) =>
        href === current ? (
          <span
            key={href}
            aria-current="page"
            className="rounded-md border border-border bg-muted px-3 py-1.5 font-medium text-foreground"
          >
            {label}
          </span>
        ) : (
          <Link
            key={href}
            href={href}
            className={cn(
              "rounded-md border border-transparent px-3 py-1.5 text-muted-foreground transition-colors hover:border-amber-500/40 hover:text-amber-500",
              FOCUS_RING
            )}
          >
            {label}
          </Link>
        )
      )}
    </nav>
  );
}
```

In `web/app/components/site-header.tsx`, update the prop type on `SiteHeader` to match:

```tsx
export function SiteHeader({ current }: { current?: PageHref }) {
```

And update the doc comment listing pages: change `` `/`, `/live`, `/quality`, `/explorer`, `/settings` `` to `` `/`, `/quality`, `/explorer`, `/settings` ``.

- [ ] **Step 2: Write the `GameFeed` client component**

Create `web/app/live/[gameId]/GameFeed.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { type BoardGameRow, formatScheduledStart, getStatusPresentation } from "@/lib/board";
import { displayScore, TEAM_NAME_TO_ABBREVIATION } from "@/lib/box-score";

function abbr(teamName: string | null): string {
  if (!teamName) return "—";
  return TEAM_NAME_TO_ABBREVIATION[teamName] ?? teamName;
}

type ApiList<T> = { data: T[]; count: number };

/**
 * Per-game live view -- the destination every board row's "View Feed"
 * button links to. Live ticker + an in-session commentary log for a live
 * game, a tip-off countdown for a scheduled one, and a link to the
 * existing box-score page for a finished one. The commentary log is
 * deliberately ephemeral (component state only, lost on reload) -- no
 * persisted history table, matching this feature's spec's non-goals.
 */
export function GameFeed({ gameId }: { gameId: string }) {
  const [game, setGame] = useState<BoardGameRow | null>(null);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const numericId = Number(gameId);

    fetch("/api/board")
      .then((res) => res.json())
      .then((data: ApiList<BoardGameRow> | null) => {
        if (cancelled) return;
        const found = data?.data.find((g) => g.game_id === numericId) ?? null;
        setGame(found);
        if (found?.commentary) setLog([found.commentary.text]);
      })
      .catch(() => {
        // Handled by the render-time null-game empty state below.
      });

    const source = new EventSource("/api/board/stream");
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as ApiList<BoardGameRow>;
        const updated = parsed.data.find((g) => g.game_id === numericId);
        if (!updated) return;
        setGame(updated);
        setLog((prev) => {
          if (!updated.commentary) return prev;
          if (prev[prev.length - 1] === updated.commentary.text) return prev;
          return [...prev, updated.commentary.text];
        });
      } catch {
        // Malformed tick -- keep last good state.
      }
    };

    return () => {
      cancelled = true;
      source.close();
    };
  }, [gameId]);

  if (game === null) {
    return <Skeleton className="h-64 w-full" />;
  }

  const presentation = getStatusPresentation(game.status);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Badge variant={presentation.kind === "live" ? "secondary" : presentation.variant}>
          {presentation.label}
        </Badge>
        {game.status === "live" && (
          <span className="font-mono text-sm text-muted-foreground">
            {game.period ? `Q${game.period}` : ""} {game.clock}
          </span>
        )}
        {game.status === "scheduled" && (
          <span className="font-mono text-sm text-muted-foreground">
            Tips off {formatScheduledStart(game.scheduled_start)}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-6 rounded-xl border border-border bg-card p-6">
        <div className="flex flex-col items-center gap-2">
          <span className="text-sm text-muted-foreground">{abbr(game.away_team)}</span>
          <span className="font-mono text-4xl font-bold tabular-nums">
            {displayScore(game.away_score)}
          </span>
        </div>
        <div className="flex flex-col items-center gap-2">
          <span className="text-sm text-muted-foreground">{abbr(game.home_team)}</span>
          <span className="font-mono text-4xl font-bold tabular-nums">
            {displayScore(game.home_score)}
          </span>
        </div>
      </div>

      {log.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Commentary
          </h2>
          <ul className="flex flex-col gap-1.5 font-mono text-sm">
            {log
              .slice()
              .reverse()
              .map((line, i) => (
                <li key={i}>{line}</li>
              ))}
          </ul>
        </div>
      )}

      <Link
        href={`/games/${game.game_id}`}
        className="text-sm text-amber-600 underline dark:text-amber-500"
      >
        View full box score
      </Link>
    </div>
  );
}

export default GameFeed;
```

- [ ] **Step 3: Write the page**

Create `web/app/live/[gameId]/page.tsx`:

```tsx
import { SiteHeader } from "@/app/components/site-header";

import { GameFeed } from "./GameFeed";

export default async function GameFeedPage({
  params,
}: {
  params: Promise<{ gameId: string }>;
}) {
  const { gameId } = await params;
  return (
    <div className="flex flex-1 flex-col">
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
        <SiteHeader />
        <GameFeed gameId={gameId} />
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Type-check and lint**

Run: `cd web && npx tsc --noEmit && npm run lint`
Expected: no errors (both `PageHref`'s narrowed union and `SiteHeader`'s now-optional prop must typecheck against every existing call site — `app/live/page.tsx` still passes `current="/live"` at this point, which is still in `PageHref`'s type until Task 17 removes that page; if `tsc` complains about `"/live"` no longer being a valid `PageHref`, that confirms Task 17's deletion needs to happen essentially atomically with this — do Task 17's Step 1 deletion of `app/live/page.tsx` before running this check if so).

- [ ] **Step 5: Manually verify in the browser**

With a live/scheduled game id from local test data (or any historical `game_id` for the finished-game path), visit `http://localhost:3000/live/<id>` and confirm the ticker/countdown/box-score-link renders per status with no console errors, and that clicking "View Feed" from the homepage board lands here correctly.

- [ ] **Step 6: Commit**

```bash
git add web/app/live/[gameId] web/app/components/jump-links.tsx web/app/components/site-header.tsx
git commit -m "web: add /live/[gameId], the per-game live feed view"
```

---

## Task 17: Retire the old `/live` page; final regression pass

**Files:**
- Delete: `web/app/live/page.tsx`
- Delete: `web/app/live/LiveBoard.tsx`
- Delete: `web/app/api/live/route.ts`
- Delete: `web/lib/live-status.ts`

**Interfaces:** none — this is pure removal of now-superseded code.

- [ ] **Step 1: Delete the retired files**

```bash
git rm web/app/live/page.tsx web/app/live/LiveBoard.tsx web/app/api/live/route.ts web/lib/live-status.ts
```

- [ ] **Step 2: Type-check and lint the whole project**

Run: `cd web && npx tsc --noEmit`
Expected: no errors — confirms nothing still imports `live-status.ts` or references the deleted page/component/route.

Run: `cd web && npm run lint`
Expected: no errors.

- [ ] **Step 3: Full manual regression pass**

With `api` (`uv run uvicorn api.main:app --reload`) and `web` (`npm run dev`) both running:

- `http://localhost:3000/` — the homepage board renders; confirm each of the four row states you can produce with local data (at minimum: historical final rows, since that's guaranteed to have data; live/scheduled/postponed depend on whatever `live_game_flow` has actually written locally).
- Click "View Feed" on a final row -> lands on `/live/<id>` and shows the settled score + a working link to `/games/<id>`.
- `http://localhost:3000/live` (the old URL) -> 404, confirming the old page is really gone.
- Every other page's nav (`JumpLinks`) no longer shows a "Live" entry, and none of them error on render.
- Kill the `api` process while `web`'s homepage is open -> confirm the board shows its error/reconnect state rather than crashing the page.

- [ ] **Step 4: Commit**

```bash
git commit -m "web: retire the standalone /live page, superseded by the unified board"
```

---

## Task 18: Restore the "Feed ticket" sidebar alongside the row list

**Added post-hoc**, after user review of the completed board: the pre-redesign board had a two-column layout (row list + a "Feed ticket" detail sidebar for the selected game), and Task 15's rewrite dropped the sidebar entirely in favor of routing "View Feed" to the new `/live/[gameId]` page. The user wants the sidebar back **alongside** that page, not instead of it: clicking a row selects it and shows a quick-glance detail panel in the sidebar (mirroring the row's live/scheduled/final/postponed status); the "View Feed" button remains a separate, distinct action navigating to the full `/live/[gameId]` page.

**Files:**
- Create: `web/app/components/feed-ticket.tsx`
- Modify: `web/app/components/board-game-row.tsx`
- Modify: `web/app/components/recent-games-board.tsx`

**Interfaces:**
- Consumes: `BoardGameRow` type, `getStatusPresentation`, `formatFreshness`, `formatScheduledStart` (all from `web/lib/board.ts`, unchanged).
- Produces: `<FeedTicket game={...} />` (new); `BoardGameRow`'s props gain optional `isSelected?: boolean` and `onSelect?: (gameId: number) => void` (additive, backward compatible — omitting them keeps today's non-selectable behavior).

Scoping note: the original sidebar's "Season" field is dropped — `BoardGameRow` (the API's unified row shape, Task 9) has no `season`/`game_date` field for live/today rows (nba_stats's scoreboard doesn't carry it), and adding it would mean touching three already-reviewed, completed tasks' code (Task 3's extraction, Task 9's three serializers, Task 12's type) for a field only the historical/final path could ever populate. "Source" stays a fixed descriptive string ("balldontlie · nba_stats"), matching the ORIGINAL sidebar's behavior exactly — that field was already hardcoded, not derived from a real per-row value, even before Task 15's rewrite.

- [ ] **Step 1: Update `BoardGameRow` to support selection**

In `web/app/components/board-game-row.tsx`, change the exported component's signature and root element:

```tsx
export function BoardGameRow({
  game,
  isSelected,
  onSelect,
}: {
  game: BoardGameRowData;
  isSelected?: boolean;
  onSelect?: (gameId: number) => void;
}) {
  const isGreyed = game.status === "final" || game.status === "postponed";
  const showScore = game.status === "live" || game.status === "final";

  return (
    <div
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={onSelect ? () => onSelect(game.game_id) : undefined}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(game.game_id);
              }
            }
          : undefined
      }
      className={cn(
        "grid grid-cols-[80px_1fr_auto] items-center gap-4 border-b border-border px-4 py-3 last:border-b-0",
        isGreyed && "opacity-60",
        onSelect && "cursor-pointer",
        onSelect && FOCUS_RING,
        isSelected && "border-l-2 border-l-amber-600 bg-muted/60 dark:border-l-amber-500"
      )}
    >
```

(everything inside the returned JSX below the opening `<div>` stays exactly as it is today — status/team/commentary blocks unchanged.) Wrap the "View Feed" button's container `div` with `onClick={(e) => e.stopPropagation()}` so clicking it navigates without also toggling row selection:

```tsx
      <div
        className="flex flex-col items-end gap-1.5"
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          render={<Link href={`/live/${game.game_id}`} />}
          nativeButton={false}
          size="sm"
          variant="ghost"
          aria-label={`View feed for ${abbr(game.away_team)} at ${abbr(game.home_team)}`}
          className={cn("border border-border bg-transparent hover:bg-muted/60", FOCUS_RING)}
        >
          View Feed
        </Button>
        <span className="font-mono text-xs text-muted-foreground">
          {formatFreshness(game.source_pulled_at)}
        </span>
      </div>
```

Using a `role="button"` `div` rather than a native `<button>` for the row is deliberate: the row must contain the "View Feed" `Button`/`Link`, and nesting interactive elements (`<button>` inside `<button>`, or `<a>` inside `<button>`) is invalid HTML — the established pattern from the pre-redesign board (which used a real `<button>` row with only a plain text hint, no nested interactive element) doesn't carry forward once the row needs a genuine nested link. `tabIndex`/`onKeyDown` (Enter/Space) keep it keyboard-operable, matching this codebase's `FOCUS_RING` convention for visible focus.

- [ ] **Step 2: Create `FeedTicket`**

Create `web/app/components/feed-ticket.tsx`:

```tsx
"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  type BoardGameRow,
  formatFreshness,
  formatScheduledStart,
  getStatusPresentation,
} from "@/lib/board";
import { displayScore, TEAM_NAME_TO_ABBREVIATION } from "@/lib/box-score";
import { cn } from "@/lib/utils";

function abbr(teamName: string | null): string {
  if (!teamName) return "—";
  return TEAM_NAME_TO_ABBREVIATION[teamName] ?? teamName;
}

/** "HH:MM:SS UTC" render of the exact pull timestamp -- only the sidebar
 * shows this alongside the row list's relative "Ns ago" freshness,
 * matching the pre-redesign board's "Last Pulled" field. */
function formatExactPulledAt(iso: string | null): string {
  if (iso === null) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  return `${parsed.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
  })} UTC`;
}

const COMMENTARY_COLOR: Record<string, string> = {
  conflict: "text-pink-600 dark:text-pink-400",
  stale: "text-amber-600 dark:text-amber-500",
  run: "text-amber-600 dark:text-amber-500",
  leader: "text-muted-foreground",
};

/**
 * The board's "Feed ticket" detail panel -- the currently-selected row's
 * quick-glance detail, restoring the pre-redesign board's sidebar
 * alongside the unified row list (Task 15 had dropped it; re-added at
 * user request). Content varies by status: live shows running
 * score/period/clock/commentary, scheduled shows tip-off time,
 * final/postponed show the settled state. "Box score"/"View Feed"
 * always links to `/live/<id>` -- the fuller live ticker + commentary
 * log view -- so this panel stays a quick glance and that page stays
 * the deep dive.
 */
export function FeedTicket({ game }: { game: BoardGameRow }) {
  const presentation = getStatusPresentation(game.status);

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="relative flex items-start justify-between gap-2 border-b border-dashed border-border px-4 py-3">
        <div>
          <h3 className="font-mono text-base font-semibold tracking-wide text-foreground uppercase">
            {abbr(game.away_team)} · {abbr(game.home_team)}
          </h3>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground uppercase">
            Feed ticket · Game #{game.game_id}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-md px-2 py-0.5 font-mono text-xs font-semibold tracking-wide uppercase",
            presentation.kind === "live"
              ? "bg-primary/15 text-primary"
              : "bg-amber-600/15 text-amber-600 dark:text-amber-500"
          )}
        >
          {presentation.label}
        </span>
        <div
          aria-hidden="true"
          className="absolute -bottom-2.5 -left-2.5 size-5 rounded-full bg-background"
        />
        <div
          aria-hidden="true"
          className="absolute -right-2.5 -bottom-2.5 size-5 rounded-full bg-background"
        />
      </div>

      <dl className="flex flex-col gap-3 px-4 py-3 font-mono text-sm">
        <div className="flex items-center justify-between gap-2">
          <dt className="tracking-wide text-muted-foreground uppercase">Status</dt>
          <dd className="text-foreground">{presentation.label}</dd>
        </div>

        {game.status === "live" && (
          <div className="flex items-center justify-between gap-2">
            <dt className="tracking-wide text-muted-foreground uppercase">Period / Clock</dt>
            <dd className="text-foreground">
              {game.period ? `Q${game.period}` : "—"}
              {game.clock ? ` · ${game.clock}` : ""}
            </dd>
          </div>
        )}

        {game.status === "scheduled" && (
          <div className="flex items-center justify-between gap-2">
            <dt className="tracking-wide text-muted-foreground uppercase">Tips Off</dt>
            <dd className="text-foreground">{formatScheduledStart(game.scheduled_start)}</dd>
          </div>
        )}

        {(game.status === "live" || game.status === "final") && (
          <div className="flex items-center justify-between gap-2">
            <dt className="tracking-wide text-muted-foreground uppercase">Score</dt>
            <dd className="text-amber-600 dark:text-amber-500">
              {abbr(game.away_team)} {displayScore(game.away_score)} —{" "}
              {abbr(game.home_team)} {displayScore(game.home_score)}
            </dd>
          </div>
        )}

        {game.status === "live" && game.commentary && (
          <div className="flex items-center justify-between gap-2">
            <dt className="tracking-wide text-muted-foreground uppercase">Commentary</dt>
            <dd className={cn("text-right", COMMENTARY_COLOR[game.commentary.kind])}>
              {game.commentary.text}
            </dd>
          </div>
        )}

        {/* Fixed descriptive string, not a per-row field -- the API
            doesn't return a "source" value on a board row. Matches the
            pre-redesign sidebar's identical hardcoded behavior. */}
        <div className="flex items-center justify-between gap-2">
          <dt className="tracking-wide text-muted-foreground uppercase">Source</dt>
          <dd className="text-foreground">balldontlie · nba_stats</dd>
        </div>

        <div className="flex items-center justify-between gap-2">
          <dt className="tracking-wide text-muted-foreground uppercase">Last Pulled</dt>
          <dd className="text-foreground">{formatExactPulledAt(game.source_pulled_at)}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="tracking-wide text-muted-foreground uppercase">Freshness</dt>
          <dd className="text-foreground">{formatFreshness(game.source_pulled_at)}</dd>
        </div>
      </dl>

      <div className="relative flex items-center border-t border-dashed border-border px-4 py-5">
        <Button
          render={<Link href={`/live/${game.game_id}`} />}
          nativeButton={false}
          size="sm"
          variant="ghost"
          className="w-full cursor-pointer border border-border bg-transparent hover:bg-muted/60"
        >
          {game.status === "final" ? "Box score" : "View Feed"}
        </Button>
        <div
          aria-hidden="true"
          className="absolute -top-2.5 -left-2.5 size-5 rounded-full bg-background"
        />
        <div
          aria-hidden="true"
          className="absolute -top-2.5 -right-2.5 size-5 rounded-full bg-background"
        />
      </div>
    </div>
  );
}

export default FeedTicket;
```

- [ ] **Step 3: Wire selection + the sidebar into `RecentGamesBoard`**

Replace `web/app/components/recent-games-board.tsx`'s render section (state/effects stay exactly as Task 15 left them) with a two-column layout:

```tsx
import { BoardGameRow } from "./board-game-row";
import { FeedTicket } from "./feed-ticket";
```

Add `selectedId` state alongside the existing `state`:

```tsx
const [selectedId, setSelectedId] = useState<number | null>(null);
```

In the initial-fetch `.then(...)`, after `setState({ status: "loaded", games })`, default-select the first row once games arrive (deferred one tick so it doesn't fight the same-render `setState`):

```tsx
if (games.length > 0) {
  Promise.resolve().then(() => {
    if (!cancelled) setSelectedId((prev) => prev ?? games[0].game_id);
  });
}
```

Replace the final render block (from `if (state.games.length === 0)` onward) with:

```tsx
  if (state.games.length === 0) {
    return null;
  }

  const selected = state.games.find((g) => g.game_id === selectedId) ?? state.games[0];

  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-heading text-lg font-bold tracking-wide text-foreground uppercase">
        Recent games
      </h2>
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
          {state.games.map((game) => (
            <BoardGameRow
              key={game.game_id}
              game={game}
              isSelected={game.game_id === selected.game_id}
              onSelect={setSelectedId}
            />
          ))}
        </div>
        <FeedTicket game={selected} />
      </div>
    </div>
  );
}

export default RecentGamesBoard;
```

- [ ] **Step 4: Type-check, lint, and manually verify**

Run: `cd web && npx tsc --noEmit` — expect only the known pre-existing `app/layout.tsx(171,50)` `LayoutProps` error, nothing new.

Run: `cd web && npm run lint` — expect clean.

With `api` and `web` dev servers running (bring up `make up` infra if needed), open the homepage and confirm: clicking any row selects it (left-border highlight) and updates the sidebar; the sidebar's content changes appropriately for whatever statuses exist in local data (at minimum final/historical rows, which should have real data); clicking "View Feed" navigates to `/live/<id>` without also just re-selecting the row; keyboard navigation (Tab to a row, Enter/Space) also selects it.

- [ ] **Step 5: Commit**

```bash
git add web/app/components/board-game-row.tsx web/app/components/feed-ticket.tsx web/app/components/recent-games-board.tsx
git commit -m "web: restore the Feed ticket sidebar alongside the unified row list"
```

---

## Self-Review

**Spec coverage:**
- §4.1 nba_stats source, naming deviation, dependency: Tasks 2, 6 (pyproject).
- §4.2 schema columns: Task 1.
- §4.3 3-way reconciliation (refined to score-only, per Task 5's rationale): Task 5.
- §5.1 `/board`/`/board/stream`, ET-day bounds, canonical nba_stats display, postponed bucket, query-cost/index: Tasks 1 (index), 9, 10.
- §5.2 per-game conflict lookup: Task 7.
- §6 commentary engine, priority, run detection, constants: Task 8.
- §7.1-7.2 data fetching + row rendering: Tasks 13, 14, 15.
- §7.3 new `/live/[gameId]` route: Task 16.
- §7.4 nav cleanup: Tasks 16 (prop change), 17 (deletion).
- §8 testing conventions (fakes, offline migrations, no web test runner): reflected throughout every task's verification steps.
- §9 rollout order: Tasks are ordered db -> ingestion -> api -> web, each independently shippable, matching the spec exactly.
- §10 open risks: nba_stats payload-shape risk is restated in `nba_live.py`'s docstring (Task 2) and `extract_nba_stats_live_states`'s docstring (Task 3); run-detection-is-an-approximation risk is restated in `board_commentary.py` (Task 8); the entity-resolution gap the spec didn't anticipate is fully addressed by Task 4, beyond the spec's original text (flagged and approved before this plan was written).

**Placeholder scan:** no `TBD`/`TODO` in any task; every code block is complete, runnable code, not a description of code.

**Type consistency check:** `LiveGameState.home_team`/`away_team`/`scheduled_start` (Task 1) match the fields `extract_nba_stats_live_states` populates (Task 3), which match what `board.py`'s `_serialize_live_row` reads (Task 9), which match `web/lib/board.ts`'s `BoardGameRow` type (Task 12), which match every consumer in Tasks 14-16. `Commentary.kind`'s four literal values (Task 8) match `BoardCommentaryKind` (Task 12) and `COMMENTARY_COLOR`'s keys (Task 14). `board_stream_generator`'s signature (Task 10) matches its test calls (same task). `reconcile_live_states`'s three-list signature (Task 5) matches its call site in `live_game_flow` (Task 6).

**Scope check:** single cohesive feature area across four services, ordered so each task leaves the repo in a working, tested state — appropriately sized for one plan, not a bundle of unrelated projects.

