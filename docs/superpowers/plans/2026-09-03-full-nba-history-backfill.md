# Full NBA History Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (This project has also previously used a boss/employee real-GitHub-PR workflow for rounds of this shape — either mechanism can execute the Employee tasks below.)

**Goal:** Extend the historical NBA box-score backfill from a 3-day pilot to every game across the 1996-97–2025-26 seasons, sourced entirely from `nba_api`, with `nba_api` as an independent `games` source rather than matched onto balldontlie's.

**Architecture:** `NBAStatsClient` gains a season-scoped `get_games_for_season` method (2 real calls per season: Regular Season + Playoffs) replacing per-day discovery. `backfill_nba_stats_flow` is rewritten to take `start_season`/`end_season`, write both `game` and `boxscore_traditional` Bronze rows per game with no cross-source matching, and keep its existing per-date checkpoint/resume/failure-handling shape. A new `stg_games_nba.sql` staging model and a `UNION ALL` in the `games` mart make nba_api a second, independent games source, mirroring `player_game_stats.sql`'s existing two-source pattern.

**Tech Stack:** Python 3.13, Prefect 3, `nba_api`, SQLAlchemy, dbt-core (Postgres), pytest.

**Spec:** `docs/superpowers/specs/2026-09-03-full-nba-history-backfill-design.md`

## Global Constraints

- Season range: 1996 through 2025 inclusive (balldontlie-style season-year integers; `1996` = "1996-97", `2025` = "2025-26" — the last fully completed season as of 2026-09-03). No pre-1996-97 seasons (real historical data gaps, out of scope).
- `nba_api` is the sole source for both games and box scores in this backfill. No balldontlie dependency, no team-name-overlap matching — `ExistingGamesReader` and `quality.reconciliation.match_games_by_team_overlap` usage are removed entirely from `backfill_nba_stats_flow.py`.
- `NBA_GAME_ID_OFFSET = 100_000_000_000` (100 billion) — the corrected, checked constant (not the 1-trillion value in the spec's first draft, which would overflow `stg_player_game_stats_nba.sql`'s `stat_id = game_id * 10,000,000 + player_id` composite past Postgres `bigint`'s ~9.22×10^18 ceiling). 100 billion keeps `stat_id`'s realistic maximum (~1.0×10^18) comfortably inside that ceiling (~9x headroom) while staying ~96,000x above balldontlie's current native `games.id` (~1,038,000).
- `start_season`/`end_season` are always-required flow parameters — no auto-resume across season boundaries. A human invokes one season (or a deliberately chosen small range) per sitting; the existing per-date checkpoint protects against redoing work within that invocation if it's interrupted and re-run with the same season range.
- Pacing: `REQUEST_PACING_SECONDS = 0.6` sleep after every real `stats.nba.com` call, including both season-level discovery calls per season (unchanged constant, now also covering the new discovery method).
- Failure handling: any exception while processing a date must not advance the checkpoint past that date, and must propagate with a message naming the failing date and NBA.com game id (unchanged behavior/contract from the existing flow).
- `dbt parse --no-partial-parse` / `dbt compile --no-populate-cache` are necessary but **not sufficient** verification — per project memory ([[dbt-offline-verification-blind-spot]]), a real `dbt run` against a real Postgres with real data is required before this is considered done, not just clean parse/compile output.
- No backfill of balldontlie's own historical `games` list, no cross-source `game_id`/`player_id` reconciliation — both explicitly deferred, not attempted in this plan.

---

## Employee 1: `nba-stats-season-client-and-flow`

**Files:**
- Modify: `ingestion/src/ingestion/sources/nba_stats.py`
- Modify: `ingestion/src/ingestion/flows/backfill_nba_stats_flow.py`
- Modify: `ingestion/pyproject.toml`
- Test: `ingestion/tests/test_nba_stats.py`
- Test: `ingestion/tests/test_backfill_nba_stats_flow.py`

**Interfaces:**
- Produces: `nba_stats.NBA_GAME_ID_OFFSET: int`, `nba_stats.offset_game_id(nba_game_id: str) -> int`, `NBAStatsClient.get_games_for_season(self, season: str) -> list[dict]` returning one dict per game shaped `{"game_id": int, "nba_game_id": str, "game_date": str, "season": int, "postseason": bool, "status": str, "home_team": str, "home_score": int, "away_team": str, "away_score": int}`. `NBAStatsClient.get_boxscore` is unchanged (still takes the raw `nba_game_id` string, returns player-stat dicts with `player_key`).
- Produces: `backfill_nba_stats_flow(start_season: int, end_season: int, sink=None, checkpoint_store=None, client=None) -> dict` returning `{"seasons_processed": int, "dates_processed": int, "games_written": int, "raw_pulls_written": int}`.
- Consumes: `nba_api.stats.endpoints.leaguegamefinder.LeagueGameFinder`, `nba_api.stats.endpoints.boxscoretraditionalv2.BoxScoreTraditionalV2` (unchanged), `ingestion.flows.backfill_flow.{RawPullSink, CheckpointStore, SQLAlchemyRawPullSink, SQLAlchemyCheckpointStore}` (unchanged, reused as before), `db.models.RawPull`.
- Removes: `NBAStatsClient.get_games_for_date` (no longer used anywhere), `ExistingGamesReader` Protocol, `SQLAlchemyExistingGamesReader` class, `_log_unmatched_nba_games` helper, the `quality.reconciliation` import, and the `quality` dependency from `ingestion/pyproject.toml` (verified via grep during design: nothing else in `ingestion` imports from `quality`).

### Step 1: Rewrite `nba_stats.py`'s game-discovery method

Replace the existing `get_games_for_date` method and add the offset function. The class docstring, `REQUEST_PACING_SECONDS`, and `get_boxscore` stay exactly as they are today — only `get_games_for_date` is removed and replaced.

Remove this method entirely from `NBAStatsClient`:

```python
    def get_games_for_date(self, date_str: str) -> list[dict]:
        """Return one dict per NBA.com game played on `date_str`.
        ...
        """
        finder = leaguegamefinder.LeagueGameFinder(
            date_from_nullable=date_str, date_to_nullable=date_str
        )
        time.sleep(REQUEST_PACING_SECONDS)

        rows = finder.get_normalized_dict()["LeagueGameFinderResults"]

        games_by_id: dict[str, set[str]] = {}
        for row in rows:
            games_by_id.setdefault(row["GAME_ID"], set()).add(row["TEAM_NAME"])

        return [
            {"game_id": game_id, "team_names": team_names}
            for game_id, team_names in games_by_id.items()
        ]
```

Add this module-level constant and function above the `NBAStatsClient` class definition:

```python
# Offsets nba_api's own GAME_ID so it can never collide with balldontlie's
# native sequential games.id (currently ~1,038,000 and growing). 100 billion
# is ~96,000x balldontlie's current id -- far more headroom than that
# sequence will plausibly reach -- while keeping stg_player_game_stats_nba
# .sql's `stat_id = game_id * 10,000,000 + player_id` composite comfortably
# inside Postgres bigint's ~9.22x10^18 ceiling (worked realistic max
# ~1.0x10^18, ~9x headroom). A larger, seemingly "safer" offset (e.g. 1
# trillion) was considered and rejected during design: it overflows that
# multiplication by several orders of magnitude.
NBA_GAME_ID_OFFSET = 100_000_000_000


def offset_game_id(nba_game_id: str) -> int:
    """Namespace nba_api's own GAME_ID into a range disjoint from
    balldontlie's native game_id space -- see NBA_GAME_ID_OFFSET above."""
    return NBA_GAME_ID_OFFSET + int(nba_game_id)
```

Add this method to `NBAStatsClient`, in place of the removed `get_games_for_date`:

```python
    def get_games_for_season(self, season: str) -> list[dict]:
        """Return one dict per NBA.com game played in `season` (e.g.
        "1996-97"), covering both regular-season and playoff games.

        All-Star and Pre Season games are excluded by construction -- only
        `season_type_nullable="Regular Season"` and `"Playoffs"` are ever
        queried, never a name-based post-filter.

        `LeagueGameFinder` returns one row per *team* per game (two rows
        per game). This groups those by GAME_ID, and for each pair uses
        the `MATCHUP` field ("CHI vs. UTA" means the row's team is home;
        "CHI @ UTA" means it's away) to determine home/away and takes each
        row's own `PTS` as that side's score. Every returned game's
        `game_id` is already offset via `offset_game_id` -- callers never
        apply the offset themselves. `nba_game_id` (the raw, un-offset
        string) is included too, since `get_boxscore` needs the raw id.
        """
        games_by_id: dict[str, dict] = {}

        for season_type, postseason in (
            ("Regular Season", False),
            ("Playoffs", True),
        ):
            finder = leaguegamefinder.LeagueGameFinder(
                season_nullable=season,
                league_id_nullable="00",
                season_type_nullable=season_type,
            )
            time.sleep(REQUEST_PACING_SECONDS)

            for row in finder.get_normalized_dict()["LeagueGameFinderResults"]:
                game = games_by_id.setdefault(
                    row["GAME_ID"],
                    {
                        "game_id": offset_game_id(row["GAME_ID"]),
                        "nba_game_id": row["GAME_ID"],
                        "game_date": row["GAME_DATE"],
                        "season": int(season[:4]),
                        "postseason": postseason,
                        "status": "Final",
                    },
                )
                if "vs." in row["MATCHUP"]:
                    game["home_team"] = row["TEAM_NAME"]
                    game["home_score"] = row["PTS"]
                else:
                    game["away_team"] = row["TEAM_NAME"]
                    game["away_score"] = row["PTS"]

        return list(games_by_id.values())
```

Also update the module docstring's "Real payload shapes" section: after the existing `LeagueGameFinder` bullet, add a note that `get_games_for_season` queries by `season_nullable`/`season_type_nullable` rather than by date, confirmed against a real call during design (1996-97: 1,189 regular-season + 72 playoff games; 2024-25: 1,230 + 84 — both counts matching real historical records), and that this replaces the old per-date discovery method entirely (no flow uses date-based discovery anymore).

### Step 2: Update `test_nba_stats.py` for `get_games_for_season`

Remove the three `get_games_for_date`-specific tests (`test_get_games_for_date_groups_two_team_rows_into_one_game`, `test_get_games_for_date_handles_multiple_games_same_date`, `test_get_games_for_date_sleeps_for_pacing`). Keep the two `get_boxscore` tests unchanged. Add these in their place:

```python
def test_offset_game_id_adds_the_namespace_constant():
    assert offset_game_id("0022300500") == 100_022_300_500
    assert offset_game_id("0029600001") == 100_029_600_001


def test_get_games_for_season_derives_home_away_from_matchup():
    """LeagueGameFinder returns one row per team per game; get_games_for_season
    must group by GAME_ID and use MATCHUP ('vs.' vs '@') to pick home/away,
    and must offset game_id via offset_game_id."""
    regular_season_rows = [
        {
            "GAME_ID": "0022300500",
            "TEAM_NAME": "Atlanta Hawks",
            "GAME_DATE": "2024-01-01",
            "MATCHUP": "ATL vs. BOS",
            "PTS": 110,
        },
        {
            "GAME_ID": "0022300500",
            "TEAM_NAME": "Boston Celtics",
            "GAME_DATE": "2024-01-01",
            "MATCHUP": "BOS @ ATL",
            "PTS": 105,
        },
    ]

    with (
        patch(
            "nba_api.stats.endpoints.leaguegamefinder.LeagueGameFinder",
            side_effect=[_finder_result(regular_season_rows), _finder_result([])],
        ) as mock_finder,
        patch("ingestion.sources.nba_stats.time.sleep") as mock_sleep,
    ):
        client = NBAStatsClient()
        games = client.get_games_for_season("2023-24")

    assert mock_finder.call_args_list[0].kwargs == {
        "season_nullable": "2023-24",
        "league_id_nullable": "00",
        "season_type_nullable": "Regular Season",
    }
    assert mock_finder.call_args_list[1].kwargs == {
        "season_nullable": "2023-24",
        "league_id_nullable": "00",
        "season_type_nullable": "Playoffs",
    }
    assert mock_sleep.call_count == 2
    assert games == [
        {
            "game_id": 100_022_300_500,
            "nba_game_id": "0022300500",
            "game_date": "2024-01-01",
            "season": 2023,
            "postseason": False,
            "status": "Final",
            "home_team": "Atlanta Hawks",
            "home_score": 110,
            "away_team": "Boston Celtics",
            "away_score": 105,
        }
    ]


def test_get_games_for_season_tags_playoffs_as_postseason():
    playoff_rows = [
        {
            "GAME_ID": "0049600001",
            "TEAM_NAME": "Chicago Bulls",
            "GAME_DATE": "1997-06-13",
            "MATCHUP": "CHI vs. UTA",
            "PTS": 90,
        },
        {
            "GAME_ID": "0049600001",
            "TEAM_NAME": "Utah Jazz",
            "GAME_DATE": "1997-06-13",
            "MATCHUP": "UTA @ CHI",
            "PTS": 86,
        },
    ]

    with (
        patch(
            "nba_api.stats.endpoints.leaguegamefinder.LeagueGameFinder",
            side_effect=[_finder_result([]), _finder_result(playoff_rows)],
        ),
        patch("ingestion.sources.nba_stats.time.sleep"),
    ):
        client = NBAStatsClient()
        games = client.get_games_for_season("1996-97")

    assert len(games) == 1
    assert games[0]["postseason"] is True
    assert games[0]["game_id"] == 100_049_600_001
    assert games[0]["season"] == 1996


def test_get_games_for_season_handles_multiple_games():
    regular_season_rows = [
        {"GAME_ID": "A", "TEAM_NAME": "Dallas Mavericks", "GAME_DATE": "1996-11-01", "MATCHUP": "DAL vs. UTA", "PTS": 100},
        {"GAME_ID": "A", "TEAM_NAME": "Utah Jazz", "GAME_DATE": "1996-11-01", "MATCHUP": "UTA @ DAL", "PTS": 95},
        {"GAME_ID": "B", "TEAM_NAME": "Miami Heat", "GAME_DATE": "1996-11-02", "MATCHUP": "MIA vs. ORL", "PTS": 88},
        {"GAME_ID": "B", "TEAM_NAME": "Orlando Magic", "GAME_DATE": "1996-11-02", "MATCHUP": "ORL @ MIA", "PTS": 80},
    ]

    with (
        patch(
            "nba_api.stats.endpoints.leaguegamefinder.LeagueGameFinder",
            side_effect=[_finder_result(regular_season_rows), _finder_result([])],
        ),
        patch("ingestion.sources.nba_stats.time.sleep"),
    ):
        client = NBAStatsClient()
        games = client.get_games_for_season("1996-97")

    games_by_nba_id = {g["nba_game_id"]: g for g in games}
    assert games_by_nba_id["A"]["home_team"] == "Dallas Mavericks"
    assert games_by_nba_id["A"]["away_team"] == "Utah Jazz"
    assert games_by_nba_id["B"]["home_team"] == "Miami Heat"
    assert games_by_nba_id["B"]["away_team"] == "Orlando Magic"
```

Add the needed import at the top of the test file: `from ingestion.sources.nba_stats import NBAStatsClient, offset_game_id`.

Run: `cd ingestion && PYTHONPATH=src:../db/src uv run pytest tests/test_nba_stats.py -v`
Expected: all tests pass (the 4 new ones, plus the 2 unchanged `get_boxscore` tests).

### Step 3: Rewrite `backfill_nba_stats_flow.py`

Replace the module docstring's "Run order" section (it describes reading balldontlie's Gold `games` table, which no longer happens) with:

```python
"""Historical NBA.com (`stats.nba.com`) games + box-score backfill, local-only.

**Deliberate, named ToS trade-off.** `nba_api` (and every tool like it)
works around `stats.nba.com`'s Akamai bot protection by sending browser-
style headers from a plain HTTP client. Doing that -- even from a real
residential IP, with no attempt to defeat CAPTCHAs or evade a block once
one happens -- is very likely a violation of NBA.com's Terms of Service.
For this portfolio project, that's judged an acceptable, common, low-stakes
choice (same category of trade-off as this project's other named decisions,
e.g. not paying for balldontlie's ALL-STAR tier) -- but it is recorded here
explicitly, not left as a hidden footnote, and this flow must never be run
anywhere except a human's own machine:

- **Never scheduled, never deployed, never CI.** This module defines a
  plain `@flow`-decorated function meant to be invoked ad hoc from a local
  shell, the same way one would run a script.
- `stats.nba.com` is known to block datacenter/cloud IPs outright, so a
  scheduled/CI run would fail immediately even if someone tried.

**`nba_api` is this flow's sole source, for both games and box scores.**
An earlier version of this flow matched NBA.com's games onto balldontlie's
Gold `games` table by team-name overlap. That was replaced (see
docs/superpowers/specs/2026-09-03-full-nba-history-backfill-design.md) after
finding real problems extending it to the full season range: several
franchises renamed across 1996-2025 (e.g. Vancouver->Memphis Grizzlies,
Seattle SuperSonics->OKC Thunder) and nba_api preserves the period-accurate
historical name while balldontlie normalizes to the current one, breaking
exact-name-overlap matching for historical games between two renamed
franchises. `nba_api`'s own `game_id` (offset via
`ingestion.sources.nba_stats.offset_game_id` so it can't collide with
balldontlie's native game_id space) is now the sole identity for every game
this flow writes -- no matching, no Gold-table read.

**Human-driven, season-by-season invocation.** `start_season`/`end_season`
are always required -- there is no auto-resume across season boundaries.
A full historical run (1996-97 through 2025-26, ~34,500 games) is on the
order of 12.5 hours of real `stats.nba.com` calls at the observed ~1.2-1.5s/
game -- meant to be run in deliberately chosen chunks across many sittings,
not unattended in one pass. The existing per-date checkpoint still protects
a single invocation against a mid-season crash: re-running the same
`start_season`/`end_season` resumes from the last fully-completed date.

**Deliberately deferred, not omitted:** cross-source reconciliation of
nba_api's and balldontlie's independent `games`/`game_id` records (now that
both are real, non-empty sources) is real, separate work for later --
`games_nba`'s rows are never merged with balldontlie's. Wiring
`source="nba_stats"` rows into `quality/`'s reconciliation or volumetric
checks is also out of scope here, unchanged from before.

**Player identity gap (schema-level fix only, unchanged from before).**
`nba_api`'s `PLAYER_ID` and balldontlie's `player_id` are different id
spaces with no shared key. `NBAStatsClient.get_boxscore` computes
`player_key` (via `ingestion.normalization.normalize_player_key`) on every
player row, and this flow writes that key straight into the Bronze payload
unmodified.
"""
```

Replace the imports block (remove `MetaData, Table, select` from sqlalchemy, remove `Engine`, remove `timedelta`/`timezone`, remove the `quality.reconciliation` import):

```python
from __future__ import annotations

from datetime import date
from typing import Protocol, runtime_checkable

from prefect import flow, get_run_logger
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from db.models import RawPull
from ingestion.config import Settings
from ingestion.flows.backfill_flow import (
    CheckpointStore,
    RawPullSink,
    SQLAlchemyCheckpointStore,
    SQLAlchemyRawPullSink,
)
from ingestion.sources.nba_stats import NBAStatsClient

CHECKPOINT_FLOW_NAME = "backfill_nba_stats"


@runtime_checkable
class NBAGameSource(Protocol):
    """Injectable NBA.com source -- matches `NBAStatsClient`'s shape."""

    def get_games_for_season(self, season: str) -> list[dict]: ...

    def get_boxscore(self, nba_game_id: str) -> list[dict]: ...
```

Remove entirely: the `ExistingGamesReader` Protocol, the `SQLAlchemyExistingGamesReader` class, and the `_log_unmatched_nba_games` function.

Replace the `backfill_nba_stats_flow` function body with:

```python
@flow(name="backfill-nba-stats-flow")
def backfill_nba_stats_flow(
    start_season: int,
    end_season: int,
    sink: RawPullSink | None = None,
    checkpoint_store: CheckpointStore | None = None,
    client: NBAGameSource | None = None,
) -> dict:
    """Historical NBA.com games + player box-score backfill, season-scoped.

    `start_season`/`end_season` are balldontlie-style season-year integers
    (1996 means "1996-97") and are always required: a human invokes this
    one season (or a deliberately chosen small range) at a time (see module
    docstring).

    Per season in `[start_season, end_season]`, one `client.get_games_for_season`
    call (2 real requests: Regular Season + Playoffs) returns every game's
    full metadata. Games from every requested season are grouped by date;
    the checkpoint row for `flow_name="backfill_nba_stats"` is consulted to
    skip any date already fully processed by an earlier, interrupted run of
    this same invocation.

    Per date (ascending): write one `RawPull(source="nba_stats",
    endpoint="game", ...)` per game, then fetch
    (`client.get_boxscore(nba_game_id)`) and write one
    `RawPull(source="nba_stats", endpoint="boxscore_traditional", ...)` per
    game. The checkpoint advances to that date only once every game on it
    is fully written.

    **Failure handling:** if any call within a date's processing raises
    (the realistic failure mode is a mid-run block: 403/CAPTCHA/connection
    reset from stats.nba.com's bot protection), the checkpoint is not
    advanced past the last fully-completed date, and the exception
    propagates naming the failing date and NBA.com game id -- re-running
    the same `start_season`/`end_season` resumes cleanly.
    """
    logger = get_run_logger()

    session_factory: sessionmaker[Session] | None = None
    if sink is None or checkpoint_store is None:
        session_factory = sessionmaker(bind=create_engine(Settings().runtime_database_url))
    sink = sink or SQLAlchemyRawPullSink(session_factory)  # type: ignore[arg-type]
    checkpoint_store = checkpoint_store or SQLAlchemyCheckpointStore(session_factory)  # type: ignore[arg-type]
    client = client or NBAStatsClient()

    games_by_date: dict[date, list[dict]] = {}
    for season in range(start_season, end_season + 1):
        season_str = f"{season}-{str(season + 1)[-2:]}"
        for game in client.get_games_for_season(season_str):
            game_date = date.fromisoformat(game["game_date"])
            games_by_date.setdefault(game_date, []).append(game)

    last_checkpoint = checkpoint_store.get_last_pulled_date(CHECKPOINT_FLOW_NAME)

    dates_processed = 0
    games_written = 0
    raw_pulls_written = 0

    for game_date in sorted(games_by_date):
        if last_checkpoint is not None and game_date <= last_checkpoint:
            continue

        date_str = game_date.isoformat()
        for game in games_by_date[game_date]:
            nba_game_id = game["nba_game_id"]

            sink.write(
                RawPull(
                    source="nba_stats",
                    endpoint="game",
                    payload={
                        "game_id": game["game_id"],
                        "game_date": game["game_date"],
                        "season": game["season"],
                        "postseason": game["postseason"],
                        "status": game["status"],
                        "home_team": game["home_team"],
                        "away_team": game["away_team"],
                        "home_score": game["home_score"],
                        "away_score": game["away_score"],
                    },
                )
            )
            raw_pulls_written += 1

            try:
                player_stats = client.get_boxscore(nba_game_id)
            except Exception as exc:
                raise RuntimeError(
                    "backfill_nba_stats_flow: failed fetching NBA.com box "
                    f"score for game {nba_game_id!r} on {date_str} -- "
                    f"checkpoint not advanced past {date_str}; re-run to "
                    "resume from this date"
                ) from exc

            sink.write(
                RawPull(
                    source="nba_stats",
                    endpoint="boxscore_traditional",
                    payload={
                        "game_id": game["game_id"],
                        "player_stats": player_stats,
                    },
                )
            )
            raw_pulls_written += 1
            games_written += 1

        checkpoint_store.advance(CHECKPOINT_FLOW_NAME, game_date)
        dates_processed += 1
        logger.info(
            "backfill_nba_stats_flow: processed %s (%d game(s), %d raw_pulls row(s) written)",
            date_str,
            len(games_by_date[game_date]),
            len(games_by_date[game_date]) * 2,
        )

    return {
        "seasons_processed": end_season - start_season + 1,
        "dates_processed": dates_processed,
        "games_written": games_written,
        "raw_pulls_written": raw_pulls_written,
    }
```

### Step 4: Rewrite `test_backfill_nba_stats_flow.py`

Replace `FakeExistingGamesReader` and `FakeNBAGameSource` with:

```python
class FakeNBAGameSource:
    """In-memory NBAGameSource -- no network, no nba_api."""

    def __init__(
        self,
        games_by_season: dict[str, list[dict]],
        boxscores_by_game_id: dict[str, list[dict]] | None = None,
        raise_for_game_id: str | None = None,
    ) -> None:
        self._games_by_season = games_by_season
        self._boxscores_by_game_id = boxscores_by_game_id or {}
        self._raise_for_game_id = raise_for_game_id
        self.requested_seasons: list[str] = []
        self.requested_boxscore_ids: list[str] = []

    def get_games_for_season(self, season: str) -> list[dict]:
        self.requested_seasons.append(season)
        return self._games_by_season.get(season, [])

    def get_boxscore(self, nba_game_id: str) -> list[dict]:
        self.requested_boxscore_ids.append(nba_game_id)
        if nba_game_id == self._raise_for_game_id:
            raise RuntimeError("simulated 403 from stats.nba.com")
        return self._boxscores_by_game_id.get(nba_game_id, [])
```

Keep `FakeSink` and `FakeCheckpointStore` unchanged. Replace every test function with:

```python
def test_backfill_nba_stats_flow_writes_game_and_boxscore_and_advances_checkpoint():
    sink = FakeSink()
    checkpoint_store = FakeCheckpointStore()
    client = FakeNBAGameSource(
        games_by_season={
            "1996-97": [
                {
                    "game_id": 100_029_600_001,
                    "nba_game_id": "0029600001",
                    "game_date": "1996-11-01",
                    "season": 1996,
                    "postseason": False,
                    "status": "Final",
                    "home_team": "Boston Celtics",
                    "home_score": 107,
                    "away_team": "Chicago Bulls",
                    "away_score": 98,
                }
            ]
        },
        boxscores_by_game_id={
            "0029600001": [
                {"PLAYER_NAME": "Michael Jordan", "PTS": 30, "player_key": "michael jordan"}
            ]
        },
    )

    result = backfill_nba_stats_flow(
        start_season=1996,
        end_season=1996,
        sink=sink,
        checkpoint_store=checkpoint_store,
        client=client,
    )

    assert result == {
        "seasons_processed": 1,
        "dates_processed": 1,
        "games_written": 1,
        "raw_pulls_written": 2,
    }
    assert client.requested_seasons == ["1996-97"]
    assert client.requested_boxscore_ids == ["0029600001"]

    assert len(sink.written) == 2
    game_pull, boxscore_pull = sink.written
    assert game_pull.source == "nba_stats"
    assert game_pull.endpoint == "game"
    assert game_pull.payload == {
        "game_id": 100_029_600_001,
        "game_date": "1996-11-01",
        "season": 1996,
        "postseason": False,
        "status": "Final",
        "home_team": "Boston Celtics",
        "away_team": "Chicago Bulls",
        "home_score": 107,
        "away_score": 98,
    }
    assert boxscore_pull.source == "nba_stats"
    assert boxscore_pull.endpoint == "boxscore_traditional"
    assert boxscore_pull.payload == {
        "game_id": 100_029_600_001,
        "player_stats": [
            {"PLAYER_NAME": "Michael Jordan", "PTS": 30, "player_key": "michael jordan"}
        ],
    }
    assert checkpoint_store.get_last_pulled_date(CHECKPOINT_FLOW_NAME) == date(1996, 11, 1)


def test_backfill_nba_stats_flow_does_not_advance_checkpoint_on_mid_date_failure():
    """A box-score fetch that raises mid-date (simulating a 403/CAPTCHA
    block) must propagate, naming the failing game, and must NOT advance
    the checkpoint past the last fully-completed date."""
    sink = FakeSink()
    checkpoint_store = FakeCheckpointStore(initial=date(1996, 10, 31))
    client = FakeNBAGameSource(
        games_by_season={
            "1996-97": [
                {
                    "game_id": 1, "nba_game_id": "G1", "game_date": "1996-11-01",
                    "season": 1996, "postseason": False, "status": "Final",
                    "home_team": "A", "home_score": 100, "away_team": "B", "away_score": 90,
                },
                {
                    "game_id": 2, "nba_game_id": "G2", "game_date": "1996-11-01",
                    "season": 1996, "postseason": False, "status": "Final",
                    "home_team": "C", "home_score": 95, "away_team": "D", "away_score": 88,
                },
            ]
        },
        boxscores_by_game_id={"G1": [{"PLAYER_NAME": "X"}]},
        raise_for_game_id="G2",
    )

    with pytest.raises(RuntimeError, match="G2"):
        backfill_nba_stats_flow(
            start_season=1996,
            end_season=1996,
            sink=sink,
            checkpoint_store=checkpoint_store,
            client=client,
        )

    assert checkpoint_store.get_last_pulled_date(CHECKPOINT_FLOW_NAME) == date(1996, 10, 31)
    # G1's game+boxscore rows, and G2's game row (written before its
    # boxscore call raised), are already in sink -- that's fine, raw_pulls
    # is append-only; what matters is the checkpoint doesn't move.
    assert len(sink.written) == 3


def test_backfill_nba_stats_flow_skips_dates_already_covered_by_checkpoint():
    sink = FakeSink()
    checkpoint_store = FakeCheckpointStore(initial=date(1996, 11, 1))
    client = FakeNBAGameSource(
        games_by_season={
            "1996-97": [
                {
                    "game_id": 1, "nba_game_id": "G1", "game_date": "1996-11-01",
                    "season": 1996, "postseason": False, "status": "Final",
                    "home_team": "A", "home_score": 100, "away_team": "B", "away_score": 90,
                },
                {
                    "game_id": 2, "nba_game_id": "G2", "game_date": "1996-11-02",
                    "season": 1996, "postseason": False, "status": "Final",
                    "home_team": "C", "home_score": 95, "away_team": "D", "away_score": 88,
                },
            ]
        },
        boxscores_by_game_id={"G2": [{"PLAYER_NAME": "Y"}]},
    )

    result = backfill_nba_stats_flow(
        start_season=1996,
        end_season=1996,
        sink=sink,
        checkpoint_store=checkpoint_store,
        client=client,
    )

    assert result["dates_processed"] == 1
    assert client.requested_boxscore_ids == ["G2"]
    assert checkpoint_store.get_last_pulled_date(CHECKPOINT_FLOW_NAME) == date(1996, 11, 2)


def test_backfill_nba_stats_flow_requests_every_season_in_range():
    sink = FakeSink()
    checkpoint_store = FakeCheckpointStore()
    client = FakeNBAGameSource(games_by_season={})

    backfill_nba_stats_flow(
        start_season=1996,
        end_season=1998,
        sink=sink,
        checkpoint_store=checkpoint_store,
        client=client,
    )

    assert client.requested_seasons == ["1996-97", "1997-98", "1998-99"]


def test_backfill_nba_stats_flow_uses_independent_checkpoint_from_other_backfills():
    sink = FakeSink()
    checkpoint_store = FakeCheckpointStore()
    checkpoint_store.advance("backfill_flow", date(2024, 5, 5))
    checkpoint_store.advance("backfill_stats", date(2024, 6, 6))
    client = FakeNBAGameSource(games_by_season={"1996-97": []})

    backfill_nba_stats_flow(
        start_season=1996,
        end_season=1996,
        sink=sink,
        checkpoint_store=checkpoint_store,
        client=client,
    )

    assert checkpoint_store.get_last_pulled_date("backfill_flow") == date(2024, 5, 5)
    assert checkpoint_store.get_last_pulled_date("backfill_stats") == date(2024, 6, 6)
    assert checkpoint_store.get_last_pulled_date(CHECKPOINT_FLOW_NAME) is None
```

Run: `cd ingestion && PYTHONPATH=src:../db/src uv run pytest tests/test_backfill_nba_stats_flow.py -v`
Expected: all 5 tests pass.

### Step 5: Remove the `quality` dependency

In `ingestion/pyproject.toml`, remove `"quality",` from `dependencies` and remove the `quality = { path = "../quality", editable = true }` line from `[tool.uv.sources]`.

Run: `cd ingestion && uv sync && PYTHONPATH=src:../db/src uv run pytest -v`
Expected: the full `ingestion` test suite passes with no import errors (confirms nothing else depended on `quality`).

### Step 6: Commit

```bash
git add ingestion/src/ingestion/sources/nba_stats.py \
        ingestion/src/ingestion/flows/backfill_nba_stats_flow.py \
        ingestion/pyproject.toml ingestion/uv.lock \
        ingestion/tests/test_nba_stats.py \
        ingestion/tests/test_backfill_nba_stats_flow.py
git commit -m "feat: make nba_api an independent, season-scoped games+stats source"
```

---

## Employee 2: `dbt-nba-games-independent-source`

**Depends on Employee 1's merged output** (real payload shapes: `game_id`/`game_date`/`season`/`postseason`/`status`/`home_team`/`away_team`/`home_score`/`away_score` for the `game` endpoint payload; `game_id` replacing `balldontlie_game_id` for the `boxscore_traditional` endpoint payload).

**Files:**
- Create: `dbt/models/staging/stg_games_nba.sql`
- Create: `dbt/models/staging/stg_games_nba.yml`
- Modify: `dbt/models/marts/games.sql`
- Modify: `dbt/models/marts/games.yml`
- Modify: `dbt/models/staging/stg_player_game_stats_nba.sql`
- Modify: `dbt/models/staging/stg_player_game_stats_nba.yml`
- Modify: `dbt/models/marts/player_game_stats.yml`

**Interfaces:**
- Consumes: `raw_pulls` rows with `source='nba_stats', endpoint='game'` (new) and `source='nba_stats', endpoint='boxscore_traditional'` with payload key `game_id` instead of `balldontlie_game_id` (changed) — both from Employee 1.
- Produces: `stg_games_nba` with the exact same column shape as `stg_games` (`game_id, game_date, season, status, postseason, home_team, away_team, home_score, away_score, pulled_at`), consumed by the modified `games.sql` mart.

### Step 1: Create `stg_games_nba.sql`

```sql
-- Silver staging model: parses nba_api's (stats.nba.com) games payload out
-- of the Bronze `raw_pulls` table for source='nba_stats', endpoint='game'
-- (docs/prd.md §04, §06), and de-duplicates to the most-recently-pulled
-- version of each game_id -- same pattern as stg_games.sql (the
-- balldontlie sibling).
--
-- nba_api is an INDEPENDENT games source, not matched onto balldontlie's
-- game_id space -- see docs/superpowers/specs/2026-09-03-full-nba-history-
-- backfill-design.md for why (renamed-franchise team-name-matching risk,
-- balldontlie's 5 req/min rate limit). `game_id` here is nba_api's own
-- GAME_ID, offset by `ingestion.sources.nba_stats.NBA_GAME_ID_OFFSET`
-- (100 billion) at ingestion time so it can never collide with
-- balldontlie's native sequential games.id -- see that module's
-- `offset_game_id` for the full guarantee.
--
-- Payload shape (source='nba_stats', endpoint='game'), written by
-- backfill_nba_stats_flow.py -- one row per game, not a paginated "data"
-- array like balldontlie's shape, so no jsonb_array_elements needed:
-- {
--   "game_id": 100022300500,
--   "game_date": "2024-01-01",
--   "season": 2023,
--   "postseason": false,
--   "status": "Final",
--   "home_team": "Atlanta Hawks",
--   "away_team": "Boston Celtics",
--   "home_score": 121,
--   "away_score": 105
-- }

with raw_game_pulls as (

    select
        payload,
        pulled_at
    from {{ source('raw', 'raw_pulls') }}
    where source = 'nba_stats'
      and endpoint = 'game'

),

typed as (

    select
        (payload ->> 'game_id')::bigint as game_id,
        (payload ->> 'game_date')::date as game_date,
        (payload ->> 'season')::int as season,
        payload ->> 'status' as status,
        (payload ->> 'postseason')::boolean as postseason,
        payload ->> 'home_team' as home_team,
        payload ->> 'away_team' as away_team,
        (payload ->> 'home_score')::int as home_score,
        (payload ->> 'away_score')::int as away_score,
        pulled_at
    from raw_game_pulls

),

deduped as (

    select
        *,
        row_number() over (
            partition by game_id
            order by pulled_at desc
        ) as rn
    from typed

)

select
    game_id,
    game_date,
    season,
    status,
    postseason,
    home_team,
    away_team,
    home_score,
    away_score,
    pulled_at
from deduped
where rn = 1
```

### Step 2: Create `stg_games_nba.yml`

```yaml
version: 2

models:
  - name: stg_games_nba
    description: >
      Silver staging model. One row per NBA game, parsed and typed out of
      the Bronze `raw_pulls.payload` JSONB for source='nba_stats',
      endpoint='game' -- nba_api's (stats.nba.com) local-only historical
      backfill, written by `backfill_nba_stats_flow.py`. Independent games
      source from `stg_games` (balldontlie) -- not matched/translated onto
      balldontlie's game_id space; see
      docs/superpowers/specs/2026-09-03-full-nba-history-backfill-design.md
      for why. De-duplicates to the most-recently-pulled row per `game_id`,
      same pattern as `stg_games`.
    columns:
      - name: game_id
        description: >
          nba_api's own GAME_ID, offset by
          `ingestion.sources.nba_stats.NBA_GAME_ID_OFFSET` (100 billion) at
          ingestion time so it can never collide with balldontlie's native
          sequential `games.id` (currently ~1,038,000). Natural key of this
          model.
        data_tests:
          - not_null
          - unique
      - name: game_date
        description: Calendar date of the game (nba_api's GAME_DATE, already a plain date string).
        data_tests:
          - not_null
      - name: season
        description: Season year (e.g. 1996 for the 1996-97 season) -- same convention as stg_games.season.
      - name: status
        description: Always "Final" -- this source only ever backfills already-completed historical games.
      - name: postseason
        description: >
          Whether the game is a postseason (playoff) game -- set by the
          ingestion flow based on which `season_type_nullable` query
          ("Regular Season" vs "Playoffs") produced the row, not derived
          here.
      - name: home_team
        description: >
          Full name of the home team, from nba_api's TEAM_NAME
          (period-accurate historical name, e.g. "Seattle SuperSonics" for
          pre-2008 games -- not normalized to the current franchise name).
        data_tests:
          - not_null
      - name: away_team
        description: Full name of the visiting team, same TEAM_NAME source as home_team.
        data_tests:
          - not_null
      - name: home_score
        description: Home team's final score.
      - name: away_score
        description: Visiting team's final score.
      - name: pulled_at
        description: `pulled_at` timestamp of the most recent `raw_pulls` row for this `game_id`.

unit_tests:
  - name: test_stg_games_nba_dedupes_to_latest_pull
    description: >
      Proves the de-dup logic keeps only the most-recently-pulled version
      of a given game_id, matching stg_games's existing pattern.
    model: stg_games_nba
    given:
      - input: source('raw', 'raw_pulls')
        rows:
          - id: 1
            source: nba_stats
            endpoint: game
            pulled_at: "2026-09-01 00:00:00"
            payload:
              game_id: 100029600001
              game_date: "1996-11-01"
              season: 1996
              postseason: false
              status: "Final"
              home_team: "Boston Celtics"
              away_team: "Chicago Bulls"
              home_score: 100
              away_score: 90
          - id: 2
            source: nba_stats
            endpoint: game
            pulled_at: "2026-09-02 00:00:00"
            payload:
              game_id: 100029600001
              game_date: "1996-11-01"
              season: 1996
              postseason: false
              status: "Final"
              home_team: "Boston Celtics"
              away_team: "Chicago Bulls"
              home_score: 107
              away_score: 98
    expect:
      rows:
        - game_id: 100029600001
          home_score: 107
          away_score: 98
```

### Step 3: Modify `games.sql`

Replace the entire file with:

```sql
-- Gold `games` table (docs/prd.md §06): 1 row per game, reconciled final
-- scores/status/schedule, read by the API and (later) the prediction model.
--
-- UNION ALL of two independent Bronze sources -- balldontlie
-- (`stg_games`) and nba_api's local-only historical backfill
-- (`stg_games_nba`), same pattern as `player_game_stats.sql`. No
-- cross-source dedup/priority logic: the two sources' game_id spaces never
-- overlap by construction (`stg_games_nba`'s game_id is offset -- see that
-- model's header), so this is a straight union, not a merge. Further
-- cross-source reconciliation (matching the same real game across both
-- sources) remains deferred, same posture as player_game_stats.sql's
-- player_key gap -- see docs/superpowers/specs/2026-09-03-full-nba-history-
-- backfill-design.md.

select
    game_id,
    game_date,
    season,
    status,
    postseason,
    home_team,
    away_team,
    home_score,
    away_score,
    pulled_at as source_pulled_at
from {{ ref('stg_games') }}

union all

select
    game_id,
    game_date,
    season,
    status,
    postseason,
    home_team,
    away_team,
    home_score,
    away_score,
    pulled_at as source_pulled_at
from {{ ref('stg_games_nba') }}
```

### Step 4: Modify `games.yml`

Change only the top-level `description` field (leave the `config`/`columns`/`data_tests` blocks exactly as they are — the existing `not_null`/`unique` tests on `game_id` now empirically validate no collision across the union):

```yaml
    description: >
      Gold `games` table (docs/prd.md §06). One row per NBA game: reconciled
      final scores, status, and schedule. UNION ALL of two independent
      Bronze sources -- balldontlie (`stg_games`) and nba_api's local-only
      historical backfill (`stg_games_nba`) -- see games.sql's header for
      why this is a union, not a merge. Cross-source reconciliation across
      the two remains deferred, same posture as
      player_game_stats.player_key.
```

### Step 5: Modify `stg_player_game_stats_nba.sql`

Change the `raw_stat_pulls` CTE's `game_id` extraction from:

```sql
        (payload ->> 'balldontlie_game_id')::bigint as game_id,
```

to:

```sql
        (payload ->> 'game_id')::bigint as game_id,
```

Update the header comment paragraph that currently reads:

```
-- Source: Employee 1's merged `backfill_nba_stats_flow`
-- (`ingestion/src/ingestion/flows/backfill_nba_stats_flow.py`) /
-- `NBAStatsClient.get_boxscore` (`ingestion/src/ingestion/sources/
-- nba_stats.py`), read directly on this branch to confirm the shape below
-- (not re-derived from the boss's plan text alone). NBA.com and
-- balldontlie use different game-ID spaces; the flow already resolves
-- this at ingestion time by matching NBA.com's games onto balldontlie's
-- Gold `games` table by team-name overlap, so this model does zero
-- cross-source matching -- `balldontlie_game_id` is a direct, already-
-- resolved passthrough.
```

to:

```
-- Source: `backfill_nba_stats_flow.py` /
-- `NBAStatsClient.get_boxscore` (`ingestion/src/ingestion/sources/
-- nba_stats.py`). nba_api is an INDEPENDENT games source (see
-- stg_games_nba.sql's header) -- `game_id` here is nba_api's own GAME_ID,
-- offset by `NBA_GAME_ID_OFFSET` (100 billion) at ingestion time, passed
-- through this model unmodified. It is the SAME offset value used for the
-- matching `game` payload written for the same real game (see
-- backfill_nba_stats_flow.py), so this table's game_id joins cleanly
-- against stg_games_nba's.
```

Update the payload-shape comment's example (`"balldontlie_game_id": 15908,` becomes `"game_id": 100022300500,`) and the sentence "`balldontlie_game_id` is a *sibling* key at the payload root" to "`game_id` is a *sibling* key at the payload root".

Update decision-log item (1)'s justification text — it currently reads:

```
--    Conclusion: a synthetic, deterministic, per-row-unique key is safe --
--    and since nothing joins on it, it can stay a plain bigint rather than
--    a text key: `game_id * 10,000,000 + PLAYER_ID`. Unique per (game,
--    player) as long as PLAYER_ID stays under 10 million (true across
--    NBA.com's entire player-ID history to date) and stable across
--    re-pulls (de-dup by pull recency still works). This keeps `api`'s and
--    `web`'s existing `stat_id: number`/bigint assumptions valid with zero
--    changes there, avoiding the type-unification `UNION ALL` would
--    otherwise force in `player_game_stats.sql` if this were text.
```

to:

```
--    Conclusion: a synthetic, deterministic, per-row-unique key is safe --
--    and since nothing joins on it, it can stay a plain bigint rather than
--    a text key: `game_id * 10,000,000 + PLAYER_ID`. Unique per (game,
--    player) as long as PLAYER_ID stays under 10 million (true across
--    NBA.com's entire player-ID history to date) and stable across
--    re-pulls (de-dup by pull recency still works). Checked against
--    overflow: game_id here is nba_api's raw GAME_ID plus
--    NBA_GAME_ID_OFFSET (100 billion, see nba_stats.py) -- realistic max
--    ~100,060,000,000 -- so stat_id's realistic max is ~1.0x10^18,
--    comfortably inside Postgres bigint's ~9.22x10^18 ceiling (~9x
--    headroom). A naively larger offset (e.g. 1 trillion) was considered
--    and rejected: it overflows this multiplication by several orders of
--    magnitude. This keeps `api`'s and `web`'s existing `stat_id:
--    number`/bigint assumptions valid with zero changes there, avoiding
--    the type-unification `UNION ALL` would otherwise force in
--    `player_game_stats.sql` if this were text.
```

Also fix the inline comment right above the `stat_id` computation, which currently reads:

```sql
        -- Synthetic per-row key -- see header decision log (1). Safe
        -- because nothing in the codebase joins on stat_id (grep
        -- findings also in the header). Kept as a real bigint (not text)
        -- by encoding player_id into game_id's low 7 digits --
        -- balldontlie game_id is currently ~7 digits and NBA.com
        -- PLAYER_ID has never exceeded 7 digits across the league's
        -- history -- so this stays unique per (game, player), stable
        -- across re-pulls, and requires zero changes to api/'s or web/'s
        -- existing `stat_id: number`/bigint assumptions, unlike a text key.
```

to:

```sql
        -- Synthetic per-row key -- see header decision log (1). Safe
        -- because nothing in the codebase joins on stat_id (grep
        -- findings also in the header). Kept as a real bigint (not text),
        -- and checked against Postgres bigint overflow at this source's
        -- real game_id scale (~100,060,000,000 max, from
        -- NBA_GAME_ID_OFFSET) -- see header decision log (1) for the
        -- worked numbers.
```

### Step 6: Modify `stg_player_game_stats_nba.yml`

Update the `game_id` column's description from:

```yaml
      - name: game_id
        description: >
          FK to the game this stat line belongs to. A direct passthrough
          of the payload's `balldontlie_game_id` -- Employee 1's flow
          already matched NBA.com's game onto balldontlie's Gold `games`
          table by team-name overlap at ingestion time, so no matching
          logic belongs here.
        data_tests:
          - not_null
```

to:

```yaml
      - name: game_id
        description: >
          FK to the game this stat line belongs to -- nba_api's own
          GAME_ID, offset by NBA_GAME_ID_OFFSET (100 billion) at ingestion
          time. A direct passthrough of the payload's `game_id`; the same
          offset value is used for the matching row in `stg_games_nba`, so
          this joins cleanly against it.
        data_tests:
          - not_null
```

Update the `stat_id` column's description from:

```yaml
      - name: stat_id
        description: >
          Synthetic per-row key: `game_id * 10,000,000 + PLAYER_ID`.
          nba_api's PlayerStats rows have no standalone primary key the
          way balldontlie's `data[].id` is a real id from their API.
          Confirmed via grep (see model header) that nothing in the
          codebase (`api/`, `web/`) joins on `stat_id` -- it's only ever
          used as a display/ordering/dedup key -- so a synthetic,
          deterministic, per-(game,player)-unique bigint is safe here.
          Kept numeric (not a text key) specifically so it matches
          balldontlie's bigint `stat_id` with no `UNION ALL` type
          reconciliation needed in `player_game_stats.sql`, and so `api/`'s
          and `web/`'s existing `stat_id: number` assumptions stay valid.
```

to:

```yaml
      - name: stat_id
        description: >
          Synthetic per-row key: `game_id * 10,000,000 + PLAYER_ID`.
          nba_api's PlayerStats rows have no standalone primary key the
          way balldontlie's `data[].id` is a real id from their API.
          Confirmed via grep (see model header) that nothing in the
          codebase (`api/`, `web/`) joins on `stat_id`. Checked against
          Postgres bigint overflow given this source's real game_id scale
          (offset by NBA_GAME_ID_OFFSET, ~100,060,000,000 max) -- realistic
          stat_id max is ~1.0x10^18, ~9x inside bigint's ~9.22x10^18
          ceiling. Kept numeric (not a text key) specifically so it matches
          balldontlie's bigint `stat_id` with no `UNION ALL` type
          reconciliation needed in `player_game_stats.sql`, and so `api/`'s
          and `web/`'s existing `stat_id: number` assumptions stay valid.
```

In the existing `test_stg_player_game_stats_nba_suffix_name_split` unit test, change every fixture row's `balldontlie_game_id:` key to `game_id:` (values 111/222/333 stay the same — this test exercises the name-split SQL logic in isolation and doesn't need realistic-scale numbers). The `expect.rows` block is unchanged.

Add a second unit test after it, in the same `unit_tests:` list:

```yaml
  - name: test_stg_player_game_stats_nba_stat_id_fits_bigint_at_realistic_scale
    description: >
      Regression test for a real bug found while planning the full-history
      backfill: game_id values for nba_stats rows are offset by
      NBA_GAME_ID_OFFSET (100 billion, see ingestion/src/ingestion/sources/
      nba_stats.py) to avoid colliding with balldontlie's native game_id
      space. stat_id = game_id * 10,000,000 + player_id must not overflow
      Postgres bigint (~9.22x10^18) at that realistic scale -- an earlier
      design draft's 1-trillion offset would have overflowed by several
      orders of magnitude. This uses a real, realistic-scale offset
      game_id (100022300500, corresponding to nba_api's raw GAME_ID
      "0022300500") and a real 7-digit player_id to prove the computed
      stat_id both fits and is computed correctly.
    model: stg_player_game_stats_nba
    given:
      - input: source('raw', 'raw_pulls')
        rows:
          - id: 1
            source: nba_stats
            endpoint: boxscore_traditional
            pulled_at: "2024-01-01 00:00:00"
            payload:
              game_id: 100022300500
              player_stats:
                - PLAYER_ID: 1629027
                  PLAYER_NAME: "Gary Trent Jr."
                  player_key: "gary trent jr."
                  TEAM_ABBREVIATION: "POR"
                  PTS: 20
                  REB: 4
                  AST: 3
                  STL: 1
                  BLK: 0
                  TO: 2
                  MIN: "34:12"
    expect:
      rows:
        - stat_id: 1000223005001629027
          game_id: 100022300500
          player_id: 1629027
```

### Step 7: Fix `player_game_stats.yml`'s stale `game_id` relationships test

**Real bug, found during plan self-review, not part of the original spec.** `dbt/models/marts/player_game_stats.yml`'s `game_id` column currently has:

```yaml
      - name: game_id
        description: FK to the `games` gold table.
        data_tests:
          - not_null
          - relationships:
              arguments:
                to: ref('stg_games')
                field: game_id
```

This checks every `player_game_stats.game_id` against `stg_games` — balldontlie's staging model only. Once `stg_player_game_stats_nba`'s `game_id` values are nba_api's own offset ids (Step 5 above), they will never appear in `stg_games` (only in the new `stg_games_nba`), so this test would fail for every nba_stats-sourced row the first time real data flows through it. Change `to: ref('stg_games')` to `to: ref('games')` — the Gold mart, which is the `UNION ALL` of both staging models (Employee 2 Step 3) — so the test correctly validates a row's `game_id` against whichever source it actually came from. This also makes the test match its own description ("FK to the `games` gold table") for the first time — it previously said one thing and checked another.

```yaml
      - name: game_id
        description: FK to the `games` gold table.
        data_tests:
          - not_null
          - relationships:
              arguments:
                to: ref('games')
                field: game_id
```

### Step 8: Verify offline, then commit

Run: `cd dbt && DBT_PROFILES_DIR=. uv run dbt parse --no-partial-parse`
Expected: clean parse, no errors.

Run: `cd dbt && DBT_PROFILES_DIR=. uv run dbt compile --no-populate-cache`
Expected: clean compile, no errors.

Run: `cd dbt && DBT_PROFILES_DIR=. uv run dbt test --select stg_games_nba stg_player_game_stats_nba --no-populate-cache` (unit tests only need parse-level validation, not a live DB, per dbt-core's unit test runner — if this requires a live connection in practice, note it and defer to the boss's real-DB verification step instead of blocking on it here).

```bash
git add dbt/models/staging/stg_games_nba.sql dbt/models/staging/stg_games_nba.yml \
        dbt/models/marts/games.sql dbt/models/marts/games.yml \
        dbt/models/staging/stg_player_game_stats_nba.sql \
        dbt/models/staging/stg_player_game_stats_nba.yml \
        dbt/models/marts/player_game_stats.yml
git commit -m "feat: make nba_api an independent games source in the Gold games mart"
```

---

## Verification (boss, before reporting to the human)

- `ingestion`: `PYTHONPATH=src:../db/src uv run pytest -v` — full suite green, including the new `get_games_for_season`/flow tests, with zero real network calls.
- `dbt`: `dbt parse --no-partial-parse` and `dbt compile --no-populate-cache` clean.
- **Real `dbt run` required, not just parse/compile** (per [[dbt-offline-verification-blind-spot]] — parse/compile already missed one real bug this project shipped once; don't repeat that here). Steps, run by the boss against the real local Postgres:
  1. Delete the incompatible pilot data and reset the checkpoint (old schema, superseded by this redesign — approved by the user during design):
     ```sql
     delete from raw_pulls where source = 'nba_stats';
     delete from backfill_checkpoints where flow_name = 'backfill_nba_stats';
     ```
  2. Run one pilot season for real:
     ```bash
     cd ingestion && PYTHONPATH=src:../db/src uv run python -c \
       "from ingestion.flows.backfill_nba_stats_flow import backfill_nba_stats_flow; \
        print(backfill_nba_stats_flow(start_season=1996, end_season=1996))"
     cd dbt && DBT_PROFILES_DIR=. uv run dbt run
     ```
  3. Verify: `games` and `player_game_stats` both contain real, non-zero rows for the 1996-97 season; spot-check a couple of real values (e.g. a real final score, a real player's point total) against public record; confirm no duplicate `game_id`/`stat_id` (the `unique` dbt tests should already catch this, but a manual `select game_id, count(*) from games group by game_id having count(*) > 1` is a cheap extra check given this is the first real run of the new offset scheme).
- State plainly in the PR: this only backfills 1996-97 as a pilot. The remaining 29 seasons (1997 through 2025) are the human's to run afterward, one at a time, per the module docstring's runbook — not attempted by the boss (the full run is ~12.5 hours of real `stats.nba.com` calls per the spec's estimate, and this project's convention is the human runs real, long-running `stats.nba.com` backfills themselves).
