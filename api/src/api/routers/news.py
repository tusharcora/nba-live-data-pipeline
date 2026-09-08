"""`GET /news` and `GET /news/lookup` -- the Phase 1 NBA news feed
(docs/superpowers/specs/2026-09-07-nba-news-feed-design.md), reading the
dbt-owned Gold `news_articles` table.

Two endpoints for two different real consumers, same posture as
`query_tools.py`'s explicit split from `games.py`'s browsing convention:

- `GET /news` -- the `/news` page's browsing endpoint (Task 4). A filter
  that matches nothing is a perfectly valid empty list; no special-casing
  needed.
- `GET /news/lookup` -- the future NL-search tool's endpoint (Task 5, if
  it runs). Zero matches must be an explicit `"no_match"` status, never an
  empty-but-"ok" list, so the LLM loop can tell "found nothing" apart from
  "found an empty result" without guessing (this project's CAP-5
  discipline, same as the four existing search tools).

Table reflected via SQLAlchemy Core (`Table(..., autoload_with=engine)`),
same read-only-table-we-don't-own pattern as `games.py`.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import MetaData, Table, func, select
from sqlalchemy.engine import Engine

from api.core.cache import cached_json
from api.core.db import get_engine
from api.core.rate_limit import DEFAULT_RATE_LIMIT, limiter
from api.core.security import require_api_key

router = APIRouter(prefix="/news", tags=["news"], dependencies=[Depends(require_api_key)])

# News changes as slowly as `news_flow`'s ~15-minute poll cadence (design
# spec's "Freshness" section) -- a longer TTL than `/games`' 15s is fine
# and further reduces load on the underlying table.
CACHE_TTL_SECONDS = 60

DEFAULT_LIMIT = 20
MAX_LIMIT = 100

NO_MATCH_MESSAGE = "No recent news matched that request."


@runtime_checkable
class NewsReader(Protocol):
    """Injectable read path for the Gold `news_articles` table."""

    def list_news(self, reporter: str | None, limit: int) -> list[dict]: ...


class SQLAlchemyNewsReader:
    """Production `NewsReader`, backed by the dbt-owned Gold `news_articles` table."""

    def __init__(self, engine: Engine | None = None) -> None:
        self._engine = engine or get_engine()

    def list_news(self, reporter: str | None, limit: int) -> list[dict]:
        metadata = MetaData()
        news_articles = Table("news_articles", metadata, autoload_with=self._engine)

        stmt = select(news_articles).order_by(news_articles.c.published_at.desc()).limit(limit)
        if reporter:
            # coalesce(byline, '') so a NULL byline compares against ''
            # rather than producing NULL (and therefore excluding the row
            # from a NOT filter, or behaving unpredictably) -- and ilike
            # for a case-insensitive substring match (review punch list:
            # "case sensitivity" + "null byline" findings).
            stmt = stmt.where(func.coalesce(news_articles.c.byline, "").ilike(f"%{reporter}%"))

        with self._engine.connect() as conn:
            return [dict(row) for row in conn.execute(stmt).mappings().all()]


def get_news_reader() -> NewsReader:
    """FastAPI dependency factory -- overridden in tests via
    `app.dependency_overrides[get_news_reader]` to inject a fake reader.
    """
    return SQLAlchemyNewsReader()


@router.get("/")
@limiter.limit(DEFAULT_RATE_LIMIT)
def list_news(
    request: Request,
    reporter: str | None = Query(
        default=None,
        description="Filter to articles whose byline contains this substring "
        "(case-insensitive), e.g. ?reporter=Charania.",
    ),
    limit: int = Query(
        default=DEFAULT_LIMIT,
        ge=1,
        le=MAX_LIMIT,
        description=f"Max articles to return, {1}-{MAX_LIMIT} (default {DEFAULT_LIMIT}).",
    ),
    reader: NewsReader = Depends(get_news_reader),
) -> dict:
    """Recent NBA news, most recently published first.

    - No params -- the most recent `limit` (default 20) articles.
    - `?reporter=<substring>` -- only articles whose byline contains the
      given substring, case-insensitive (e.g. `?reporter=Charania`). A
      filter that matches nothing returns a valid empty list, not an error.
    - `?limit=<1-100>` -- caps the number of rows returned; out-of-range
      values are a 422 (FastAPI's own `Query` validation), not silently
      clamped.

    Response shape:
        {"data": [<article row as a dict>, ...], "count": <int>}
    """

    def _compute() -> dict:
        rows = reader.list_news(reporter, limit)
        return {"data": rows, "count": len(rows)}

    cache_key = f"news:{reporter or ''}:{limit}"
    return cached_json(cache_key, CACHE_TTL_SECONDS, _compute)


@router.get("/lookup")
@limiter.limit(DEFAULT_RATE_LIMIT)
def lookup_news(
    request: Request,
    reporter: str | None = Query(default=None, description="Same substring filter as GET /news."),
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    reader: NewsReader = Depends(get_news_reader),
) -> dict:
    """CAP-5-style lookup for the future NL-search tool (Task 5).

    Response shape:
        {"status": "ok", "data": [<article row>, ...], "message": None}
        {"status": "no_match", "data": None, "message": <str>}
    """

    def _compute() -> dict:
        rows = reader.list_news(reporter, limit)
        if not rows:
            return {"status": "no_match", "data": None, "message": NO_MATCH_MESSAGE}
        return {"status": "ok", "data": rows, "message": None}

    cache_key = f"news:lookup:{reporter or ''}:{limit}"
    return cached_json(cache_key, CACHE_TTL_SECONDS, _compute)
