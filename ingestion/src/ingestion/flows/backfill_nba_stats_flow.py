"""Historical NBA.com (`stats.nba.com`) box-score backfill — local-only.

**Deliberate, named ToS trade-off.** `nba_api` (and every tool like it)
works around `stats.nba.com`'s Akamai bot protection by sending browser-
style headers from a plain HTTP client. Doing that — even from a real
residential IP, with no attempt to defeat CAPTCHAs or evade a block once
one happens — is very likely a violation of NBA.com's Terms of Service.
For this portfolio project, that's judged an acceptable, common, low-stakes
choice (same category of trade-off as this project's other named decisions,
e.g. not paying for balldontlie's ALL-STAR tier in Week 5) — but it is
recorded here explicitly, not left as a hidden footnote, and this flow must
never be run anywhere except a human's own machine:

- **Never scheduled, never deployed, never CI.** This module defines a
  plain `@flow`-decorated function meant to be invoked ad hoc from a local
  shell (exactly like `backfill_flow`/`backfill_stats_flow` are), the same
  way one would run a script. Nothing here registers a Prefect deployment,
  and nothing in `.github/workflows/` should ever import this module.
- `stats.nba.com` is known to block datacenter/cloud IPs outright, so a
  scheduled/CI run would fail immediately even if someone tried.

**Run order (new for this project — read before running).** Every other
`ingestion` flow only ever reads/writes Bronze (`raw_pulls`). This flow is
the first to read a Gold, dbt-owned table (`games`) as an input — it needs
to know which games balldontlie already has ingested for a date before it
can match NBA.com's games against them. That makes the real run order:

    1. `backfill_flow` (balldontlie games backfill)
    2. `dbt run` (builds the Gold `games` table this flow reads)
    3. `backfill_nba_stats_flow` (this flow)
    4. `dbt run` again (Employee 2's staging/mart model then parses the
       new `raw_pulls` rows this flow just wrote)

Running this flow before step 2 will simply find zero balldontlie games for
every date (an empty, not broken, `ExistingGamesReader` result) and match
nothing.

**Runtime expectations.** `NBAStatsClient` sleeps ~600ms between every real
request (see `ingestion.sources.nba_stats.REQUEST_PACING_SECONDS`), and
this flow makes exactly one `get_games_for_date` call per date plus one
`get_boxscore` call per *matched* game — no other pagination or retries.
For this project's existing 3-day/26-game backfill window
(2024-01-01..2024-01-03): 3 date calls + up to 26 box-score calls ≈
29 requests × ~0.6-1s each (network latency on top of the sleep) ≈ 20-30
real seconds. A full season backfill (~1,230 games, ~170 game days) would
be tens of minutes minimum (~170 + ~1,230 ≈ 1,400 requests) — run it in the
background, not synchronously in a terminal you need back.

**Deliberately deferred, not omitted:** wiring `source="nba_stats"` rows
into `quality/`'s reconciliation (`quality.reconciliation`) or volumetric
(`quality.volumetric`) checks is out of scope for this flow. Those modules
are untouched by this change. A future round could reconcile NBA.com's and
balldontlie's box scores the same way `reconcile_games_for_date` already
reconciles balldontlie/ESPN game-level fields — noted here for whoever
picks that up next, not attempted now.

**Player identity gap (schema-level fix only).** `nba_api`'s `PLAYER_ID`
and balldontlie's `player_id` are different id spaces with no shared key.
This flow does not solve cross-source player identity resolution — it only
ensures the Bronze payload carries what a later resolution step would need:
`NBAStatsClient.get_boxscore` already computes `player_key` (via
`ingestion.normalization.normalize_player_key(row["PLAYER_NAME"])`) on
every player row, and this flow writes that key straight into the Bronze
payload unmodified, so a downstream dbt model can extract it with zero
inline Python.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Protocol, runtime_checkable

from prefect import flow, get_run_logger
from sqlalchemy import MetaData, Table, create_engine, select
from sqlalchemy.engine import Engine
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
from quality.reconciliation import match_games_by_team_overlap

# Independent of "backfill_flow"/"backfill_stats" — this source is matched
# and gated entirely differently (Gold-table-driven, local-only), so it
# must never share a checkpoint row with either balldontlie backfill.
CHECKPOINT_FLOW_NAME = "backfill_nba_stats"


@runtime_checkable
class NBAGameSource(Protocol):
    """Injectable NBA.com source — matches `NBAStatsClient`'s shape."""

    def get_games_for_date(self, date_str: str) -> list[dict]: ...

    def get_boxscore(self, nba_game_id: str) -> list[dict]: ...


@runtime_checkable
class ExistingGamesReader(Protocol):
    """Injectable read path for balldontlie's already-dbt-built Gold `games`
    table.

    This is a new kind of reader for `ingestion`: every other flow's
    injected dependency writes Bronze or reads a Bronze/checkpoint source;
    this one *reads a Gold, dbt-owned table* as an input, because this flow
    can't know which games to match NBA.com against without it (see module
    docstring's run-order note). Kept as its own protocol/reader (rather
    than reusing `quality.volumetric.GoldReader`) since the shape needed
    here — `(game_id, team_names)` per date — is different from that
    module's `(game_id, team_ids, player_counts)`.
    """

    def get_games_for_date(self, game_date: date) -> list[tuple[int, set[str]]]: ...


class SQLAlchemyExistingGamesReader:
    """Production `ExistingGamesReader`.

    Reflects the Gold `games` table via `Table(..., autoload_with=engine)`
    rather than adding a new ORM model — `ingestion` doesn't own this
    table's schema, dbt does (same reflection pattern as
    `quality.volumetric.SQLAlchemyGoldReader`).
    """

    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def get_games_for_date(self, game_date: date) -> list[tuple[int, set[str]]]:
        metadata = MetaData()
        games = Table("games", metadata, autoload_with=self._engine)

        stmt = select(games.c.game_id, games.c.home_team, games.c.away_team).where(
            games.c.game_date == game_date
        )

        with self._engine.connect() as conn:
            return [
                (game_id, {home_team, away_team})
                for game_id, home_team, away_team in conn.execute(stmt)
            ]


def _log_unmatched_nba_games(
    logger, date_str: str, nba_games: list[dict], matched_nba_game_ids: set[str]
) -> None:
    for game in nba_games:
        if game["game_id"] not in matched_nba_game_ids:
            logger.info(
                "backfill_nba_stats_flow: %s: NBA.com game %s (teams=%s) has "
                "no balldontlie match for this date — skipped, not written",
                date_str,
                game["game_id"],
                sorted(game["team_names"]),
            )


@flow(name="backfill-nba-stats-flow")
def backfill_nba_stats_flow(
    start_date: str | None = None,
    end_date: str | None = None,
    sink: RawPullSink | None = None,
    checkpoint_store: CheckpointStore | None = None,
    existing_games_reader: ExistingGamesReader | None = None,
    client: NBAGameSource | None = None,
) -> dict:
    """Historical NBA.com player box-score backfill, matched onto balldontlie
    games by team-name overlap (see module docstring for the full set of
    load-bearing decisions this flow makes).

    Resumable exactly like `backfill_flow`/`backfill_stats_flow`: the
    checkpoint row for `flow_name="backfill_nba_stats"` is consulted first;
    if one exists, the run resumes from `last_pulled_date + 1 day`,
    ignoring `start_date`.

    Per date in `[resolved_start, resolved_end]`:
      1. Read balldontlie's already-ingested games for that date from Gold
         (`existing_games_reader`).
      2. Read NBA.com's games for that date (`client.get_games_for_date`).
      3. Match them by team-name overlap
         (`quality.reconciliation.match_games_by_team_overlap`) — reused
         directly, not reimplemented. balldontlie is the *primary* side of
         the match, so every matched pair's own game id is already
         balldontlie's `game_id`; NBA.com's game id is recovered from the
         match's `secondary_fields["nba_game_id"]` (the stashing convention
         chosen here — see the `fields` dicts built below).
      4. For each matched pair, fetch the NBA.com box score
         (`client.get_boxscore`) and write one `RawPull(source="nba_stats",
         endpoint="boxscore_traditional", ...)` via `sink`.
      5. Any NBA.com game with no balldontlie match for that date is
         logged, not written (no fabricated/null `balldontlie_game_id`).

    **Failure handling:** if any call within a date's processing raises
    (the realistic failure mode is a mid-run block: 403/CAPTCHA/connection
    reset from `stats.nba.com`'s bot protection, not a clean empty result),
    the checkpoint for that date is never advanced — the exception
    propagates with a message naming the failing date and NBA.com game id,
    so a re-run resumes cleanly from the last fully-completed date.
    """
    logger = get_run_logger()

    engine: Engine | None = None
    session_factory: sessionmaker[Session] | None = None
    if sink is None or checkpoint_store is None or existing_games_reader is None:
        engine = create_engine(Settings().runtime_database_url)
        session_factory = sessionmaker(bind=engine)
    sink = sink or SQLAlchemyRawPullSink(session_factory)  # type: ignore[arg-type]
    checkpoint_store = checkpoint_store or SQLAlchemyCheckpointStore(session_factory)  # type: ignore[arg-type]
    existing_games_reader = existing_games_reader or SQLAlchemyExistingGamesReader(engine)  # type: ignore[arg-type]
    client = client or NBAStatsClient()

    resolved_end = (
        date.fromisoformat(end_date)
        if end_date
        else datetime.now(timezone.utc).date() - timedelta(days=1)
    )

    last_checkpoint = checkpoint_store.get_last_pulled_date(CHECKPOINT_FLOW_NAME)
    if last_checkpoint is not None:
        resolved_start = last_checkpoint + timedelta(days=1)
    elif start_date is not None:
        resolved_start = date.fromisoformat(start_date)
    else:
        raise ValueError(
            "start_date is required on the first backfill_nba_stats_flow "
            f"run — no checkpoint found for flow_name={CHECKPOINT_FLOW_NAME!r}"
        )

    dates_processed = 0
    raw_pulls_written = 0
    games_matched = 0
    games_unmatched = 0

    current = resolved_start
    while current <= resolved_end:
        date_str = current.isoformat()

        # Primary side of the match: balldontlie's already-ingested games
        # for this date, read from Gold. `fields` stashes balldontlie's own
        # (already-correct) integer game_id so it can be pulled back out
        # untouched after matching — that's the whole point of matching on
        # balldontlie-as-primary: the Bronze payload this flow writes never
        # needs to invent or translate an id.
        bdl_games = existing_games_reader.get_games_for_date(current)
        primary_games: list[tuple[str, set[str], dict]] = [
            (str(game_id), team_names, {"balldontlie_game_id": game_id})
            for game_id, team_names in bdl_games
        ]

        # Secondary side: NBA.com's games for the same date. `fields`
        # stashes NBA.com's own string GAME_ID under the same
        # "<source>_game_id" convention, for the same reason.
        nba_games = client.get_games_for_date(date_str)
        secondary_games: list[tuple[str, set[str], dict]] = [
            (game["game_id"], game["team_names"], {"nba_game_id": game["game_id"]})
            for game in nba_games
        ]

        matches = match_games_by_team_overlap(primary_games, secondary_games)

        matched_nba_game_ids = {
            secondary_fields["nba_game_id"] for _, _, secondary_fields in matches
        }
        _log_unmatched_nba_games(logger, date_str, nba_games, matched_nba_game_ids)

        pages_written = 0
        for _, primary_fields, secondary_fields in matches:
            balldontlie_game_id = primary_fields["balldontlie_game_id"]
            nba_game_id = secondary_fields["nba_game_id"]

            try:
                player_stats = client.get_boxscore(nba_game_id)
            except Exception as exc:
                raise RuntimeError(
                    "backfill_nba_stats_flow: failed fetching NBA.com box "
                    f"score for game {nba_game_id!r} (balldontlie "
                    f"game_id={balldontlie_game_id!r}) on {date_str} — "
                    f"checkpoint not advanced past {date_str}; re-run to "
                    "resume from this date"
                ) from exc

            sink.write(
                RawPull(
                    source="nba_stats",
                    endpoint="boxscore_traditional",
                    payload={
                        "balldontlie_game_id": balldontlie_game_id,
                        "player_stats": player_stats,
                    },
                )
            )
            pages_written += 1

        checkpoint_store.advance(CHECKPOINT_FLOW_NAME, current)
        dates_processed += 1
        raw_pulls_written += pages_written
        games_matched += len(matches)
        games_unmatched += len(nba_games) - len(matches)
        logger.info(
            "backfill_nba_stats_flow: processed %s (%d matched game(s), "
            "%d unmatched NBA.com game(s), %d raw_pulls row(s) written)",
            date_str,
            len(matches),
            len(nba_games) - len(matches),
            pages_written,
        )
        current += timedelta(days=1)

    return {
        "dates_processed": dates_processed,
        "raw_pulls_written": raw_pulls_written,
        "games_matched": games_matched,
        "games_unmatched": games_unmatched,
    }
