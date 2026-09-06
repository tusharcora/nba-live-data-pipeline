import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SearchSection, STREAM_TIMEOUT_MS } from "./search-section";
import { responseFromChunks as mockStreamResponse } from "@/lib/test-support/sse-stream";

/**
 * Component-level coverage of this story's I/O & Edge-Case Matrix
 * (`_bmad-output/specs/spec-nl-stats-search/stories/3-search-page-ui.md`).
 * `lib/search-stream.test.ts` already covers the SSE-framing edge cases at
 * the parsing layer; these tests drive the whole component (mocking only
 * `global.fetch`) to verify the matrix's *rendering* outcomes -- the
 * "happy path"/"no data"/"ambiguous" rows exercise the same
 * `readSearchStream` code path as those unit tests, plus the reducer that
 * turns a done-payload into one of this component's visually distinct
 * states; "fetch fails" and "empty question" are pure component behavior
 * with nothing to cover at the parsing layer.
 */

const DONE_ANSWER = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ citation: null, noData: false, candidates: null, ...overrides });

/** One answer-text chunk frame, matching Dev2's real `sseTextChunk()`
 * output (`web/app/api/search/route.ts` on story2/bff-search-route):
 * `data: {"text": "..."}`, not raw text. `JSON.stringify` handles any
 * characters (quotes, parens, etc.) in `text` safely. */
const dataChunk = (text: string) => `data: ${JSON.stringify({ text })}\n\n`;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // No global `afterEach` is registered (`vitest.config.ts` doesn't set
  // `test.globals: true`), so `@testing-library/react`'s automatic
  // per-test cleanup never triggers on its own -- do it explicitly, or a
  // second `render()` in a later test in this file leaves the previous
  // test's DOM behind and queries start matching duplicate elements.
  cleanup();
});

async function askQuestion(question: string) {
  const user = userEvent.setup();
  render(<SearchSection />);
  await user.type(screen.getByLabelText(/ask a stats question/i), question);
  await user.click(screen.getByRole("button", { name: /ask/i }));
  return user;
}

describe("SearchSection", () => {
  it("renders the streamed answer and its citation once the stream completes (happy path)", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockStreamResponse([
        dataChunk("The Lakers won"),
        dataChunk(" 103-98"),
        `event: done\ndata: ${DONE_ANSWER({
          citation: { table: "games", dateRange: "2025-10-01..2026-01-05" },
        })}\n\n`,
      ])
    );

    await askQuestion("Who won the Lakers game on Jan 5?");

    await waitFor(() =>
      expect(screen.getByText("The Lakers won 103-98")).toBeInTheDocument()
    );
    expect(screen.getByText(/games/)).toBeInTheDocument();
    expect(screen.getByText(/2025-10-01\.\.2026-01-05/)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/api/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ question: "Who won the Lakers game on Jan 5?" }),
      })
    );
  });

  it("renders an explicit sourcing-gap indicator, never a silent citation-less answer (CAP-4)", async () => {
    // citation: null with noData: false and candidates: null -- a real
    // answer with nothing to cite. Must never render indistinguishably
    // from a normal, sourced answer.
    vi.mocked(fetch).mockResolvedValue(
      mockStreamResponse([
        dataChunk("The Lakers won 103-98"),
        `event: done\ndata: ${DONE_ANSWER({ citation: null })}\n\n`,
      ])
    );

    await askQuestion("Who won the Lakers game on Jan 5?");

    await waitFor(() =>
      expect(screen.getByText("The Lakers won 103-98")).toBeInTheDocument()
    );
    expect(
      await screen.findByText(/no source citation was returned/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Source:/)).not.toBeInTheDocument();
  });

  it("renders a distinct no-data panel, not a normal answer, when noData is true", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockStreamResponse([
        dataChunk("(this text should never be shown)"),
        `event: done\ndata: ${DONE_ANSWER({ noData: true })}\n\n`,
      ])
    );

    await askQuestion("Stats for a team that never played");

    expect(await screen.findByText("No data for that")).toBeInTheDocument();
    expect(screen.queryByText(/this text should never be shown/)).not.toBeInTheDocument();
  });

  it("renders a distinct ambiguous panel listing every candidate", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockStreamResponse([
        `event: done\ndata: ${DONE_ANSWER({
          candidates: ["LeBron James", "LeBron James Jr."],
        })}\n\n`,
      ])
    );

    await askQuestion("How many points did LeBron score?");

    expect(await screen.findByText(/did you mean/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "LeBron James" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "LeBron James Jr." })).toBeInTheDocument();
  });

  it("re-queries with the picked candidate's name when a 'did you mean' button is clicked", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockStreamResponse([
        `event: done\ndata: ${DONE_ANSWER({
          candidates: ["LeBron James", "LeBron James Jr."],
        })}\n\n`,
      ])
    );

    const user = await askQuestion("How many points did LeBron score?");
    expect(await screen.findByText(/did you mean/i)).toBeInTheDocument();

    vi.mocked(fetch).mockResolvedValueOnce(
      mockStreamResponse([
        dataChunk("LeBron James scored 30 points"),
        `event: done\ndata: ${DONE_ANSWER({
          citation: { table: "player_game_stats", dateRange: "2026-01-05..2026-01-05" },
        })}\n\n`,
      ])
    );

    await user.click(screen.getByRole("button", { name: "LeBron James" }));

    // Re-queries with the candidate's exact display string as a brand-new
    // question -- the second `/api/search` call, not the first.
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ question: "LeBron James" }),
      })
    );

    // The ambiguous panel is replaced by the new answer, not left showing
    // alongside it.
    expect(
      await screen.findByText("LeBron James scored 30 points")
    ).toBeInTheDocument();
    expect(screen.queryByText(/did you mean/i)).not.toBeInTheDocument();

    // The question input reflects the picked candidate too.
    expect(screen.getByLabelText(/ask a stats question/i)).toHaveValue("LeBron James");
  });

  it("renders a connection-error alert when the fetch itself fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));

    await askQuestion("Any question");

    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByText(/couldn't reach the search service/i)).toBeInTheDocument();
  });

  it("renders a connection-error alert when the response is not ok", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 500 }));

    await askQuestion("Any question");

    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByText(/server responded 500/i)).toBeInTheDocument();
  });

  it("renders a connection-error alert when the response is ok but has no body", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));

    await askQuestion("Any question");

    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
  });

  it("renders a connection-error alert when the done payload's JSON is malformed", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockStreamResponse(["event: done\ndata: {not valid json\n\n"])
    );

    await askQuestion("Any question");

    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByText(/couldn't reach the search service/i)).toBeInTheDocument();
  });

  it("renders a stream-ended-early error when the stream closes without a `done` frame", async () => {
    // No `event: done` frame at all -- e.g. a truncated response, a proxy
    // timeout, or a server crash mid-stream. Without this state, the UI
    // would be stuck showing "Thinking…"/"Answering…" forever.
    vi.mocked(fetch).mockResolvedValue(mockStreamResponse([dataChunk("partial answer")]));

    await askQuestion("Any question");

    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByText(/stream ended unexpectedly/i)).toBeInTheDocument();
  });

  it("renders a timeout error when the request never gets a response", async () => {
    // Simulates the Fetch spec's real behavior for a hung request: the
    // fetch promise stays pending until its AbortSignal fires, at which
    // point it rejects. A real `/api/search` call that never responds at
    // all is exactly this case; a manually-built `Response`'s body (used
    // by the other tests here) can't reproduce the "stream opens, then
    // stalls forever" variant, since aborting only cancels a *real*
    // fetch's body, not one built by hand in a test.
    vi.mocked(fetch).mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        })
    );

    render(<SearchSection />);

    // Fake timers must already be active *before* the click, since that's
    // what synchronously registers `runSearch`'s `setTimeout` -- a timer
    // registered against the real clock is invisible to
    // `advanceTimersByTimeAsync` below. `fireEvent`, not `userEvent`,
    // here: `userEvent`'s simulated typing/click delays need real timers
    // to resolve, which defeats the point of faking them.
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText(/ask a stats question/i), {
      target: { value: "Any question" },
    });
    fireEvent.click(screen.getByRole("button", { name: /ask/i }));

    await vi.advanceTimersByTimeAsync(STREAM_TIMEOUT_MS);
    vi.useRealTimers();

    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByText(/took too long to respond/i)).toBeInTheDocument();
  });

  it("never sends a request for a blank/whitespace-only question", async () => {
    const user = userEvent.setup();
    render(<SearchSection />);

    await user.type(screen.getByLabelText(/ask a stats question/i), "   ");
    expect(screen.getByRole("button", { name: /ask/i })).toBeDisabled();

    expect(fetch).not.toHaveBeenCalled();
  });
});
