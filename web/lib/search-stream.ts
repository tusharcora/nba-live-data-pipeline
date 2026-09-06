/**
 * Parsing for the `/api/search` SSE-over-POST response (Story 2's BFF
 * route). `EventSource` can't send a POST body, so `/search`'s page
 * reads `response.body` directly (`getReader()` + `TextDecoder`) instead
 * of using `EventSource` the way `/api/live` does (`app/live/LiveBoard.tsx`).
 *
 * Contract confirmed against Dev2's real route (`web/app/api/search/route.ts`
 * on `story2/bff-search-route`, cross-checked during that PR's review):
 * anonymous `data:` frames carry a JSON object `{"text": "..."}` per chunk
 * (not raw text -- JSON-wrapping avoids a literal blank line inside the
 * answer text ever being mistaken for an SSE frame boundary), concatenating
 * each chunk's `text` field in order; the stream ends with one `event: done`
 * frame whose `data:` line is a JSON object matching `SearchDonePayload`.
 *
 * Pure, DOM-free module by design so the trickiest logic here (SSE framing
 * split across arbitrary chunk boundaries) is unit-testable without a
 * browser or a real network stream.
 */

export type SearchCitation = {
  table: string;
  dateRange: string;
  /**
   * Optional -- SPEC.md's CAP-2 requires aggregate/leaderboard answers to
   * disclose the game count they were computed over, but the contract
   * this story was handed (see the story spec's Design Notes) only
   * defines `table`/`dateRange`. Rendered when present so a real Story 2
   * payload carrying it just works; absence never breaks anything.
   */
  gameCount?: number | string;
};

export type SearchDonePayload = {
  citation: SearchCitation | null;
  noData: boolean;
  candidates: string[] | null;
};

export type SearchStreamEvent =
  | { kind: "chunk"; text: string }
  | { kind: "done"; payload: SearchDonePayload };

/**
 * One `\n\n`-delimited SSE frame, already stripped of its trailing blank
 * line. A frame is one or more `field: value` lines; this only cares
 * about `event:` and `data:` (multiple `data:` lines in one frame are
 * joined with `\n`, per the SSE spec, though the assumed contract never
 * emits more than one).
 */
function parseSSEFrame(frame: string): { event: string; data: string } | null {
  const lines = frame.split("\n");
  let event = "message";
  const dataLines: string[] = [];

  for (const rawLine of lines) {
    // A leading space after the colon is optional per the SSE spec.
    const match = /^([a-zA-Z]+):\s?(.*)$/.exec(rawLine);
    if (!match) continue; // blank line / comment (`:`) / malformed -- ignore
    const [, field, value] = match;
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

/**
 * Parses a `done` frame's JSON `data:` payload, defensively -- unknown/
 * mismatched fields are dropped rather than thrown on, since the real
 * `/api/search` route (Story 2) may not have landed yet and its exact
 * field shape is only assumed (see this module's header). Drops are
 * logged via `console.warn` so contract drift is at least visible during
 * Story 4's integration pass, rather than silently rendering as "no
 * citation" / "no candidates".
 */
function parseDonePayload(raw: string): SearchDonePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // `typeof [] === "object"` -- an array (or any other non-plain-object
  // JSON value that happens to satisfy `typeof === "object"`, i.e. only
  // arrays and `null`, already excluded below) is not a valid payload.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;

  const noData = obj.noData === true;

  let candidates: string[] | null = null;
  if (Array.isArray(obj.candidates)) {
    const stringCandidates = obj.candidates.filter(
      (c): c is string => typeof c === "string" && c.trim().length > 0
    );
    if (stringCandidates.length !== obj.candidates.length) {
      console.warn(
        "/api/search done payload: dropped non-string or empty `candidates` entries",
        obj.candidates
      );
    }
    // De-duplicated: a "did you mean" list showing the same name twice
    // gives the user nothing, and duplicate strings would collide as
    // React list keys.
    candidates = Array.from(new Set(stringCandidates));
  }

  let citation: SearchCitation | null = null;
  if (typeof obj.citation === "object" && obj.citation !== null && !Array.isArray(obj.citation)) {
    const c = obj.citation as Record<string, unknown>;
    if (typeof c.table === "string" && typeof c.dateRange === "string") {
      citation = { table: c.table, dateRange: c.dateRange };
      if (typeof c.gameCount === "number" || typeof c.gameCount === "string") {
        citation.gameCount = c.gameCount;
      }
    } else {
      console.warn(
        "/api/search done payload: `citation` present but missing table/dateRange, dropped",
        obj.citation
      );
    }
  }

  return { citation, noData, candidates };
}

/**
 * Parses one answer-text chunk frame's JSON `data:` payload
 * (`{"text": "..."}`, matching `route.ts`'s `sseTextChunk()`). Returns
 * `null` on anything that doesn't match -- invalid JSON, a non-object, or
 * a missing/non-string `text` field -- so the caller can drop just that
 * one chunk (logging why) rather than fail the whole stream over one bad
 * frame; unlike a malformed `done` payload, losing one chunk still leaves
 * the rest of the answer usable.
 */
function parseChunkPayload(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const text = (parsed as Record<string, unknown>).text;
  return typeof text === "string" ? text : null;
}

/**
 * Reads a `fetch()` Response's body as a stream of `SearchStreamEvent`s.
 * Buffers partial lines/frames across chunk boundaries -- a `\n\n`
 * separator (or the final flush at stream end) can land anywhere relative
 * to a `TextDecoder` chunk boundary, so this never assumes one network
 * chunk lines up with one SSE frame.
 *
 * A frame that fails to parse (`parseSSEFrame` returns null), or a chunk
 * frame whose JSON payload doesn't match `{"text": string}`, is skipped,
 * not fatal -- the stream keeps going and the rest of the answer still
 * comes through. Only a `done` event whose payload fails to parse is
 * fatal: with no usable payload the caller can't tell normal/no-data/
 * ambiguous apart, so this throws and the caller's fetch try/catch should
 * route to the connection-error state.
 */
export async function* readSearchStream(
  response: Response
): AsyncGenerator<SearchStreamEvent, void, void> {
  if (!response.body) {
    throw new Error("Response has no body to stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) {
        buffer += decoder.decode(); // flush any trailing multi-byte char
        // Some SSE senders omit the final blank line after the last
        // frame -- synthesize the separator so the one parse loop below
        // handles a trailing frame the same way as every other frame,
        // rather than duplicating its branch/parse logic in a second
        // end-of-stream code path.
        if (buffer.trim() && !buffer.endsWith("\n\n")) buffer += "\n\n";
      }

      for (
        let separatorIndex = buffer.indexOf("\n\n");
        separatorIndex !== -1;
        separatorIndex = buffer.indexOf("\n\n")
      ) {
        const rawFrame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const parsed = parseSSEFrame(rawFrame);
        if (!parsed) continue;

        if (parsed.event === "done") {
          const payload = parseDonePayload(parsed.data);
          if (!payload) {
            throw new Error("Malformed `done` payload in /api/search stream");
          }
          yield { kind: "done", payload };
          return;
        }

        const chunkText = parseChunkPayload(parsed.data);
        if (chunkText === null) {
          console.warn(
            "/api/search data chunk: not valid JSON `{\"text\": string}`, dropped",
            parsed.data
          );
          continue;
        }
        yield { kind: "chunk", text: chunkText };
      }

      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}
