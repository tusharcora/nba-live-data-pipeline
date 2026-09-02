from unittest.mock import Mock, patch

import httpx
import pytest

from ingestion.sources.balldontlie import BallDontLieClient


def _response(payload: dict) -> Mock:
    response = Mock()
    response.json.return_value = payload
    response.raise_for_status.return_value = None
    return response


def test_get_stats_pages_single_page():
    only_page = {
        "data": [{"id": 1, "pts": 23, "min": "30"}],
        "meta": {"next_cursor": None, "per_page": 100},
    }

    with patch("httpx.get", side_effect=[_response(only_page)]) as mock_get:
        client = BallDontLieClient(api_key="test-key")
        pages = list(client.get_stats_pages("2024-01-01"))

    assert pages == [only_page]
    assert mock_get.call_count == 1

    call = mock_get.call_args_list[0]
    assert call.args[0] == "https://api.balldontlie.io/v1/stats"
    assert call.kwargs["params"] == {"dates[]": "2024-01-01", "per_page": 100}
    assert call.kwargs["headers"] == {"Authorization": "test-key"}


def test_get_stats_pages_follows_cursor_pagination_then_stops():
    page_1 = {
        "data": [{"id": 1, "pts": 23, "min": "30"}],
        "meta": {"next_cursor": 200, "per_page": 100},
    }
    page_2 = {
        "data": [{"id": 2, "pts": 11, "min": "18"}],
        "meta": {"next_cursor": None, "per_page": 100},
    }

    with patch(
        "httpx.get", side_effect=[_response(page_1), _response(page_2)]
    ) as mock_get:
        client = BallDontLieClient(api_key="test-key")
        pages = list(client.get_stats_pages("2024-01-01"))

    # Full decoded pages are yielded, in order, and iteration stops once
    # next_cursor is null — no third request is made.
    assert pages == [page_1, page_2]
    assert mock_get.call_count == 2

    first_call, second_call = mock_get.call_args_list

    assert first_call.args[0] == "https://api.balldontlie.io/v1/stats"
    assert first_call.kwargs["params"] == {"dates[]": "2024-01-01", "per_page": 100}
    assert first_call.kwargs["headers"] == {"Authorization": "test-key"}

    # Second request follows the cursor from page 1's meta.
    assert second_call.kwargs["params"] == {
        "dates[]": "2024-01-01",
        "per_page": 100,
        "cursor": 200,
    }
    assert second_call.kwargs["headers"] == {"Authorization": "test-key"}


def test_get_stats_pages_handles_empty_result_set():
    empty_page = {"data": [], "meta": {"next_cursor": None, "per_page": 100}}

    with patch("httpx.get", side_effect=[_response(empty_page)]) as mock_get:
        client = BallDontLieClient(api_key="test-key")
        pages = list(client.get_stats_pages("2024-01-02"))

    assert pages == [empty_page]
    assert mock_get.call_count == 1


def test_get_stats_pages_raises_on_non_2xx_response():
    response = Mock()
    response.raise_for_status.side_effect = httpx.HTTPStatusError(
        "boom", request=Mock(), response=Mock(status_code=500)
    )

    with patch("httpx.get", return_value=response):
        client = BallDontLieClient(api_key="test-key")
        with pytest.raises(httpx.HTTPStatusError):
            list(client.get_stats_pages("2024-01-01"))
