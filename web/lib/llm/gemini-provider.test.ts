// @vitest-environment node
//
// `createGeminiClient` constructs a real Google GenAI SDK client (network
// calls mocked elsewhere, not here) — same Node-environment reasoning as
// anthropic-provider.test.ts.
//
// The `functionCalls`/`text` response shapes and `FunctionDeclaration`/
// `Content`/`Part` request shapes below are transcribed from the installed
// `@google/genai` package's own bundled type definitions
// (node_modules/@google/genai/dist/genai.d.ts), not guessed — this is the
// same "test against the real shape" discipline lib/search-tools.test.ts
// applied to Dev1's FastAPI envelope.
import { describe, expect, it, vi } from "vitest";
import { FunctionCallingConfigMode } from "@google/genai";
import type { GenerateContentResponse } from "@google/genai";
import { createGeminiClient, geminiLlmClient, GEMINI_SEARCH_MODEL } from "@/lib/llm/gemini-provider";
import type { ConversationMessage, ToolDefinition } from "@/lib/llm/types";

function textResponse(text: string): GenerateContentResponse {
  return { text, functionCalls: undefined } as unknown as GenerateContentResponse;
}

function functionCallResponse(
  calls: { name: string; args: Record<string, unknown> }[],
): GenerateContentResponse {
  return { text: undefined, functionCalls: calls } as unknown as GenerateContentResponse;
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

describe("geminiLlmClient", () => {
  it("sends the model, system instruction, and a FunctionDeclaration using parametersJsonSchema", async () => {
    const generateContent = vi.fn().mockResolvedValueOnce(textResponse("hi"));
    const client = geminiLlmClient(generateContent);

    await client.send({
      systemPrompt: "You are a stats assistant.",
      tools: TOOLS,
      history: [{ role: "user", content: "hello" }],
    });

    const callArgs = generateContent.mock.calls[0][0];
    expect(callArgs.model).toBe(GEMINI_SEARCH_MODEL);
    expect(callArgs.config.systemInstruction).toBe("You are a stats assistant.");
    // parametersJsonSchema takes the JSON Schema object directly -- no
    // conversion to Gemini's own Type-enum-based `parameters` field.
    expect(callArgs.config.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "get_player_stats",
            description: "Look up a player's stats.",
            parametersJsonSchema: TOOLS[0].inputSchema,
          },
        ],
      },
    ]);
    expect(callArgs.config.toolConfig).toEqual({
      functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
    });
  });

  it("translates a plain user turn to role 'user' with a text part", async () => {
    const generateContent = vi.fn().mockResolvedValueOnce(textResponse("hi"));
    const client = geminiLlmClient(generateContent);

    await client.send({ systemPrompt: "", tools: [], history: [{ role: "user", content: "How many points?" }] });

    expect(generateContent.mock.calls[0][0].contents).toEqual([
      { role: "user", parts: [{ text: "How many points?" }] },
    ]);
  });

  it("extracts a functionCall response as a toolCalls request with a synthesized id", async () => {
    const generateContent = vi
      .fn()
      .mockResolvedValueOnce(
        functionCallResponse([{ name: "get_player_stats", args: { player_name: "LeBron James" } }]),
      );
    const client = geminiLlmClient(generateContent);

    const response = await client.send({ systemPrompt: "", tools: TOOLS, history: [{ role: "user", content: "q" }] });

    // Gemini's FunctionCall.id is only populated by the separate Live/Bidi
    // API -- a plain generateContent response never has one, so this
    // adapter must synthesize one for our shared ToolCallRequest.id.
    expect(response.toolCalls).toEqual([
      { id: "get_player_stats-0", name: "get_player_stats", input: { player_name: "LeBron James" } },
    ]);
  });

  it("extracts multiple functionCalls from a single raw response, all correctly and in order (regression: extraction, not history round-tripping)", async () => {
    // Unlike the "preserves call order" test further down (which only
    // exercises translating an already-built ConversationMessage history
    // into Gemini's request shape), this feeds a raw multi-functionCall SDK
    // response through the real extractToolCalls path via `send()` --
    // catches a regression that drops or corrupts calls during extraction
    // itself, which a history-only test cannot.
    const generateContent = vi.fn().mockResolvedValueOnce(
      functionCallResponse([
        { name: "get_player_stats", args: { player_name: "LeBron James" } },
        { name: "get_player_stats", args: { player_name: "Kevin Durant" } },
        { name: "get_game_result", args: { team_a: "Lakers", team_b: "Celtics", date: "2024-01-03" } },
      ]),
    );
    const client = geminiLlmClient(generateContent);

    const response = await client.send({
      systemPrompt: "",
      tools: TOOLS,
      history: [{ role: "user", content: "Compare LeBron and Durant, and the Lakers-Celtics result" }],
    });

    expect(response.toolCalls).toEqual([
      { id: "get_player_stats-0", name: "get_player_stats", input: { player_name: "LeBron James" } },
      { id: "get_player_stats-1", name: "get_player_stats", input: { player_name: "Kevin Durant" } },
      {
        id: "get_game_result-2",
        name: "get_game_result",
        input: { team_a: "Lakers", team_b: "Celtics", date: "2024-01-03" },
      },
    ]);
  });

  it("returns an empty, honest turn (never throws) when the response's text/functionCalls getters throw, e.g. a safety block", async () => {
    const blockedResponse = {
      get text(): string {
        throw new Error("Cannot read properties of undefined (no candidates)");
      },
      get functionCalls(): never {
        throw new Error("Cannot read properties of undefined (no candidates)");
      },
    } as unknown as GenerateContentResponse;
    const generateContent = vi.fn().mockResolvedValueOnce(blockedResponse);
    const client = geminiLlmClient(generateContent);

    const response = await client.send({ systemPrompt: "", tools: [], history: [{ role: "user", content: "q" }] });

    expect(response).toEqual({ text: "", toolCalls: [] });
  });

  it("returns final text with no tool calls when functionCalls is absent (the model answered directly)", async () => {
    const generateContent = vi.fn().mockResolvedValueOnce(textResponse("The answer is 30 points."));
    const client = geminiLlmClient(generateContent);

    const response = await client.send({ systemPrompt: "", tools: [], history: [{ role: "user", content: "q" }] });

    expect(response).toEqual({ text: "The answer is 30 points.", toolCalls: [] });
  });

  it("translates an assistant turn's tool calls to role 'model' with functionCall parts", async () => {
    const generateContent = vi.fn().mockResolvedValueOnce(textResponse("done"));
    const client = geminiLlmClient(generateContent);
    const history: ConversationMessage[] = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        text: "",
        toolCalls: [
          { id: "get_player_stats-0", name: "get_player_stats", input: { player_name: "LeBron James" } },
        ],
      },
    ];

    await client.send({ systemPrompt: "", tools: [], history });

    const contents = generateContent.mock.calls[0][0].contents;
    expect(contents[1]).toEqual({
      role: "model",
      parts: [{ functionCall: { name: "get_player_stats", args: { player_name: "LeBron James" } } }],
    });
  });

  it("translates a tool_results message to role 'user' with functionResponse parts wrapped under 'output'", async () => {
    const generateContent = vi.fn().mockResolvedValueOnce(textResponse("done"));
    const client = geminiLlmClient(generateContent);
    const history: ConversationMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", text: "", toolCalls: [] },
      {
        role: "tool_results",
        results: [{ id: "get_player_stats-0", name: "get_player_stats", output: { points: 30 }, isError: false }],
      },
    ];

    await client.send({ systemPrompt: "", tools: [], history });

    const contents = generateContent.mock.calls[0][0].contents;
    // Correlated by `name`, not `id` -- see this module's implementation
    // header comment on why a plain generateContent call can't rely on
    // FunctionResponse.id for matching.
    expect(contents[2]).toEqual({
      role: "user",
      parts: [{ functionResponse: { name: "get_player_stats", response: { output: { points: 30 } } } }],
    });
  });

  it("wraps an error tool result under the response's 'error' key, per Gemini's documented FunctionResponse convention", async () => {
    const generateContent = vi.fn().mockResolvedValueOnce(textResponse("done"));
    const client = geminiLlmClient(generateContent);
    const history: ConversationMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", text: "", toolCalls: [] },
      {
        role: "tool_results",
        results: [{ id: "x", name: "get_player_stats", output: { message: "failed" }, isError: true }],
      },
    ];

    await client.send({ systemPrompt: "", tools: [], history });

    const contents = generateContent.mock.calls[0][0].contents;
    expect(contents[2].parts[0].functionResponse.response).toEqual({ error: { message: "failed" } });
  });

  it("preserves call order for multiple tool calls/results in one turn (Gemini has no cross-call id correlation here)", async () => {
    const generateContent = vi.fn().mockResolvedValueOnce(textResponse("done"));
    const client = geminiLlmClient(generateContent);
    const history: ConversationMessage[] = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        text: "",
        toolCalls: [
          { id: "get_player_stats-0", name: "get_player_stats", input: { player_name: "LeBron James" } },
          { id: "get_player_stats-1", name: "get_player_stats", input: { player_name: "Kevin Durant" } },
        ],
      },
      {
        role: "tool_results",
        results: [
          { id: "get_player_stats-0", name: "get_player_stats", output: { points: 30 }, isError: false },
          { id: "get_player_stats-1", name: "get_player_stats", output: { points: 28 }, isError: false },
        ],
      },
    ];

    await client.send({ systemPrompt: "", tools: [], history });

    const contents = generateContent.mock.calls[0][0].contents;
    expect(contents[1].parts).toEqual([
      { functionCall: { name: "get_player_stats", args: { player_name: "LeBron James" } } },
      { functionCall: { name: "get_player_stats", args: { player_name: "Kevin Durant" } } },
    ]);
    expect(contents[2].parts).toEqual([
      { functionResponse: { name: "get_player_stats", response: { output: { points: 30 } } } },
      { functionResponse: { name: "get_player_stats", response: { output: { points: 28 } } } },
    ]);
  });
});

describe("createGeminiClient", () => {
  it("memoizes the client for the same API key", () => {
    const a = createGeminiClient("test-key-1");
    const b = createGeminiClient("test-key-1");
    expect(a).toBe(b);
  });

  it("constructs a new client when the API key changes", () => {
    const a = createGeminiClient("test-key-a");
    const c = createGeminiClient("test-key-b");
    expect(a).not.toBe(c);
  });
});
