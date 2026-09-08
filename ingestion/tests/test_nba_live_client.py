from unittest.mock import MagicMock, patch

from ingestion.sources.nba_live import NbaLiveScoreboardClient


def test_get_scoreboard_returns_the_underlying_dict():
    """Patches the `ScoreBoard` class itself, not `httpx.get` — `nba_api`
    makes its own HTTP calls internally, so this is the one documented
    exception to this project's usual httpx-mocking convention (see
    `CLAUDE.md` and `nba_live.py`'s module docstring).
    """
    fake_board = MagicMock()
    fake_board.get_dict.return_value = {
        "scoreboard": {"gameDate": "2026-09-06", "games": []}
    }

    with patch(
        "ingestion.sources.nba_live.scoreboard.ScoreBoard", return_value=fake_board
    ):
        result = NbaLiveScoreboardClient().get_scoreboard()

    assert result == {"scoreboard": {"gameDate": "2026-09-06", "games": []}}
