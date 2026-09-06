import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("getAnthropicClient", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("memoizes a single client instance across calls", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const { getAnthropicClient } = await import("@/lib/anthropic-client");

    const first = getAnthropicClient();
    const second = getAnthropicClient();

    expect(first).toBe(second);
  });

  it("constructs a client even when ANTHROPIC_API_KEY is unset, rather than throwing at import time", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { getAnthropicClient } = await import("@/lib/anthropic-client");

    // Construction itself must not throw here — an actual missing-key
    // failure surfaces at request time in app/api/search/route.ts, which
    // catches it and relays the honest fallback response (see
    // route.test.ts's "emits an honest done event if constructing the
    // Anthropic client itself throws" — that test covers the route's side
    // of this contract with a mocked failure).
    expect(() => getAnthropicClient()).not.toThrow();
  });
});
