from datetime import date

import pytest
from fastapi.testclient import TestClient

from api.main import app
from api.routers.query_tools import (
    get_game_result_tool_reader,
    get_leaders_tool_reader,
    get_player_stat_aggregate_tool_reader,
    get_player_stats_tool_reader,
    get_team_games_tool_reader,
)

API_KEY = "test-service-key"

# --------------------------------------------------------------------------
# Shared fixture data
# --------------------------------------------------------------------------

FAKE_GAMES = [
    {
        "game_id": 1,
        "game_date": date(2024, 1, 3),
        "season": 2023,
        "status": "Final",
        "postseason": False,
        "home_team": "Los Angeles Lakers",
        "away_team": "Boston Celtics",
        "home_score": 112,
        "away_score": 118,
        "source_pulled_at": "2024-01-03T23:00:00",
    },
    {
        "game_id": 2,
        "game_date": date(2024, 1, 5),
        "season": 2023,
        "status": "Final",
        "postseason": False,
        "home_team": "Golden State Warriors",
        "away_team": "Los Angeles Lakers",
        "home_score": 101,
        "away_score": 109,
        "source_pulled_at": "2024-01-05T23:00:00",
    },
    {
        "game_id": 3,
        "game_date": date(2024, 1, 7),
        "season": 2023,
        "status": "Final",
        "postseason": False,
        "home_team": "Phoenix Suns",
        "away_team": "Boston Celtics",
        "home_score": 120,
        "away_score": 115,
        "source_pulled_at": "2024-01-07T23:00:00",
    },
    {
        "game_id": 4,
        "game_date": date(2024, 1, 3),
        "season": 2023,
        "status": "Final",
        "postseason": False,
        "home_team": "Los Angeles Clippers",
        "away_team": "Phoenix Suns",
        "home_score": 105,
        "away_score": 99,
        "source_pulled_at": "2024-01-03T23:00:00",
    },
]
GAMES_BY_ID = {g["game_id"]: g for g in FAKE_GAMES}

FAKE_PLAYER_STATS = [
    {
        "stat_id": 1,
        "game_id": 1,
        "player_id": 11,
        "player_first_name": "LeBron",
        "player_last_name": "James",
        "team": "Lakers",
        "points": 28,
        "rebounds": 8,
        "assists": 9,
        "steals": 1,
        "blocks": 0,
        "turnovers": 3,
        "minutes_played": "36:12",
    },
    {
        "stat_id": 2,
        "game_id": 1,
        "player_id": 22,
        "player_first_name": "Jayson",
        "player_last_name": "Tatum",
        "team": "Celtics",
        "points": 31,
        "rebounds": 7,
        "assists": 4,
        "steals": 2,
        "blocks": 1,
        "turnovers": 2,
        "minutes_played": "38:45",
    },
    {
        "stat_id": 3,
        "game_id": 2,
        "player_id": 11,
        "player_first_name": "LeBron",
        "player_last_name": "James",
        "team": "Lakers",
        "points": 22,
        "rebounds": 10,
        "assists": 6,
        "steals": 0,
        "blocks": 1,
        "turnovers": 1,
        "minutes_played": "34:02",
    },
    {
        "stat_id": 4,
        "game_id": 3,
        "player_id": 33,
        "player_first_name": "Michael",
        "player_last_name": "Jordan",
        "team": "Bulls",
        "points": 15,
        "rebounds": 3,
        "assists": 2,
        "steals": 1,
        "blocks": 0,
        "turnovers": 1,
        "minutes_played": "20:00",
    },
    {
        "stat_id": 5,
        "game_id": 3,
        "player_id": 44,
        "player_first_name": "Jordan",
        "player_last_name": "Poole",
        "team": "Warriors",
        "points": 19,
        "rebounds": 2,
        "assists": 5,
        "steals": 0,
        "blocks": 0,
        "turnovers": 2,
        "minutes_played": "25:00",
    },
]


# --------------------------------------------------------------------------
# Fake readers -- apply the same filtering a real SQL query would, so tests
# exercise real route behavior rather than a pre-filtered fixture.
# --------------------------------------------------------------------------


class FakePlayerStatsToolReader:
    def __init__(self, player_rows=None, games_by_id=None):
        self.player_rows = FAKE_PLAYER_STATS if player_rows is None else player_rows
        self.games_by_id = GAMES_BY_ID if games_by_id is None else games_by_id
        self.call_count = 0

    def distinct_player_names(self):
        return sorted(
            {f"{r['player_first_name']} {r['player_last_name']}" for r in self.player_rows}
        )

    def get_player_stats(self, player_name, start_date, end_date, limit):
        self.call_count += 1
        out = []
        for r in self.player_rows:
            full_name = f"{r['player_first_name']} {r['player_last_name']}"
            if full_name.lower() != player_name.lower():
                continue
            game = self.games_by_id[r["game_id"]]
            if start_date is not None and game["game_date"] < start_date:
                continue
            if end_date is not None and game["game_date"] > end_date:
                continue
            row = dict(r)
            row.update(
                {
                    "game_date": game["game_date"],
                    "home_team": game["home_team"],
                    "away_team": game["away_team"],
                    "home_score": game["home_score"],
                    "away_score": game["away_score"],
                }
            )
            out.append(row)
        # Same ORDER BY game_date DESC + LIMIT the real reader applies.
        out.sort(key=lambda row: row["game_date"], reverse=True)
        return out[:limit]


class FakeTeamGamesToolReader:
    def __init__(self, games=None):
        self.games = FAKE_GAMES if games is None else games
        self.call_count = 0

    def distinct_team_names(self):
        names = set()
        for g in self.games:
            names.add(g["home_team"])
            names.add(g["away_team"])
        return sorted(names)

    def get_team_games(self, team_name, start_date, end_date, limit):
        self.call_count += 1
        out = []
        for g in self.games:
            if g["home_team"] != team_name and g["away_team"] != team_name:
                continue
            if start_date is not None and g["game_date"] < start_date:
                continue
            if end_date is not None and g["game_date"] > end_date:
                continue
            out.append(dict(g))
        # Same ORDER BY game_date DESC + LIMIT the real reader applies.
        out.sort(key=lambda row: row["game_date"], reverse=True)
        return out[:limit]


class FakeLeadersToolReader:
    def __init__(self, player_rows=None, games_by_id=None):
        self.player_rows = FAKE_PLAYER_STATS if player_rows is None else player_rows
        self.games_by_id = GAMES_BY_ID if games_by_id is None else games_by_id
        self.call_count = 0

    def get_leaders(self, stat_column, start_date, end_date, limit):
        self.call_count += 1
        matching = []
        for r in self.player_rows:
            game = self.games_by_id[r["game_id"]]
            if start_date is not None and game["game_date"] < start_date:
                continue
            if end_date is not None and game["game_date"] > end_date:
                continue
            matching.append((r, game))

        if not matching:
            return {"leaders": [], "start_date": None, "end_date": None, "game_count": 0}

        dates = [game["game_date"] for _, game in matching]
        game_ids = {r["game_id"] for r, _ in matching}
        totals: dict[int, int] = {}
        names: dict[int, tuple[str, str]] = {}
        for r, _ in matching:
            pid = r["player_id"]
            totals[pid] = totals.get(pid, 0) + r[stat_column]
            names[pid] = (r["player_first_name"], r["player_last_name"])

        ranked = sorted(totals.items(), key=lambda kv: kv[1], reverse=True)[:limit]
        leaders = [
            {
                "player_id": pid,
                "player_first_name": names[pid][0],
                "player_last_name": names[pid][1],
                "total": total,
            }
            for pid, total in ranked
        ]
        return {
            "leaders": leaders,
            "start_date": min(dates),
            "end_date": max(dates),
            "game_count": len(game_ids),
        }


class FakeGameResultToolReader:
    def __init__(self, games=None, player_rows=None):
        self.games = FAKE_GAMES if games is None else games
        self.player_rows = FAKE_PLAYER_STATS if player_rows is None else player_rows
        self.call_count = 0

    def distinct_team_names(self):
        names = set()
        for g in self.games:
            names.add(g["home_team"])
            names.add(g["away_team"])
        return sorted(names)

    def get_game_result(self, team_a, team_b, game_date):
        self.call_count += 1
        for g in self.games:
            if g["game_date"] != game_date:
                continue
            if {g["home_team"], g["away_team"]} == {team_a, team_b}:
                return dict(g)
        return None

    def get_box_score(self, game_id):
        return [dict(r) for r in self.player_rows if r["game_id"] == game_id]


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("API_SERVICE_KEY", API_KEY)
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.pop(get_player_stats_tool_reader, None)
    app.dependency_overrides.pop(get_team_games_tool_reader, None)
    app.dependency_overrides.pop(get_leaders_tool_reader, None)
    app.dependency_overrides.pop(get_player_stat_aggregate_tool_reader, None)
    app.dependency_overrides.pop(get_game_result_tool_reader, None)


def _auth(**kwargs):
    kwargs.setdefault("headers", {})["X-API-Key"] = API_KEY
    return kwargs


# --------------------------------------------------------------------------
# get_player_stats
# --------------------------------------------------------------------------


def test_get_player_stats_exact_match(client):
    reader = FakePlayerStatsToolReader()
    app.dependency_overrides[get_player_stats_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/player-stats", **_auth(params={"player_name": "LeBron James"})
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["data"]["player_name"] == "LeBron James"
    # stat_id comes back as a JS-safe string, not a bare int (see
    # test_get_player_stats_stat_id_is_stringified_for_js_safety below for
    # the large-int case this actually protects against).
    assert {row["stat_id"] for row in body["data"]["games"]} == {"1", "3"}
    assert body["candidates"] is None
    assert body["message"] is None


def test_get_player_stats_fuzzy_single_hit_resolves_and_returns_ok(client):
    """A typo with exactly one close match resolves silently -- never a guess
    on a genuinely ambiguous name, but also never surfaced as ambiguous when
    there's truly only one candidate."""
    reader = FakePlayerStatsToolReader()
    app.dependency_overrides[get_player_stats_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/player-stats", **_auth(params={"player_name": "Lebron Jaems"})
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["data"]["player_name"] == "LeBron James"


def test_get_player_stats_ambiguous_name_returns_candidates(client):
    reader = FakePlayerStatsToolReader()
    app.dependency_overrides[get_player_stats_tool_reader] = lambda: reader

    resp = client.get("/tools/player-stats", **_auth(params={"player_name": "Jordan"}))

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ambiguous"
    assert body["data"] is None
    candidate_names = {c["name"] for c in body["candidates"]}
    assert candidate_names == {"Michael Jordan", "Jordan Poole"}
    assert body["message"]


def test_get_player_stats_no_match(client):
    reader = FakePlayerStatsToolReader()
    app.dependency_overrides[get_player_stats_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/player-stats", **_auth(params={"player_name": "Zzyzx Nobody"})
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "no_match"
    assert body["data"] is None
    assert body["message"]


def test_get_player_stats_resolved_name_but_no_rows_in_range_is_no_match(client):
    """A real player name that resolves, but with zero games in the
    requested date range, must still be `no_match` -- never a bare empty
    list dressed up as `ok`."""
    reader = FakePlayerStatsToolReader()
    app.dependency_overrides[get_player_stats_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/player-stats",
        **_auth(params={"player_name": "LeBron James", "date": "2099-01-01"}),
    )

    assert resp.status_code == 200
    assert resp.json()["status"] == "no_match"


def test_get_player_stats_rejects_malformed_date(client):
    reader = FakePlayerStatsToolReader()
    app.dependency_overrides[get_player_stats_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/player-stats",
        **_auth(params={"player_name": "LeBron James", "date": "not-a-date"}),
    )

    assert resp.status_code == 400


def test_get_player_stats_rejects_start_date_after_end_date(client):
    reader = FakePlayerStatsToolReader()
    app.dependency_overrides[get_player_stats_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/player-stats",
        **_auth(
            params={
                "player_name": "LeBron James",
                "start_date": "2024-01-05",
                "end_date": "2024-01-03",
            }
        ),
    )

    assert resp.status_code == 400


def test_get_player_stats_rejects_date_combined_with_start_date(client):
    reader = FakePlayerStatsToolReader()
    app.dependency_overrides[get_player_stats_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/player-stats",
        **_auth(
            params={
                "player_name": "LeBron James",
                "date": "2024-01-03",
                "start_date": "2024-01-01",
            }
        ),
    )

    assert resp.status_code == 400


def test_get_player_stats_filters_by_date_range(client):
    """`start_date`/`end_date` (without `date`) actually restricts which of
    the resolved player's games come back."""
    reader = FakePlayerStatsToolReader()
    app.dependency_overrides[get_player_stats_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/player-stats",
        **_auth(
            params={
                "player_name": "LeBron James",
                "start_date": "2024-01-04",
                "end_date": "2024-01-31",
            }
        ),
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    # LeBron has games on 2024-01-03 (stat_id 1) and 2024-01-05 (stat_id 3);
    # only the second falls in this range.
    assert {row["stat_id"] for row in body["data"]["games"]} == {"3"}


def test_get_player_stats_stat_id_is_stringified_for_js_safety(client):
    """Even a `PlayerStatsToolReader` that returns a raw (unstringified) int
    `stat_id` -- as a naive fake or a future reader implementation might --
    must come back over the wire as a JS-safe string, not a bare int that
    could lose precision past Number.MAX_SAFE_INTEGER in a JS client.
    """
    big_stat_id = 10_000_000_123_456_789

    class _RawIntStatIdReader:
        def distinct_player_names(self):
            return ["LeBron James"]

        def get_player_stats(self, player_name, start_date, end_date, limit):
            return [
                {
                    "stat_id": big_stat_id,
                    "game_id": 1,
                    "player_id": 11,
                    "player_first_name": "LeBron",
                    "player_last_name": "James",
                    "team": "Lakers",
                    "points": 28,
                    "rebounds": 8,
                    "assists": 9,
                    "steals": 1,
                    "blocks": 0,
                    "turnovers": 3,
                    "minutes_played": "36:12",
                    "game_date": "2024-01-03",
                    "home_team": "Los Angeles Lakers",
                    "away_team": "Boston Celtics",
                    "home_score": 112,
                    "away_score": 118,
                }
            ]

    app.dependency_overrides[get_player_stats_tool_reader] = lambda: _RawIntStatIdReader()

    resp = client.get(
        "/tools/player-stats", **_auth(params={"player_name": "LeBron James"})
    )

    assert resp.status_code == 200
    stat_id = resp.json()["data"]["games"][0]["stat_id"]
    assert stat_id == str(big_stat_id)
    assert isinstance(stat_id, str)


def test_get_player_stats_diacritic_insensitive_exact_match(client):
    """Real ingested data includes diacritic names (e.g. Luka Dončić,
    Nikola Jokić) -- a plain-ASCII query must still resolve exactly,
    not fall through to fuzzy (or worse, no_match)."""
    reader = FakePlayerStatsToolReader(
        player_rows=[
            {
                "stat_id": 99,
                "game_id": 1,
                "player_id": 77,
                "player_first_name": "Luka",
                "player_last_name": "Dončić",
                "team": "Mavericks",
                "points": 40,
                "rebounds": 10,
                "assists": 10,
                "steals": 1,
                "blocks": 0,
                "turnovers": 4,
                "minutes_played": "38:00",
            }
        ],
    )
    app.dependency_overrides[get_player_stats_tool_reader] = lambda: reader

    resp = client.get("/tools/player-stats", **_auth(params={"player_name": "Luka Doncic"}))

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["data"]["player_name"] == "Luka Dončić"


def test_get_player_stats_respects_limit_param(client):
    """Without a cap, a wide date range for a long-career player could
    return an unbounded row set into the LLM tool-calling loop."""
    reader = FakePlayerStatsToolReader()
    app.dependency_overrides[get_player_stats_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/player-stats", **_auth(params={"player_name": "LeBron James", "limit": 1})
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    games = body["data"]["games"]
    assert len(games) == 1
    # Most recent game first (game_date desc): Jan-5 (stat_id 3) over Jan-3 (stat_id 1).
    assert games[0]["stat_id"] == "3"


def test_get_player_stats_rejects_limit_above_upper_bound(client):
    reader = FakePlayerStatsToolReader()
    app.dependency_overrides[get_player_stats_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/player-stats",
        **_auth(params={"player_name": "LeBron James", "limit": 501}),
    )

    assert resp.status_code == 422


def test_get_player_stats_requires_api_key(client):
    reader = FakePlayerStatsToolReader()
    app.dependency_overrides[get_player_stats_tool_reader] = lambda: reader

    resp = client.get("/tools/player-stats", params={"player_name": "LeBron James"})

    assert resp.status_code == 401


# --------------------------------------------------------------------------
# get_team_games
# --------------------------------------------------------------------------


def test_get_team_games_happy_path(client):
    reader = FakeTeamGamesToolReader()
    app.dependency_overrides[get_team_games_tool_reader] = lambda: reader

    resp = client.get("/tools/team-games", **_auth(params={"team": "Boston Celtics"}))

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["data"]["team"] == "Boston Celtics"
    games = body["data"]["games"]
    assert {g["game_id"] for g in games} == {1, 3}
    away_game = next(g for g in games if g["game_id"] == 1)
    assert away_game["opponent"] == "Los Angeles Lakers"
    assert away_game["is_home"] is False
    assert away_game["team_score"] == 118
    assert away_game["opponent_score"] == 112


def test_get_team_games_fuzzy_single_hit(client):
    reader = FakeTeamGamesToolReader()
    app.dependency_overrides[get_team_games_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/team-games", **_auth(params={"team": "Golden State Warrior"})
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["data"]["team"] == "Golden State Warriors"


def test_get_team_games_ambiguous(client):
    reader = FakeTeamGamesToolReader()
    app.dependency_overrides[get_team_games_tool_reader] = lambda: reader

    resp = client.get("/tools/team-games", **_auth(params={"team": "Los Angeles"}))

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ambiguous"
    assert body["candidates"] is not None
    assert len(body["candidates"]) >= 2


def test_get_team_games_no_match(client):
    reader = FakeTeamGamesToolReader()
    app.dependency_overrides[get_team_games_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/team-games", **_auth(params={"team": "Nonexistent City Team"})
    )

    assert resp.status_code == 200
    assert resp.json()["status"] == "no_match"


def test_get_team_games_rejects_malformed_date(client):
    reader = FakeTeamGamesToolReader()
    app.dependency_overrides[get_team_games_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/team-games",
        **_auth(params={"team": "Boston Celtics", "date": "not-a-date"}),
    )

    assert resp.status_code == 400


def test_get_team_games_rejects_start_date_after_end_date(client):
    reader = FakeTeamGamesToolReader()
    app.dependency_overrides[get_team_games_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/team-games",
        **_auth(
            params={
                "team": "Boston Celtics",
                "start_date": "2024-01-07",
                "end_date": "2024-01-03",
            }
        ),
    )

    assert resp.status_code == 400


def test_get_team_games_rejects_date_combined_with_start_date(client):
    reader = FakeTeamGamesToolReader()
    app.dependency_overrides[get_team_games_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/team-games",
        **_auth(
            params={
                "team": "Boston Celtics",
                "date": "2024-01-03",
                "start_date": "2024-01-01",
            }
        ),
    )

    assert resp.status_code == 400


def test_get_team_games_filters_by_date_range(client):
    """`start_date`/`end_date` (without `date`) actually restricts which of
    the resolved team's games come back."""
    reader = FakeTeamGamesToolReader()
    app.dependency_overrides[get_team_games_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/team-games",
        **_auth(
            params={
                "team": "Boston Celtics",
                "start_date": "2024-01-06",
                "end_date": "2024-01-31",
            }
        ),
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    # Celtics play on 2024-01-03 (game_id 1) and 2024-01-07 (game_id 3);
    # only the second falls in this range.
    assert {g["game_id"] for g in body["data"]["games"]} == {3}


def test_get_team_games_respects_limit_param(client):
    """Without a cap, a wide date range for a long-tenured franchise could
    return an unbounded row set into the LLM tool-calling loop."""
    reader = FakeTeamGamesToolReader()
    app.dependency_overrides[get_team_games_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/team-games", **_auth(params={"team": "Boston Celtics", "limit": 1})
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    games = body["data"]["games"]
    assert len(games) == 1
    # Most recent Celtics game first (game_date desc): Jan-7 (game_id 3) over Jan-3 (game_id 1).
    assert games[0]["game_id"] == 3


def test_get_team_games_rejects_limit_above_upper_bound(client):
    reader = FakeTeamGamesToolReader()
    app.dependency_overrides[get_team_games_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/team-games", **_auth(params={"team": "Boston Celtics", "limit": 501})
    )

    assert resp.status_code == 422


def test_get_team_games_requires_api_key(client):
    reader = FakeTeamGamesToolReader()
    app.dependency_overrides[get_team_games_tool_reader] = lambda: reader

    resp = client.get("/tools/team-games", params={"team": "Boston Celtics"})

    assert resp.status_code == 401


# --------------------------------------------------------------------------
# get_leaders
# --------------------------------------------------------------------------


def test_get_leaders_happy_path_embeds_date_range_and_game_count(client):
    reader = FakeLeadersToolReader()
    app.dependency_overrides[get_leaders_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/leaders",
        **_auth(
            params={
                "stat": "assists",
                "start_date": "2024-01-01",
                "end_date": "2024-01-31",
                "limit": 5,
            }
        ),
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    data = body["data"]
    assert data["stat"] == "assists"
    # LeBron: 9 + 6 = 15 assists across two games -- the top assists leader.
    assert data["leaders"][0]["player_name"] == "LeBron James"
    assert data["leaders"][0]["value"] == 15
    assert data["date_range"] == {"start_date": "2024-01-03", "end_date": "2024-01-07"}
    assert data["game_count"] == 3


def test_get_leaders_no_rows_in_range_is_no_match(client):
    reader = FakeLeadersToolReader()
    app.dependency_overrides[get_leaders_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/leaders",
        **_auth(params={"stat": "assists", "start_date": "2099-01-01"}),
    )

    assert resp.status_code == 200
    assert resp.json()["status"] == "no_match"


def test_get_leaders_rejects_start_date_after_end_date(client):
    reader = FakeLeadersToolReader()
    app.dependency_overrides[get_leaders_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/leaders",
        **_auth(
            params={
                "stat": "assists",
                "start_date": "2024-01-07",
                "end_date": "2024-01-03",
            }
        ),
    )

    assert resp.status_code == 400
    assert reader.call_count == 0


def test_get_leaders_rejects_limit_above_upper_bound(client):
    reader = FakeLeadersToolReader()
    app.dependency_overrides[get_leaders_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/leaders", **_auth(params={"stat": "assists", "limit": 101})
    )

    assert resp.status_code == 422


def test_get_leaders_rejects_unknown_stat(client):
    reader = FakeLeadersToolReader()
    app.dependency_overrides[get_leaders_tool_reader] = lambda: reader

    resp = client.get("/tools/leaders", **_auth(params={"stat": "fouls"}))

    assert resp.status_code == 400
    assert reader.call_count == 0


def test_get_leaders_rejects_malformed_date(client):
    reader = FakeLeadersToolReader()
    app.dependency_overrides[get_leaders_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/leaders", **_auth(params={"stat": "assists", "start_date": "not-a-date"})
    )

    assert resp.status_code == 400


def test_get_leaders_stat_param_is_case_insensitive(client):
    """Consistent with this module's fuzzy name matching being
    case-insensitive -- a caller/LLM shouldn't need to get a fixed,
    small enum-like param's exact case right either."""
    reader = FakeLeadersToolReader()
    app.dependency_overrides[get_leaders_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/leaders",
        **_auth(
            params={
                "stat": "ASSISTS",
                "start_date": "2024-01-01",
                "end_date": "2024-01-31",
            }
        ),
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["data"]["stat"] == "assists"
    assert reader.call_count == 1


def test_get_leaders_requires_api_key(client):
    reader = FakeLeadersToolReader()
    app.dependency_overrides[get_leaders_tool_reader] = lambda: reader

    resp = client.get("/tools/leaders", params={"stat": "assists"})

    assert resp.status_code == 401


# --------------------------------------------------------------------------
# get_player_stat_aggregate
# --------------------------------------------------------------------------


class FakePlayerStatAggregateToolReader:
    """Applies the same filtering/aggregation a real SQL query would (see
    SQLAlchemyPlayerStatAggregateToolReader), rather than pre-computing the
    answer, so tests exercise real route behavior."""

    def __init__(self, player_rows=None, games_by_id=None):
        self.player_rows = FAKE_PLAYER_STATS if player_rows is None else player_rows
        self.games_by_id = GAMES_BY_ID if games_by_id is None else games_by_id
        self.call_count = 0

    def distinct_player_names(self):
        return sorted(
            {f"{r['player_first_name']} {r['player_last_name']}" for r in self.player_rows}
        )

    def get_aggregate(self, player_name, stat_column, operation, threshold, start_date, end_date):
        self.call_count += 1
        matching = []
        for r in self.player_rows:
            full_name = f"{r['player_first_name']} {r['player_last_name']}"
            if full_name.lower() != player_name.lower():
                continue
            game = self.games_by_id[r["game_id"]]
            if start_date is not None and game["game_date"] < start_date:
                continue
            if end_date is not None and game["game_date"] > end_date:
                continue
            row = dict(r)
            row.update(
                {
                    "game_date": game["game_date"],
                    "home_team": game["home_team"],
                    "away_team": game["away_team"],
                    "home_score": game["home_score"],
                    "away_score": game["away_score"],
                }
            )
            matching.append(row)

        game_count_considered = len(matching)
        if game_count_considered == 0:
            return {
                "game_count_considered": 0,
                "value": None,
                "matching_games": None,
                "extreme_game": None,
                "date_range": None,
            }

        dates = [row["game_date"] for row in matching]
        date_range = {"start_date": min(dates), "end_date": max(dates)}

        def _stringify(row):
            out = dict(row)
            out["stat_id"] = str(out["stat_id"])
            return out

        if operation in ("sum", "avg"):
            total = sum(row[stat_column] for row in matching)
            value = total / game_count_considered if operation == "avg" else total
            return {
                "game_count_considered": game_count_considered,
                "value": value,
                "matching_games": None,
                "extreme_game": None,
                "date_range": date_range,
            }

        if operation in ("max", "min"):
            best_value = (
                max(row[stat_column] for row in matching)
                if operation == "max"
                else min(row[stat_column] for row in matching)
            )
            tied = [row for row in matching if row[stat_column] == best_value]
            tied.sort(key=lambda row: row["game_date"], reverse=True)  # most recent wins ties
            return {
                "game_count_considered": game_count_considered,
                "value": best_value,
                "matching_games": None,
                "extreme_game": _stringify(tied[0]),
                "date_range": date_range,
            }

        # count_over_threshold / count_under_threshold
        if operation == "count_over_threshold":
            hits = [row for row in matching if row[stat_column] >= threshold]
        else:
            hits = [row for row in matching if row[stat_column] <= threshold]
        hits.sort(key=lambda row: row["game_date"], reverse=True)
        return {
            "game_count_considered": game_count_considered,
            "value": len(hits),
            "matching_games": [_stringify(row) for row in hits[:20]],
            "extreme_game": None,
            "date_range": date_range,
        }


def test_get_player_stat_aggregate_count_over_threshold_boundary_inclusive(client):
    # LeBron scores exactly 22 and 28 in the fixture -- >= 22 must include both.
    reader = FakePlayerStatAggregateToolReader()
    app.dependency_overrides[get_player_stat_aggregate_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/player-stat-aggregate",
        **_auth(
            params={
                "player_name": "LeBron James",
                "stat": "points",
                "operation": "count_over_threshold",
                "threshold": 22,
            }
        ),
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["data"]["value"] == 2
    assert body["data"]["game_count_considered"] == 2
    assert body["data"]["matching_games_truncated"] is False


def test_get_player_stat_aggregate_zero_result_is_ok_not_no_match(client):
    # LeBron never scores 50+ in the fixture, but he has real games in
    # range -- this must be a real "ok" answer of 0, never no_match. This
    # is the exact correctness risk this design flagged: a future "fix"
    # collapsing a falsy 0 into no_match must fail this test.
    reader = FakePlayerStatAggregateToolReader()
    app.dependency_overrides[get_player_stat_aggregate_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/player-stat-aggregate",
        **_auth(
            params={
                "player_name": "LeBron James",
                "stat": "points",
                "operation": "count_over_threshold",
                "threshold": 50,
            }
        ),
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["data"]["value"] == 0
    assert body["data"]["game_count_considered"] == 2


def test_get_player_stat_aggregate_no_games_in_range_is_no_match(client):
    reader = FakePlayerStatAggregateToolReader()
    app.dependency_overrides[get_player_stat_aggregate_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/player-stat-aggregate",
        **_auth(
            params={
                "player_name": "LeBron James",
                "stat": "points",
                "operation": "sum",
                "start_date": "2099-01-01",
            }
        ),
    )

    assert resp.status_code == 200
    assert resp.json()["status"] == "no_match"


def test_get_player_stat_aggregate_max_tie_break_most_recent(client):
    # Two fabricated games tied for LeBron's max rebounds (10) -- the more
    # recent one (game_id 6, 2024-01-09) must be cited, not game_id 3.
    tied_rows = FAKE_PLAYER_STATS + [
        {
            "stat_id": 6,
            "game_id": 6,
            "player_id": 11,
            "player_first_name": "LeBron",
            "player_last_name": "James",
            "team": "Lakers",
            "points": 20,
            "rebounds": 10,
            "assists": 5,
            "steals": 1,
            "blocks": 0,
            "turnovers": 2,
            "minutes_played": "33:00",
        }
    ]
    games_by_id = dict(GAMES_BY_ID)
    games_by_id[6] = {
        "game_id": 6,
        "game_date": date(2024, 1, 9),
        "season": 2023,
        "status": "Final",
        "postseason": False,
        "home_team": "Los Angeles Lakers",
        "away_team": "Denver Nuggets",
        "home_score": 110,
        "away_score": 104,
        "source_pulled_at": "2024-01-09T23:00:00",
    }
    reader = FakePlayerStatAggregateToolReader(player_rows=tied_rows, games_by_id=games_by_id)
    app.dependency_overrides[get_player_stat_aggregate_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/player-stat-aggregate",
        **_auth(
            params={"player_name": "LeBron James", "stat": "rebounds", "operation": "max"}
        ),
    )

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["value"] == 10
    assert data["extreme_game"]["game_id"] == 6


def test_get_player_stat_aggregate_matching_games_truncated_flag(client):
    # 25 games all scoring 30+ -- value must be the true 25, matching_games
    # capped at 20, and matching_games_truncated must be True.
    many_rows = []
    games_by_id = {}
    for i in range(25):
        game_id = 100 + i
        many_rows.append(
            {
                "stat_id": game_id,
                "game_id": game_id,
                "player_id": 11,
                "player_first_name": "LeBron",
                "player_last_name": "James",
                "team": "Lakers",
                "points": 30,
                "rebounds": 8,
                "assists": 7,
                "steals": 1,
                "blocks": 0,
                "turnovers": 2,
                "minutes_played": "35:00",
            }
        )
        games_by_id[game_id] = {
            "game_id": game_id,
            "game_date": date(2024, 1, 1 + i),
            "season": 2023,
            "status": "Final",
            "postseason": False,
            "home_team": "Los Angeles Lakers",
            "away_team": "Denver Nuggets",
            "home_score": 110,
            "away_score": 104,
            "source_pulled_at": "2024-01-01T23:00:00",
        }
    reader = FakePlayerStatAggregateToolReader(player_rows=many_rows, games_by_id=games_by_id)
    app.dependency_overrides[get_player_stat_aggregate_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/player-stat-aggregate",
        **_auth(
            params={
                "player_name": "LeBron James",
                "stat": "points",
                "operation": "count_over_threshold",
                "threshold": 30,
            }
        ),
    )

    data = resp.json()["data"]
    assert data["value"] == 25
    assert len(data["matching_games"]) == 20
    assert data["matching_games_truncated"] is True


def test_get_player_stat_aggregate_default_date_range_is_full_history(client):
    reader = FakePlayerStatAggregateToolReader()
    app.dependency_overrides[get_player_stat_aggregate_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/player-stat-aggregate",
        **_auth(params={"player_name": "LeBron James", "stat": "points", "operation": "avg"}),
    )

    data = resp.json()["data"]
    # LeBron's two fixture games are 2024-01-03 and 2024-01-05 -- omitting
    # date/date_range must return that full span, not a guessed narrower one.
    assert data["date_range"] == {"start_date": "2024-01-03", "end_date": "2024-01-05"}


def test_get_player_stat_aggregate_rejects_threshold_with_non_count_operation(client):
    reader = FakePlayerStatAggregateToolReader()
    app.dependency_overrides[get_player_stat_aggregate_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/player-stat-aggregate",
        **_auth(
            params={
                "player_name": "LeBron James",
                "stat": "points",
                "operation": "avg",
                "threshold": 20,
            }
        ),
    )

    assert resp.status_code == 400
    assert reader.call_count == 0


def test_get_player_stat_aggregate_requires_threshold_for_count_operation(client):
    reader = FakePlayerStatAggregateToolReader()
    app.dependency_overrides[get_player_stat_aggregate_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/player-stat-aggregate",
        **_auth(
            params={
                "player_name": "LeBron James",
                "stat": "points",
                "operation": "count_over_threshold",
            }
        ),
    )

    assert resp.status_code == 400
    assert reader.call_count == 0


def test_get_player_stat_aggregate_rejects_unknown_operation(client):
    reader = FakePlayerStatAggregateToolReader()
    app.dependency_overrides[get_player_stat_aggregate_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/player-stat-aggregate",
        **_auth(
            params={"player_name": "LeBron James", "stat": "points", "operation": "median"}
        ),
    )

    assert resp.status_code == 400
    assert reader.call_count == 0


def test_get_player_stat_aggregate_ambiguous_name(client):
    # "Jordan" fuzzy-matches both "Michael Jordan" and "Jordan Poole" in the
    # shared FAKE_PLAYER_STATS fixture -- same query and same two candidates
    # api/tests/test_query_tools.py's existing
    # test_get_player_stats_ambiguous_name_returns_candidates already
    # exercises for get_player_stats, reused here since it's a real
    # ambiguous case (neither name is an exact match for "Jordan", so
    # _resolve_name's exact-match-first branch never short-circuits it).
    reader = FakePlayerStatAggregateToolReader()
    app.dependency_overrides[get_player_stat_aggregate_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/player-stat-aggregate",
        **_auth(params={"player_name": "Jordan", "stat": "points", "operation": "sum"}),
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ambiguous"
    candidate_names = {c["name"] for c in body["candidates"]}
    assert candidate_names == {"Michael Jordan", "Jordan Poole"}


def test_get_player_stat_aggregate_requires_api_key(client):
    reader = FakePlayerStatAggregateToolReader()
    app.dependency_overrides[get_player_stat_aggregate_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/player-stat-aggregate",
        params={"player_name": "LeBron James", "stat": "points", "operation": "sum"},
    )

    assert resp.status_code == 401


# --------------------------------------------------------------------------
# get_game_result
# --------------------------------------------------------------------------


def test_get_game_result_found_includes_box_score(client):
    reader = FakeGameResultToolReader()
    app.dependency_overrides[get_game_result_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/game-result",
        **_auth(
            params={
                "team_a": "Los Angeles Lakers",
                "team_b": "Boston Celtics",
                "date": "2024-01-03",
            }
        ),
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["data"]["game"]["game_id"] == 1
    assert body["data"]["game"]["home_score"] == 112
    # stat_id comes back as a JS-safe string, not a bare int.
    box_score_ids = {row["stat_id"] for row in body["data"]["box_score"]}
    assert box_score_ids == {"1", "2"}


def test_get_game_result_order_of_teams_does_not_matter(client):
    reader = FakeGameResultToolReader()
    app.dependency_overrides[get_game_result_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/game-result",
        **_auth(
            params={
                "team_a": "Boston Celtics",
                "team_b": "Los Angeles Lakers",
                "date": "2024-01-03",
            }
        ),
    )

    assert resp.status_code == 200
    assert resp.json()["data"]["game"]["game_id"] == 1


def test_get_game_result_no_match(client):
    reader = FakeGameResultToolReader()
    app.dependency_overrides[get_game_result_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/game-result",
        **_auth(
            params={
                "team_a": "Los Angeles Lakers",
                "team_b": "Boston Celtics",
                "date": "2024-06-01",
            }
        ),
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "no_match"
    assert body["data"] is None


def test_get_game_result_ambiguous_team_a(client):
    reader = FakeGameResultToolReader()
    app.dependency_overrides[get_game_result_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/game-result",
        **_auth(
            params={"team_a": "Los Angeles", "team_b": "Boston Celtics", "date": "2024-01-03"}
        ),
    )

    assert resp.status_code == 200
    assert resp.json()["status"] == "ambiguous"


def test_get_game_result_no_match_team_name(client):
    reader = FakeGameResultToolReader()
    app.dependency_overrides[get_game_result_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/game-result",
        **_auth(
            params={
                "team_a": "Nonexistent City Team",
                "team_b": "Boston Celtics",
                "date": "2024-01-03",
            }
        ),
    )

    assert resp.status_code == 200
    assert resp.json()["status"] == "no_match"


def test_get_game_result_ambiguous_team_b(client):
    """Mirrors test_get_game_result_ambiguous_team_a -- team_b is resolved
    independently of team_a, and an ambiguous team_b must surface the same
    way an ambiguous team_a does, not be masked by team_a already having
    resolved cleanly."""
    reader = FakeGameResultToolReader()
    app.dependency_overrides[get_game_result_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/game-result",
        **_auth(
            params={"team_a": "Boston Celtics", "team_b": "Los Angeles", "date": "2024-01-03"}
        ),
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ambiguous"
    candidate_names = {c["name"] for c in body["candidates"]}
    assert candidate_names == {"Los Angeles Lakers", "Los Angeles Clippers"}


def test_get_game_result_no_match_team_b(client):
    """Mirrors test_get_game_result_no_match_team_name, but for team_b --
    a team_a that resolves cleanly must not short-circuit team_b's own
    no-match check."""
    reader = FakeGameResultToolReader()
    app.dependency_overrides[get_game_result_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/game-result",
        **_auth(
            params={
                "team_a": "Los Angeles Lakers",
                "team_b": "Nonexistent City Team",
                "date": "2024-01-03",
            }
        ),
    )

    assert resp.status_code == 200
    assert resp.json()["status"] == "no_match"


def test_get_game_result_rejects_malformed_date(client):
    reader = FakeGameResultToolReader()
    app.dependency_overrides[get_game_result_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/game-result",
        **_auth(
            params={
                "team_a": "Los Angeles Lakers",
                "team_b": "Boston Celtics",
                "date": "not-a-date",
            }
        ),
    )

    assert resp.status_code == 400


def test_get_game_result_same_team_resolved_twice_is_no_match(client):
    """team_a and team_b resolving to the same team (e.g. two differently-
    worded queries for the same franchise) must be a clear no_match, not the
    confusing 'No game found between X and X' that a same-team lookup would
    otherwise produce."""
    reader = FakeGameResultToolReader()
    app.dependency_overrides[get_game_result_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/game-result",
        **_auth(
            params={
                "team_a": "Los Angeles Lakers",
                "team_b": "Los Angeles Lakers",
                "date": "2024-01-03",
            }
        ),
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "no_match"
    assert "same team" in body["message"]
    assert reader.call_count == 0  # never reached the reader's game lookup


def test_get_game_result_stat_id_is_stringified_for_js_safety(client):
    """Even a `GameResultToolReader` that returns a raw (unstringified) int
    `stat_id` in its box score must come back over the wire as a JS-safe
    string, not a bare int."""
    big_stat_id = 10_000_000_123_456_789

    class _RawIntStatIdReader:
        def distinct_team_names(self):
            return ["Los Angeles Lakers", "Boston Celtics"]

        def get_game_result(self, team_a, team_b, game_date):
            return {
                "game_id": 1,
                "game_date": "2024-01-03",
                "season": 2023,
                "status": "Final",
                "postseason": False,
                "home_team": "Los Angeles Lakers",
                "away_team": "Boston Celtics",
                "home_score": 112,
                "away_score": 118,
                "source_pulled_at": "2024-01-03T23:00:00",
            }

        def get_box_score(self, game_id):
            return [
                {
                    "stat_id": big_stat_id,
                    "game_id": 1,
                    "player_id": 11,
                    "player_first_name": "LeBron",
                    "player_last_name": "James",
                    "team": "Lakers",
                    "points": 28,
                    "rebounds": 8,
                    "assists": 9,
                    "steals": 1,
                    "blocks": 0,
                    "turnovers": 3,
                    "minutes_played": "36:12",
                }
            ]

    app.dependency_overrides[get_game_result_tool_reader] = lambda: _RawIntStatIdReader()

    resp = client.get(
        "/tools/game-result",
        **_auth(
            params={
                "team_a": "Los Angeles Lakers",
                "team_b": "Boston Celtics",
                "date": "2024-01-03",
            }
        ),
    )

    assert resp.status_code == 200
    stat_id = resp.json()["data"]["box_score"][0]["stat_id"]
    assert stat_id == str(big_stat_id)
    assert isinstance(stat_id, str)


def test_get_game_result_requires_api_key(client):
    reader = FakeGameResultToolReader()
    app.dependency_overrides[get_game_result_tool_reader] = lambda: reader

    resp = client.get(
        "/tools/game-result",
        params={
            "team_a": "Los Angeles Lakers",
            "team_b": "Boston Celtics",
            "date": "2024-01-03",
        },
    )

    assert resp.status_code == 401
