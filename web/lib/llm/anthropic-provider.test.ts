// @vitest-environment node
//
// `createAnthropicClient` constructs a real Anthropic SDK client (network
// calls mocked elsewhere, not here). The Anthropic SDK refuses to
// initialize under jsdom's browser-like globals unless
// `dangerouslyAllowBrowser` is set, so this needs Node's plain environment
// — same reasoning as the pre-refactor anthropic-client.test.ts this file
// replaces.
import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropicLlmClient, createAnthropicClient, ANTHROPIC_SEARCH_MODEL } from "@/lib/llm/anthropic-provider";
import type { ConversationMessage, ToolDefinition } from "@/lib/llm/types";

// The Anthropic SDK call is always mocked per this repo's offline-testing
// convention (CLAUDE.md) — no real LLM or network call runs in these
// tests. These fixtures port the shape assertions that used to live
// directly in search-loop.test.ts before the provider was extracted.

function textMessage(text: string): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: ANTHROPIC_SEARCH_MODEL,
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
    model: ANTHROPIC_SEARCH_MODEL,
    content: [{ type: "tool_use", id, name, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
  } as unknown as Anthropic.Message;
}

const TOOLS: ToolDefinition[] = [
  {
    name: "get_player_stats",
    description: "Look up a player's stats.",
    inputSchema: {
      type: "object",
      properties: { player_name: { type: "string" } },
      required: ["player_name"],
    },
  },
];

describe("anthropicLlmClient", () => {
  it("sends the model, system prompt, translated tools, and history", async () => {
    const createMessage = vi.fn().mockResolvedValueOnce(textMessage("hi"));
    const client = anthropicLlmClient(createMessage);

    await client.send({
      systemPrompt: "You are a stats assistant.",
      tools: TOOLS,
      history: [{ role: "user", content: "hello" }],
    });

    expect(createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: ANTHROPIC_SEARCH_MODEL,
        system: "You are a stats assistant.",
        tools: [
          {
            name: "get_player_stats",
            description: "Look up a player's stats.",
            input_schema: TOOLS[0].inputSchema,
          },
        ],
        messages: [{ role: "user", content: "hello" }],
      }),
    );
  });

  it("extracts tool calls from a tool_use response", async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce(toolUseMessage("get_player_stats", { player_name: "LeBron James" }, "abc"));
    const client = anthropicLlmClient(createMessage);

    const response = await client.send({
      systemPrompt: "",
      tools: TOOLS,
      history: [{ role: "user", content: "q" }],
    });

    expect(response).toEqual({
      text: "",
      toolCalls: [{ id: "abc", name: "get_player_stats", input: { player_name: "LeBron James" } }],
    });
  });

  it("returns final text with no tool calls on end_turn", async () => {
    const createMessage = vi.fn().mockResolvedValueOnce(textMessage("The answer is 30 points."));
    const client = anthropicLlmClient(createMessage);

    const response = await client.send({ systemPrompt: "", tools: [], history: [{ role: "user", content: "q" }] });

    expect(response).toEqual({ text: "The answer is 30 points.", toolCalls: [] });
  });

  it("translates assistant + tool_results history messages into Anthropic's message shape", async () => {
    const createMessage = vi.fn().mockResolvedValueOnce(textMessage("done"));
    const client = anthropicLlmClient(createMessage);
    const history: ConversationMessage[] = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ id: "abc", name: "get_player_stats", input: { player_name: "LeBron James" } }],
      },
      {
        role: "tool_results",
        results: [{ id: "abc", name: "get_player_stats", output: { points: 30 }, isError: false }],
      },
    ];

    await client.send({ systemPrompt: "", tools: [], history });

    const messages = createMessage.mock.calls[0][0].messages;
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "abc", name: "get_player_stats", input: { player_name: "LeBron James" } }],
    });
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "abc",
          content: JSON.stringify({ points: 30 }),
          is_error: false,
        },
      ],
    });
  });

  it("marks a tool_results message with is_error: true when the result was an error", async () => {
    const createMessage = vi.fn().mockResolvedValueOnce(textMessage("done"));
    const client = anthropicLlmClient(createMessage);
    const history: ConversationMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", text: "", toolCalls: [] },
      {
        role: "tool_results",
        results: [{ id: "abc", name: "get_player_stats", output: { status: "error" }, isError: true }],
      },
    ];

    await client.send({ systemPrompt: "", tools: [], history });

    const messages = createMessage.mock.calls[0][0].messages;
    expect(messages[2].content[0]).toEqual(
      expect.objectContaining({ type: "tool_result", is_error: true }),
    );
  });
});

describe("createAnthropicClient", () => {
  it("memoizes the client for the same API key", () => {
    const a = createAnthropicClient("test-key-1");
    const b = createAnthropicClient("test-key-1");
    expect(a).toBe(b);
  });

  it("constructs a new client when the API key changes", () => {
    const a = createAnthropicClient("test-key-a");
    const c = createAnthropicClient("test-key-b");
    expect(a).not.toBe(c);
  });
});
