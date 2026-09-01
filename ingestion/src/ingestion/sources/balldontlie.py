from collections.abc import Iterator

import httpx


class BallDontLieClient:
    """Primary source — box scores, live game state, play-by-play, injuries, standings.

    Wired up in week 1 (backfill) and week 2 (live polling); see docs/prd.md §03/§12.
    """

    def __init__(
        self, api_key: str, base_url: str = "https://api.balldontlie.io/v1"
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url

    def _get(self, path: str, params: dict) -> dict:
        """Low-level GET against the balldontlie API.

        Sends the v1 API's `Authorization: <key>` header convention (no
        "Bearer" prefix) and raises on any non-2xx response rather than
        silently returning a partial/error payload.
        """
        response = httpx.get(
            f"{self.base_url}{path}",
            params=params,
            headers={"Authorization": self.api_key},
        )
        response.raise_for_status()
        return response.json()

    def get_games_pages(self, date: str) -> Iterator[dict]:
        """Yield every page of the `/games` response for a single date.

        Bronze stores whole API responses, not just the `data` list, so each
        yielded item is the full decoded JSON page (including `meta`).
        Follows balldontlie's cursor pagination (`meta.next_cursor`) until
        the cursor is null/absent.
        """
        params: dict = {"dates[]": date, "per_page": 100}

        while True:
            page = self._get("/games", params)
            yield page

            next_cursor = page.get("meta", {}).get("next_cursor")
            if not next_cursor:
                break

            params = {**params, "cursor": next_cursor}
