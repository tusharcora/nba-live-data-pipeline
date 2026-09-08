import datetime as dt

import fakeredis
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Column, DateTime, Integer, MetaData, String, Table, create_engine, insert

from api.core import cache as cache_module
from api.main import app
from api.routers.news import SQLAlchemyNewsReader, get_news_reader

API_KEY = "test-service-key"


class FakeNewsReader:
    """Test double for the news-reader DI seam (`NewsReader` protocol).

    Applies the same case-insensitive substring `reporter` filter (treating
    a null `byline` as an empty string) and `limit` truncation a real SQL
    query would, so filter tests exercise real route behavior.

    `list_news`'s real contract (`SQLAlchemyNewsReader.list_news`) returns
    `published_at`/`ingested_at` as already-`.isoformat()`-ed strings, not
    raw `datetime` objects, so a JSON-cache round-trip can't change their
    format. `FAKE_ROWS` below matches that contract (isoformat strings)
    so this fake stays a faithful stand-in for the real reader.
    """

    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.received_reporter: str | None | str = "not-called"
        self.received_limit: int | str = "not-called"
        self.call_count = 0

    def list_news(self, reporter: str | None, limit: int) -> list[dict]:
        self.call_count += 1
        self.received_reporter = reporter
        self.received_limit = limit

        rows = self.rows
        if reporter:
            needle = reporter.lower()
            rows = [row for row in rows if needle in (row["byline"] or "").lower()]
        return rows[:limit]


FAKE_ROWS = [
    {
        "article_id": 1,
        "headline": "Ben Simmons returning to NBA",
        "summary": "...",
        "byline": "Marc J. Spears",
        "published_at": "2026-09-06T18:30:00+00:00",
        "article_url": "https://www.espn.com/nba/story/_/id/1",
        "ingested_at": "2026-09-06T18:45:00+00:00",
    },
    {
        "article_id": 2,
        "headline": "NBA trade rumors roundup",
        "summary": "...",
        "byline": None,
        "published_at": "2026-09-06T12:00:00+00:00",
        "article_url": "https://www.espn.com/nba/story/_/id/2",
        "ingested_at": "2026-09-06T12:15:00+00:00",
    },
]


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("API_SERVICE_KEY", API_KEY)
    fake = fakeredis.FakeRedis()
    monkeypatch.setattr(cache_module, "get_cache_client", lambda: fake)
    test_client = TestClient(app)
    yield test_client
    app.dependency_overrides.clear()


def test_list_news_returns_all_rows_with_no_filter(client):
    app.dependency_overrides[get_news_reader] = lambda: FakeNewsReader(FAKE_ROWS)

    response = client.get("/news", headers={"X-API-Key": API_KEY})

    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 2
    assert [row["article_id"] for row in body["data"]] == [1, 2]


def test_list_news_reporter_filter_is_case_insensitive(client):
    reader = FakeNewsReader(FAKE_ROWS)
    app.dependency_overrides[get_news_reader] = lambda: reader

    response = client.get("/news?reporter=spears", headers={"X-API-Key": API_KEY})

    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 1
    assert body["data"][0]["article_id"] == 1
    assert reader.received_reporter == "spears"


def test_list_news_reporter_filter_treats_null_byline_as_no_match(client):
    app.dependency_overrides[get_news_reader] = lambda: FakeNewsReader(FAKE_ROWS)

    response = client.get("/news?reporter=nobody", headers={"X-API-Key": API_KEY})

    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 0
    assert body["data"] == []


def test_list_news_limit_rejects_out_of_range_values(client):
    app.dependency_overrides[get_news_reader] = lambda: FakeNewsReader(FAKE_ROWS)

    too_low = client.get("/news?limit=0", headers={"X-API-Key": API_KEY})
    too_high = client.get("/news?limit=101", headers={"X-API-Key": API_KEY})

    assert too_low.status_code == 422
    assert too_high.status_code == 422


def test_list_news_default_limit_is_20(client):
    reader = FakeNewsReader(FAKE_ROWS)
    app.dependency_overrides[get_news_reader] = lambda: reader

    client.get("/news", headers={"X-API-Key": API_KEY})

    assert reader.received_limit == 20


def test_lookup_news_returns_ok_status_with_matches(client):
    app.dependency_overrides[get_news_reader] = lambda: FakeNewsReader(FAKE_ROWS)

    response = client.get("/news/lookup?reporter=Spears", headers={"X-API-Key": API_KEY})

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert len(body["data"]) == 1
    assert body["message"] is None


def test_lookup_news_returns_no_match_status_when_empty(client):
    app.dependency_overrides[get_news_reader] = lambda: FakeNewsReader(FAKE_ROWS)

    response = client.get("/news/lookup?reporter=Nobody", headers={"X-API-Key": API_KEY})

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "no_match"
    assert body["data"] is None
    assert body["message"]


def test_list_news_second_request_is_served_from_cache(client, monkeypatch):
    reader = FakeNewsReader(FAKE_ROWS)
    app.dependency_overrides[get_news_reader] = lambda: reader

    client.get("/news", headers={"X-API-Key": API_KEY})
    client.get("/news", headers={"X-API-Key": API_KEY})

    assert reader.call_count == 1


def test_list_news_cached_and_uncached_responses_are_byte_identical(client):
    """Covers the route + `cached_json` round-trip: `cached_json` stores the
    computed result via `json.dumps(..., default=str)`, so *if* a reader
    ever handed the route raw `datetime` objects again, a cache miss
    (FastAPI's own encoder, which produces ISO-8601) and a cache hit
    (`str(datetime)`, space-separated, not ISO-8601) would silently
    disagree on timestamp format. Comparing full response bodies -- not
    just `reader.call_count` -- is what would catch that divergence at
    this layer.

    NOTE: this only proves the route/cache layer is well-behaved *given* a
    reader that already returns isoformat strings (`FakeNewsReader`, per
    its docstring, mirrors that contract) -- it does not exercise
    `SQLAlchemyNewsReader.list_news`'s own `.isoformat()` conversion, since
    that class is never called here. See
    `test_sqlalchemy_news_reader_list_news_returns_isoformat_strings`
    below for a test that calls the real reader directly.
    """
    reader = FakeNewsReader(FAKE_ROWS)
    app.dependency_overrides[get_news_reader] = lambda: reader

    first = client.get("/news", headers={"X-API-Key": API_KEY})
    second = client.get("/news", headers={"X-API-Key": API_KEY})

    assert reader.call_count == 1  # second request served from cache
    assert first.status_code == second.status_code == 200
    assert first.text == second.text
    assert first.json() == second.json()
    # Pin the exact ISO-8601 format so a regression to `str(datetime)`
    # ("2026-09-06 18:30:00+00:00", space-separated) would fail loudly.
    assert first.json()["data"][0]["published_at"] == "2026-09-06T18:30:00+00:00"


def _sqlite_news_engine(rows: list[dict]):
    """A real (but throwaway, in-memory) SQLite engine standing in for the
    Postgres `news_articles` table, so `SQLAlchemyNewsReader.list_news` --
    which reflects a live table via `autoload_with` -- can be exercised
    directly, the same way `alembic --sql`/`dbt parse` verify this project's
    other SQL-touching code without a live Postgres. Mocking `Engine` for
    this specific method isn't practical: `autoload_with` needs something
    genuinely inspectable to reflect column types from.
    """
    engine = create_engine("sqlite:///:memory:")
    metadata = MetaData()
    news_articles = Table(
        "news_articles",
        metadata,
        Column("article_id", Integer, primary_key=True),
        Column("headline", String),
        Column("summary", String),
        Column("byline", String),
        Column("published_at", DateTime()),
        Column("article_url", String),
        Column("source", String),
        Column("ingested_at", DateTime()),
    )
    metadata.create_all(engine)
    if rows:
        with engine.begin() as conn:
            conn.execute(insert(news_articles), rows)
    return engine


def test_sqlalchemy_news_reader_list_news_returns_isoformat_strings():
    """Exercises `SQLAlchemyNewsReader.list_news` directly -- not through
    `FakeNewsReader`/the FastAPI DI seam -- against a real reflected table,
    so it actually covers the `.isoformat()` conversion the router fix
    added. If that conversion were reverted back to a bare `dict(row)`,
    `published_at`/`ingested_at` below would come back as `datetime`
    objects, which fail an `== <isoformat string>` comparison and fail
    `isinstance(..., str)` -- so this test would fail.

    Uses naive (no-tzinfo) datetimes: SQLite's `DATETIME` affinity doesn't
    round-trip a `tzinfo` the way Postgres's `TIMESTAMPTZ` does, and that
    round-trip fidelity isn't what this test is about -- only that
    `list_news` calls `.isoformat()` on whatever `datetime` the row comes
    back with, whether tz-aware or naive.
    """
    published = dt.datetime(2026, 9, 6, 18, 30)
    ingested = dt.datetime(2026, 9, 6, 18, 45)
    engine = _sqlite_news_engine(
        [
            {
                "article_id": 1,
                "headline": "Ben Simmons returning to NBA",
                "summary": "...",
                "byline": "Marc J. Spears",
                "published_at": published,
                "article_url": "https://www.espn.com/nba/story/_/id/1",
                "source": "espn",
                "ingested_at": ingested,
            }
        ]
    )

    rows = SQLAlchemyNewsReader(engine=engine).list_news(reporter=None, limit=20)

    assert len(rows) == 1
    assert rows[0]["published_at"] == published.isoformat()
    assert rows[0]["ingested_at"] == ingested.isoformat()
    assert isinstance(rows[0]["published_at"], str)
    assert isinstance(rows[0]["ingested_at"], str)


def test_list_news_falls_open_when_redis_is_unreachable(client, monkeypatch):
    class _BrokenClient:
        def get(self, *_args, **_kwargs):
            raise ConnectionError("boom")

        def set(self, *_args, **_kwargs):
            raise ConnectionError("boom")

    monkeypatch.setattr(cache_module, "get_cache_client", lambda: _BrokenClient())
    app.dependency_overrides[get_news_reader] = lambda: FakeNewsReader(FAKE_ROWS)

    response = client.get("/news", headers={"X-API-Key": API_KEY})

    assert response.status_code == 200
    assert response.json()["count"] == 2
