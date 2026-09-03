"""NBA.com (`stats.nba.com`) box-score source, via the `nba_api` package.

**Local-only, human-run source — never scheduled, never CI, never a Prefect
deployment.** `stats.nba.com` sits behind Akamai bot protection that blocks
datacenter/cloud IPs outright, so this client only works run ad hoc from a
human's own residential-IP machine (see
`ingestion/src/ingestion/flows/backfill_nba_stats_flow.py`'s module
docstring for the full write-up of this as a deliberate, named ToS
trade-off).

Real payload shapes (confirmed 2026-09 by installing `nba_api==1.11.4` and
reading its endpoint source directly — `nba_api/stats/endpoints/
leaguegamefinder.py` and `.../boxscoretraditionalv2.py` — rather than
guessing at columns; no live `stats.nba.com` call was made from this
sandbox):

- `LeagueGameFinder(...).get_normalized_dict()["LeagueGameFinderResults"]`
  returns one row **per team per game** (so two rows per game), with real
  columns including `GAME_ID`, `GAME_DATE`, `TEAM_ID`, `TEAM_NAME`,
  `TEAM_ABBREVIATION`, `MATCHUP`, `WL`, plus the team's box-score totals for
  that game (`PTS`, `REB`, `AST`, ...). `TEAM_NAME` is documented/known to
  carry the same full "City + Nickname" style balldontlie uses for
  `home_team`/`away_team` (e.g. "Atlanta Hawks", "Los Angeles Lakers") — see
  the team-name comparison below.
- `get_games_for_season` queries `LeagueGameFinder` by `season_nullable`/
  `season_type_nullable` rather than by date, confirmed against a real call
  during design (1996-97: 1,189 regular-season + 72 playoff games; 2024-25:
  1,230 + 84 — both counts matching real historical records). This replaces
  the old per-date discovery method entirely — no flow uses date-based
  discovery anymore.
- `BoxScoreTraditionalV2(game_id=...).get_normalized_dict()["PlayerStats"]`
  returns one row per player who appeared, with real columns including
  `GAME_ID`, `TEAM_ID`, `TEAM_ABBREVIATION`, `TEAM_CITY`, `PLAYER_ID`,
  `PLAYER_NAME`, `START_POSITION`, `COMMENT`, `MIN`, and the usual box-score
  stat columns (`PTS`, `REB`, `AST`, `STL`, `BLK`, `TO`, `PF`,
  `PLUS_MINUS`, shooting splits). `PLAYER_NAME` is a single "First Last"
  string (e.g. "Gary Trent Jr."), which is why `player_key` is computed
  here rather than downstream.

  Note (found while reading the installed package, not previously known):
  `BoxScoreTraditionalV2` is deprecated by `nba_api` as of the 2025-26
  season in favor of `BoxScoreTraditionalV3`, with a `DeprecationWarning`
  raised on every construction. `nba_api`'s own docs say NBA.com has
  stopped *publishing new* data on this endpoint for the current season —
  but this flow is a historical backfill against already-completed 2024
  games, which is exactly the kind of past-season data this endpoint was
  built to serve, so V2 is used deliberately here (its already-keyed
  `PlayerStats` result matches this project's "no positional parsing in
  dbt" requirement exactly). Flagged in the PR for the human to keep in
  mind if this is ever pointed at a current-season date.
"""

from __future__ import annotations

import time

from nba_api.stats.endpoints import boxscoretraditionalv2, leaguegamefinder

from ingestion.normalization import normalize_player_key

# Minimum pause between every real request this client sends to
# stats.nba.com, regardless of endpoint. 600ms is a community-found "safe"
# floor reported in github.com/swar/nba_api issue discussion threads about
# avoiding 403/CAPTCHA responses from Akamai's bot protection when requests
# are sent back-to-back from a single IP — not an official rate limit
# published by NBA.com (there isn't one), just the pacing this project has
# chosen to bake in rather than leave to caller discipline.
REQUEST_PACING_SECONDS = 0.6

# Offsets nba_api's own GAME_ID so it can never collide with balldontlie's
# native sequential games.id (currently ~1,038,000 and growing). 100 billion
# is ~96,000x balldontlie's current id -- far more headroom than that
# sequence will plausibly reach -- while keeping stg_player_game_stats_nba
# .sql's `stat_id = game_id * 10,000,000 + player_id` composite comfortably
# inside Postgres bigint's ~9.22x10^18 ceiling (worked realistic max
# ~1.0x10^18, ~9x headroom). A larger, seemingly "safer" offset (e.g. 1
# trillion) was considered and rejected during design: it overflows that
# multiplication by several orders of magnitude.
NBA_GAME_ID_OFFSET = 100_000_000_000


def offset_game_id(nba_game_id: str) -> int:
    """Namespace nba_api's own GAME_ID into a range disjoint from
    balldontlie's native game_id space -- see NBA_GAME_ID_OFFSET above."""
    return NBA_GAME_ID_OFFSET + int(nba_game_id)


class NBAStatsClient:
    """Wraps `nba_api`'s `stats.nba.com` endpoints for the local-only backfill.

    Every method that makes a real network call sleeps
    `REQUEST_PACING_SECONDS` immediately after that call returns (not
    before/around it — the pacing exists between consecutive requests, and
    the caller controls how many requests happen). This is intentionally
    inside the client, not the flow, per this project's rate-limit-pacing
    convention: callers should never need to remember to sleep.
    """

    def get_games_for_season(self, season: str) -> list[dict]:
        """Return one dict per NBA.com game played in `season` (e.g.
        "1996-97"), covering both regular-season and playoff games.

        All-Star and Pre Season games are excluded by construction -- only
        `season_type_nullable="Regular Season"` and `"Playoffs"` are ever
        queried, never a name-based post-filter.

        `LeagueGameFinder` returns one row per *team* per game (two rows
        per game). This groups those by GAME_ID, and for each pair uses
        the `MATCHUP` field ("CHI vs. UTA" means the row's team is home;
        "CHI @ UTA" means it's away) to determine home/away and takes each
        row's own `PTS` as that side's score. Every returned game's
        `game_id` is already offset via `offset_game_id` -- callers never
        apply the offset themselves. `nba_game_id` (the raw, un-offset
        string) is included too, since `get_boxscore` needs the raw id.
        """
        games_by_id: dict[str, dict] = {}

        for season_type, postseason in (
            ("Regular Season", False),
            ("Playoffs", True),
        ):
            finder = leaguegamefinder.LeagueGameFinder(
                season_nullable=season,
                league_id_nullable="00",
                season_type_nullable=season_type,
            )
            time.sleep(REQUEST_PACING_SECONDS)

            for row in finder.get_normalized_dict()["LeagueGameFinderResults"]:
                game = games_by_id.setdefault(
                    row["GAME_ID"],
                    {
                        "game_id": offset_game_id(row["GAME_ID"]),
                        "nba_game_id": row["GAME_ID"],
                        "game_date": row["GAME_DATE"],
                        "season": int(season[:4]),
                        "postseason": postseason,
                        "status": "Final",
                    },
                )
                if "vs." in row["MATCHUP"]:
                    game["home_team"] = row["TEAM_NAME"]
                    game["home_score"] = row["PTS"]
                else:
                    game["away_team"] = row["TEAM_NAME"]
                    game["away_score"] = row["PTS"]

        return list(games_by_id.values())

    def get_boxscore(self, nba_game_id: str) -> list[dict]:
        """Return the per-player traditional box score for one NBA.com game.

        Uses `.get_normalized_dict()["PlayerStats"]` (already keyed dicts),
        never `.get_dict()`'s raw `headers`/`rowSet` positional shape — that
        would push fragile positional column parsing into dbt, which this
        project's staging models are built to avoid.

        Each returned row is the real `PlayerStats` dict plus one added key,
        `player_key`, computed via `ingestion.normalization.
        normalize_player_key(row["PLAYER_NAME"])`. This is required so the
        Bronze payload already carries a cross-source player-matching key —
        dbt cannot run Python inline, so this can't be deferred downstream.
        """
        boxscore = boxscoretraditionalv2.BoxScoreTraditionalV2(game_id=nba_game_id)
        time.sleep(REQUEST_PACING_SECONDS)

        player_rows = boxscore.get_normalized_dict()["PlayerStats"]

        result = []
        for row in player_rows:
            row_with_key = dict(row)
            row_with_key["player_key"] = normalize_player_key(row["PLAYER_NAME"])
            result.append(row_with_key)
        return result
