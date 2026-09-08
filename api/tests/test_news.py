from datetime import datetime, timezone

import fakeredis
import pytest
from fastapi.testclient import TestClient

from api.core import cache as cache_module
from api.main import app
from api.routers.news import get_news_reader

API_KEY = "test-service-key"


class FakeNewsReader:
    """Test double for the news-reader DI seam (`NewsReader` protocol).

    Applies the same case-insensitive substring `reporter` filter (treating
    a null `byline` as an empty string) and `limit` truncation a real SQL
    query would, so filter tests exercise real route behavior.
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
        "published_at": datetime(2026, 9, 6, 18, 30, tzinfo=timezone.utc),
        "article_url": "https://www.espn.com/nba/story/_/id/1",
        "ingested_at": datetime(2026, 9, 6, 18, 45, tzinfo=timezone.utc),
    },
    {
        "article_id": 2,
        "headline": "NBA trade rumors roundup",
        "summary": "...",
        "byline": None,
        "published_at": datetime(2026, 9, 6, 12, 0, tzinfo=timezone.utc),
        "article_url": "https://www.espn.com/nba/story/_/id/2",
        "ingested_at": datetime(2026, 9, 6, 12, 15, tzinfo=timezone.utc),
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
