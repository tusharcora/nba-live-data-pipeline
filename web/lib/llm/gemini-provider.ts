// Gemini implementation of LlmClient (llm/types.ts) -- the default search
// LLM provider (get-llm-client.ts), chosen for its usable free tier.
//
// SDK: `@google/genai` (npm), the actively maintained Google GenAI JS/TS
// SDK -- NOT the older `@google/generative-ai` package, which is the
// predecessor this one replaced. Verified directly against the installed
// package's own bundled type definitions
// (node_modules/@google/genai/dist/genai.d.ts) rather than assumed, since
// both the package name and Gemini's model lineup have changed over time.
//
// Model: `gemini-3.8-flash` -- confirmed via ai.google.dev's models and
// pricing pages (Sept 2026) as the current-generation, "New Stable" Flash
// model, explicitly positioned for "autonomous agents" and native tool
// use, and free of charge on the free tier. `gemini-3.5-flash-lite` is a
// cheaper/faster free-tier alternative ("optimized for high-volume agentic
// tasks") worth switching to if this route's free-tier rate limit ever
// becomes the binding constraint -- flagged here rather than silently
// picked, since that's a real tradeoff a future maintainer may want to
// revisit.
//
// Why `generateContent`, not Gemini's newer "Interactions API": Google's
// current docs recommend the Interactions API (server-side, stateful
// history keyed by `previous_interaction_id`) for new development, but
// `generateContent` remains fully supported. This shared `LlmClient`
// interface -- and Anthropic's Messages API, the other provider it must
// also fit -- both assume a stateless, full-history-resend call shape
// (search-loop.ts rebuilds and resends the whole conversation every turn).
// The Interactions API's server-side session model doesn't fit that
// shape without bolting on cross-call session-id bookkeeping the shared
// interface has no slot for, so `generateContent` (still the SDK's own
// documented, code-sampled function-calling path) was chosen instead.
// Worth reconsidering if a third provider's *only* API is stateful, or if
// `generateContent` is ever actually deprecated.
//
// Function-calling shape notes (the parts of this mapping that were least
// obvious, for whoever adds a third provider next):
//   - `FunctionDeclaration.parametersJsonSchema` accepts a plain JSON
//     Schema object directly -- used here instead of the alternative
//     `parameters` field, which requires re-expressing the schema with
//     Gemini's own `Type` enum (`Type.OBJECT`, `Type.STRING`, ...). This is
//     what lets `ToolDefinition.inputSchema` (already a plain JSON Schema)
//     pass through with zero conversion.
//   - Role naming differs: Gemini uses `"model"` for the assistant's turn
//     where Anthropic uses `"assistant"`.
//   - No provider-agnostic call-id correlation: `FunctionCall.id` /
//     `FunctionResponse.id` exist but are populated only by Gemini's
//     separate Live/Bidi (streaming session) API. For a plain
//     `generateContent` call, a function response is correlated to its
//     call by `name` plus the order it appears in among the turn's parts
//     -- there is no id-based matching to rely on. See
//     `ToolCallResult.name` in llm/types.ts, added specifically so this
//     adapter has what it needs without an id.
//   - A function's result is wrapped as `{output: ...}` or `{error: ...}`
//     inside `FunctionResponse.response` -- the SDK's own documented
//     convention ("Use 'output' key to specify function output and
//     'error' key to specify error details"), not a free-form payload.

import { FunctionCallingConfigMode, GoogleGenAI } from "@google/genai";
import type {
  Content,
  FunctionDeclaration,
  GenerateContentParameters,
  GenerateContentResponse,
  Part,
} from "@google/genai";
import type {
  ConversationMessage,
  LlmClient,
  LlmResponse,
  ToolCallRequest,
  ToolDefinition,
} from "@/lib/llm/types";

export const GEMINI_SEARCH_MODEL = "gemini-3.8-flash";
const MAX_OUTPUT_TOKENS = 1024;

export type GenerateContent = (
  params: GenerateContentParameters,
) => Promise<GenerateContentResponse>;

function toGeminiTools(tools: ToolDefinition[]): FunctionDeclaration[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.inputSchema,
  }));
}

function toGeminiContents(history: ConversationMessage[]): Content[] {
  return history.map((message) => {
    if (message.role === "user") {
      return { role: "user", parts: [{ text: message.content }] };
    }

    if (message.role === "assistant") {
      const parts: Part[] = [];
      if (message.text) parts.push({ text: message.text });
      for (const call of message.toolCalls) {
        parts.push({ functionCall: { name: call.name, args: call.input } });
      }
      return { role: "model", parts };
    }

    // "tool_results" -- see this module's header comment: correlated by
    // name + array order, not by id.
    const parts: Part[] = message.results.map((result) => ({
      functionResponse: {
        name: result.name,
        response: result.isError ? { error: result.output } : { output: result.output },
      },
    }));
    return { role: "user", parts };
  });
}

function extractToolCalls(response: GenerateContentResponse): ToolCallRequest[] {
  const calls = response.functionCalls ?? [];
  return calls.map((call, index) => ({
    // Synthesized -- see this module's header comment on why `call.id`
    // can't be relied on for a plain generateContent call.
    id: `${call.name ?? "unknown"}-${index}`,
    name: call.name ?? "",
    input: (call.args ?? {}) as Record<string, unknown>,
  }));
}

/** Builds an `LlmClient` backed by Gemini's `generateContent`, given an
 * injectable `generateContent` function -- same DI seam pattern as
 * anthropic-provider.ts's `anthropicLlmClient`. `createGeminiClient()`
 * below is the real, non-test factory. */
export function geminiLlmClient(generateContent: GenerateContent): LlmClient {
  return {
    async send({ systemPrompt, tools, history }): Promise<LlmResponse> {
      const response = await generateContent({
        model: GEMINI_SEARCH_MODEL,
        contents: toGeminiContents(history),
        config: {
          systemInstruction: systemPrompt,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          tools: [{ functionDeclarations: toGeminiTools(tools) }],
          toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
        },
      });

      // Unlike Anthropic's stop_reason, `functionCalls` is undefined/empty
      // exactly when the model produced a final answer instead of
      // requesting a tool call -- no separate "is this turn final" signal
      // to cross-check.
      return { text: response.text ?? "", toolCalls: extractToolCalls(response) };
    },
  };
}

let cachedClient: LlmClient | null = null;
let cachedApiKey: string | null = null;

/** Real, non-test factory: constructs the Google GenAI SDK client for the
 * given API key and wraps it as an `LlmClient`. Memoized per API key, same
 * pattern as anthropic-provider.ts's `createAnthropicClient`. */
export function createGeminiClient(apiKey: string): LlmClient {
  if (!cachedClient || cachedApiKey !== apiKey) {
    const sdkClient = new GoogleGenAI({ apiKey });
    cachedClient = geminiLlmClient((params) => sdkClient.models.generateContent(params));
    cachedApiKey = apiKey;
  }
  return cachedClient;
}
