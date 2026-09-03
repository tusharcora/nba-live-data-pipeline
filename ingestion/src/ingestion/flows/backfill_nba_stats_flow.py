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
