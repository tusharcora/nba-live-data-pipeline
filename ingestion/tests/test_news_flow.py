from db.models import RawPull
from ingestion.flows.news_flow import news_flow


class FakeRawPullSink:
    def __init__(self) -> None:
        self.written: list[RawPull] = []

    def write(self, raw_pull: RawPull) -> None:
        self.written.append(raw_pull)


class FakeNewsSource:
    def __init__(self, payload: dict) -> None:
        self._payload = payload
        self.call_count = 0

    def get_news(self) -> dict:
        self.call_count += 1
        return self._payload


def _news_payload() -> dict:
    return {
        "header": "NBA News",
        "articles": [
            {
                "id": 49824980,
                "type": "Story",
                "headline": "Ben Simmons returning to NBA",
                "description": "...",
                "byline": "Marc J. Spears",
                "published": "2026-09-06T18:30:00Z",
                "links": {"web": {"href": "https://www.espn.com/x"}},
            }
        ],
    }


def test_news_flow_writes_one_raw_pull_for_the_whole_batch():
    sink = FakeRawPullSink()
    source = FakeNewsSource(_news_payload())

    result = news_flow(raw_pull_sink=sink, public_feed_client=source)

    assert len(sink.written) == 1
    pull = sink.written[0]
    assert pull.source == "public_feed"
    assert pull.endpoint == "news"
    assert pull.payload == _news_payload()
    assert result == {"raw_pulls_written": 1}


def test_news_flow_calls_the_source_exactly_once():
    sink = FakeRawPullSink()
    source = FakeNewsSource(_news_payload())

    news_flow(raw_pull_sink=sink, public_feed_client=source)

    assert source.call_count == 1
