from unittest.mock import Mock, patch

import httpx
import pytest

from ingestion.sources.public_feed import PublicFeedClient


def _response(payload: dict) -> Mock:
    response = Mock()
    response.json.return_value = payload
    response.raise_for_status.return_value = None
    return response


def test_get_scoreboard_returns_full_decoded_payload():
    payload = {
        "events": [
            {
                "id": "401584793",
                "date": "2024-01-01T00:00Z",
                "competitions": [
                    {
                        "competitors": [
                            {
                                "homeAway": "home",
                                "team": {"displayName": "Atlanta Hawks"},
                                "score": "121",
                            },
                            {
                                "homeAway": "away",
                                "team": {"displayName": "Boston Celtics"},
                                "score": "105",
                            },
                        ],
                        "status": {"type": {"name": "STATUS_FINAL"}},
                    }
                ],
            }
        ]
    }

    with patch("httpx.get", return_value=_response(payload)) as mock_get:
        client = PublicFeedClient(
            base_url="https://site.api.espn.com/apis/site/v2/sports/basketball/nba"
        )
        result = client.get_scoreboard("20240101")

    # Bronze stores the whole decoded response, not just `events`.
    assert result == payload
    assert mock_get.call_count == 1

    call = mock_get.call_args
    assert (
        call.args[0]
        == "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"
    )
    assert call.kwargs["params"] == {"dates": "20240101"}
    # Unauthenticated public feed — no auth header sent.
    assert "headers" not in call.kwargs or not call.kwargs["headers"]


def test_get_scoreboard_raises_on_non_2xx_response():
    response = Mock()
    response.raise_for_status.side_effect = httpx.HTTPStatusError(
        "boom", request=Mock(), response=Mock(status_code=500)
    )

    with patch("httpx.get", return_value=response):
        client = PublicFeedClient(
            base_url="https://site.api.espn.com/apis/site/v2/sports/basketball/nba"
        )
        with pytest.raises(httpx.HTTPStatusError):
            client.get_scoreboard("20240101")
