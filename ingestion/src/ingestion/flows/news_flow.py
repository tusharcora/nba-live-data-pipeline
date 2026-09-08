from typing import Protocol, runtime_checkable

from prefect import flow, get_run_logger
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from db.models import RawPull
from ingestion.config import Settings
from ingestion.flows.backfill_flow import RawPullSink, SQLAlchemyRawPullSink
from ingestion.sources.public_feed import PublicFeedClient


@runtime_checkable
class NewsSource(Protocol):
    """Injectable news-feed client — matches `PublicFeedClient.get_news() -> dict`."""

    def get_news(self) -> dict: ...


@flow(name="news-flow")
def news_flow(
    raw_pull_sink: RawPullSink | None = None,
    public_feed_client: NewsSource | None = None,
) -> dict:
    """One poll cycle against ESPN's public news feed
    (docs/superpowers/specs/2026-09-07-nba-news-feed-design.md).

    A single pass, not a real-time loop — repeated polling is a Prefect
    deployment-scheduling concern (a ~15-minute cadence per the spec's
    "Freshness" section), out of scope for the flow body itself, same
    posture as `live_game_flow`.

    Writes exactly ONE Bronze `raw_pull` row per call, holding the whole
    `{"articles": [...]}` batch verbatim — matching `live_game_flow`'s own
    "one row, whole batch" shape for `public_feed`'s scoreboard endpoint,
    not a new one-row-per-article convention. `stg_news_articles.sql`
    unnests the array downstream.

    `raw_pull_sink`/`public_feed_client` are injected so the flow body
    never opens a DB connection or makes an HTTP call itself — see
    `ingestion/tests/test_news_flow.py` for the fakes used in tests.
    """
    logger = get_run_logger()

    session_factory: sessionmaker[Session] | None = None
    if raw_pull_sink is None:
        session_factory = sessionmaker(bind=create_engine(Settings().runtime_database_url))
    raw_pull_sink = raw_pull_sink or SQLAlchemyRawPullSink(session_factory)  # type: ignore[arg-type]
    public_feed_client = public_feed_client or PublicFeedClient(
        base_url=Settings().public_feed_base_url
    )

    news = public_feed_client.get_news()
    raw_pull_sink.write(RawPull(source="public_feed", endpoint="news", payload=news))

    logger.info("news_flow: wrote 1 raw_pull (%d articles in batch)", len(news.get("articles", [])))

    return {"raw_pulls_written": 1}
