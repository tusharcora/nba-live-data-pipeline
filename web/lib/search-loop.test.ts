import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { FALLBACK_RESULT, runSearchLoop, SEARCH_MODEL } from "@/lib/search-loop";
import type { ToolResultEnvelope } from "@/lib/search-tools";

// The Anthropic SDK call is always mocked per this repo's offline-testing
// convention (CLAUDE.md) — no real LLM or network call runs in these tests.

function textMessage(text: string): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: SEARCH_MODEL,
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
  } as unknown as Anthropic.Message;
}

function toolUseMessage(name: string, input: Record<string, unknown>, id = "tool_1"): Anthropic.Message {
  return {
    id: "msg_tool",
    type: "message",
    role: "assistant",
    model: SEARCH_MODEL,
    content: [{ type: "tool_use", id, name, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
  } as unknown as Anthropic.Message;
}

const OK_RESULT: ToolResultEnvelope = {
  status: "ok",
  table: "player_game_stats",
  date_range: "2024-10-22 to 2024-10-22",
  data: [{ points: 30 }],
  candidates: null,
};

const NO_MATCH_RESULT: ToolResultEnvelope = {
  status: "no_match",
  table: null,
  date_range: null,
  data: null,
  candidates: null,
};

const AMBIGUOUS_RESULT: ToolResultEnvelope = {
  status: "ambiguous",
  table: null,
  date_range: null,
  data: null,
  candidates: ["LeBron James", "LeBron James Jr."],
};

const ERROR_RESULT: ToolResultEnvelope = {
  status: "error",
  table: null,
  date_range: null,
  data: null,
  candidates: null,
};

describe("runSearchLoop", () => {
  it("happy path: one tool call resolves, citation is populated", async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce(toolUseMessage("get_player_stats", { player_name: "LeBron James" }))
      .mockResolvedValueOnce(textMessage("LeBron James scored 30 points on 2024-10-22."));
    const callTool = vi.fn().mockResolvedValueOnce(OK_RESULT);

    const result = await runSearchLoop({ question: "How many points did LeBron score?", createMessage, callTool });

    expect(callTool).toHaveBeenCalledWith("get_player_stats", { player_name: "LeBron James" });
    expect(result.noData).toBe(false);
    expect(result.candidates).toBeNull();
    expect(result.citation).toEqual({ table: "player_game_stats", dateRange: "2024-10-22 to 2024-10-22" });
    expect(result.answerText).toContain("30 points");
  });

  it("relays a no_match tool result honestly, never fabricating a number", async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce(toolUseMessage("get_game_result", { team_a: "Lakers", team_b: "Celtics", date: "2099-01-01" }))
      .mockResolvedValueOnce(textMessage("I couldn't find a game between those teams on that date."));
    const callTool = vi.fn().mockResolvedValueOnce(NO_MATCH_RESULT);

    const result = await runSearchLoop({ question: "Lakers vs Celtics on 2099-01-01?", createMessage, callTool });

    expect(result.noData).toBe(true);
    expect(result.citation).toBeNull();
    expect(result.candidates).toBeNull();
  });

  it("relays an ambiguous tool result as a candidate list, never guessing", async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce(toolUseMessage("get_player_stats", { player_name: "LeBron" }))
      .mockResolvedValueOnce(textMessage("Did you mean one of these players?"));
    const callTool = vi.fn().mockResolvedValueOnce(AMBIGUOUS_RESULT);

    const result = await runSearchLoop({ question: "LeBron's points?", createMessage, callTool });

    expect(result.noData).toBe(false);
    expect(result.citation).toBeNull();
    expect(result.candidates).toEqual(["LeBron James", "LeBron James Jr."]);
  });

  it("marks a failed tool call as is_error and falls back honestly when it never recovers", async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce(toolUseMessage("get_player_stats", { player_name: "LeBron James" }))
      .mockResolvedValueOnce(textMessage("Something went wrong, here's a guess: 25 points."));
    const callTool = vi.fn().mockResolvedValueOnce(ERROR_RESULT);

    const result = await runSearchLoop({ question: "LeBron's points?", createMessage, callTool });

    // A tool_result for the error was sent back with is_error: true.
    const secondCallArgs = createMessage.mock.calls[1][0] as Anthropic.MessageCreateParamsNonStreaming;
    const userMessages = secondCallArgs.messages.filter((m) => m.role === "user");
    const toolResultMessage = userMessages[userMessages.length - 1];
    expect(toolResultMessage.content).toEqual([
      expect.objectContaining({ type: "tool_result", is_error: true }),
    ]);

    // No successful tool call ever happened -> discard the model's own
    // (fabricated) text and use the fixed fallback instead. CAP-4/CAP-5.
    expect(result).toEqual(FALLBACK_RESULT);
  });

  it("discards the model's answer and falls back when no tool was ever called", async () => {
    const createMessage = vi.fn().mockResolvedValueOnce(textMessage("LeBron James is a great player."));
    const callTool = vi.fn();

    const result = await runSearchLoop({ question: "Tell me about LeBron James", createMessage, callTool });

    expect(callTool).not.toHaveBeenCalled();
    expect(result).toEqual(FALLBACK_RESULT);
  });

  it("falls back honestly when the loop exceeds its iteration cap", async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValue(toolUseMessage("get_player_stats", { player_name: "LeBron James" }));
    const callTool = vi.fn().mockResolvedValue(OK_RESULT);

    const result = await runSearchLoop({ question: "LeBron's points?", createMessage, callTool });

    expect(result).toEqual(FALLBACK_RESULT);
    expect(createMessage).toHaveBeenCalledTimes(6);
  });

  it("treats an ok tool result missing table/date_range as ungrounded (fallback), never a bare number", async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce(toolUseMessage("get_player_stats", { player_name: "LeBron James" }))
      .mockResolvedValueOnce(textMessage("30 points."));
    const callTool = vi.fn().mockResolvedValueOnce({
      status: "ok",
      table: null,
      date_range: null,
      data: [{ points: 30 }],
      candidates: null,
    } satisfies ToolResultEnvelope);

    const result = await runSearchLoop({ question: "LeBron's points?", createMessage, callTool });

    expect(result).toEqual(FALLBACK_RESULT);
  });

  it("falls back when an ok result has a table but no date_range (partial grounding is still ungrounded)", async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce(toolUseMessage("get_player_stats", { player_name: "LeBron James" }))
      .mockResolvedValueOnce(textMessage("30 points."));
    const callTool = vi.fn().mockResolvedValueOnce({
      status: "ok",
      table: "player_game_stats",
      date_range: null,
      data: [{ points: 30 }],
      candidates: null,
    } satisfies ToolResultEnvelope);

    const result = await runSearchLoop({ question: "LeBron's points?", createMessage, callTool });

    expect(result).toEqual(FALLBACK_RESULT);
  });

  it("falls back when an ok result has a date_range but no table (partial grounding is still ungrounded)", async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce(toolUseMessage("get_player_stats", { player_name: "LeBron James" }))
      .mockResolvedValueOnce(textMessage("30 points."));
    const callTool = vi.fn().mockResolvedValueOnce({
      status: "ok",
      table: null,
      date_range: "2024-10-22 to 2024-10-22",
      data: [{ points: 30 }],
      candidates: null,
    } satisfies ToolResultEnvelope);

    const result = await runSearchLoop({ question: "LeBron's points?", createMessage, callTool });

    expect(result).toEqual(FALLBACK_RESULT);
  });

  it("falls back on an ambiguous result with no candidates to disambiguate against", async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce(toolUseMessage("get_player_stats", { player_name: "LeBron" }))
      .mockResolvedValueOnce(textMessage("Did you mean someone specific?"));
    const callTool = vi.fn().mockResolvedValueOnce({
      status: "ambiguous",
      table: null,
      date_range: null,
      data: null,
      candidates: [],
    } satisfies ToolResultEnvelope);

    const result = await runSearchLoop({ question: "LeBron's points?", createMessage, callTool });

    expect(result).toEqual(FALLBACK_RESULT);
  });

  it("substitutes a minimal placeholder when the final turn's text is empty despite a grounded result", async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce(toolUseMessage("get_player_stats", { player_name: "LeBron James" }))
      .mockResolvedValueOnce(textMessage(""));
    const callTool = vi.fn().mockResolvedValueOnce(OK_RESULT);

    const result = await runSearchLoop({ question: "LeBron's points?", createMessage, callTool });

    expect(result.citation).toEqual({ table: "player_game_stats", dateRange: "2024-10-22 to 2024-10-22" });
    expect(result.answerText.length).toBeGreaterThan(0);
  });
});
