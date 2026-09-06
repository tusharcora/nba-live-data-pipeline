// @vitest-environment node
//
// `createGroqClient` constructs a real Groq SDK client (network calls
// mocked elsewhere, not here) -- same Node-environment reasoning as
// anthropic-provider.test.ts / gemini-provider.test.ts.
//
// The `ChatCompletion`/`tool_calls` response shapes and
// `ChatCompletionMessageParam`/`ChatCompletionTool` request shapes below
// are transcribed from the installed `groq-sdk` package's own bundled type
// definitions (node_modules/groq-sdk/resources/chat/completions.d.ts and
// resources/shared.d.ts), not guessed -- same "test against the real
// shape" discipline gemini-provider.test.ts applied to @google/genai.
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletion } from "groq-sdk/resources/chat/completions";
import { createGroqClient, groqLlmClient, GROQ_SEARCH_MODEL } from "@/lib/llm/groq-provider";
import type { ConversationMessage, ToolDefinition } from "@/lib/llm/types";

function textCompletion(text: string): ChatCompletion {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: GROQ_SEARCH_MODEL,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        logprobs: null,
        message: { role: "assistant", content: text },
      },
    ],
  } as unknown as ChatCompletion;
}

// Builds a raw `choices[0].message.tool_calls` response -- the real shape
// `extractToolCalls` reads, with `function.arguments` as a JSON *string*
// (per ChatCompletionMessageToolCall.Function -- not an already-parsed
// object like Anthropic's `input` or Gemini's `args`). `text` defaults to
// `null` (the common case: a pure tool-call turn), but can be set to
// exercise a turn carrying both reasoning text AND tool calls at once --
// `message.content` and `message.tool_calls` are independent fields on the
// same message, not mutually exclusive.
function toolCallCompletion(
  calls: { id: string; name: string; args: Record<string, unknown> | string }[],
  text: string | null = null,
): ChatCompletion {
  return {
    id: "chatcmpl-2",
    object: "chat.completion",
    created: 1,
    model: GROQ_SEARCH_MODEL,
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        logprobs: null,
        message: {
          role: "assistant",
          content: text,
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args),
            },
          })),
        },
      },
    ],
  } as unknown as ChatCompletion;
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

describe("groqLlmClient", () => {
  it("sends the model, system message, translated tools, and tool_choice: auto", async () => {
    const createChatCompletion = vi.fn().mockResolvedValueOnce(textCompletion("hi"));
    const client = groqLlmClient(createChatCompletion);

    await client.send({
      systemPrompt: "You are a stats assistant.",
      tools: TOOLS,
      history: [{ role: "user", content: "hello" }],
    });

    const callArgs = createChatCompletion.mock.calls[0][0];
    expect(callArgs.model).toBe(GROQ_SEARCH_MODEL);
    expect(callArgs.tool_choice).toBe("auto");
    // The system prompt is an ordinary {role: "system"} message, not a
    // separate top-level field like Anthropic's `system` or Gemini's
    // `systemInstruction`.
    expect(callArgs.messages[0]).toEqual({ role: "system", content: "You are a stats assistant." });
    expect(callArgs.messages[1]).toEqual({ role: "user", content: "hello" });
    // `parameters` takes the JSON Schema object directly -- no conversion.
    expect(callArgs.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_player_stats",
          description: "Look up a player's stats.",
          parameters: TOOLS[0].inputSchema,
        },
      },
    ]);
  });

  it("extracts a single tool call, parsing the JSON-string arguments into an object", async () => {
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallCompletion([{ id: "call_abc", name: "get_player_stats", args: { player_name: "LeBron James" } }]),
      );
    const client = groqLlmClient(createChatCompletion);

    const response = await client.send({ systemPrompt: "", tools: TOOLS, history: [{ role: "user", content: "q" }] });

    expect(response).toEqual({
      text: "",
      toolCalls: [{ id: "call_abc", name: "get_player_stats", input: { player_name: "LeBron James" } }],
    });
  });

  it("extracts both the reasoning text AND the tool calls when a turn carries both at once", async () => {
    // Regression guard: message.content and message.tool_calls are
    // independent fields on the same ChatCompletionMessage, not mutually
    // exclusive -- a turn can carry a preamble ("Let me look that up...")
    // alongside a tool call. Nothing else in this suite exercises a
    // non-null content on a tool_calls response (toolCallCompletion
    // defaults `text` to null), so a regression that started dropping the
    // model's reasoning text on a combined turn would otherwise go
    // uncaught.
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallCompletion(
          [{ id: "call_abc", name: "get_player_stats", args: { player_name: "LeBron James" } }],
          "Let me look up LeBron's stats for that date.",
        ),
      );
    const client = groqLlmClient(createChatCompletion);

    const response = await client.send({ systemPrompt: "", tools: TOOLS, history: [{ role: "user", content: "q" }] });

    expect(response).toEqual({
      text: "Let me look up LeBron's stats for that date.",
      toolCalls: [{ id: "call_abc", name: "get_player_stats", input: { player_name: "LeBron James" } }],
    });
  });

  it("extracts multiple tool calls from a single raw response, all correctly and in order (regression: extraction, not history round-tripping)", async () => {
    // Feeds a raw multi-tool_call SDK response through the real send() ->
    // extraction path -- catches a regression that drops or corrupts
    // calls during extraction itself, which a fake-LlmClient test (like
    // search-loop.test.ts's) cannot.
    const createChatCompletion = vi.fn().mockResolvedValueOnce(
      toolCallCompletion([
        { id: "call_a", name: "get_player_stats", args: { player_name: "LeBron James" } },
        { id: "call_b", name: "get_player_stats", args: { player_name: "Kevin Durant" } },
        {
          id: "call_c",
          name: "get_game_result",
          args: { team_a: "Lakers", team_b: "Celtics", date: "2024-01-03" },
        },
      ]),
    );
    const client = groqLlmClient(createChatCompletion);

    const response = await client.send({
      systemPrompt: "",
      tools: TOOLS,
      history: [{ role: "user", content: "Compare LeBron and Durant, and the Lakers-Celtics result" }],
    });

    expect(response.toolCalls).toEqual([
      { id: "call_a", name: "get_player_stats", input: { player_name: "LeBron James" } },
      { id: "call_b", name: "get_player_stats", input: { player_name: "Kevin Durant" } },
      {
        id: "call_c",
        name: "get_game_result",
        input: { team_a: "Lakers", team_b: "Celtics", date: "2024-01-03" },
      },
    ]);
  });

  it("returns final text with no tool calls when the model answers directly", async () => {
    const createChatCompletion = vi.fn().mockResolvedValueOnce(textCompletion("The answer is 30 points."));
    const client = groqLlmClient(createChatCompletion);

    const response = await client.send({ systemPrompt: "", tools: [], history: [{ role: "user", content: "q" }] });

    expect(response).toEqual({ text: "The answer is 30 points.", toolCalls: [] });
  });

  it("degrades to an empty input (never throws) when a tool call's arguments string is malformed JSON", async () => {
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallCompletion([{ id: "call_bad", name: "get_player_stats", args: "{not valid json" }]),
      );
    const client = groqLlmClient(createChatCompletion);

    const response = await client.send({ systemPrompt: "", tools: TOOLS, history: [{ role: "user", content: "q" }] });

    expect(response.toolCalls).toEqual([{ id: "call_bad", name: "get_player_stats", input: {} }]);
  });

  it("translates an assistant turn's tool calls into a message with tool_calls and JSON-stringified arguments", async () => {
    const createChatCompletion = vi.fn().mockResolvedValueOnce(textCompletion("done"));
    const client = groqLlmClient(createChatCompletion);
    const history: ConversationMessage[] = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ id: "call_abc", name: "get_player_stats", input: { player_name: "LeBron James" } }],
      },
    ];

    await client.send({ systemPrompt: "", tools: [], history });

    const messages = createChatCompletion.mock.calls[0][0].messages;
    expect(messages[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_abc",
          type: "function",
          function: { name: "get_player_stats", arguments: JSON.stringify({ player_name: "LeBron James" }) },
        },
      ],
    });
  });

  it("translates a tool_results message into one separate {role: tool} message per result, correlated by tool_call_id", async () => {
    const createChatCompletion = vi.fn().mockResolvedValueOnce(textCompletion("done"));
    const client = groqLlmClient(createChatCompletion);
    const history: ConversationMessage[] = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        text: "",
        toolCalls: [
          { id: "call_a", name: "get_player_stats", input: { player_name: "LeBron James" } },
          { id: "call_b", name: "get_player_stats", input: { player_name: "Kevin Durant" } },
        ],
      },
      {
        role: "tool_results",
        results: [
          { id: "call_a", name: "get_player_stats", output: { points: 30 }, isError: false },
          { id: "call_b", name: "get_player_stats", output: { points: 28 }, isError: false },
        ],
      },
    ];

    await client.send({ systemPrompt: "", tools: [], history });

    const messages = createChatCompletion.mock.calls[0][0].messages;
    // Unlike Anthropic (one user turn, multiple tool_result blocks) or
    // Gemini (one Content, multiple functionResponse parts), Groq/OpenAI-
    // shaped APIs get one separate {role: "tool"} message per result.
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "call_a", content: JSON.stringify({ points: 30 }) });
    expect(messages[4]).toEqual({ role: "tool", tool_call_id: "call_b", content: JSON.stringify({ points: 28 }) });
  });

  it("has no dedicated error flag -- an error result's isError is only conveyed through the JSON content itself", async () => {
    const createChatCompletion = vi.fn().mockResolvedValueOnce(textCompletion("done"));
    const client = groqLlmClient(createChatCompletion);
    const history: ConversationMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", text: "", toolCalls: [] },
      {
        role: "tool_results",
        results: [{ id: "call_x", name: "get_player_stats", output: { status: "error" }, isError: true }],
      },
    ];

    await client.send({ systemPrompt: "", tools: [], history });

    const messages = createChatCompletion.mock.calls[0][0].messages;
    expect(messages[3]).toEqual({
      role: "tool",
      tool_call_id: "call_x",
      content: JSON.stringify({ status: "error" }),
    });
    expect(messages[3]).not.toHaveProperty("is_error");
  });
});

describe("createGroqClient", () => {
  it("memoizes the client for the same API key", () => {
    const a = createGroqClient("test-key-1");
    const b = createGroqClient("test-key-1");
    expect(a).toBe(b);
  });

  it("constructs a new client when the API key changes", () => {
    const a = createGroqClient("test-key-a");
    const c = createGroqClient("test-key-b");
    expect(a).not.toBe(c);
  });
});
