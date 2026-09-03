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

Team-name-matching verification (Global Constraints step 3): compared
`nba_api`'s bundled canonical team list (`nba_api.stats.static.teams.
get_teams()`, which `nba_api` sources from `stats.nba.com`'s own team
master data — the same domain `TEAM_NAME` values come from) against
balldontlie's confirmed real `full_name` format (`dbt/models/marts/
games.sql` / `stg_games.sql`: "Atlanta Hawks", "Boston Celtics", "Dallas
Mavericks", etc.). All 30 team full names match byte-for-byte between the
two lists, **including the one name most commonly flagged as a cross-source
mismatch risk**: NBA.com's canonical list uses "Los Angeles Clippers" (not
the "LA Clippers" shorthand ESPN and some broadcasts use), which is exactly
balldontlie's format too. Conclusion: no hardcoded 30-team canonical-name
mapping is needed before calling `match_games_by_team_overlap` — both
sources are expected to use identical full team names. This is an
analytical determination from static reference data, not a live
`stats.nba.com` response, since this sandbox has no network access to that
host — the human's first real run against `LeagueGameFinder` is the actual
proof, and this client does not silently swallow a mismatch: an unmatched
NBA.com game is logged, not guessed at (see the flow).
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


class NBAStatsClient:
    """Wraps `nba_api`'s `stats.nba.com` endpoints for the local-only backfill.

    Every method that makes a real network call sleeps
    `REQUEST_PACING_SECONDS` immediately after that call returns (not
    before/around it — the pacing exists between consecutive requests, and
    the caller controls how many requests happen). This is intentionally
    inside the client, not the flow, per this project's rate-limit-pacing
    convention: callers should never need to remember to sleep.
    """

    def get_games_for_date(self, date_str: str) -> list[dict]:
        """Return one dict per NBA.com game played on `date_str`.

        `LeagueGameFinder` (filtered to a single-day date range) returns one
        row per *team* per game — two rows per game. This groups those rows
        by `GAME_ID` and returns `{"game_id": ..., "team_names": {...}}` per
        game, ready to feed straight into
        `quality.reconciliation.match_games_by_team_overlap` as a
        `(game_id, team_names, fields)` tuple (the caller attaches
        `fields`).
        """
        finder = leaguegamefinder.LeagueGameFinder(
            date_from_nullable=date_str, date_to_nullable=date_str
        )
        time.sleep(REQUEST_PACING_SECONDS)

        rows = finder.get_normalized_dict()["LeagueGameFinderResults"]

        games_by_id: dict[str, set[str]] = {}
        for row in rows:
            games_by_id.setdefault(row["GAME_ID"], set()).add(row["TEAM_NAME"])

        return [
            {"game_id": game_id, "team_names": team_names}
            for game_id, team_names in games_by_id.items()
        ]

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
