// Groq implementation of LlmClient (llm/types.ts) -- an alternative search
// LLM provider (get-llm-client.ts) alongside Gemini (still the default)
// and Anthropic.
//
// Motivation: Gemini (`gemini-3.8-flash`, launched 2026-09-02) has been
// returning real, repeated `503 UNAVAILABLE` "high demand" errors in
// production while still absorbing launch traffic -- not a bug in this
// app, a genuine upstream reliability gap. Groq runs its own LPU hardware
// (not GPU-based), so it doesn't share that failure mode. This is exactly
// the "add a provider later" case the LlmClient abstraction exists for --
// search-loop.ts needed zero changes to add this.
//
// SDK: `groq-sdk` (npm), the official first-party TypeScript SDK --
// verified directly against the installed package's own bundled type
// definitions (node_modules/groq-sdk/resources/chat/completions.d.ts and
// resources/shared.d.ts), same discipline as gemini-provider.ts. Groq's
// API is also OpenAI Chat-Completions-compatible (reachable by pointing
// the `openai` package at https://api.groq.com/openai/v1), but the
// official SDK is the cleaner choice here -- Groq's own types, no fighting
// a generic client's defaults/headers for a different provider.
//
// Model: `openai/gpt-oss-20b` -- confirmed via console.groq.com/docs/models,
// .../docs/tool-use, and .../docs/deprecations (checked live, Sept 2026):
// a current, non-deprecated model with confirmed tool-use support (not
// just JSON mode), and the documented successor to `llama-3.1-8b-instant`
// (deprecated 2026-08-16) -- the same cheap/fast tier this project already
// picks for this exact workload (Claude Haiku 4.5, Gemini's Flash tier).
// `llama-3.3-70b-versatile` and `llama-3.1-8b-instant` are both deprecated
// as of 2026-08-16 and deliberately NOT used, despite being the two names
// most likely to show up in older docs/training data. `openai/gpt-oss-120b`
// (larger, ~2x the per-token cost) and `groq/compound`/`groq/compound-mini`
// (bundle their OWN built-in web-search/code-execution tools, which risks
// conflicting with this app's narrow, closed 4-tool set) were considered
// and passed over.
//
// Function-calling shape notes (the parts of this mapping that were least
// obvious, for whoever adds a 4th provider next):
//   - Groq's API is the classic OpenAI Chat Completions shape:
//     `tools: [{type: "function", function: {name, description, parameters}}]`,
//     `messages: [{role, content, ...}]` with the system prompt as an
//     ordinary `{role: "system", content}` message -- not a separate
//     top-level field like Anthropic's `system` or Gemini's
//     `systemInstruction`.
//   - `FunctionDefinition.parameters` is a plain JSON Schema object
//     (`Record<string, unknown>`, per resources/shared.d.ts) -- like
//     Gemini's `parametersJsonSchema`, `ToolDefinition.inputSchema` passes
//     through with zero conversion.
//   - Tool-call arguments come back as a JSON **string**
//     (`ChatCompletionMessageToolCall.function.arguments: string`), not an
//     already-parsed object like Anthropic's `input` or Gemini's `args` --
//     must be `JSON.parse()`d. The SDK's own docs warn the model doesn't
//     always emit valid JSON, so this is guarded with a try/catch
//     (degrading to `{}`, which search-tools.ts's required-field
//     validation then rejects cleanly) rather than trusted or left to
//     throw out of the search loop.
//   - Multiple tool results are NOT grouped into one turn the way
//     Anthropic (multiple `tool_result` blocks in one `user` message) or
//     Gemini (multiple `functionResponse` parts in one Content) do -- each
//     tool result is its own separate `{role: "tool", tool_call_id,
//     content}` message.
//   - No dedicated error flag on a tool message (unlike Anthropic's
//     `is_error` or Gemini's `{error: ...}` wrapping convention) -- an
//     error result's `isError` is only conveyed through the JSON content
//     itself (`ToolResultEnvelope.status === "error"`), which the model
//     can still read there.
//   - Correlation is by `id` (`tool_call_id` matches
//     `ChatCompletionMessageToolCall.id`), same as Anthropic's `tool_use_id`
//     -- unlike Gemini, which has no usable id on a plain `generateContent`
//     call and correlates by name + turn order instead.
//   - `max_tokens` is deprecated in favor of `max_completion_tokens` --
//     used the latter.

import Groq from "groq-sdk";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "groq-sdk/resources/chat/completions";
import {
  MAX_OUTPUT_TOKENS,
  type ConversationMessage,
  type LlmClient,
  type LlmResponse,
  type ToolCallRequest,
  type ToolDefinition,
} from "@/lib/llm/types";

export const GROQ_SEARCH_MODEL = "openai/gpt-oss-20b";

export type CreateChatCompletion = (
  params: ChatCompletionCreateParamsNonStreaming,
) => Promise<ChatCompletion>;

function toGroqTools(tools: ToolDefinition[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function toGroqMessages(
  systemPrompt: string,
  history: ConversationMessage[],
): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt }];

  for (const message of history) {
    switch (message.role) {
      case "user":
        messages.push({ role: "user", content: message.content });
        break;

      case "assistant": {
        const toolCalls = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        }));
        messages.push({
          role: "assistant",
          content: message.text.length > 0 ? message.text : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
        break;
      }

      case "tool_results":
        // See this module's header comment: unlike Anthropic/Gemini, each
        // result is its own message, not grouped into one turn.
        for (const result of message.results) {
          messages.push({
            role: "tool",
            tool_call_id: result.id,
            content: JSON.stringify(result.output),
          });
        }
        break;

      default: {
        // Exhaustiveness check: a new ConversationMessage variant added to
        // llm/types.ts without a matching case here is a compile error at
        // this line, not a silent runtime gap.
        const unhandled: never = message;
        throw new Error(`toGroqMessages: unhandled ConversationMessage: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  return messages;
}

function extractToolCalls(response: ChatCompletion): ToolCallRequest[] {
  const rawCalls = response.choices[0]?.message.tool_calls ?? [];
  return rawCalls.map((call) => {
    let input: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(call.function.arguments);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>;
      }
    } catch (error) {
      // The SDK's own docs warn the model doesn't always emit valid JSON
      // for tool call arguments -- degrade to an empty input (which
      // search-tools.ts's required-field validation then rejects cleanly
      // as a tool error) rather than throw out of the search loop over one
      // malformed call.
      console.error(
        `[groq-provider] failed to parse tool call arguments for "${call.function.name}":`,
        error,
      );
    }
    return { id: call.id, name: call.function.name, input };
  });
}

function extractText(response: ChatCompletion): string {
  return response.choices[0]?.message.content ?? "";
}

/** Builds an `LlmClient` backed by Groq's chat completions API, given an
 * injectable `createChatCompletion` function -- same DI seam pattern as
 * anthropic-provider.ts's `anthropicLlmClient` / gemini-provider.ts's
 * `geminiLlmClient`. `createGroqClient()` below is the real, non-test
 * factory. */
export function groqLlmClient(createChatCompletion: CreateChatCompletion): LlmClient {
  return {
    async send({ systemPrompt, tools, history }): Promise<LlmResponse> {
      const response = await createChatCompletion({
        model: GROQ_SEARCH_MODEL,
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        messages: toGroqMessages(systemPrompt, history),
        tools: toGroqTools(tools),
        tool_choice: "auto",
      });

      return { text: extractText(response), toolCalls: extractToolCalls(response) };
    },
  };
}

let cachedClient: LlmClient | null = null;
let cachedApiKey: string | null = null;

/** Real, non-test factory: constructs the Groq SDK client for the given
 * API key and wraps it as an `LlmClient`. Memoized per API key, same
 * pattern as the other two providers' factories. */
export function createGroqClient(apiKey: string): LlmClient {
  if (!cachedClient || cachedApiKey !== apiKey) {
    const sdkClient = new Groq({ apiKey });
    cachedClient = groqLlmClient((params) => sdkClient.chat.completions.create(params));
    cachedApiKey = apiKey;
  }
  return cachedClient;
}
