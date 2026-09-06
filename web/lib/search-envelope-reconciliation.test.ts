// End-to-end check that runSearchLoop (search-loop.ts) produces a real,
// non-fallback citation when fed Dev1's *actual* FastAPI envelope shape —
// not the originally assumed one. This is the regression test for the
// contract mismatch found in PR #57's review of PR #58: the real envelope
// is `{status, data, candidates, message}` (no top-level `table`/`date_range`),
// which used to make finalize()'s CAP-4 grounding check fall through to
// FALLBACK_RESULT on every single successful lookup. Only `fetchFromApi`
// is mocked here — the real `callTool` (search-tools.ts) runs unmodified,
// exercising the actual normalization/derivation logic end to end. The LLM
// side uses a fake LlmClient (llm/types.ts) rather than any real provider
// SDK shape — this test is about the FastAPI contract, not the LLM
// provider, which lib/llm/anthropic-provider.test.ts and
// lib/llm/gemini-provider.test.ts cover separately.
import { describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmResponse } from "@/lib/llm/types";

const fetchFromApiMock = vi.fn();
vi.mock("@/lib/fastapi-client", () => ({
  fetchFromApi: (...args: unknown[]) => fetchFromApiMock(...args),
}));

const { runSearchLoop, FALLBACK_RESULT } = await import("@/lib/search-loop");
const { callTool } = await import("@/lib/search-tools");

function fakeLlmClient(...responses: LlmResponse[]): LlmClient {
  const send = vi.fn();
  for (const response of responses) send.mockResolvedValueOnce(response);
  return { send };
}

function toolCallResponse(name: string, input: Record<string, unknown>): LlmResponse {
  return { text: "", toolCalls: [{ id: "call_1", name, input }] };
}

function finalResponse(text: string): LlmResponse {
  return { text, toolCalls: [] };
}

describe("runSearchLoop against Dev1's real FastAPI envelope (PR #58)", () => {
  it("get_player_stats: produces a real citation, not the fallback", async () => {
    fetchFromApiMock.mockResolvedValueOnce({
      status: "ok",
      data: {
        player_name: "LeBron James",
        games: [{ stat_id: "1", game_id: 1, game_date: "2024-01-03", points: 28 }],
      },
      candidates: null,
      message: null,
    });

    const llmClient = fakeLlmClient(
      toolCallResponse("get_player_stats", { player_name: "LeBron James" }),
      finalResponse("LeBron James scored 28 points on 2024-01-03."),
    );

    const result = await runSearchLoop({
      question: "How many points did LeBron score on 2024-01-03?",
      llmClient,
      callTool,
    });

    expect(fetchFromApiMock).toHaveBeenCalledWith(
      "/tools/player-stats?player_name=LeBron+James",
    );
    expect(result).not.toEqual(FALLBACK_RESULT);
    expect(result.noData).toBe(false);
    expect(result.citation).toEqual({ table: "player_game_stats", dateRange: "2024-01-03" });
  });

  it("get_leaders: derives dateRange from data.date_range, not a top-level field", async () => {
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

    const llmClient = fakeLlmClient(
      toolCallResponse("get_leaders", {
        stat: "assists",
        date_range: { start: "2024-01-01", end: "2024-01-31" },
      }),
      finalResponse("LeBron James leads with 15 assists across 3 games (2024-01-03 to 2024-01-07)."),
    );

    const result = await runSearchLoop({
      question: "Who leads in assists in January?",
      llmClient,
      callTool,
    });

    expect(result.noData).toBe(false);
    expect(result.citation).toEqual({
      table: "player_game_stats",
      dateRange: "2024-01-03 to 2024-01-07",
    });
  });

  it("get_game_result no_match: relays honestly using the real message field", async () => {
    fetchFromApiMock.mockResolvedValueOnce({
      status: "no_match",
      data: null,
      candidates: null,
      message: "No game found between Los Angeles Lakers and Boston Celtics on 2099-01-01.",
    });

    const llmClient = fakeLlmClient(
      toolCallResponse("get_game_result", {
        team_a: "Los Angeles Lakers",
        team_b: "Boston Celtics",
        date: "2099-01-01",
      }),
      finalResponse("There's no data for that matchup on that date."),
    );

    const result = await runSearchLoop({
      question: "Lakers vs Celtics on 2099-01-01?",
      llmClient,
      callTool,
    });

    expect(result.noData).toBe(true);
    expect(result.citation).toBeNull();
  });

  it("ambiguous player name: real {name} candidate objects surface as a plain string list", async () => {
    fetchFromApiMock.mockResolvedValueOnce({
      status: "ambiguous",
      data: null,
      candidates: [{ name: "Michael Jordan" }, { name: "Jordan Poole" }],
      message: "Multiple players match 'Jordan' -- please clarify which one.",
    });

    const llmClient = fakeLlmClient(
      toolCallResponse("get_player_stats", { player_name: "Jordan" }),
      finalResponse("Did you mean Michael Jordan or Jordan Poole?"),
    );

    const result = await runSearchLoop({ question: "Jordan's stats?", llmClient, callTool });

    expect(result.noData).toBe(false);
    expect(result.citation).toBeNull();
    expect(result.candidates).toEqual(["Michael Jordan", "Jordan Poole"]);
  });
});
