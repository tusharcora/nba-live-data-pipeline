class PublicFeedClient:
    """Secondary source — reconciliation for the same games as BallDontLieClient.

    Undocumented, no SLA — treated as unstable by design (docs/prd.md §03).
    Wired up in week 2 alongside live polling.
    """

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url

    def get_games(self, date: str) -> list[dict]:
        raise NotImplementedError("wired in week 1")
