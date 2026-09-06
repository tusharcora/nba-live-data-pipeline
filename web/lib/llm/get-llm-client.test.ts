import { beforeEach, describe, expect, it, vi } from "vitest";

// Both provider factories are mocked -- this test verifies only the
// selection/config-validation logic, not either provider's real behavior
// (covered by anthropic-provider.test.ts / gemini-provider.test.ts).
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

const { getLlmClient, resolveSearchLlmProvider } = await import("@/lib/llm/get-llm-client");

describe("resolveSearchLlmProvider", () => {
  it("defaults to gemini when SEARCH_LLM_PROVIDER is unset", () => {
    expect(resolveSearchLlmProvider({})).toBe("gemini");
  });

  it("accepts 'anthropic' and 'gemini', case-insensitively", () => {
    expect(resolveSearchLlmProvider({ SEARCH_LLM_PROVIDER: "anthropic" })).toBe("anthropic");
    expect(resolveSearchLlmProvider({ SEARCH_LLM_PROVIDER: "Gemini" })).toBe("gemini");
    expect(resolveSearchLlmProvider({ SEARCH_LLM_PROVIDER: "ANTHROPIC" })).toBe("anthropic");
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
  });

  it("defaults to gemini, constructed with GEMINI_API_KEY", () => {
    const client = getLlmClient({ GEMINI_API_KEY: "g-key" });
    expect(createGeminiClientMock).toHaveBeenCalledWith("g-key");
    expect(createAnthropicClientMock).not.toHaveBeenCalled();
    expect((client as unknown as { __provider: string }).__provider).toBe("gemini");
  });

  it("throws a clear config error -- not a silent fallback to anthropic -- when gemini (the default) has no GEMINI_API_KEY", () => {
    expect(() => getLlmClient({})).toThrow(/GEMINI_API_KEY is not set/);
    expect(createAnthropicClientMock).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only GEMINI_API_KEY the same as a missing one", () => {
    expect(() => getLlmClient({ GEMINI_API_KEY: "   " })).toThrow(/GEMINI_API_KEY is not set/);
    expect(createGeminiClientMock).not.toHaveBeenCalled();
  });

  it("uses anthropic when explicitly selected, constructed with ANTHROPIC_API_KEY", () => {
    const client = getLlmClient({ SEARCH_LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "a-key" });
    expect(createAnthropicClientMock).toHaveBeenCalledWith("a-key");
    expect(createGeminiClientMock).not.toHaveBeenCalled();
    expect((client as unknown as { __provider: string }).__provider).toBe("anthropic");
  });

  it("throws a clear config error -- not a silent fallback to gemini -- when anthropic is selected but has no ANTHROPIC_API_KEY", () => {
    expect(() => getLlmClient({ SEARCH_LLM_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY is not set/);
    expect(createGeminiClientMock).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only ANTHROPIC_API_KEY the same as a missing one", () => {
    expect(() =>
      getLlmClient({ SEARCH_LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "\t\n " }),
    ).toThrow(/ANTHROPIC_API_KEY is not set/);
    expect(createAnthropicClientMock).not.toHaveBeenCalled();
  });

  it("propagates an unknown-provider error rather than defaulting", () => {
    expect(() => getLlmClient({ SEARCH_LLM_PROVIDER: "openai" })).toThrow(/Unknown SEARCH_LLM_PROVIDER/);
    expect(createAnthropicClientMock).not.toHaveBeenCalled();
    expect(createGeminiClientMock).not.toHaveBeenCalled();
  });
});
