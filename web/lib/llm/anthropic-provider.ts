// Anthropic implementation of LlmClient (llm/types.ts). Behavior is
// unchanged from the pre-refactor Anthropic-only search-loop.ts + the old
// lib/anthropic-client.ts (now folded into this file) -- this is a
// refactor, not a rewrite: same model, same non-streaming per-turn calls,
// same tool-use-block extraction. See llm/types.ts's header comment for
// why the shared interface looks the way it does.

import Anthropic from "@anthropic-ai/sdk";
import {
  MAX_OUTPUT_TOKENS,
  type ConversationMessage,
  type LlmClient,
  type LlmResponse,
  type ToolCallRequest,
  type ToolDefinition,
} from "@/lib/llm/types";

export const ANTHROPIC_SEARCH_MODEL = "claude-haiku-4-5";

export type CreateMessage = (
  params: Anthropic.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Message>;

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
  }));
}

function toAnthropicMessages(history: ConversationMessage[]): Anthropic.MessageParam[] {
  return history.map((message): Anthropic.MessageParam => {
    switch (message.role) {
      case "user":
        return { role: "user", content: message.content };

      case "assistant": {
        const content: Anthropic.ContentBlockParam[] = [];
        if (message.text) content.push({ type: "text", text: message.text });
        for (const call of message.toolCalls) {
          content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
        }
        return { role: "assistant", content };
      }

      case "tool_results": {
        // Anthropic relays every tool result as a single `user` turn of
        // `tool_result` blocks, correlated by `tool_use_id`.
        const content: Anthropic.ToolResultBlockParam[] = message.results.map((result) => ({
          type: "tool_result",
          tool_use_id: result.id,
          content: JSON.stringify(result.output),
          is_error: result.isError,
        }));
        return { role: "user", content };
      }

      default: {
        // Exhaustiveness check: a new ConversationMessage variant added to
        // llm/types.ts without a matching case here is a compile error at
        // this line, not a silent runtime gap.
        const unhandled: never = message;
        throw new Error(`toAnthropicMessages: unhandled ConversationMessage: ${JSON.stringify(unhandled)}`);
      }
    }
  });
}

function extractToolCalls(response: Anthropic.Message): ToolCallRequest[] {
  return response.content
    .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
    .map((block) => ({
      id: block.id,
      name: block.name,
      input: (block.input ?? {}) as Record<string, unknown>,
    }));
}

function extractText(response: Anthropic.Message): string {
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** Builds an `LlmClient` backed by the Anthropic Messages API, given an
 * injectable `createMessage` function -- DI'd exactly like the rest of
 * this codebase's offline-testable seams (CLAUDE.md's Testing section).
 * `createAnthropicClient()` below is the real, non-test factory. */
export function anthropicLlmClient(createMessage: CreateMessage): LlmClient {
  return {
    async send({ systemPrompt, tools, history }): Promise<LlmResponse> {
      const response = await createMessage({
        model: ANTHROPIC_SEARCH_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemPrompt,
        tools: toAnthropicTools(tools),
        messages: toAnthropicMessages(history),
      });

      const toolCalls = extractToolCalls(response);
      // A final turn is any response that isn't itself requesting a tool
      // call. Checking both `stop_reason` and the extracted blocks (rather
      // than either alone) mirrors the pre-refactor loop's own defensive
      // condition: `stop_reason === "tool_use"` with zero tool_use blocks
      // (or vice versa) shouldn't happen, but either way there is nothing
      // to dispatch, so it's still a final turn from this adapter's view.
      if (response.stop_reason !== "tool_use" || toolCalls.length === 0) {
        return { text: extractText(response), toolCalls: [] };
      }
      return { text: extractText(response), toolCalls };
    },
  };
}

let cachedClient: LlmClient | null = null;
let cachedApiKey: string | null = null;

/** Real, non-test factory: constructs the Anthropic SDK client for the
 * given API key and wraps it as an `LlmClient`. Memoized per API key
 * (matches the pre-refactor `anthropic-client.ts`'s single-instance
 * caching) so repeated calls within one server process reuse one
 * underlying `Anthropic` client. */
export function createAnthropicClient(apiKey: string): LlmClient {
  if (!cachedClient || cachedApiKey !== apiKey) {
    const sdkClient = new Anthropic({ apiKey });
    cachedClient = anthropicLlmClient((params) => sdkClient.messages.create(params));
    cachedApiKey = apiKey;
  }
  return cachedClient;
}
