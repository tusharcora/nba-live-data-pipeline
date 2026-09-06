// Provider-selection factory for the NL stats search BFF route. Reads
// SEARCH_LLM_PROVIDER (defaulting to "gemini", the free-tier provider) and
// constructs the matching LlmClient with its own API key. A missing key
// for the *selected* provider is a configuration error, not a silent
// fallback to the other provider -- better to fail loudly at request time
// than to quietly bill the wrong provider or serve degraded behavior.

import { createAnthropicClient } from "@/lib/llm/anthropic-provider";
import { createGeminiClient } from "@/lib/llm/gemini-provider";
import type { LlmClient } from "@/lib/llm/types";

export type SearchLlmProvider = "anthropic" | "gemini";

const DEFAULT_PROVIDER: SearchLlmProvider = "gemini";

export function resolveSearchLlmProvider(env: Record<string, string | undefined> = process.env): SearchLlmProvider {
  const raw = env.SEARCH_LLM_PROVIDER?.trim().toLowerCase();
  if (!raw) return DEFAULT_PROVIDER;
  if (raw === "anthropic" || raw === "gemini") return raw;
  throw new Error(
    `Unknown SEARCH_LLM_PROVIDER "${env.SEARCH_LLM_PROVIDER}" -- expected "anthropic" or "gemini".`,
  );
}

/** Builds the `LlmClient` for whichever provider `SEARCH_LLM_PROVIDER`
 * selects (default "gemini"). Throws a clear, actionable error -- never a
 * silent fallback to the other provider -- if the selected provider's API
 * key env var isn't set. */
export function getLlmClient(env: Record<string, string | undefined> = process.env): LlmClient {
  const provider = resolveSearchLlmProvider(env);

  if (provider === "gemini") {
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'SEARCH_LLM_PROVIDER is "gemini" (the default) but GEMINI_API_KEY is not set. ' +
          "Set GEMINI_API_KEY, or set SEARCH_LLM_PROVIDER=anthropic and ANTHROPIC_API_KEY instead.",
      );
    }
    return createGeminiClient(apiKey);
  }

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'SEARCH_LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set. ' +
        "Set ANTHROPIC_API_KEY, or unset SEARCH_LLM_PROVIDER (or set it to \"gemini\") and GEMINI_API_KEY instead.",
    );
  }
  return createAnthropicClient(apiKey);
}
