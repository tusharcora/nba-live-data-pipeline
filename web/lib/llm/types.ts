// Provider-agnostic LLM contract for the NL stats search BFF route
// (app/api/search/route.ts / lib/search-loop.ts). Shaped around what
// search-loop.ts actually needs to run its agentic tool-use loop -- send
// the running conversation + tool definitions, get back either a final
// answer or a batch of tool calls to dispatch -- not around either real
// provider's own SDK vocabulary. Neither Anthropic's `ContentBlock`/
// `tool_use` naming nor Gemini's `Part`/`functionCall` naming should leak
// past their respective adapters (llm/anthropic-provider.ts,
// llm/gemini-provider.ts).
//
// This repo's Python side already does the equivalent thing with
// `@runtime_checkable` Protocol-based DI for swappable implementations
// (CLAUDE.md's Testing section, e.g. ingestion's `RawPullSink`) -- this is
// the same pattern in TypeScript: one small interface (`LlmClient`) that
// every provider implements, so search-loop.ts never needs to change again
// when a third provider is added.

/** One tool's definition, as a plain JSON Schema object for its parameters
 * -- provider-agnostic on purpose. Each adapter translates this into its
 * own tool-declaration shape (Anthropic's `input_schema`, Gemini's
 * `parametersJsonSchema` -- both happen to accept a JSON Schema object
 * directly, which is exactly why this type stores one rather than a
 * provider-specific schema representation). */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** One tool call the model is requesting this turn. */
export interface ToolCallRequest {
  /** Correlates this request to its eventual `ToolCallResult`. Assigned by
   * whichever adapter produced it (Anthropic: the real `tool_use` block
   * id; Gemini: synthesized, since a plain `generateContent` call doesn't
   * populate `FunctionCall.id` -- see gemini-provider.ts). */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** One tool call's result, ready to relay back to the model. */
export interface ToolCallResult {
  id: string;
  /** Carried alongside `id` because Gemini correlates a function response
   * to its call by name + turn order, not by id (id-based correlation is
   * specific to Gemini's separate Live/Bidi API) -- see
   * gemini-provider.ts's header comment. Anthropic's adapter ignores this
   * and uses `id` instead. */
  name: string;
  /** JSON-serializable result payload (this app always passes a
   * `ToolResultEnvelope` from lib/search-tools.ts here). */
  output: unknown;
  isError: boolean;
}

/**
 * One turn of the running conversation. search-loop.ts builds this array
 * up turn by turn and hands the whole thing to `LlmClient.send()` on every
 * call -- both Anthropic's Messages API and Gemini's `generateContent` are
 * stateless, full-history-resend APIs, so this shape maps directly onto
 * either one. (Gemini also offers a newer stateful "Interactions API" with
 * server-side history, which this shape deliberately does NOT accommodate
 * -- see gemini-provider.ts's header comment for why `generateContent` was
 * chosen instead.)
 */
export type ConversationMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; text: string; toolCalls: ToolCallRequest[] }
  | { role: "tool_results"; results: ToolCallResult[] };

/** One provider call's result. Empty `toolCalls` means the model is done
 * and `text` is the final answer; a non-empty `toolCalls` means
 * search-loop.ts must dispatch them and call `send()` again with a
 * `tool_results` message appended to `history`. */
export interface LlmResponse {
  text: string;
  toolCalls: ToolCallRequest[];
}

/** Shared per-turn output token ceiling. Kept in one place rather than
 * duplicated as each provider's own local constant (Anthropic's
 * `max_tokens`, Gemini's `maxOutputTokens`) -- both providers currently
 * want the same value for this workload, and a future provider can still
 * override it locally if it genuinely needs to. */
export const MAX_OUTPUT_TOKENS = 1024;

/** The one seam search-loop.ts depends on. Any provider that can turn a
 * system prompt + tool definitions + running history into text-or-tool-calls
 * can implement this. */
export interface LlmClient {
  send(params: {
    systemPrompt: string;
    tools: ToolDefinition[];
    history: ConversationMessage[];
  }): Promise<LlmResponse>;
}
