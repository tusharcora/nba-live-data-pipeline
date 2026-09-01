from unittest.mock import Mock, patch

import httpx
import pytest

from ingestion.sources.balldontlie import BallDontLieClient


def _response(payload: dict) -> Mock:
    response = Mock()
    response.json.return_value = payload
    response.raise_for_status.return_value = None
    return response


def test_get_games_pages_follows_cursor_pagination_then_stops():
    page_1 = {
        "data": [{"id": 1, "date": "2024-01-01"}],
        "meta": {"next_cursor": 100, "per_page": 100},
    }
    page_2 = {
        "data": [{"id": 2, "date": "2024-01-01"}],
        "meta": {"next_cursor": None, "per_page": 100},
    }

    with patch(
        "httpx.get", side_effect=[_response(page_1), _response(page_2)]
    ) as mock_get:
        client = BallDontLieClient(api_key="test-key")
        pages = list(client.get_games_pages("2024-01-01"))

    # Full decoded pages are yielded, in order, and iteration stops once
    # next_cursor is null — no third request is made.
    assert pages == [page_1, page_2]
    assert mock_get.call_count == 2

    first_call, second_call = mock_get.call_args_list

    assert first_call.args[0] == "https://api.balldontlie.io/v1/games"
    assert first_call.kwargs["params"] == {"dates[]": "2024-01-01", "per_page": 100}
    assert first_call.kwargs["headers"] == {"Authorization": "test-key"}

    # Second request follows the cursor from page 1's meta.
    assert second_call.kwargs["params"] == {
        "dates[]": "2024-01-01",
        "per_page": 100,
        "cursor": 100,
    }
    assert second_call.kwargs["headers"] == {"Authorization": "test-key"}


def test_get_games_pages_stops_after_single_page_with_no_cursor():
    only_page = {"data": [], "meta": {"next_cursor": None}}

    with patch("httpx.get", side_effect=[_response(only_page)]) as mock_get:
        client = BallDontLieClient(api_key="test-key")
        pages = list(client.get_games_pages("2024-01-02"))

    assert pages == [only_page]
    assert mock_get.call_count == 1


def test_get_raises_on_non_2xx_response():
    response = Mock()
    response.raise_for_status.side_effect = httpx.HTTPStatusError(
        "boom", request=Mock(), response=Mock(status_code=500)
    )

    with patch("httpx.get", return_value=response):
        client = BallDontLieClient(api_key="test-key")
        with pytest.raises(httpx.HTTPStatusError):
            list(client.get_games_pages("2024-01-01"))
