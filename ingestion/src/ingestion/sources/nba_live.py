"""nba_api's **live** scoreboard (`nba_api.live.nba.endpoints.scoreboard`)
— a different part of the `nba_api` package from the **historical**
`stats.nba.com` endpoints `ingestion/src/ingestion/sources/nba_stats.py`
wraps for `backfill_nba_stats_flow.py`.

That distinction matters for two reasons:

1. **File naming.** `nba_stats.py` already exists (the historical, local-
   only, human-run `NBAStatsClient`). This module is named `nba_live.py`
   to avoid colliding with it. The *data* this module writes still uses
   `source="nba_stats"` as its label (see `live_game_flow.py`) — only the
   file path differs.
2. **Deployability.** `nba_stats.py`'s module docstring documents
   `stats.nba.com` as sitting behind Akamai bot protection that blocks
   datacenter/cloud IPs, making that client "local-only, human-run,
   never scheduled, never CI, never a Prefect deployment." The live
   scoreboard endpoint targets a *different* NBA.com property
   (`cdn.nba.com`'s live-data JSON feed, not `stats.nba.com`), which is
   widely used unauthenticated from cloud/CI environments in the `nba_api`
   community without the same IP-blocking issue. **This is an assumption,
   not yet verified against a real request from this project's own
   deployment environment** — flagged per this codebase's "ASSUMED shape,
   not yet verified" convention (see `extract_balldontlie_live_states`'s
   docstring for the precedent). Confirm with a real call from the actual
   Prefect deployment target before relying on a scheduled cadence.

Real payload shape is ASSUMED per `nba_api`'s documented `ScoreBoard`
contract (`get_dict()["scoreboard"]["games"]`), not yet verified against a
live response:

    {
      "scoreboard": {
        "gameDate": "2026-09-06",
        "games": [
          {
            "gameId": "0022500123",
            "gameStatus": 1 | 2 | 3,   # 1=scheduled, 2=live, 3=final
            "gameStatusText": "7:30 pm ET" | "Qtr 3 4:12" | "Final" | ...,
            "gameTimeUTC": "2026-09-07T00:30:00Z",
            "period": 0,
            "gameClock": "",
            "homeTeam": {"teamCity": "Los Angeles", "teamName": "Lakers", "score": 0},
            "awayTeam": {"teamCity": "Boston", "teamName": "Celtics", "score": 0}
          },
          ...
        ]
      }
    }
"""

from __future__ import annotations

from nba_api.live.nba.endpoints import scoreboard


class NbaLiveScoreboardClient:
    """Wraps `nba_api`'s live scoreboard for dependency injection.

    No API key, no date parameter — the live scoreboard is always
    "today" (NBA.com's own notion of today) by construction.
    """

    def get_scoreboard(self) -> dict:
        return scoreboard.ScoreBoard().get_dict()
