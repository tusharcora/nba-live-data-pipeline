import { beforeEach, describe, expect, it, vi } from "vitest";

// All three provider factories are mocked -- this test verifies only the
// selection/config-validation logic, not any provider's real behavior
// (covered by anthropic-provider.test.ts / gemini-provider.test.ts /
// groq-provider.test.ts).
const createAnthropicClientMock = vi.fn<(apiKey: string) => { send: () => void; __provider: string }>(
  () => ({ send: vi.fn(), __provider: "anthropic" }),
);
vi.mock("@/lib/llm/anthropic-provider", () => ({
  createAnthropicClient: (apiKey: string) => createAnthropicClientMock(apiKey),
}));

const createGeminiClientMock = vi.fn<(apiKey: string) => { send: () => void; __provider: string }>(
  () => ({ send: vi.fn(), __provider: "gemini" }),
);
vi.mock("@/lib/llm/gemini-provider", () => ({
  createGeminiClient: (apiKey: string) => createGeminiClientMock(apiKey),
}));

const createGroqClientMock = vi.fn<(apiKey: string) => { send: () => void; __provider: string }>(
  () => ({ send: vi.fn(), __provider: "groq" }),
);
vi.mock("@/lib/llm/groq-provider", () => ({
  createGroqClient: (apiKey: string) => createGroqClientMock(apiKey),
}));

const { getLlmClient, resolveSearchLlmProvider } = await import("@/lib/llm/get-llm-client");

function providerOf(client: unknown): string {
  return (client as { __provider: string }).__provider;
}

describe("resolveSearchLlmProvider", () => {
  it("defaults to groq when SEARCH_LLM_PROVIDER is unset", () => {
    expect(resolveSearchLlmProvider({})).toBe("groq");
  });

  it("accepts 'anthropic', 'gemini', and 'groq', case-insensitively", () => {
    expect(resolveSearchLlmProvider({ SEARCH_LLM_PROVIDER: "anthropic" })).toBe("anthropic");
    expect(resolveSearchLlmProvider({ SEARCH_LLM_PROVIDER: "Gemini" })).toBe("gemini");
    expect(resolveSearchLlmProvider({ SEARCH_LLM_PROVIDER: "ANTHROPIC" })).toBe("anthropic");
    expect(resolveSearchLlmProvider({ SEARCH_LLM_PROVIDER: "Groq" })).toBe("groq");
    expect(resolveSearchLlmProvider({ SEARCH_LLM_PROVIDER: "GROQ" })).toBe("groq");
  });

  it("throws a clear error on an unrecognized provider value", () => {
    expect(() => resolveSearchLlmProvider({ SEARCH_LLM_PROVIDER: "openai" })).toThrow(
      /Unknown SEARCH_LLM_PROVIDER "openai"/,
    );
  });
});

describe("getLlmClient", () => {
  beforeEach(() => {
    createAnthropicClientMock.mockClear();
    createGeminiClientMock.mockClear();
    createGroqClientMock.mockClear();
  });

  it("defaults to groq, constructed with GROQ_API_KEY", () => {
    const client = getLlmClient({ GROQ_API_KEY: "gr-key" });
    expect(createGroqClientMock).toHaveBeenCalledWith("gr-key");
    expect(createAnthropicClientMock).not.toHaveBeenCalled();
    expect(createGeminiClientMock).not.toHaveBeenCalled();
    expect(providerOf(client)).toBe("groq");
  });

  it("throws a clear config error -- not a silent fallback to another provider -- when groq (the default) has no GROQ_API_KEY", () => {
    expect(() => getLlmClient({})).toThrow(/GROQ_API_KEY is not set/);
    expect(createAnthropicClientMock).not.toHaveBeenCalled();
    expect(createGeminiClientMock).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only GROQ_API_KEY the same as a missing one, when groq is the (default) implicit selection", () => {
    expect(() => getLlmClient({ GROQ_API_KEY: "  \t" })).toThrow(/GROQ_API_KEY is not set/);
    expect(createGroqClientMock).not.toHaveBeenCalled();
  });

  it("uses gemini when explicitly selected, constructed with GEMINI_API_KEY", () => {
    const client = getLlmClient({ SEARCH_LLM_PROVIDER: "gemini", GEMINI_API_KEY: "g-key" });
    expect(createGeminiClientMock).toHaveBeenCalledWith("g-key");
    expect(createAnthropicClientMock).not.toHaveBeenCalled();
    expect(createGroqClientMock).not.toHaveBeenCalled();
    expect(providerOf(client)).toBe("gemini");
  });

  it("throws a clear config error -- not a silent fallback to another provider -- when gemini is explicitly selected but has no GEMINI_API_KEY", () => {
    expect(() => getLlmClient({ SEARCH_LLM_PROVIDER: "gemini" })).toThrow(/GEMINI_API_KEY is not set/);
    expect(createAnthropicClientMock).not.toHaveBeenCalled();
    expect(createGroqClientMock).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only GEMINI_API_KEY the same as a missing one", () => {
    expect(() =>
      getLlmClient({ SEARCH_LLM_PROVIDER: "gemini", GEMINI_API_KEY: "   " }),
    ).toThrow(/GEMINI_API_KEY is not set/);
    expect(createGeminiClientMock).not.toHaveBeenCalled();
  });

  it("uses anthropic when explicitly selected, constructed with ANTHROPIC_API_KEY", () => {
    const client = getLlmClient({ SEARCH_LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "a-key" });
    expect(createAnthropicClientMock).toHaveBeenCalledWith("a-key");
    expect(createGeminiClientMock).not.toHaveBeenCalled();
    expect(createGroqClientMock).not.toHaveBeenCalled();
    expect(providerOf(client)).toBe("anthropic");
  });

  it("throws a clear config error -- not a silent fallback to another provider -- when anthropic is selected but has no ANTHROPIC_API_KEY", () => {
    expect(() => getLlmClient({ SEARCH_LLM_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY is not set/);
    expect(createGeminiClientMock).not.toHaveBeenCalled();
    expect(createGroqClientMock).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only ANTHROPIC_API_KEY the same as a missing one", () => {
    expect(() =>
      getLlmClient({ SEARCH_LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "\t\n " }),
    ).toThrow(/ANTHROPIC_API_KEY is not set/);
    expect(createAnthropicClientMock).not.toHaveBeenCalled();
  });

  it("uses groq when explicitly selected, constructed with GROQ_API_KEY", () => {
    const client = getLlmClient({ SEARCH_LLM_PROVIDER: "groq", GROQ_API_KEY: "gr-key" });
    expect(createGroqClientMock).toHaveBeenCalledWith("gr-key");
    expect(createGeminiClientMock).not.toHaveBeenCalled();
    expect(createAnthropicClientMock).not.toHaveBeenCalled();
    expect(providerOf(client)).toBe("groq");
  });

  it("throws a clear config error -- not a silent fallback to another provider -- when groq is explicitly selected but has no GROQ_API_KEY", () => {
    expect(() => getLlmClient({ SEARCH_LLM_PROVIDER: "groq" })).toThrow(/GROQ_API_KEY is not set/);
    expect(createGeminiClientMock).not.toHaveBeenCalled();
    expect(createAnthropicClientMock).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only GROQ_API_KEY the same as a missing one", () => {
    expect(() =>
      getLlmClient({ SEARCH_LLM_PROVIDER: "groq", GROQ_API_KEY: "  \t" }),
    ).toThrow(/GROQ_API_KEY is not set/);
    expect(createGroqClientMock).not.toHaveBeenCalled();
  });

  it("propagates an unknown-provider error rather than defaulting", () => {
    expect(() => getLlmClient({ SEARCH_LLM_PROVIDER: "openai" })).toThrow(/Unknown SEARCH_LLM_PROVIDER/);
    expect(createAnthropicClientMock).not.toHaveBeenCalled();
    expect(createGeminiClientMock).not.toHaveBeenCalled();
    expect(createGroqClientMock).not.toHaveBeenCalled();
  });
});
