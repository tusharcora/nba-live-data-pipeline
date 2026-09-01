import httpx


class PublicFeedClient:
    """Secondary source — reconciliation for the same games as BallDontLieClient.

    Undocumented, no SLA — treated as unstable by design (docs/prd.md §03).
    Wired up in week 2 alongside live polling.

    Assumed payload shape (ESPN's public unauthenticated scoreboard endpoint,
    NOT yet verified against real ingested data — same convention as Week 1's
    dbt staging models for flagging an unverified upstream shape):

    GET https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=YYYYMMDD

    {
      "events": [
        {
          "id": "401584793",
          "date": "2024-01-01T00:00Z",
          "competitions": [
            {
              "competitors": [
                {
                  "homeAway": "home" | "away",
                  "team": {"displayName": "Atlanta Hawks"},
                  "score": "121"
                }
              ],
              "status": {"type": {"name": "STATUS_FINAL" | "STATUS_IN_PROGRESS" | ...}}
            }
          ]
        }
      ]
    }
    """

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url

    def _get(self, path: str, params: dict) -> dict:
        """Low-level GET against the public feed.

        Unauthenticated — no auth header is sent. Raises on any non-2xx
        response rather than silently returning a partial/error payload,
        mirroring BallDontLieClient's `_get`.
        """
        response = httpx.get(f"{self.base_url}{path}", params=params)
        response.raise_for_status()
        return response.json()

    def get_scoreboard(self, date: str) -> dict:
        """Fetch the scoreboard for a single date.

        Bronze stores whole API responses, not just the `events` list, so
        the returned value is the full decoded JSON response. A single GET
        per date — the scoreboard endpoint returns everything for the date
        in one response, so unlike balldontlie's `/games` there is no
        pagination to follow.
        """
        return self._get("/scoreboard", {"dates": date})
