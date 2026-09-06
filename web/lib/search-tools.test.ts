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

  it("declares all four tools from query-tools.md with the right required params", () => {
    // NOTE: this only checks internal self-consistency of TOOL_DEFINITIONS
    // (names/required fields match each other and this test's expectations)
    // — it deliberately does not read query-tools.md itself. That doc lives
    // under _bmad-output/specs/, which per this story's "only commit source
    // changes under web/" instruction is not part of this PR's committed
    // tree, so a test depending on it would pass locally but break for
    // anyone who checks out only this branch's diff. The tool-name/param
    // list below was transcribed from query-tools.md by hand at
    // implementation time — see search-tools.ts's module header comment.
    const byName = Object.fromEntries(TOOL_DEFINITIONS.map((t) => [t.name, t]));

    expect(Object.keys(byName).sort()).toEqual(
      ["get_game_result", "get_leaders", "get_player_stats", "get_team_games"].sort(),
    );
    expect(byName.get_player_stats.inputSchema.required).toEqual(["player_name"]);
    expect(byName.get_team_games.inputSchema.required).toEqual(["team"]);
    expect(byName.get_leaders.inputSchema.required).toEqual(["stat", "date_range"]);
    expect(byName.get_game_result.inputSchema.required).toEqual(["team_a", "team_b", "date"]);
  });
});
