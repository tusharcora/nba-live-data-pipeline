import { describe, expect, it, vi } from "vitest";
import { FALLBACK_RESULT, runSearchLoop } from "@/lib/search-loop";
import type { ToolResultEnvelope } from "@/lib/search-tools";
import type { LlmClient, LlmResponse } from "@/lib/llm/types";
import type { SearchResultData } from "@/lib/search-result-types";

// The LLM call is always mocked against a fake LlmClient per this repo's
// offline-testing convention (CLAUDE.md) — no real LLM or network call
// runs in these tests, and no provider SDK is imported here at all. This
// is deliberate: runSearchLoop must work against *any* conforming
// LlmClient, not just Anthropic's or Gemini's — see lib/llm/anthropic-provider.test.ts
// and lib/llm/gemini-provider.test.ts for the provider-specific adapter
// tests that verify each real SDK shape translates correctly.

function fakeLlmClient(...responses: LlmResponse[]): LlmClient {
  const send = vi.fn();
  for (const response of responses) send.mockResolvedValueOnce(response);
  return { send };
}

function toolCallResponse(name: string, input: Record<string, unknown>, id = "call_1"): LlmResponse {
  return { text: "", toolCalls: [{ id, name, input }] };
}

function finalResponse(text: string): LlmResponse {
  return { text, toolCalls: [] };
}

const SAMPLE_RESULT_DATA: SearchResultData = {
  type: "player_stats",
  payload: { playerName: "LeBron James", games: [] },
};

const OK_RESULT: ToolResultEnvelope = {
  status: "ok",
  table: "player_game_stats",
  date_range: "2024-10-22 to 2024-10-22",
  data: [{ points: 30 }],
  resultData: SAMPLE_RESULT_DATA,
  candidates: null,
  message: null,
};

const NO_MATCH_RESULT: ToolResultEnvelope = {
  status: "no_match",
  table: null,
  date_range: null,
  data: null,
  resultData: null,
  candidates: null,
  message: "No game found between Lakers and Celtics on 2099-01-01.",
};

const AMBIGUOUS_RESULT: ToolResultEnvelope = {
  status: "ambiguous",
  table: null,
  date_range: null,
  data: null,
  resultData: null,
  candidates: ["LeBron James", "LeBron James Jr."],
  message: "Multiple players match 'LeBron' -- please clarify which one.",
};

const ERROR_RESULT: ToolResultEnvelope = {
  status: "error",
  table: null,
  date_range: null,
  data: null,
  resultData: null,
  candidates: null,
  message: null,
};

describe("runSearchLoop", () => {
  it("happy path: one tool call resolves, citation is populated", async () => {
    const llmClient = fakeLlmClient(
      toolCallResponse("get_player_stats", { player_name: "LeBron James" }),
      finalResponse("LeBron James scored 30 points on 2024-10-22."),
    );
    const callTool = vi.fn().mockResolvedValueOnce(OK_RESULT);

    const result = await runSearchLoop({ question: "How many points did LeBron score?", llmClient, callTool });

    expect(callTool).toHaveBeenCalledWith("get_player_stats", { player_name: "LeBron James" });
    expect(result.noData).toBe(false);
    expect(result.candidates).toBeNull();
    expect(result.citation).toEqual({ table: "player_game_stats", dateRange: "2024-10-22 to 2024-10-22" });
    expect(result.answerText).toContain("30 points");
  });

  it("relays a no_match tool result honestly, never fabricating a number", async () => {
    const llmClient = fakeLlmClient(
      toolCallResponse("get_game_result", { team_a: "Lakers", team_b: "Celtics", date: "2099-01-01" }),
      finalResponse("I couldn't find a game between those teams on that date."),
    );
    const callTool = vi.fn().mockResolvedValueOnce(NO_MATCH_RESULT);

    const result = await runSearchLoop({ question: "Lakers vs Celtics on 2099-01-01?", llmClient, callTool });

    expect(result.noData).toBe(true);
    expect(result.citation).toBeNull();
    expect(result.candidates).toBeNull();
  });

  it("relays an ambiguous tool result as a candidate list, never guessing", async () => {
    const llmClient = fakeLlmClient(
      toolCallResponse("get_player_stats", { player_name: "LeBron" }),
      finalResponse("Did you mean one of these players?"),
    );
    const callTool = vi.fn().mockResolvedValueOnce(AMBIGUOUS_RESULT);

    const result = await runSearchLoop({ question: "LeBron's points?", llmClient, callTool });

    expect(result.noData).toBe(false);
    expect(result.citation).toBeNull();
    expect(result.candidates).toEqual(["LeBron James", "LeBron James Jr."]);
  });

  it("marks a failed tool call as is_error and falls back honestly when it never recovers", async () => {
    const llmClient = fakeLlmClient(
      toolCallResponse("get_player_stats", { player_name: "LeBron James" }, "call_err"),
      finalResponse("Something went wrong, here's a guess: 25 points."),
    );
    const callTool = vi.fn().mockResolvedValueOnce(ERROR_RESULT);

    const result = await runSearchLoop({ question: "LeBron's points?", llmClient, callTool });

    // A tool_results message was pushed to history with isError: true for
    // this call, correlated by id and carrying the original tool name.
    const secondSendArgs = vi.mocked(llmClient.send).mock.calls[1][0];
    const toolResultsMessage = secondSendArgs.history.find((m) => m.role === "tool_results");
    expect(toolResultsMessage).toEqual({
      role: "tool_results",
      results: [{ id: "call_err", name: "get_player_stats", output: ERROR_RESULT, isError: true }],
    });

    // No successful tool call ever happened -> discard the model's own
    // (fabricated) text and use the fixed fallback instead. CAP-4/CAP-5.
    expect(result).toEqual(FALLBACK_RESULT);
  });

  it("discards the model's answer and falls back when no tool was ever called", async () => {
    const llmClient = fakeLlmClient(finalResponse("LeBron James is a great player."));
    const callTool = vi.fn();

    const result = await runSearchLoop({ question: "Tell me about LeBron James", llmClient, callTool });

    expect(callTool).not.toHaveBeenCalled();
    expect(result).toEqual(FALLBACK_RESULT);
  });

  it("falls back honestly when the loop exceeds its iteration cap", async () => {
    const send = vi.fn().mockResolvedValue(toolCallResponse("get_player_stats", { player_name: "LeBron James" }));
    const llmClient: LlmClient = { send };
    const callTool = vi.fn().mockResolvedValue(OK_RESULT);

    const result = await runSearchLoop({ question: "LeBron's points?", llmClient, callTool });

    expect(result).toEqual(FALLBACK_RESULT);
    expect(send).toHaveBeenCalledTimes(6);
  });

  it("treats an ok tool result missing table/date_range as ungrounded (fallback), never a bare number", async () => {
    const llmClient = fakeLlmClient(
      toolCallResponse("get_player_stats", { player_name: "LeBron James" }),
      finalResponse("30 points."),
    );
    const callTool = vi.fn().mockResolvedValueOnce({
      status: "ok",
      table: null,
      date_range: null,
      data: [{ points: 30 }],
      candidates: null,
      message: null,
      resultData: null,
    } satisfies ToolResultEnvelope);

    const result = await runSearchLoop({ question: "LeBron's points?", llmClient, callTool });

    expect(result).toEqual(FALLBACK_RESULT);
  });

  it("falls back when an ok result has a table but no date_range (partial grounding is still ungrounded)", async () => {
    const llmClient = fakeLlmClient(
      toolCallResponse("get_player_stats", { player_name: "LeBron James" }),
      finalResponse("30 points."),
    );
    const callTool = vi.fn().mockResolvedValueOnce({
      status: "ok",
      table: "player_game_stats",
      date_range: null,
      data: [{ points: 30 }],
      candidates: null,
      message: null,
      resultData: null,
    } satisfies ToolResultEnvelope);

    const result = await runSearchLoop({ question: "LeBron's points?", llmClient, callTool });

    expect(result).toEqual(FALLBACK_RESULT);
  });

  it("falls back when an ok result has a date_range but no table (partial grounding is still ungrounded)", async () => {
    const llmClient = fakeLlmClient(
      toolCallResponse("get_player_stats", { player_name: "LeBron James" }),
      finalResponse("30 points."),
    );
    const callTool = vi.fn().mockResolvedValueOnce({
      status: "ok",
      table: null,
      date_range: "2024-10-22 to 2024-10-22",
      data: [{ points: 30 }],
      candidates: null,
      message: null,
      resultData: null,
    } satisfies ToolResultEnvelope);

    const result = await runSearchLoop({ question: "LeBron's points?", llmClient, callTool });

    expect(result).toEqual(FALLBACK_RESULT);
  });

  it("falls back on an ambiguous result with no candidates to disambiguate against", async () => {
    const llmClient = fakeLlmClient(
      toolCallResponse("get_player_stats", { player_name: "LeBron" }),
      finalResponse("Did you mean someone specific?"),
    );
    const callTool = vi.fn().mockResolvedValueOnce({
      status: "ambiguous",
      table: null,
      date_range: null,
      data: null,
      candidates: [],
      message: "Multiple players match 'LeBron' -- please clarify which one.",
      resultData: null,
    } satisfies ToolResultEnvelope);

    const result = await runSearchLoop({ question: "LeBron's points?", llmClient, callTool });

    expect(result).toEqual(FALLBACK_RESULT);
  });

  it("substitutes a minimal placeholder when the final turn's text is empty despite a grounded result", async () => {
    const llmClient = fakeLlmClient(
      toolCallResponse("get_player_stats", { player_name: "LeBron James" }),
      finalResponse(""),
    );
    const callTool = vi.fn().mockResolvedValueOnce(OK_RESULT);

    const result = await runSearchLoop({ question: "LeBron's points?", llmClient, callTool });

    expect(result.citation).toEqual({ table: "player_game_stats", dateRange: "2024-10-22 to 2024-10-22" });
    expect(result.answerText.length).toBeGreaterThan(0);
  });

  it("handles multiple tool calls in a single turn, dispatching each and preserving order in history", async () => {
    const llmClient = fakeLlmClient(
      {
        text: "",
        toolCalls: [
          { id: "call_a", name: "get_player_stats", input: { player_name: "LeBron James" } },
          { id: "call_b", name: "get_player_stats", input: { player_name: "Kevin Durant" } },
        ],
      },
      finalResponse("LeBron scored 30, Durant scored 28."),
    );
    const callTool = vi.fn().mockResolvedValueOnce(OK_RESULT).mockResolvedValueOnce(OK_RESULT);

    const result = await runSearchLoop({ question: "Compare LeBron and Durant's points", llmClient, callTool });

    expect(callTool).toHaveBeenNthCalledWith(1, "get_player_stats", { player_name: "LeBron James" });
    expect(callTool).toHaveBeenNthCalledWith(2, "get_player_stats", { player_name: "Kevin Durant" });
    const secondSendArgs = vi.mocked(llmClient.send).mock.calls[1][0];
    const toolResultsMessage = secondSendArgs.history.find((m) => m.role === "tool_results");
    expect(toolResultsMessage).toEqual({
      role: "tool_results",
      results: [
        { id: "call_a", name: "get_player_stats", output: OK_RESULT, isError: false },
        { id: "call_b", name: "get_player_stats", output: OK_RESULT, isError: false },
      ],
    });
    expect(result.noData).toBe(false);
  });

  it("happy path: resultData is populated alongside the citation", async () => {
    const llmClient = fakeLlmClient(
      toolCallResponse("get_player_stats", { player_name: "LeBron James" }),
      finalResponse("LeBron James scored 30 points on 2024-10-22."),
    );
    const callTool = vi.fn().mockResolvedValueOnce(OK_RESULT);

    const result = await runSearchLoop({ question: "How many points did LeBron score?", llmClient, callTool });

    expect(result.resultData).toEqual(SAMPLE_RESULT_DATA);
  });

  it("resultData is null on a no_match result, same as citation", async () => {
    const llmClient = fakeLlmClient(
      toolCallResponse("get_game_result", { team_a: "Lakers", team_b: "Celtics", date: "2099-01-01" }),
      finalResponse("I couldn't find a game between those teams on that date."),
    );
    const callTool = vi.fn().mockResolvedValueOnce(NO_MATCH_RESULT);

    const result = await runSearchLoop({ question: "Lakers vs Celtics on 2099-01-01?", llmClient, callTool });

    expect(result.resultData).toBeNull();
  });

  it("resultData is null on FALLBACK_RESULT (no tool call ever succeeded)", async () => {
    const llmClient = fakeLlmClient(finalResponse("I don't know."));
    const callTool = vi.fn();

    const result = await runSearchLoop({ question: "asdf", llmClient, callTool });

    expect(result).toEqual(FALLBACK_RESULT);
    expect(result.resultData).toBeNull();
  });
});
