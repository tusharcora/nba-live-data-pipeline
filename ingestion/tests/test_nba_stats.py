from unittest.mock import Mock, patch

from ingestion.sources.nba_stats import NBAStatsClient, offset_game_id


def _finder_result(rows: list[dict]) -> Mock:
    finder = Mock()
    finder.get_normalized_dict.return_value = {"LeagueGameFinderResults": rows}
    return finder


def _boxscore_result(rows: list[dict]) -> Mock:
    boxscore = Mock()
    boxscore.get_normalized_dict.return_value = {"PlayerStats": rows}
    return boxscore


def test_offset_game_id_adds_the_namespace_constant():
    assert offset_game_id("0022300500") == 100_022_300_500
    assert offset_game_id("0029600001") == 100_029_600_001


def test_get_games_for_season_derives_home_away_from_matchup():
    """LeagueGameFinder returns one row per team per game; get_games_for_season
    must group by GAME_ID and use MATCHUP ('vs.' vs '@') to pick home/away,
    and must offset game_id via offset_game_id."""
    regular_season_rows = [
        {
            "GAME_ID": "0022300500",
            "TEAM_NAME": "Atlanta Hawks",
            "GAME_DATE": "2024-01-01",
            "MATCHUP": "ATL vs. BOS",
            "PTS": 110,
        },
        {
            "GAME_ID": "0022300500",
            "TEAM_NAME": "Boston Celtics",
            "GAME_DATE": "2024-01-01",
            "MATCHUP": "BOS @ ATL",
            "PTS": 105,
        },
    ]

    with (
        patch(
            "nba_api.stats.endpoints.leaguegamefinder.LeagueGameFinder",
            side_effect=[_finder_result(regular_season_rows), _finder_result([])],
        ) as mock_finder,
        patch("ingestion.sources.nba_stats.time.sleep") as mock_sleep,
    ):
        client = NBAStatsClient()
        games = client.get_games_for_season("2023-24")

    assert mock_finder.call_args_list[0].kwargs == {
        "season_nullable": "2023-24",
        "league_id_nullable": "00",
        "season_type_nullable": "Regular Season",
    }
    assert mock_finder.call_args_list[1].kwargs == {
        "season_nullable": "2023-24",
        "league_id_nullable": "00",
        "season_type_nullable": "Playoffs",
    }
    assert mock_sleep.call_count == 2
    assert games == [
        {
            "game_id": 100_022_300_500,
            "nba_game_id": "0022300500",
            "game_date": "2024-01-01",
            "season": 2023,
            "postseason": False,
            "status": "Final",
            "home_team": "Atlanta Hawks",
            "home_score": 110,
            "away_team": "Boston Celtics",
            "away_score": 105,
        }
    ]


def test_get_games_for_season_tags_playoffs_as_postseason():
    playoff_rows = [
        {
            "GAME_ID": "0049600001",
            "TEAM_NAME": "Chicago Bulls",
            "GAME_DATE": "1997-06-13",
            "MATCHUP": "CHI vs. UTA",
            "PTS": 90,
        },
        {
            "GAME_ID": "0049600001",
            "TEAM_NAME": "Utah Jazz",
            "GAME_DATE": "1997-06-13",
            "MATCHUP": "UTA @ CHI",
            "PTS": 86,
        },
    ]

    with (
        patch(
            "nba_api.stats.endpoints.leaguegamefinder.LeagueGameFinder",
            side_effect=[_finder_result([]), _finder_result(playoff_rows)],
        ),
        patch("ingestion.sources.nba_stats.time.sleep"),
    ):
        client = NBAStatsClient()
        games = client.get_games_for_season("1996-97")

    assert len(games) == 1
    assert games[0]["postseason"] is True
    assert games[0]["game_id"] == 100_049_600_001
    assert games[0]["season"] == 1996


def test_get_games_for_season_handles_multiple_games():
    # NOTE: the plan's brief used non-numeric GAME_ID values ("A"/"B") here,
    # which can't survive `offset_game_id`'s `int(nba_game_id)` call (used by
    # every other test in this file, and required by get_games_for_season
    # itself). Swapped for numeric-string ids -- same test intent (grouping
    # multiple distinct games by GAME_ID), just fixture data that the
    # implementation can actually accept.
    regular_season_rows = [
        {"GAME_ID": "100", "TEAM_NAME": "Dallas Mavericks", "GAME_DATE": "1996-11-01", "MATCHUP": "DAL vs. UTA", "PTS": 100},
        {"GAME_ID": "100", "TEAM_NAME": "Utah Jazz", "GAME_DATE": "1996-11-01", "MATCHUP": "UTA @ DAL", "PTS": 95},
        {"GAME_ID": "200", "TEAM_NAME": "Miami Heat", "GAME_DATE": "1996-11-02", "MATCHUP": "MIA vs. ORL", "PTS": 88},
        {"GAME_ID": "200", "TEAM_NAME": "Orlando Magic", "GAME_DATE": "1996-11-02", "MATCHUP": "ORL @ MIA", "PTS": 80},
    ]

    with (
        patch(
            "nba_api.stats.endpoints.leaguegamefinder.LeagueGameFinder",
            side_effect=[_finder_result(regular_season_rows), _finder_result([])],
        ),
        patch("ingestion.sources.nba_stats.time.sleep"),
    ):
        client = NBAStatsClient()
        games = client.get_games_for_season("1996-97")

    games_by_nba_id = {g["nba_game_id"]: g for g in games}
    assert games_by_nba_id["100"]["home_team"] == "Dallas Mavericks"
    assert games_by_nba_id["100"]["away_team"] == "Utah Jazz"
    assert games_by_nba_id["200"]["home_team"] == "Miami Heat"
    assert games_by_nba_id["200"]["away_team"] == "Orlando Magic"


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
