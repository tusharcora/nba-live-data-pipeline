class BallDontLieClient:
    """Primary source — box scores, live game state, play-by-play, injuries, standings.

    Wired up in week 1 (backfill) and week 2 (live polling); see docs/prd.md §03/§12.
    """

    def __init__(self, base_url: str = "https://api.balldontlie.io/v1") -> None:
        self.base_url = base_url

    def get_games(self, date: str) -> list[dict]:
        raise NotImplementedError("wired in week 1")
