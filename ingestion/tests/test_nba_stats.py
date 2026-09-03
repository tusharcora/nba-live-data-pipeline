from unittest.mock import Mock, patch

from ingestion.sources.nba_stats import NBAStatsClient


def _finder_result(rows: list[dict]) -> Mock:
    finder = Mock()
    finder.get_normalized_dict.return_value = {"LeagueGameFinderResults": rows}
    return finder


def _boxscore_result(rows: list[dict]) -> Mock:
    boxscore = Mock()
    boxscore.get_normalized_dict.return_value = {"PlayerStats": rows}
    return boxscore


def test_get_games_for_date_groups_two_team_rows_into_one_game():
    """LeagueGameFinder returns one row per team per game (two rows/game) —
    get_games_for_date must group those by GAME_ID into one dict per game
    carrying both team names."""
    rows = [
        {
            "GAME_ID": "0022300500",
            "TEAM_ID": 1610612737,
            "TEAM_NAME": "Atlanta Hawks",
            "GAME_DATE": "2024-01-01",
            "MATCHUP": "ATL vs. BOS",
        },
        {
            "GAME_ID": "0022300500",
            "TEAM_ID": 1610612738,
            "TEAM_NAME": "Boston Celtics",
            "GAME_DATE": "2024-01-01",
            "MATCHUP": "BOS @ ATL",
        },
    ]

    with patch(
        "nba_api.stats.endpoints.leaguegamefinder.LeagueGameFinder",
        return_value=_finder_result(rows),
    ) as mock_finder:
        client = NBAStatsClient()
        games = client.get_games_for_date("2024-01-01")

    mock_finder.assert_called_once_with(
        date_from_nullable="2024-01-01", date_to_nullable="2024-01-01"
    )
    assert games == [
        {
            "game_id": "0022300500",
            "team_names": {"Atlanta Hawks", "Boston Celtics"},
        }
    ]


def test_get_games_for_date_handles_multiple_games_same_date():
    rows = [
        {"GAME_ID": "A", "TEAM_NAME": "Dallas Mavericks"},
        {"GAME_ID": "A", "TEAM_NAME": "Utah Jazz"},
        {"GAME_ID": "B", "TEAM_NAME": "Miami Heat"},
        {"GAME_ID": "B", "TEAM_NAME": "Orlando Magic"},
    ]

    with patch(
        "nba_api.stats.endpoints.leaguegamefinder.LeagueGameFinder",
        return_value=_finder_result(rows),
    ):
        client = NBAStatsClient()
        games = client.get_games_for_date("2024-01-02")

    games_by_id = {g["game_id"]: g["team_names"] for g in games}
    assert games_by_id == {
        "A": {"Dallas Mavericks", "Utah Jazz"},
        "B": {"Miami Heat", "Orlando Magic"},
    }


def test_get_games_for_date_sleeps_for_pacing():
    rows = [{"GAME_ID": "A", "TEAM_NAME": "Miami Heat"}]

    with (
        patch(
            "nba_api.stats.endpoints.leaguegamefinder.LeagueGameFinder",
            return_value=_finder_result(rows),
        ),
        patch("ingestion.sources.nba_stats.time.sleep") as mock_sleep,
    ):
        client = NBAStatsClient()
        client.get_games_for_date("2024-01-01")

    mock_sleep.assert_called_once()


def test_get_boxscore_returns_player_stats_with_player_key():
    rows = [
        {
            "GAME_ID": "0022300500",
            "TEAM_ID": 1610612737,
            "PLAYER_ID": 1629027,
            "PLAYER_NAME": "Gary Trent Jr.",
            "PTS": 20,
        },
        {
            "GAME_ID": "0022300500",
            "TEAM_ID": 1610612738,
            "PLAYER_ID": 201939,
            "PLAYER_NAME": "Stephen Curry",
            "PTS": 30,
        },
    ]

    with patch(
        "nba_api.stats.endpoints.boxscoretraditionalv2.BoxScoreTraditionalV2",
        return_value=_boxscore_result(rows),
    ) as mock_boxscore:
        client = NBAStatsClient()
        player_stats = client.get_boxscore("0022300500")

    mock_boxscore.assert_called_once_with(game_id="0022300500")
    assert len(player_stats) == 2
    assert player_stats[0]["PLAYER_NAME"] == "Gary Trent Jr."
    assert player_stats[0]["player_key"] == "gary trent jr."
    assert player_stats[1]["PLAYER_NAME"] == "Stephen Curry"
    assert player_stats[1]["player_key"] == "stephen curry"
    # Original real columns are preserved verbatim, not replaced.
    assert player_stats[0]["PTS"] == 20


def test_get_boxscore_sleeps_for_pacing():
    rows = [{"PLAYER_NAME": "Stephen Curry", "GAME_ID": "A"}]

    with (
        patch(
            "nba_api.stats.endpoints.boxscoretraditionalv2.BoxScoreTraditionalV2",
            return_value=_boxscore_result(rows),
        ),
        patch("ingestion.sources.nba_stats.time.sleep") as mock_sleep,
    ):
        client = NBAStatsClient()
        client.get_boxscore("A")

    mock_sleep.assert_called_once()
