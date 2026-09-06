// Provider-selection factory for the NL stats search BFF route. Reads
// SEARCH_LLM_PROVIDER (defaulting to "gemini", the free-tier provider) and
// constructs the matching LlmClient with its own API key. A missing key
// for the *selected* provider is a configuration error, not a silent
// fallback to another provider -- better to fail loudly at request time
// than to quietly bill the wrong provider or serve degraded behavior.

import { createAnthropicClient } from "@/lib/llm/anthropic-provider";
import { createGeminiClient } from "@/lib/llm/gemini-provider";
import { createGroqClient } from "@/lib/llm/groq-provider";
import type { LlmClient } from "@/lib/llm/types";

export type SearchLlmProvider = "anthropic" | "gemini" | "groq";

const DEFAULT_PROVIDER: SearchLlmProvider = "gemini";

export function resolveSearchLlmProvider(env: Record<string, string | undefined> = process.env): SearchLlmProvider {
  const raw = env.SEARCH_LLM_PROVIDER?.trim().toLowerCase();
  if (!raw) return DEFAULT_PROVIDER;
  if (raw === "anthropic" || raw === "gemini" || raw === "groq") return raw;
  throw new Error(
    `Unknown SEARCH_LLM_PROVIDER "${env.SEARCH_LLM_PROVIDER}" -- expected "anthropic", "gemini", or "groq".`,
  );
}

// .trim() before the emptiness check: a whitespace-only value (e.g. a
// blank line left in .env.local) is not a usable key and must fail the
// same clear-error path as a fully missing one, not silently reach the
// SDK as "".
function requireApiKey(
  env: Record<string, string | undefined>,
  envVarName: string,
  provider: SearchLlmProvider,
): string {
  const apiKey = env[envVarName]?.trim();
  if (!apiKey) {
    const isDefault = provider === DEFAULT_PROVIDER;
    throw new Error(
      `SEARCH_LLM_PROVIDER is "${provider}"${isDefault ? " (the default)" : ""} but ${envVarName} is not set. ` +
        `Set ${envVarName}, or choose a different SEARCH_LLM_PROVIDER ("anthropic" | "gemini" | "groq") and its matching API key instead.`,
    );
  }
  return apiKey;
}

/** Builds the `LlmClient` for whichever provider `SEARCH_LLM_PROVIDER`
 * selects (default "gemini"). Throws a clear, actionable error -- never a
 * silent fallback to another provider -- if the selected provider's API
 * key env var isn't set (or is whitespace-only). */
export function getLlmClient(env: Record<string, string | undefined> = process.env): LlmClient {
  const provider = resolveSearchLlmProvider(env);

  switch (provider) {
    case "gemini":
      return createGeminiClient(requireApiKey(env, "GEMINI_API_KEY", provider));
    case "anthropic":
      return createAnthropicClient(requireApiKey(env, "ANTHROPIC_API_KEY", provider));
    case "groq":
      return createGroqClient(requireApiKey(env, "GROQ_API_KEY", provider));
    default: {
      // Exhaustiveness check: a new SearchLlmProvider value added above
      // without a matching case here is a compile error at this line, not
      // a silent runtime gap. resolveSearchLlmProvider() already rejects
      // any other string before this function is reached.
      const unhandled: never = provider;
      throw new Error(`getLlmClient: unhandled SearchLlmProvider: ${JSON.stringify(unhandled)}`);
    }
  }
}
