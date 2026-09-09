import { describe, expect, it, vi, beforeEach } from "vitest";

const fetchFromApiMock = vi.fn();
vi.mock("@/lib/fastapi-client", () => ({
  fetchFromApi: (...args: unknown[]) => fetchFromApiMock(...args),
}));

// Imported after the mock so the module under test picks up the mocked
// fetchFromApi (no real HTTP call ever happens in this test file).
const { callTool, TOOL_DEFINITIONS } = await import("@/lib/search-tools");

// Fixtures below are transcribed from Dev1's actual PR #58
// (api/tests/test_query_tools.py / api/src/api/routers/query_tools.py),
// not re-guessed — this is the real `{status, data, candidates, message}`
// envelope, reconciled after PR #57's review of PR #58 found the originally
// assumed `{status, table, date_range, data, candidates}` shape didn't
// match. See search-tools.ts's module header comment for the full contract.

describe("callTool", () => {
  beforeEach(() => {
    fetchFromApiMock.mockReset();
  });

  it("dispatches get_player_stats with start_date/end_date (not date_range_start/end) and derives table+dateRange", async () => {
    // Real shape: api/tests/test_query_tools.py::test_get_player_stats_exact_match
    fetchFromApiMock.mockResolvedValueOnce({
      status: "ok",
      data: {
        player_name: "LeBron James",
        games: [
          { stat_id: "1", game_id: 1, game_date: "2024-01-03", points: 28 },
          { stat_id: "3", game_id: 2, game_date: "2024-01-05", points: 22 },
        ],
      },
      candidates: null,
      message: null,
    });

    const result = await callTool("get_player_stats", {
      player_name: "LeBron James",
      date_range: { start: "2024-01-01", end: "2024-01-31" },
    });

    expect(fetchFromApiMock).toHaveBeenCalledWith(
      "/tools/player-stats?player_name=LeBron+James&start_date=2024-01-01&end_date=2024-01-31",
    );
    expect(result.status).toBe("ok");
    // table/date_range are derived locally, not read off the wire (the real
    // envelope has neither field) — min..max across the returned games.
    expect(result.table).toBe("player_game_stats");
    expect(result.date_range).toBe("2024-01-03 to 2024-01-05");
    expect(result.message).toBeNull();
  });

  it("dispatches get_team_games and derives dateRange from data.games[].game_date", async () => {
    // Real shape: api/tests/test_query_tools.py::test_get_team_games_happy_path
    fetchFromApiMock.mockResolvedValueOnce({
      status: "ok",
      data: {
        team: "Boston Celtics",
        games: [
          { game_id: 1, game_date: "2024-01-03", opponent: "Los Angeles Lakers" },
          { game_id: 3, game_date: "2024-01-07", opponent: "Phoenix Suns" },
        ],
      },
      candidates: null,
      message: null,
    });

    const result = await callTool("get_team_games", { team: "Boston Celtics" });

    expect(fetchFromApiMock).toHaveBeenCalledWith("/tools/team-games?team=Boston+Celtics");
    expect(result.table).toBe("games");
    expect(result.date_range).toBe("2024-01-03 to 2024-01-07");
  });

  it("builds a start_date/end_date query for get_leaders and derives dateRange from data.date_range", async () => {
    // Real shape: api/tests/test_query_tools.py::test_get_leaders_happy_path_embeds_date_range_and_game_count
    fetchFromApiMock.mockResolvedValueOnce({
      status: "ok",
      data: {
        stat: "assists",
        leaders: [{ player_id: 11, player_name: "LeBron James", value: 15 }],
        date_range: { start_date: "2024-01-03", end_date: "2024-01-07" },
        game_count: 3,
      },
      candidates: null,
      message: null,
    });

    const result = await callTool("get_leaders", {
      stat: "assists",
      date_range: { start: "2024-01-01", end: "2024-01-31" },
      limit: 5,
    });

    expect(fetchFromApiMock).toHaveBeenCalledWith(
      "/tools/leaders?stat=assists&start_date=2024-01-01&end_date=2024-01-31&limit=5",
    );
    expect(result.table).toBe("player_game_stats");
    expect(result.date_range).toBe("2024-01-03 to 2024-01-07");
  });

  it("dispatches get_game_result and derives a single-date dateRange from data.game.game_date", async () => {
    // Real shape: api/tests/test_query_tools.py::test_get_game_result_found_includes_box_score
    fetchFromApiMock.mockResolvedValueOnce({
      status: "ok",
      data: {
        game: { game_id: 1, game_date: "2024-01-03", home_score: 112, away_score: 118 },
        box_score: [{ stat_id: "1" }, { stat_id: "2" }],
      },
      candidates: null,
      message: null,
    });

    const result = await callTool("get_game_result", {
      team_a: "Los Angeles Lakers",
      team_b: "Boston Celtics",
      date: "2024-01-03",
    });

    expect(fetchFromApiMock).toHaveBeenCalledWith(
      "/tools/game-result?team_a=Los+Angeles+Lakers&team_b=Boston+Celtics&date=2024-01-03",
    );
    expect(result.table).toBe("games");
    expect(result.date_range).toBe("2024-01-03");
  });

  it("relays a no_match result's message, with no table/date_range (only set for ok)", async () => {
    // Real shape: api/tests/test_query_tools.py::test_get_game_result_no_match
    fetchFromApiMock.mockResolvedValueOnce({
      status: "no_match",
      data: null,
      candidates: null,
      message: "No game found between Los Angeles Lakers and Boston Celtics on 2099-01-01.",
    });

    const result = await callTool("get_game_result", {
      team_a: "Los Angeles Lakers",
      team_b: "Boston Celtics",
      date: "2099-01-01",
    });

    expect(result.status).toBe("no_match");
    expect(result.table).toBeNull();
    expect(result.date_range).toBeNull();
    expect(result.message).toBe(
      "No game found between Los Angeles Lakers and Boston Celtics on 2099-01-01.",
    );
  });

  it("extracts plain candidate names from the real {name} object shape", async () => {
    // Real shape: api/tests/test_query_tools.py::test_get_player_stats_ambiguous_name_returns_candidates
    fetchFromApiMock.mockResolvedValueOnce({
      status: "ambiguous",
      data: null,
      candidates: [{ name: "Michael Jordan" }, { name: "Jordan Poole" }],
      message: "Multiple players match 'Jordan' -- please clarify which one.",
    });

    const result = await callTool("get_player_stats", { player_name: "Jordan" });

    expect(result.status).toBe("ambiguous");
    expect(result.candidates).toEqual(["Michael Jordan", "Jordan Poole"]);
  });

  it("returns an error envelope, never throwing, when the FastAPI call fails", async () => {
    fetchFromApiMock.mockRejectedValueOnce(new Error("FastAPI /tools/player-stats responded 500"));

    const result = await callTool("get_player_stats", { player_name: "LeBron James" });

    expect(result).toEqual({
      status: "error",
      table: null,
      date_range: null,
      resultData: null,
      data: null,
      candidates: null,
      message: null,
    });
  });

  it("returns an error envelope for an unknown tool name rather than throwing", async () => {
    const result = await callTool("get_something_unsupported", {});

    expect(result.status).toBe("error");
    expect(fetchFromApiMock).not.toHaveBeenCalled();
  });

  it("returns an error envelope, without calling FastAPI, when a required field is missing", async () => {
    // get_game_result requires team_a, team_b, and date — omit date here.
    const result = await callTool("get_game_result", { team_a: "Lakers", team_b: "Celtics" });

    expect(result.status).toBe("error");
    expect(fetchFromApiMock).not.toHaveBeenCalled();
  });

  it("treats an incomplete date_range (missing end) as a missing required field for get_leaders", async () => {
    const result = await callTool("get_leaders", {
      stat: "points",
      date_range: { start: "2024-10-22" },
    });

    expect(result.status).toBe("error");
    expect(fetchFromApiMock).not.toHaveBeenCalled();
  });

  it("normalizes a malformed upstream response to an error envelope", async () => {
    fetchFromApiMock.mockResolvedValueOnce({ unexpected: "shape" });

    const result = await callTool("get_player_stats", { player_name: "LeBron James" });

    expect(result.status).toBe("error");
  });

  it("normalizes an ok result with an unrecognized data shape to a null (not crashed) dateRange", async () => {
    // Defensive case: status is "ok" but `data` doesn't match any known
    // per-tool shape (e.g. a future Story 1 change) — table is still
    // derivable (we always know which tool we called), but dateRange can't
    // be, and that must degrade to null rather than throw.
    fetchFromApiMock.mockResolvedValueOnce({
      status: "ok",
      data: { something: "unexpected" },
      candidates: null,
      message: null,
    });

    const result = await callTool("get_player_stats", { player_name: "LeBron James" });

    expect(result.status).toBe("ok");
    expect(result.table).toBe("player_game_stats");
    expect(result.date_range).toBeNull();
  });

  it("declares all six tools from query-tools.md with the right required params", () => {
    const byName = Object.fromEntries(TOOL_DEFINITIONS.map((t) => [t.name, t]));

    expect(Object.keys(byName).sort()).toEqual(
      [
        "get_game_result",
        "get_leaders",
        "get_player_stat_aggregate",
        "get_player_stats",
        "get_player_streak",
        "get_team_games",
      ].sort(),
    );
    expect(byName.get_player_stats.inputSchema.required).toEqual(["player_name"]);
    expect(byName.get_team_games.inputSchema.required).toEqual(["team"]);
    expect(byName.get_leaders.inputSchema.required).toEqual(["stat", "date_range"]);
    expect(byName.get_game_result.inputSchema.required).toEqual(["team_a", "team_b", "date"]);
    expect(byName.get_player_stat_aggregate.inputSchema.required).toEqual([
      "player_name",
      "stat",
      "operation",
    ]);
    expect(byName.get_player_streak.inputSchema.required).toEqual([
      "player_name",
      "stat",
      "threshold",
    ]);
  });
});

describe("callTool -- resultData", () => {
  beforeEach(() => {
    fetchFromApiMock.mockReset();
  });

  it("derives player_stats resultData verbatim from data.games", async () => {
    fetchFromApiMock.mockResolvedValueOnce({
      status: "ok",
      data: {
        player_name: "Luka Dončić",
        games: [
          { stat_id: "1", game_id: 1, player_id: 1629029, player_first_name: "Luka", player_last_name: "Dončić", team: "DAL", points: 41, rebounds: 6, assists: 5, steals: 1, blocks: 0, turnovers: 4, minutes_played: "31", game_date: "2024-01-03", home_team: "Dallas Mavericks", away_team: "Portland Trail Blazers", home_score: 126, away_score: 97 },
        ],
      },
      candidates: null,
      message: null,
    });

    const result = await callTool("get_player_stats", { player_name: "Luka Doncic" });

    expect(result.resultData).toEqual({
      type: "player_stats",
      payload: {
        playerName: "Luka Dončić",
        games: [
          { stat_id: "1", game_id: 1, player_id: 1629029, player_first_name: "Luka", player_last_name: "Dončić", team: "DAL", points: 41, rebounds: 6, assists: 5, steals: 1, blocks: 0, turnovers: 4, minutes_played: "31", game_date: "2024-01-03", home_team: "Dallas Mavericks", away_team: "Portland Trail Blazers", home_score: 126, away_score: 97 },
        ],
      },
    });
  });

  it("reshapes get_team_games's team-centric rows into GameRow shape", async () => {
    // Real shape from api/src/api/routers/query_tools.py's _team_game_view().
    fetchFromApiMock.mockResolvedValueOnce({
      status: "ok",
      data: {
        team: "Boston Celtics",
        games: [
          {
            game_id: 1, game_date: "2024-01-03", team: "Boston Celtics", opponent: "New York Knicks",
            team_score: 110, opponent_score: 104, is_home: true, status: "Final", postseason: false, season: 2023,
          },
          {
            game_id: 2, game_date: "2024-01-07", team: "Boston Celtics", opponent: "Miami Heat",
            team_score: 98, opponent_score: 101, is_home: false, status: "Final", postseason: false, season: 2023,
          },
        ],
      },
      candidates: null,
      message: null,
    });

    const result = await callTool("get_team_games", { team: "Boston Celtics" });

    expect(result.resultData).toEqual({
      type: "team_games",
      payload: {
        team: "Boston Celtics",
        games: [
          {
            game_id: 1, game_date: "2024-01-03", season: 2023, status: "Final", postseason: false,
            home_team: "Boston Celtics", away_team: "New York Knicks", home_score: 110, away_score: 104,
            source_pulled_at: "",
          },
          {
            game_id: 2, game_date: "2024-01-07", season: 2023, status: "Final", postseason: false,
            home_team: "Miami Heat", away_team: "Boston Celtics", home_score: 101, away_score: 98,
            source_pulled_at: "",
          },
        ],
      },
    });
  });

  it("derives leaders resultData with player_id/player_name/value rows", async () => {
    fetchFromApiMock.mockResolvedValueOnce({
      status: "ok",
      data: {
        stat: "points",
        date_range: { start_date: "2024-01-01", end_date: "2024-01-03" },
        game_count: 26,
        leaders: [
          { player_id: 203944, player_name: "Julius Randle", value: 74 },
          { player_id: 1630162, player_name: "Anthony Edwards", value: 70 },
        ],
      },
      candidates: null,
      message: null,
    });

    const result = await callTool("get_leaders", {
      stat: "points",
      date_range: { start: "2024-01-01", end: "2024-01-03" },
    });

    expect(result.resultData).toEqual({
      type: "leaders",
      payload: {
        stat: "points",
        gameCount: 26,
        leaders: [
          { player_id: 203944, player_name: "Julius Randle", value: 74 },
          { player_id: 1630162, player_name: "Anthony Edwards", value: 70 },
        ],
      },
    });
  });

  it("enriches get_game_result's box_score rows with the game's own date/team/score fields", async () => {
    // Real shape: query_tools.py's get_box_score() selects plain
    // player_game_stats with NO join to games -- box_score rows have no
    // game_date/home_team/away_team/home_score/away_score of their own.
    fetchFromApiMock.mockResolvedValueOnce({
      status: "ok",
      data: {
        game: {
          game_id: 1, game_date: "2024-01-03", season: 2023, status: "Final", postseason: false,
          home_team: "Dallas Mavericks", away_team: "Portland Trail Blazers", home_score: 126, away_score: 97,
          source_pulled_at: "2026-01-01T00:00:00Z",
        },
        box_score: [
          { stat_id: "1", game_id: 1, player_id: 1629029, player_first_name: "Luka", player_last_name: "Dončić", team: "DAL", points: 41, rebounds: 6, assists: 5, steals: 1, blocks: 0, turnovers: 4, minutes_played: "31" },
        ],
      },
      candidates: null,
      message: null,
    });

    const result = await callTool("get_game_result", {
      team_a: "Dallas Mavericks",
      team_b: "Portland Trail Blazers",
      date: "2024-01-03",
    });

    expect(result.resultData).toEqual({
      type: "game_result",
      payload: {
        game: {
          game_id: 1, game_date: "2024-01-03", season: 2023, status: "Final", postseason: false,
          home_team: "Dallas Mavericks", away_team: "Portland Trail Blazers", home_score: 126, away_score: 97,
          source_pulled_at: "2026-01-01T00:00:00Z",
        },
        boxScore: [
          {
            stat_id: "1", game_id: 1, player_id: 1629029, player_first_name: "Luka", player_last_name: "Dončić",
            team: "DAL", points: 41, rebounds: 6, assists: 5, steals: 1, blocks: 0, turnovers: 4, minutes_played: "31",
            game_date: "2024-01-03", home_team: "Dallas Mavericks", away_team: "Portland Trail Blazers",
            home_score: 126, away_score: 97,
          },
        ],
      },
    });
  });

  it("is null for a no_match result, same as citation", async () => {
    fetchFromApiMock.mockResolvedValueOnce({
      status: "no_match",
      data: null,
      candidates: null,
      message: "No player found matching 'Zzz'.",
    });

    const result = await callTool("get_player_stats", { player_name: "Zzz" });

    expect(result.resultData).toBeNull();
  });

  it("passes data_confidence through from a raw get_game_result response into resultData", async () => {
    // deriveResultData's get_game_result case casts the raw `game` object
    // straight through (`game as GameRow`) rather than an explicit
    // field-by-field mapping, unlike get_team_games's teamGameViewToGameRow
    // -- this pins that a future refactor toward explicit mapping can't
    // silently drop data_confidence with zero test failures.
    const dataConfidence = {
      field: "home_score",
      note: "nba_stats and balldontlie disagreed on home score during live play (nba_stats: 101, balldontlie: 103).",
      primary_source: "nba_stats",
      primary_value: "101",
      secondary_source: "balldontlie",
      secondary_value: "103",
    };
    fetchFromApiMock.mockResolvedValueOnce({
      status: "ok",
      data: {
        game: {
          game_id: 1,
          game_date: "2024-01-03",
          home_team: "Los Angeles Lakers",
          away_team: "Boston Celtics",
          data_confidence: dataConfidence,
        },
        box_score: [],
      },
      candidates: null,
      message: null,
    });

    const result = await callTool("get_game_result", {
      team_a: "Los Angeles Lakers",
      team_b: "Boston Celtics",
      date: "2024-01-03",
    });

    expect(result.resultData?.type).toBe("game_result");
    if (result.resultData?.type === "game_result") {
      expect(result.resultData.payload.game.data_confidence).toEqual(dataConfidence);
    }
  });
});

describe("callTool -- get_player_stat_aggregate", () => {
  beforeEach(() => {
    fetchFromApiMock.mockReset();
  });

  it("dispatches with operation/threshold and derives dateRange from data.date_range", async () => {
    fetchFromApiMock.mockResolvedValueOnce({
      status: "ok",
      data: {
        player_name: "LeBron James",
        stat: "points",
        operation: "count_over_threshold",
        threshold: 30,
        value: 2,
        extreme_game: null,
        matching_games: [],
        matching_games_truncated: false,
        game_count_considered: 5,
        date_range: { start_date: "2024-01-01", end_date: "2024-01-31" },
      },
      candidates: null,
      message: null,
    });

    const result = await callTool("get_player_stat_aggregate", {
      player_name: "LeBron James",
      stat: "points",
      operation: "count_over_threshold",
      threshold: 30,
      date_range: { start: "2024-01-01", end: "2024-01-31" },
    });

    expect(fetchFromApiMock).toHaveBeenCalledWith(
      "/tools/player-stat-aggregate?player_name=LeBron+James&stat=points&operation=count_over_threshold&threshold=30&start_date=2024-01-01&end_date=2024-01-31",
    );
    expect(result.status).toBe("ok");
    expect(result.table).toBe("player_game_stats");
    expect(result.date_range).toBe("2024-01-01 to 2024-01-31");
  });

  it("derives stat_aggregate resultData from the ok payload", async () => {
    fetchFromApiMock.mockResolvedValueOnce({
      status: "ok",
      data: {
        player_name: "LeBron James",
        stat: "points",
        operation: "count_over_threshold",
        threshold: 30,
        value: 47,
        extreme_game: null,
        matching_games: [{ stat_id: "1", game_id: 1, points: 30 }],
        matching_games_truncated: true,
        game_count_considered: 1600,
        date_range: { start_date: "2003-10-29", end_date: "2026-09-06" },
      },
      candidates: null,
      message: null,
    });

    const result = await callTool("get_player_stat_aggregate", {
      player_name: "LeBron James",
      stat: "points",
      operation: "count_over_threshold",
      threshold: 30,
    });

    expect(result.resultData).toEqual({
      type: "stat_aggregate",
      payload: {
        playerName: "LeBron James",
        stat: "points",
        operation: "count_over_threshold",
        threshold: 30,
        value: 47,
        extremeGame: null,
        matchingGames: [{ stat_id: "1", game_id: 1, points: 30 }],
        matchingGamesTruncated: true,
        gameCountConsidered: 1600,
      },
    });
  });

  it("omits threshold from the query string for a non-count operation", async () => {
    fetchFromApiMock.mockResolvedValueOnce({
      status: "ok",
      data: {
        player_name: "LeBron James",
        stat: "points",
        operation: "avg",
        threshold: null,
        value: 27.3,
        extreme_game: null,
        matching_games: null,
        matching_games_truncated: false,
        game_count_considered: 5,
        date_range: { start_date: "2024-01-01", end_date: "2024-01-31" },
      },
      candidates: null,
      message: null,
    });

    await callTool("get_player_stat_aggregate", {
      player_name: "LeBron James",
      stat: "points",
      operation: "avg",
    });

    expect(fetchFromApiMock).toHaveBeenCalledWith(
      "/tools/player-stat-aggregate?player_name=LeBron+James&stat=points&operation=avg",
    );
  });

  it("returns ERROR_ENVELOPE if operation is missing (required field)", async () => {
    const result = await callTool("get_player_stat_aggregate", { player_name: "LeBron James", stat: "points" });
    expect(result.status).toBe("error");
    expect(fetchFromApiMock).not.toHaveBeenCalled();
  });
});

describe("callTool -- get_player_streak", () => {
  beforeEach(() => {
    fetchFromApiMock.mockReset();
  });

  it("dispatches with threshold and derives player_streak resultData", async () => {
    fetchFromApiMock.mockResolvedValueOnce({
      status: "ok",
      data: {
        player_name: "LeBron James",
        stat: "points",
        threshold: 20,
        longest_streak: 9,
        streak_date_range: { start_date: "2025-11-02", end_date: "2025-11-20" },
        is_active: false,
        games: [{ stat_id: "1", game_id: 1, points: 25 }],
        date_range: { start_date: "2003-10-29", end_date: "2026-09-06" },
      },
      candidates: null,
      message: null,
    });

    const result = await callTool("get_player_streak", {
      player_name: "LeBron James",
      stat: "points",
      threshold: 20,
    });

    expect(fetchFromApiMock).toHaveBeenCalledWith(
      "/tools/player-streak?player_name=LeBron+James&stat=points&threshold=20",
    );
    expect(result.table).toBe("player_game_stats");
    expect(result.date_range).toBe("2003-10-29 to 2026-09-06");
    expect(result.resultData).toEqual({
      type: "player_streak",
      payload: {
        playerName: "LeBron James",
        stat: "points",
        threshold: 20,
        longestStreak: 9,
        isActive: false,
        games: [{ stat_id: "1", game_id: 1, points: 25 }],
      },
    });
  });

  it("returns ERROR_ENVELOPE if threshold is missing (required field)", async () => {
    const result = await callTool("get_player_streak", { player_name: "LeBron James", stat: "points" });
    expect(result.status).toBe("error");
    expect(fetchFromApiMock).not.toHaveBeenCalled();
  });
});
