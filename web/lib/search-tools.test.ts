import { describe, expect, it, vi, beforeEach } from "vitest";

const fetchFromApiMock = vi.fn();
vi.mock("@/lib/fastapi-client", () => ({
  fetchFromApi: (...args: unknown[]) => fetchFromApiMock(...args),
}));

// Imported after the mock so the module under test picks up the mocked
// fetchFromApi (no real HTTP call ever happens in this test file).
const { callTool, TOOL_DEFINITIONS } = await import("@/lib/search-tools");

describe("callTool", () => {
  beforeEach(() => {
    fetchFromApiMock.mockReset();
  });

  it("dispatches get_player_stats to the assumed endpoint with query params", async () => {
    fetchFromApiMock.mockResolvedValueOnce({
      status: "ok",
      table: "player_game_stats",
      date_range: "2024-10-22 to 2024-10-22",
      data: [{ points: 30 }],
      candidates: null,
    });

    const result = await callTool("get_player_stats", {
      player_name: "LeBron James",
      date: "2024-10-22",
    });

    expect(fetchFromApiMock).toHaveBeenCalledWith(
      "/tools/player-stats?player_name=LeBron+James&date=2024-10-22",
    );
    expect(result.status).toBe("ok");
    expect(result.table).toBe("player_game_stats");
  });

  it("builds a date_range query for get_leaders", async () => {
    fetchFromApiMock.mockResolvedValueOnce({
      status: "ok",
      table: "player_game_stats",
      date_range: "2024-10-22 to 2024-11-05",
      data: [],
      candidates: null,
    });

    await callTool("get_leaders", {
      stat: "points",
      date_range: { start: "2024-10-22", end: "2024-11-05" },
      limit: 5,
    });

    expect(fetchFromApiMock).toHaveBeenCalledWith(
      "/tools/leaders?stat=points&date_range_start=2024-10-22&date_range_end=2024-11-05&limit=5",
    );
  });

  it("dispatches get_game_result to the assumed endpoint", async () => {
    fetchFromApiMock.mockResolvedValueOnce({
      status: "no_match",
      table: null,
      date_range: null,
      data: null,
      candidates: null,
    });

    const result = await callTool("get_game_result", {
      team_a: "Lakers",
      team_b: "Celtics",
      date: "2099-01-01",
    });

    expect(fetchFromApiMock).toHaveBeenCalledWith(
      "/tools/game-result?team_a=Lakers&team_b=Celtics&date=2099-01-01",
    );
    expect(result.status).toBe("no_match");
  });

  it("returns an error envelope, never throwing, when the FastAPI call fails", async () => {
    fetchFromApiMock.mockRejectedValueOnce(new Error("FastAPI /tools/player-stats responded 500"));

    const result = await callTool("get_player_stats", { player_name: "LeBron James" });

    expect(result).toEqual({ status: "error", table: null, date_range: null, data: null, candidates: null });
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
    expect(byName.get_player_stats.input_schema.required).toEqual(["player_name"]);
    expect(byName.get_team_games.input_schema.required).toEqual(["team"]);
    expect(byName.get_leaders.input_schema.required).toEqual(["stat", "date_range"]);
    expect(byName.get_game_result.input_schema.required).toEqual(["team_a", "team_b", "date"]);
  });
});
