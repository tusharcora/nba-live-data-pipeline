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

const OK_RESULT_WITH_CONFIDENCE: ToolResultEnvelope = {
  status: "ok",
  table: "games",
  date_range: "2024-10-22 to 2024-10-22",
  data: {
    game: {
      game_id: 1,
      home_team: "Los Angeles Lakers",
      away_team: "Boston Celtics",
      home_score: 103,
      away_score: 101,
      data_confidence: {
        field: "home_score",
        note: "balldontlie and nba_stats disagree on home score; showing balldontlie's number.",
        primary_source: "balldontlie",
        primary_value: "103",
        secondary_source: "nba_stats",
        secondary_value: "101",
      },
    },
    box_score: [],
  },
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
    // this call, correlated by id and carrying the original tool name. The
    // model-facing output always has the `resultData` key stripped (see
    // the dedicated resultData-stripping test below) -- even here, where
    // ERROR_RESULT's resultData was already `null`, the key itself must be
    // absent, not merely `null`.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { resultData: _omittedFromError, ...strippedErrorResult } = ERROR_RESULT;
    const secondSendArgs = vi.mocked(llmClient.send).mock.calls[1][0];
    const toolResultsMessage = secondSendArgs.history.find((m) => m.role === "tool_results");
    expect(toolResultsMessage).toEqual({
      role: "tool_results",
      results: [{ id: "call_err", name: "get_player_stats", output: strippedErrorResult, isError: true }],
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
    // OK_RESULT carries a non-null resultData -- the model-facing output
    // must have it stripped (see the dedicated resultData-stripping test
    // below), even though `lastToolResult`/the final SearchResult still get
    // the full envelope.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { resultData: _omitted, ...strippedOkResult } = OK_RESULT;
    expect(toolResultsMessage).toEqual({
      role: "tool_results",
      results: [
        { id: "call_a", name: "get_player_stats", output: strippedOkResult, isError: false },
        { id: "call_b", name: "get_player_stats", output: strippedOkResult, isError: false },
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

  it("strips resultData from the model-facing tool output, but still surfaces it on the final SearchResult", async () => {
    const llmClient = fakeLlmClient(
      toolCallResponse("get_player_stats", { player_name: "LeBron James" }),
      finalResponse("LeBron James scored 30 points on 2024-10-22."),
    );
    const callTool = vi.fn().mockResolvedValueOnce(OK_RESULT);

    const result = await runSearchLoop({ question: "How many points did LeBron score?", llmClient, callTool });

    // The tool-result message pushed into the second `send()` call's
    // history (i.e. what actually reaches the LLM) must not carry
    // resultData at all -- not even as an explicit `null` -- since the
    // model already sees the same rows via `data`.
    const secondSendArgs = vi.mocked(llmClient.send).mock.calls[1][0];
    const toolResultsMessage = secondSendArgs.history.find((m) => m.role === "tool_results");
    expect(toolResultsMessage?.role).toBe("tool_results");
    if (toolResultsMessage?.role === "tool_results") {
      const modelFacingOutput = toolResultsMessage.results[0].output as Record<string, unknown>;
      expect(modelFacingOutput).not.toHaveProperty("resultData");
      expect(modelFacingOutput.data).toEqual(OK_RESULT.data);
    }

    // Meanwhile the BFF-facing SearchResult (built from lastToolResult,
    // which still carries the full envelope) keeps resultData intact for
    // the client's tables.
    expect(result.resultData).toEqual(SAMPLE_RESULT_DATA);
  });

  it("comparison: one turn requesting two get_player_stat_aggregate calls with different date_range dispatches both and cites the last one", async () => {
    const AGGREGATE_A: ToolResultEnvelope = {
      status: "ok",
      table: "player_game_stats",
      date_range: "2026-09-01 to 2026-09-30",
      data: { player_name: "LeBron James", value: 812 },
      resultData: {
        type: "stat_aggregate",
        payload: {
          playerName: "LeBron James", stat: "points", operation: "sum", threshold: null,
          value: 812, extremeGame: null, matchingGames: null, matchingGamesTruncated: false,
          gameCountConsidered: 30,
        },
      },
      candidates: null,
      message: null,
    };
    const AGGREGATE_B: ToolResultEnvelope = {
      status: "ok",
      table: "player_game_stats",
      date_range: "2025-10-01 to 2026-09-30",
      data: { player_name: "Stephen Curry", value: 2400 },
      resultData: {
        type: "stat_aggregate",
        payload: {
          playerName: "Stephen Curry", stat: "points", operation: "sum", threshold: null,
          value: 2400, extremeGame: null, matchingGames: null, matchingGamesTruncated: false,
          gameCountConsidered: 60,
        },
      },
      candidates: null,
      message: null,
    };

    const llmClient = fakeLlmClient(
      {
        text: "",
        toolCalls: [
          {
            id: "call_1",
            name: "get_player_stat_aggregate",
            input: {
              player_name: "LeBron James",
              stat: "points",
              operation: "sum",
              date_range: { start: "2026-09-01", end: "2026-09-30" },
            },
          },
          {
            id: "call_2",
            name: "get_player_stat_aggregate",
            input: {
              player_name: "Stephen Curry",
              stat: "points",
              operation: "sum",
              date_range: { start: "2025-10-01", end: "2026-09-30" },
            },
          },
        ],
      },
      finalResponse("Stephen Curry scored more (2400 vs. 812)."),
    );
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(AGGREGATE_A)
      .mockResolvedValueOnce(AGGREGATE_B);

    const result = await runSearchLoop({
      question: "Who scored more, LeBron this month or Steph this season?",
      llmClient,
      callTool,
    });

    expect(callTool).toHaveBeenCalledTimes(2);
    expect(callTool).toHaveBeenNthCalledWith(1, "get_player_stat_aggregate", {
      player_name: "LeBron James",
      stat: "points",
      operation: "sum",
      date_range: { start: "2026-09-01", end: "2026-09-30" },
    });
    expect(callTool).toHaveBeenNthCalledWith(2, "get_player_stat_aggregate", {
      player_name: "Stephen Curry",
      stat: "points",
      operation: "sum",
      date_range: { start: "2025-10-01", end: "2026-09-30" },
    });
    expect(result.noData).toBe(false);
    expect(result.answerText).toContain("2400");
  });

  it("suppresses resultData on a comparison turn dispatching 2 ok results, but keeps the prose answer (Important #4)", async () => {
    // Same shape as the comparison test above, but asserting the specific
    // regression this fix targets: finalize() must not let lastToolResult's
    // single-subject resultData through when the turn that produced it
    // dispatched more than one ok/no_match/ambiguous result -- that would
    // misleadingly render only the *second* subject's stat card as if it
    // were "the" answer. The prose answerText is untouched since the model
    // saw both tool results.
    const AGGREGATE_A: ToolResultEnvelope = {
      status: "ok",
      table: "player_game_stats",
      date_range: "2026-09-01 to 2026-09-30",
      data: { player_name: "LeBron James", value: 812 },
      resultData: {
        type: "stat_aggregate",
        payload: {
          playerName: "LeBron James", stat: "points", operation: "sum", threshold: null,
          value: 812, extremeGame: null, matchingGames: null, matchingGamesTruncated: false,
          gameCountConsidered: 30,
        },
      },
      candidates: null,
      message: null,
    };
    const AGGREGATE_B: ToolResultEnvelope = {
      status: "ok",
      table: "player_game_stats",
      date_range: "2025-10-01 to 2026-09-30",
      data: { player_name: "Stephen Curry", value: 2400 },
      resultData: {
        type: "stat_aggregate",
        payload: {
          playerName: "Stephen Curry", stat: "points", operation: "sum", threshold: null,
          value: 2400, extremeGame: null, matchingGames: null, matchingGamesTruncated: false,
          gameCountConsidered: 60,
        },
      },
      candidates: null,
      message: null,
    };

    const llmClient = fakeLlmClient(
      {
        text: "",
        toolCalls: [
          {
            id: "call_1",
            name: "get_player_stat_aggregate",
            input: {
              player_name: "LeBron James",
              stat: "points",
              operation: "sum",
              date_range: { start: "2026-09-01", end: "2026-09-30" },
            },
          },
          {
            id: "call_2",
            name: "get_player_stat_aggregate",
            input: {
              player_name: "Stephen Curry",
              stat: "points",
              operation: "sum",
              date_range: { start: "2025-10-01", end: "2026-09-30" },
            },
          },
        ],
      },
      finalResponse("Stephen Curry scored more (2400 vs. 812)."),
    );
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(AGGREGATE_A)
      .mockResolvedValueOnce(AGGREGATE_B);

    const result = await runSearchLoop({
      question: "Who scored more, LeBron this month or Steph this season?",
      llmClient,
      callTool,
    });

    expect(result.resultData).toBeNull();
    expect(result.answerText.length).toBeGreaterThan(0);
    expect(result.answerText).toContain("2400");
  });

  it("still populates resultData for a turn with exactly one ok result (no regression from the comparison-turn fix)", async () => {
    const llmClient = fakeLlmClient(
      toolCallResponse("get_player_stats", { player_name: "LeBron James" }),
      finalResponse("LeBron James scored 30 points on 2024-10-22."),
    );
    const callTool = vi.fn().mockResolvedValueOnce(OK_RESULT);

    const result = await runSearchLoop({ question: "How many points did LeBron score?", llmClient, callTool });

    expect(result.resultData).toEqual(SAMPLE_RESULT_DATA);
  });

  it("threads a tool result's data_confidence through to the model's context", async () => {
    const llmClient = fakeLlmClient(
      toolCallResponse("get_game_result", { team_a: "Lakers", team_b: "Celtics", date: "2024-10-22" }),
      finalResponse("Lakers beat Celtics 103-101 -- sources disagree on the home score."),
    );
    const callTool = vi.fn().mockResolvedValueOnce(OK_RESULT_WITH_CONFIDENCE);

    await runSearchLoop({ question: "What was the score?", llmClient, callTool });

    // runSearchLoop calls llmClient.send({systemPrompt, tools, history})
    // once per iteration with the full accumulated history so far. The
    // second call (index 1) is the one made after the first iteration's
    // tool dispatch pushed a `{role: "tool_results", results}` entry onto
    // history -- assert the raw data_confidence payload reached it, proving
    // nothing upstream (search-tools.ts's envelope construction) silently
    // drops the field before the model ever sees it.
    const send = llmClient.send as ReturnType<typeof vi.fn>;
    const secondCallArgs = send.mock.calls[1][0];
    const serializedHistory = JSON.stringify(secondCallArgs.history);
    expect(serializedHistory).toContain("data_confidence");
    expect(serializedHistory).toContain("balldontlie and nba_stats disagree");
  });
});
