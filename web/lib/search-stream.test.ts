// @vitest-environment node
//
// Uses the real `Response`/`ReadableStream`/`TextEncoder` globals Node's
// fetch implementation provides -- jsdom (this project's default test
// environment, see `vitest.config.ts`) doesn't implement those.
import { describe, expect, it } from "vitest";

import { DEFAULT_SEARCH_ERROR_MESSAGE, readSearchStream, type SearchStreamEvent } from "./search-stream";
import { responseFromChunks } from "./test-support/sse-stream";
import type { SearchResultData } from "@/lib/search-result-types";

async function collect(response: Response): Promise<SearchStreamEvent[]> {
  const events: SearchStreamEvent[] = [];
  for await (const event of readSearchStream(response)) events.push(event);
  return events;
}

describe("readSearchStream", () => {
  it("streams a happy-path answer split across two JSON-wrapped chunks, then a done payload with a citation", async () => {
    // Matches Dev2's real `sseTextChunk()` output (`web/app/api/search/route.ts`
    // on story2/bff-search-route): each chunk's `data:` line is
    // `{"text": "..."}`, not raw text -- confirmed against that PR's own
    // `route.test.ts` fixtures during its review.
    const response = responseFromChunks([
      'data: {"text":"The Lakers won"}\n\n',
      'data: {"text":" 103-98 on 2026-01-05"}\n\n',
      'event: done\ndata: {"citation":{"table":"games","dateRange":"2025-10-01..2026-01-05"},"noData":false,"candidates":null}\n\n',
    ]);

    const events = await collect(response);

    expect(events).toEqual([
      { kind: "chunk", text: "The Lakers won" },
      { kind: "chunk", text: " 103-98 on 2026-01-05" },
      {
        kind: "done",
        payload: {
          citation: { table: "games", dateRange: "2025-10-01..2026-01-05" },
          noData: false,
          candidates: null,
          resultData: null,
        },
      },
    ]);
  });

  it("reassembles a frame whose `\\n\\n` separator is split across chunk boundaries", async () => {
    // The separator between the two `data:` frames is split: one chunk
    // ends mid-way through it, the next begins with the rest.
    const response = responseFromChunks([
      'data: {"text":"partial answer"}\n',
      '\ndata: {"text":"rest"}\n\nevent: done\ndata: {"citation":null,"noData":false,"candidates":null}\n\n',
    ]);

    const events = await collect(response);

    expect(events[0]).toEqual({ kind: "chunk", text: "partial answer" });
    expect(events[1]).toEqual({ kind: "chunk", text: "rest" });
    expect(events[2].kind).toBe("done");
  });

  it("drops a chunk frame whose JSON payload doesn't match `{text: string}`, without breaking the stream", async () => {
    const response = responseFromChunks([
      "data: {not valid json\n\n", // invalid JSON
      'data: {"answer":"wrong field name"}\n\n', // valid JSON, no `text` field
      "data: [1,2,3]\n\n", // valid JSON, but an array
      'data: {"text":"real chunk"}\n\n',
      'event: done\ndata: {"citation":null,"noData":false,"candidates":null}\n\n',
    ]);

    const events = await collect(response);

    expect(events).toEqual([
      { kind: "chunk", text: "real chunk" },
      {
        kind: "done",
        payload: { citation: null, noData: false, candidates: null, resultData: null },
      },
    ]);
  });

  it("reports noData via the done payload", async () => {
    const response = responseFromChunks([
      'event: done\ndata: {"citation":null,"noData":true,"candidates":null}\n\n',
    ]);

    const events = await collect(response);

    expect(events).toEqual([
      {
        kind: "done",
        payload: { citation: null, noData: true, candidates: null, resultData: null },
      },
    ]);
  });

  it("reports ambiguous candidates via the done payload", async () => {
    const response = responseFromChunks([
      'event: done\ndata: {"citation":null,"noData":false,"candidates":["LeBron James","LeBron James Jr."]}\n\n',
    ]);

    const events = await collect(response);

    expect(events).toEqual([
      {
        kind: "done",
        payload: {
          citation: null,
          noData: false,
          candidates: ["LeBron James", "LeBron James Jr."],
          resultData: null,
        },
      },
    ]);
  });

  it("de-duplicates and drops empty-string candidates", async () => {
    const response = responseFromChunks([
      'event: done\ndata: {"citation":null,"noData":false,"candidates":["LeBron James","LeBron James","","  "]}\n\n',
    ]);

    const events = await collect(response);

    expect(events).toEqual([
      {
        kind: "done",
        payload: { citation: null, noData: false, candidates: ["LeBron James"], resultData: null },
      },
    ]);
  });

  it("includes an optional citation.gameCount when the payload carries one", async () => {
    const response = responseFromChunks([
      'event: done\ndata: {"citation":{"table":"player_game_stats","dateRange":"2025-10-01..2026-01-05","gameCount":12},"noData":false,"candidates":null}\n\n',
    ]);

    const events = await collect(response);

    expect(events).toEqual([
      {
        kind: "done",
        payload: {
          citation: { table: "player_game_stats", dateRange: "2025-10-01..2026-01-05", gameCount: 12 },
          noData: false,
          candidates: null,
          resultData: null,
        },
      },
    ]);
  });

  it("parses resultData from a done payload when present", async () => {
    const resultData: SearchResultData = {
      type: "leaders",
      payload: { stat: "points", gameCount: 26, leaders: [{ player_id: 1, player_name: "A", value: 10 }] },
    };
    const response = responseFromChunks([
      `event: done\ndata: ${JSON.stringify({ citation: null, noData: false, candidates: null, resultData })}\n\n`,
    ]);

    const events = await collect(response);

    expect(events[events.length - 1]).toEqual({
      kind: "done",
      payload: { citation: null, noData: false, candidates: null, resultData },
    });
  });

  it("parses a stat_aggregate resultData from a done payload, surviving the live client path (Critical #1 regression)", async () => {
    // Regression coverage for VALID_RESULT_TYPES silently dropping the two
    // newest tool result types -- get_player_stat_aggregate's own
    // "stat_aggregate" type must round-trip through parseDonePayload just
    // like the original four, not fall through to `resultData: null`.
    const resultData: SearchResultData = {
      type: "stat_aggregate",
      payload: {
        playerName: "LeBron James",
        stat: "points",
        operation: "sum",
        threshold: null,
        value: 812,
        extremeGame: null,
        matchingGames: null,
        matchingGamesTruncated: false,
        gameCountConsidered: 30,
      },
    };
    const response = responseFromChunks([
      `event: done\ndata: ${JSON.stringify({ citation: null, noData: false, candidates: null, resultData })}\n\n`,
    ]);

    const events = await collect(response);

    expect(events[events.length - 1]).toEqual({
      kind: "done",
      payload: { citation: null, noData: false, candidates: null, resultData },
    });
  });

  it("drops a malformed resultData (wrong type discriminant) rather than failing the whole done parse", async () => {
    const response = responseFromChunks([
      `event: done\ndata: ${JSON.stringify({
        citation: null,
        noData: false,
        candidates: null,
        resultData: { type: "not_a_real_type", payload: {} },
      })}\n\n`,
    ]);

    const events = await collect(response);

    expect(events[events.length - 1]).toEqual({
      kind: "done",
      payload: { citation: null, noData: false, candidates: null, resultData: null },
    });
  });

  it("defaults resultData to null when absent (backward-compatible with an older payload)", async () => {
    const response = responseFromChunks([
      `event: done\ndata: ${JSON.stringify({ citation: null, noData: true, candidates: null })}\n\n`,
    ]);

    const events = await collect(response);

    expect(events[events.length - 1]).toEqual({
      kind: "done",
      payload: { citation: null, noData: true, candidates: null, resultData: null },
    });
  });

  it("reports a distinct error event, not a done event, for an event: error frame", async () => {
    const response = responseFromChunks([
      'data: {"text":"this text should never be shown"}\n\n',
      'event: error\ndata: {"message":"Search is temporarily unavailable. Please try again shortly."}\n\n',
    ]);

    const events = await collect(response);

    expect(events).toEqual([
      { kind: "chunk", text: "this text should never be shown" },
      {
        kind: "error",
        payload: { message: DEFAULT_SEARCH_ERROR_MESSAGE },
      },
    ]);
  });

  it("falls back to a default message when an error frame's JSON is malformed, without throwing", async () => {
    const response = responseFromChunks(["event: error\ndata: {not valid json\n\n"]);

    const events = await collect(response);

    expect(events).toEqual([
      {
        kind: "error",
        payload: { message: DEFAULT_SEARCH_ERROR_MESSAGE },
      },
    ]);
  });

  it("falls back to a default message when an error frame has no usable `message` field", async () => {
    const response = responseFromChunks(['event: error\ndata: {"reason":"wrong field name"}\n\n']);

    const events = await collect(response);

    expect(events).toEqual([
      {
        kind: "error",
        payload: { message: DEFAULT_SEARCH_ERROR_MESSAGE },
      },
    ]);
  });

  it("rejects a done payload that parses to a JSON array rather than an object", async () => {
    const response = responseFromChunks(["event: done\ndata: [1,2,3]\n\n"]);

    await expect(collect(response)).rejects.toThrow(/Malformed `done` payload/);
  });

  it("skips a malformed frame (no data/event fields) without breaking the stream", async () => {
    const response = responseFromChunks([
      ": this is a comment, not a field\n\n",
      'data: {"text":"real chunk"}\n\n',
      'event: done\ndata: {"citation":null,"noData":false,"candidates":null}\n\n',
    ]);

    const events = await collect(response);

    expect(events).toEqual([
      { kind: "chunk", text: "real chunk" },
      {
        kind: "done",
        payload: { citation: null, noData: false, candidates: null, resultData: null },
      },
    ]);
  });

  it("throws when the done frame's JSON payload is malformed", async () => {
    const response = responseFromChunks(["event: done\ndata: {not json\n\n"]);

    await expect(collect(response)).rejects.toThrow(/Malformed `done` payload/);
  });

  it("handles a trailing frame with no final blank line", async () => {
    const response = responseFromChunks([
      'event: done\ndata: {"citation":null,"noData":false,"candidates":null}',
    ]);

    const events = await collect(response);

    expect(events).toEqual([
      {
        kind: "done",
        payload: { citation: null, noData: false, candidates: null, resultData: null },
      },
    ]);
  });

  it("yields nothing when the stream closes with no frames at all", async () => {
    const response = responseFromChunks([]);

    const events = await collect(response);

    expect(events).toEqual([]);
  });

  it("throws when the response has no body", async () => {
    const response = new Response(null);

    await expect(collect(response)).rejects.toThrow(/no body/);
  });
});
