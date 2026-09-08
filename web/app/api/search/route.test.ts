// @vitest-environment node
//
// This route handler test exercises real Request/Response/ReadableStream
// (Node's fetch-API globals) rather than jsdom's DOM-focused environment,
// which is the project default after Story 3/4 consolidated the two
// per-story vitest configs into one (see vitest.config.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";

// Both the LLM client factory and the search loop are mocked — this test
// verifies only the route's SSE framing/final-event contract, matching
// this repo's "no real LLM calls in CI" convention (CLAUDE.md). The
// tool-dispatch loop itself is covered by lib/search-loop.test.ts and
// lib/search-tools.test.ts; the provider adapters are covered by
// lib/llm/anthropic-provider.test.ts and lib/llm/gemini-provider.test.ts.
const getLlmClientMock = vi.fn(() => ({ send: vi.fn() }));
vi.mock("@/lib/llm/get-llm-client", () => ({
  getLlmClient: () => getLlmClientMock(),
}));

const runSearchLoopMock = vi.fn();
vi.mock("@/lib/search-loop", () => ({
  runSearchLoop: (...args: unknown[]) => runSearchLoopMock(...args),
}));

const { POST } = await import("@/app/api/search/route");

async function readBody(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

function postRequest(payload: unknown): Request {
  return new Request("http://localhost/api/search", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

describe("POST /api/search", () => {
  beforeEach(() => {
    runSearchLoopMock.mockReset();
  });

  it("returns Vercel-safe SSE headers, same set as app/api/live", async () => {
    runSearchLoopMock.mockResolvedValueOnce({
      answerText: "",
      citation: null,
      noData: true,
      candidates: null,
      resultData: null,
    });

    const response = await POST(postRequest({ question: "anything" }));

    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
  });

  it("streams the answer as data: chunks, then event: done with the pinned citation contract", async () => {
    const answerText =
      "LeBron James scored 30 points in the game against the Warriors on 2024-10-22.";
    runSearchLoopMock.mockResolvedValueOnce({
      answerText,
      citation: { table: "player_game_stats", dateRange: "2024-10-22 to 2024-10-22" },
      noData: false,
      candidates: null,
      resultData: null,
    });

    const response = await POST(
      postRequest({ question: "How many points did LeBron score on 2024-10-22?" }),
    );
    const body = await readBody(response);
    const frames = body.split("\n\n").filter(Boolean);

    const doneFrame = frames[frames.length - 1];
    expect(doneFrame).toContain("event: done");
    const doneJson = JSON.parse(doneFrame.split("data: ")[1]);
    expect(doneJson).toEqual({
      citation: { table: "player_game_stats", dateRange: "2024-10-22 to 2024-10-22" },
      noData: false,
      candidates: null,
      resultData: null,
    });

    const textFrames = frames.slice(0, -1);
    expect(textFrames.length).toBeGreaterThan(1); // answerText exceeds the 40-char chunk size
    for (const frame of textFrames) {
      expect(frame.startsWith("data: ")).toBe(true);
    }
    const reconstructed = textFrames
      .map((frame) => JSON.parse(frame.replace(/^data: /, "")).text as string)
      .join("");
    expect(reconstructed).toBe(answerText);
  });

  it("relays noData/candidates verbatim in the done event for a no-match search", async () => {
    runSearchLoopMock.mockResolvedValueOnce({
      answerText: "I couldn't find data for that.",
      citation: null,
      noData: true,
      candidates: null,
      resultData: null,
    });

    const response = await POST(postRequest({ question: "Lakers vs Celtics on 2099-01-01?" }));
    const body = await readBody(response);
    const doneFrame = body.split("\n\n").filter(Boolean).pop()!;
    const doneJson = JSON.parse(doneFrame.split("data: ")[1]);

    expect(doneJson).toEqual({ citation: null, noData: true, candidates: null, resultData: null });
  });

  it("relays an ambiguous candidate list verbatim in the done event", async () => {
    runSearchLoopMock.mockResolvedValueOnce({
      answerText: "Did you mean one of these?",
      citation: null,
      noData: false,
      candidates: ["LeBron James", "LeBron James Jr."],
      resultData: null,
    });

    const response = await POST(postRequest({ question: "LeBron's points?" }));
    const body = await readBody(response);
    const doneFrame = body.split("\n\n").filter(Boolean).pop()!;
    const doneJson = JSON.parse(doneFrame.split("data: ")[1]);

    expect(doneJson).toEqual({
      citation: null,
      noData: false,
      candidates: ["LeBron James", "LeBron James Jr."],
      resultData: null,
    });
  });

  it("includes resultData in the done event when the search loop returns it", async () => {
    const resultData = {
      type: "player_stats" as const,
      payload: { playerName: "LeBron James", games: [] },
    };
    runSearchLoopMock.mockResolvedValueOnce({
      answerText: "LeBron James scored 30 points.",
      citation: { table: "player_game_stats", dateRange: "2024-10-22" },
      noData: false,
      candidates: null,
      resultData,
    });

    const response = await POST(postRequest({ question: "How many points did LeBron score?" }));
    const body = await readBody(response);
    const doneFrame = body.split("\n\n").filter(Boolean).pop()!;
    const doneJson = JSON.parse(doneFrame.split("data: ")[1]);

    expect(doneJson.resultData).toEqual(resultData);
  });

  it("rejects a request with no question", async () => {
    const response = await POST(postRequest({}));
    expect(response.status).toBe(400);
    expect(runSearchLoopMock).not.toHaveBeenCalled();
  });

  it("rejects a question over the length cap without calling the search loop", async () => {
    const response = await POST(postRequest({ question: "a".repeat(501) }));
    expect(response.status).toBe(400);
    expect(runSearchLoopMock).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON", async () => {
    const response = await POST(
      new Request("http://localhost/api/search", { method: "POST", body: "not json" }),
    );
    expect(response.status).toBe(400);
  });

  it("emits a distinct event: error (never event: done, never a thrown error to the client) if the search loop itself fails", async () => {
    runSearchLoopMock.mockRejectedValueOnce(new Error("LLM API unreachable"));

    const response = await POST(postRequest({ question: "anything" }));
    const body = await readBody(response);

    expect(body).toContain("event: error");
    expect(body).not.toContain("event: done");
    const errorJson = JSON.parse(body.split("data: ")[1]);
    expect(errorJson).toEqual({ message: "Search is temporarily unavailable. Please try again shortly." });
  });

  it("emits a distinct event: error if constructing the LLM client itself throws", async () => {
    getLlmClientMock.mockImplementationOnce(() => {
      throw new Error("GEMINI_API_KEY not configured");
    });

    const response = await POST(postRequest({ question: "anything" }));
    const body = await readBody(response);

    expect(runSearchLoopMock).not.toHaveBeenCalled();
    expect(body).toContain("event: error");
    expect(body).not.toContain("event: done");
    const errorJson = JSON.parse(body.split("data: ")[1]);
    expect(errorJson).toEqual({ message: "Search is temporarily unavailable. Please try again shortly." });
  });

  it("never leaks the underlying error message to the client in the error event", async () => {
    runSearchLoopMock.mockRejectedValueOnce(new Error("secret upstream detail: API key sk-abc123"));

    const response = await POST(postRequest({ question: "anything" }));
    const body = await readBody(response);

    expect(body).not.toContain("secret upstream detail");
    expect(body).not.toContain("sk-abc123");
  });
});
