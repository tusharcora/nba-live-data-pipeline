from db.models import LiveGameState, QualityMetric, RawPull, SourceConflict
from ingestion.flows.live_game_flow import (
    extract_balldontlie_live_states,
    extract_balldontlie_team_names,
    extract_nba_stats_live_states,
    extract_public_feed_live_states,
    extract_public_feed_team_names,
    live_game_flow,
    match_game_ids_by_team_overlap,
    reconcile_live_states,
    remap_game_ids,
)

# --- Pure extraction function tests (no DB/network) -------------------------


def test_extract_balldontlie_live_states_from_games_page():
    page = {
        "data": [
            {
                "id": 15908,
                "status": "3rd Qtr",
                "period": 3,
                "time": "5:42",
                "home_team_score": 101,
                "visitor_team_score": 98,
            },
            {
                "id": 15909,
                "status": "Final",
                "period": 4,
                "time": "Final",
                "home_team_score": 110,
                "visitor_team_score": 104,
            },
        ],
        "meta": {"next_cursor": None},
    }

    states = extract_balldontlie_live_states(page)

    assert len(states) == 2
    first, second = states
    assert isinstance(first, LiveGameState)
    assert first.game_id == 15908
    assert first.source == "balldontlie"
    assert first.home_score == 101
    assert first.away_score == 98
    assert first.period == 3
    assert first.clock == "5:42"
    assert first.status == "3rd Qtr"

    assert second.game_id == 15909
    assert second.status == "Final"


def test_extract_balldontlie_live_states_handles_missing_optional_fields():
    page = {"data": [{"id": 1, "status": "Scheduled"}], "meta": {}}

    states = extract_balldontlie_live_states(page)

    assert len(states) == 1
    state = states[0]
    assert state.game_id == 1
    assert state.home_score is None
    assert state.away_score is None
    assert state.period is None
    assert state.clock is None
    assert state.status == "Scheduled"


def test_extract_balldontlie_live_states_empty_page():
    assert extract_balldontlie_live_states({"data": [], "meta": {}}) == []


def test_extract_public_feed_live_states_from_scoreboard():
    scoreboard = {
        "events": [
            {
                "id": "401584793",
                "date": "2026-09-01T00:00Z",
                "competitions": [
                    {
                        "competitors": [
                            {
                                "homeAway": "home",
                                "team": {"displayName": "Atlanta Hawks"},
                                "score": "102",
                            },
                            {
                                "homeAway": "away",
                                "team": {"displayName": "Boston Celtics"},
                                "score": "99",
                            },
                        ],
                        "status": {
                            "type": {"name": "STATUS_IN_PROGRESS"},
                            "period": 4,
                            "displayClock": "2:15",
                        },
                    }
                ],
            }
        ]
    }

    states = extract_public_feed_live_states(scoreboard)

    assert len(states) == 1
    state = states[0]
    assert isinstance(state, LiveGameState)
    assert state.game_id == 401584793
    assert state.source == "public_feed"
    assert state.home_score == 102
    assert state.away_score == 99
    assert state.period == 4
    assert state.clock == "2:15"
    assert state.status == "STATUS_IN_PROGRESS"


def test_extract_public_feed_live_states_handles_missing_score_and_status():
    scoreboard = {
        "events": [
            {
                "id": "1",
                "competitions": [
                    {
                        "competitors": [
                            {"homeAway": "home", "team": {}, "score": ""},
                            {"homeAway": "away", "team": {}},
                        ],
                        "status": {"type": {}},
                    }
                ],
            }
        ]
    }

    states = extract_public_feed_live_states(scoreboard)

    assert len(states) == 1
    state = states[0]
    assert state.home_score is None
    assert state.away_score is None
    assert state.period is None
    assert state.clock is None
    assert state.status == "unknown"


def test_extract_public_feed_live_states_empty_events():
    assert extract_public_feed_live_states({"events": []}) == []


def _nba_stats_scoreboard() -> dict:
    return {
        "scoreboard": {
            "gameDate": "2026-09-06",
            "games": [
                {
                    "gameId": "0022500123",
                    "gameStatus": 2,
                    "gameStatusText": "Qtr 3 4:12",
                    "gameTimeUTC": "2026-09-06T23:30:00Z",
                    "period": 3,
                    "gameClock": "PT04M12.00S",
                    "homeTeam": {"teamCity": "Miami", "teamName": "Heat", "score": 91},
                    "awayTeam": {"teamCity": "Boston", "teamName": "Celtics", "score": 88},
                },
                {
                    "gameId": "0022500124",
                    "gameStatus": 1,
                    "gameStatusText": "7:30 pm ET",
                    "gameTimeUTC": "2026-09-07T00:30:00Z",
                    "period": 0,
                    "gameClock": "",
                    "homeTeam": {"teamCity": "Minnesota", "teamName": "Timberwolves", "score": 0},
                    "awayTeam": {"teamCity": "Dallas", "teamName": "Mavericks", "score": 0},
                },
                {
                    "gameId": "0022500125",
                    "gameStatus": 3,
                    "gameStatusText": "Final",
                    "gameTimeUTC": "2026-09-06T19:00:00Z",
                    "period": 4,
                    "gameClock": "",
                    "homeTeam": {"teamCity": "Golden State", "teamName": "Warriors", "score": 118},
                    "awayTeam": {"teamCity": "Phoenix", "teamName": "Suns", "score": 109},
                },
                {
                    "gameId": "0022500126",
                    "gameStatus": 1,
                    "gameStatusText": "Postponed",
                    "gameTimeUTC": "2026-09-07T00:00:00Z",
                    "period": 0,
                    "gameClock": "",
                    "homeTeam": {"teamCity": "Denver", "teamName": "Nuggets", "score": 0},
                    "awayTeam": {"teamCity": "Utah", "teamName": "Jazz", "score": 0},
                },
            ],
        }
    }


def test_extract_nba_stats_live_states_normalizes_team_names_and_scores():
    states = extract_nba_stats_live_states(_nba_stats_scoreboard())

    live = next(s for s in states if s.game_id == 22500123)
    assert live.source == "nba_stats"
    assert live.home_team == "Miami Heat"
    assert live.away_team == "Boston Celtics"
    assert live.home_score == 91
    assert live.away_score == 88
    assert live.period == 3
    assert live.status == "in_progress"


def test_extract_nba_stats_live_states_scheduled_game_has_start_time_no_score_yet():
    states = extract_nba_stats_live_states(_nba_stats_scoreboard())

    scheduled = next(s for s in states if s.game_id == 22500124)
    assert scheduled.status == "scheduled"
    assert scheduled.scheduled_start.isoformat() == "2026-09-07T00:30:00+00:00"
    assert scheduled.home_score == 0


def test_extract_nba_stats_live_states_final_game():
    states = extract_nba_stats_live_states(_nba_stats_scoreboard())

    final = next(s for s in states if s.game_id == 22500125)
    assert final.status == "final"
    assert final.home_score == 118
    assert final.away_score == 109


def test_extract_nba_stats_live_states_postponed_regardless_of_game_status_code():
    """gameStatus=1 alone would normally mean "scheduled" -- the postponement
    keyword in gameStatusText overrides that, matching the substring-based
    postponed/cancelled/suspended/delayed detection this codebase already
    uses in `web/lib/live-status.ts`'s retiring `getStatusPresentation`.
    """
    states = extract_nba_stats_live_states(_nba_stats_scoreboard())

    postponed = next(s for s in states if s.game_id == 22500126)
    assert postponed.status == "postponed"


def test_extract_nba_stats_live_states_empty_games():
    assert extract_nba_stats_live_states({"scoreboard": {"games": []}}) == []


# --- Team-name extraction and game_id matching tests -------------------------


def test_extract_balldontlie_team_names():
    page = {
        "data": [
            {
                "id": 15908,
                "home_team": {"full_name": "Miami Heat"},
                "visitor_team": {"full_name": "Boston Celtics"},
            }
        ]
    }

    assert extract_balldontlie_team_names(page) == {
        15908: {"Miami Heat", "Boston Celtics"}
    }


def test_extract_balldontlie_team_names_missing_team_data_is_skipped():
    assert extract_balldontlie_team_names({"data": [{"id": 1}]}) == {1: set()}


def test_extract_public_feed_team_names():
    scoreboard = {
        "events": [
            {
                "id": "401584793",
                "competitions": [
                    {
                        "competitors": [
                            {"homeAway": "home", "team": {"displayName": "Miami Heat"}},
                            {"homeAway": "away", "team": {"displayName": "Boston Celtics"}},
                        ]
                    }
                ],
            }
        ]
    }

    assert extract_public_feed_team_names(scoreboard) == {
        401584793: {"Miami Heat", "Boston Celtics"}
    }


def test_match_game_ids_by_team_overlap_matches_on_shared_team_name():
    canonical = {22500123: {"Miami Heat", "Boston Celtics"}, 22500124: {"LA Lakers", "Denver Nuggets"}}
    other = {15908: {"Miami Heat", "Boston Celtics"}}

    assert match_game_ids_by_team_overlap(canonical, other) == {15908: 22500123}


def test_match_game_ids_by_team_overlap_no_overlap_is_unmatched():
    canonical = {22500123: {"Miami Heat", "Boston Celtics"}}
    other = {99: {"Some Other Team", "Another Team"}}

    assert match_game_ids_by_team_overlap(canonical, other) == {}


def test_match_game_ids_by_team_overlap_each_canonical_claimed_at_most_once():
    canonical = {22500123: {"Miami Heat", "Boston Celtics"}}
    other = {1: {"Miami Heat"}, 2: {"Miami Heat"}}

    matches = match_game_ids_by_team_overlap(canonical, other)
    assert len(matches) == 1
    assert set(matches.values()) == {22500123}


def test_remap_game_ids_rewrites_matched_ids_leaves_unmatched_alone():
    states = [
        LiveGameState(game_id=15908, source="balldontlie", status="in_progress"),
        LiveGameState(game_id=999, source="balldontlie", status="in_progress"),
    ]

    remap_game_ids(states, {15908: 22500123})

    assert states[0].game_id == 22500123
    assert states[1].game_id == 999


# --- Flow orchestration tests (fakes only, no DB/network) --------------------


class FakeRawPullSink:
    def __init__(self) -> None:
        self.written: list[RawPull] = []

    def write(self, raw_pull: RawPull) -> None:
        self.written.append(raw_pull)


class FakeRowSink:
    """One generic fake used for both the LiveGameState and QualityMetric sinks."""

    def __init__(self) -> None:
        self.written: list[object] = []

    def write(self, row: object) -> None:
        self.written.append(row)


class FakeBallDontLieClient:
    def __init__(self, pages: list[dict]) -> None:
        self._pages = pages
        self.requested_dates: list[str] = []

    def get_games_pages(self, date_str: str):
        self.requested_dates.append(date_str)
        yield from self._pages


class FakeScoreboardSource:
    def __init__(self, scoreboard: dict) -> None:
        self._scoreboard = scoreboard
        self.requested_dates: list[str] = []

    def get_scoreboard(self, date: str) -> dict:
        self.requested_dates.append(date)
        return self._scoreboard


def _balldontlie_pages() -> list[dict]:
    return [
        {
            "data": [
                {
                    "id": 15908,
                    "status": "3rd Qtr",
                    "period": 3,
                    "time": "5:42",
                    "home_team_score": 101,
                    "visitor_team_score": 98,
                }
            ],
            "meta": {"next_cursor": None},
        }
    ]


def _public_feed_scoreboard() -> dict:
    return {
        "events": [
            {
                "id": "401584793",
                "competitions": [
                    {
                        "competitors": [
                            {"homeAway": "home", "team": {}, "score": "102"},
                            {"homeAway": "away", "team": {}, "score": "99"},
                        ],
                        "status": {
                            "type": {"name": "STATUS_IN_PROGRESS"},
                            "period": 4,
                            "displayClock": "2:15",
                        },
                    }
                ],
            }
        ]
    }


def test_live_game_flow_writes_raw_pull_for_each_source():
    raw_pull_sink = FakeRawPullSink()
    live_game_state_sink = FakeRowSink()
    quality_metric_sink = FakeRowSink()

    live_game_flow(
        date="2026-09-01",
        raw_pull_sink=raw_pull_sink,
        live_game_state_sink=live_game_state_sink,
        quality_metric_sink=quality_metric_sink,
        balldontlie_client=FakeBallDontLieClient(_balldontlie_pages()),
        public_feed_client=FakeScoreboardSource(_public_feed_scoreboard()),
    )

    assert len(raw_pull_sink.written) == 2
    sources = {rp.source for rp in raw_pull_sink.written}
    assert sources == {"balldontlie", "public_feed"}

    bdl_pull = next(rp for rp in raw_pull_sink.written if rp.source == "balldontlie")
    assert bdl_pull.endpoint == "games"
    assert bdl_pull.payload == _balldontlie_pages()[0]

    pf_pull = next(rp for rp in raw_pull_sink.written if rp.source == "public_feed")
    assert pf_pull.endpoint == "scoreboard"
    assert pf_pull.payload == _public_feed_scoreboard()


def test_live_game_flow_extracts_live_game_state_rows_from_both_sources():
    live_game_state_sink = FakeRowSink()

    live_game_flow(
        date="2026-09-01",
        raw_pull_sink=FakeRawPullSink(),
        live_game_state_sink=live_game_state_sink,
        quality_metric_sink=FakeRowSink(),
        balldontlie_client=FakeBallDontLieClient(_balldontlie_pages()),
        public_feed_client=FakeScoreboardSource(_public_feed_scoreboard()),
    )

    assert len(live_game_state_sink.written) == 2
    sources = {row.source for row in live_game_state_sink.written}
    assert sources == {"balldontlie", "public_feed"}
    for row in live_game_state_sink.written:
        assert isinstance(row, LiveGameState)


def test_live_game_flow_writes_poll_lag_metric_exactly_once():
    quality_metric_sink = FakeRowSink()

    result = live_game_flow(
        date="2026-09-01",
        raw_pull_sink=FakeRawPullSink(),
        live_game_state_sink=FakeRowSink(),
        quality_metric_sink=quality_metric_sink,
        balldontlie_client=FakeBallDontLieClient(_balldontlie_pages()),
        public_feed_client=FakeScoreboardSource(_public_feed_scoreboard()),
    )

    assert len(quality_metric_sink.written) == 1
    metric = quality_metric_sink.written[0]
    assert isinstance(metric, QualityMetric)
    assert metric.check_name == "live_poll_lag_seconds"
    assert metric.metric_value >= 0
    assert metric.metadata_json == {"date": "2026-09-01"}

    assert result["raw_pulls_written"] == 2
    assert result["live_game_states_written"] == 2


def test_live_game_flow_requests_both_sources_with_the_given_date():
    balldontlie_client = FakeBallDontLieClient(_balldontlie_pages())
    public_feed_client = FakeScoreboardSource(_public_feed_scoreboard())

    live_game_flow(
        date="2026-09-01",
        raw_pull_sink=FakeRawPullSink(),
        live_game_state_sink=FakeRowSink(),
        quality_metric_sink=FakeRowSink(),
        balldontlie_client=balldontlie_client,
        public_feed_client=public_feed_client,
    )

    assert balldontlie_client.requested_dates == ["2026-09-01"]
    assert public_feed_client.requested_dates == ["2026-09-01"]


def test_live_game_flow_handles_multiple_balldontlie_pages():
    pages = [
        {
            "data": [{"id": 1, "status": "Final"}],
            "meta": {"next_cursor": 100},
        },
        {
            "data": [{"id": 2, "status": "Final"}],
            "meta": {"next_cursor": None},
        },
    ]
    raw_pull_sink = FakeRawPullSink()
    live_game_state_sink = FakeRowSink()

    result = live_game_flow(
        date="2026-09-01",
        raw_pull_sink=raw_pull_sink,
        live_game_state_sink=live_game_state_sink,
        quality_metric_sink=FakeRowSink(),
        balldontlie_client=FakeBallDontLieClient(pages),
        public_feed_client=FakeScoreboardSource({"events": []}),
    )

    bdl_pulls = [rp for rp in raw_pull_sink.written if rp.source == "balldontlie"]
    assert len(bdl_pulls) == 2
    bdl_states = [row for row in live_game_state_sink.written if row.source == "balldontlie"]
    assert len(bdl_states) == 2
    assert result["raw_pulls_written"] == 3  # 2 balldontlie pages + 1 public_feed pull
    assert result["live_game_states_written"] == 2


# --- Score reconciliation tests -----------------------------------------------


def test_reconcile_live_states_flags_disagreeing_scores():
    nba_stats_states = [
        LiveGameState(game_id=1, source="nba_stats", home_score=91, away_score=88, status="in_progress")
    ]
    balldontlie_states = [
        LiveGameState(game_id=1, source="balldontlie", home_score=89, away_score=88, status="3rd Qtr")
    ]

    conflicts = reconcile_live_states(nba_stats_states, balldontlie_states, [])

    assert len(conflicts) == 1
    conflict = conflicts[0]
    assert isinstance(conflict, SourceConflict)
    assert conflict.game_id == "1"
    assert conflict.field_name == "home_score"
    assert conflict.primary_source == "nba_stats"
    assert conflict.primary_value == "91"
    assert conflict.secondary_source == "balldontlie"
    assert conflict.secondary_value == "89"


def test_reconcile_live_states_agreeing_scores_yield_no_conflicts():
    nba_stats_states = [
        LiveGameState(game_id=1, source="nba_stats", home_score=91, away_score=88, status="in_progress")
    ]
    balldontlie_states = [
        LiveGameState(game_id=1, source="balldontlie", home_score=91, away_score=88, status="3rd Qtr")
    ]

    assert reconcile_live_states(nba_stats_states, balldontlie_states, []) == []


def test_reconcile_live_states_never_compares_status_field():
    """status vocabularies differ by source design (nba_api's normalized
    tokens vs. balldontlie's raw strings vs. ESPN's STATUS_* constants) —
    comparing it would flag a "conflict" every single poll for reasons
    that have nothing to do with real disagreement.
    """
    nba_stats_states = [
        LiveGameState(game_id=1, source="nba_stats", home_score=91, away_score=88, status="in_progress")
    ]
    balldontlie_states = [
        LiveGameState(game_id=1, source="balldontlie", home_score=91, away_score=88, status="3rd Qtr")
    ]

    assert reconcile_live_states(nba_stats_states, balldontlie_states, []) == []


def test_reconcile_live_states_checks_both_secondary_sources_independently():
    nba_stats_states = [
        LiveGameState(game_id=1, source="nba_stats", home_score=91, away_score=88, status="in_progress")
    ]
    balldontlie_states = [
        LiveGameState(game_id=1, source="balldontlie", home_score=89, away_score=88, status="3rd Qtr")
    ]
    public_feed_states = [
        LiveGameState(game_id=1, source="public_feed", home_score=91, away_score=90, status="STATUS_IN_PROGRESS")
    ]

    conflicts = reconcile_live_states(nba_stats_states, balldontlie_states, public_feed_states)

    fields_by_secondary = {c.secondary_source: c.field_name for c in conflicts}
    assert fields_by_secondary == {"balldontlie": "home_score", "public_feed": "away_score"}


def test_reconcile_live_states_skips_games_with_no_secondary_row():
    nba_stats_states = [
        LiveGameState(game_id=1, source="nba_stats", home_score=91, away_score=88, status="in_progress")
    ]

    assert reconcile_live_states(nba_stats_states, [], []) == []


def test_reconcile_live_states_skips_games_with_no_scores_yet():
    nba_stats_states = [
        LiveGameState(game_id=1, source="nba_stats", home_score=None, away_score=None, status="scheduled")
    ]
    balldontlie_states = [
        LiveGameState(game_id=1, source="balldontlie", home_score=None, away_score=None, status="Scheduled")
    ]

    assert reconcile_live_states(nba_stats_states, balldontlie_states, []) == []
