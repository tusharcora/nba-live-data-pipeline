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

    def get_news(self) -> dict:
        """Fetch the current rolling window of NBA news articles.

        Real payload shape, verified directly against a live response
        2026-09-07 (docs/superpowers/specs/2026-09-07-nba-news-feed-design.md's
        Findings section) — unlike `get_scoreboard`'s assumed shape, this one
        is confirmed, not guessed:

        GET https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news

        {
          "header": "NBA News",
          "articles": [
            {
              "id": 49824980,
              "type": "Story",
              "headline": "...",
              "description": "...",
              "byline": "Marc J. Spears",
              "published": "2026-09-06T18:30:00Z",
              "lastModified": "2026-09-06T18:30:00Z",
              "links": {"web": {"href": "https://www.espn.com/nba/story/..."}}
            }
          ]
        }

        A rolling window of the most recent articles (~6 observed in one
        real pull), not a paginated archive — no `dates`/pagination params,
        unlike `get_scoreboard`.

        No retry/backoff on a non-2xx response or timeout: `_get()` raises
        via `raise_for_status()`, same as every other HTTP client in this
        codebase (`BallDontLieClient`, `get_scoreboard` itself) — a failed
        flow run is Prefect's own concern, not something wrapped here. This
        is a deliberate consistency choice, not a gap.
        """
        return self._get("/news", {})
