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
//   - `thought_signature` (required on replay): Gemini's real API attaches
//     an opaque `Part.thoughtSignature` string to the *same Part* that
//     carries a `functionCall`, and requires that exact signature to be
//     replayed on that same Part when the turn is echoed back in a later
//     request's `contents` -- omitting it fails with a 400
//     ("Function call is missing a thought_signature in functionCall
//     parts... required for tools to work correctly"). This is
//     undocumented in any way a mocked SDK call could surface (confirmed
//     against a real API call, not just the docs -- see this repo's PR
//     history for the exact error and a live end-to-end verification).
//     `Part.thoughtSignature` is not exposed by the `response.functionCalls`
//     convenience getter (which only returns `FunctionCall[]`), so
//     `extractToolCalls` below reads `response.candidates[0].content.parts`
//     directly to capture each function-call part's sibling
//     `thoughtSignature` alongside it. It's stored in the shared
//     `ToolCallRequest.providerData` (an intentionally opaque, Gemini-only
//     field -- see llm/types.ts) and replayed onto the reconstructed Part
//     in `toGeminiContents`'s assistant case. Anthropic has no equivalent
//     concept and never sets or reads this field.

import { FunctionCallingConfigMode, GoogleGenAI } from "@google/genai";
import type {
  Content,
  FunctionDeclaration,
  GenerateContentParameters,
  GenerateContentResponse,
  Part,
} from "@google/genai";
import {
  MAX_OUTPUT_TOKENS,
  type ConversationMessage,
  type LlmClient,
  type LlmResponse,
  type ToolCallRequest,
  type ToolDefinition,
} from "@/lib/llm/types";

export const GEMINI_SEARCH_MODEL = "gemini-3.8-flash";

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
  return history.map((message): Content => {
    switch (message.role) {
      case "user":
        return { role: "user", parts: [{ text: message.content }] };

      case "assistant": {
        const parts: Part[] = [];
        if (message.text) parts.push({ text: message.text });
        for (const call of message.toolCalls) {
          const part: Part = { functionCall: { name: call.name, args: call.input } };
          // Replay the thought_signature Gemini attached to this exact
          // function-call part when it was first returned, if any -- see
          // this module's header comment. Required for the API to accept
          // this turn being echoed back; omitting it is a 400, not a
          // silent degradation.
          if (typeof call.providerData === "string") {
            part.thoughtSignature = call.providerData;
          }
          parts.push(part);
        }
        return { role: "model", parts };
      }

      case "tool_results": {
        // See this module's header comment: correlated by name + array
        // order, not by id.
        const parts: Part[] = message.results.map((result) => ({
          functionResponse: {
            name: result.name,
            response: result.isError ? { error: result.output } : { output: result.output },
          },
        }));
        return { role: "user", parts };
      }

      default: {
        // Exhaustiveness check: a new ConversationMessage variant added to
        // llm/types.ts without a matching case here is a compile error at
        // this line, not a silent runtime gap.
        const unhandled: never = message;
        throw new Error(`toGeminiContents: unhandled ConversationMessage: ${JSON.stringify(unhandled)}`);
      }
    }
  });
}

function extractToolCalls(response: GenerateContentResponse): ToolCallRequest[] {
  // Deliberately not `response.functionCalls` (the convenience getter):
  // it only returns `FunctionCall[]`, discarding each Part's sibling
  // `thoughtSignature` field -- which must be captured here and replayed
  // verbatim later (see this module's header comment). Reading
  // `candidates[0].content.parts` directly keeps `functionCall` and
  // `thoughtSignature` correlated, since the API attaches the signature to
  // the exact same Part that carries the function call, not to a separate
  // part or to FunctionCall itself.
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const calls: ToolCallRequest[] = [];
  let index = 0;
  for (const part of parts) {
    if (!part.functionCall) continue;
    const call = part.functionCall;
    calls.push({
      // Synthesized -- see this module's header comment on why `call.id`
      // can't be relied on for a plain generateContent call.
      id: `${call.name ?? "unknown"}-${index}`,
      name: call.name ?? "",
      input: (call.args ?? {}) as Record<string, unknown>,
      ...(part.thoughtSignature ? { providerData: part.thoughtSignature } : {}),
    });
    index++;
  }
  return calls;
}

// `response.text` is a getter that reads `candidates[0]` under the hood --
// it throws (rather than returning undefined) when there are no candidates
// at all, which happens for a safety-blocked prompt or response (no
// candidates generated at all, as opposed to a normal empty/text-only
// turn, which the getter handles fine). `extractToolCalls` above uses
// optional chaining on `candidates`/`content`/`parts` instead of the
// throwing `response.functionCalls` getter (see its own comment), so it
// can't throw here -- this guard exists for `response.text` specifically.
// Either way, a safety block produces the same honest "couldn't complete
// this" result as any other provider failure, never an uncaught throw out
// of the search loop.
function readGeminiOutput(response: GenerateContentResponse): LlmResponse {
  try {
    return { text: response.text ?? "", toolCalls: extractToolCalls(response) };
  } catch (error) {
    console.error("[gemini-provider] failed to read response.text (likely a safety block):", error);
    return { text: "", toolCalls: [] };
  }
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
      return readGeminiOutput(response);
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
