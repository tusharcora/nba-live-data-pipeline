// POST /api/search — Statmuse-style natural-language stats search BFF route
// (SPEC-nl-stats-search, Story 2). Runs the agentic tool-use loop
// (lib/search-loop.ts) against whichever LLM provider is configured
// (lib/llm/get-llm-client.ts — Gemini by default, Anthropic as an
// alternative), then streams the answer to the browser as SSE.
//
// Follows app/api/live/route.ts's Vercel-safe SSE precedent: Node runtime,
// the documented "immediate Response + background stream" shape (PRD
// §04/§13), and the same anti-buffering header set. Unlike /live, this
// route builds its own stream from scratch rather than piping an already-
// flowing upstream SSE body — see lib/search-loop.ts's Design Notes for why
// the loop itself uses non-streaming provider calls.
//
// No provider's API key ever reaches the browser — only
// lib/llm/get-llm-client.ts (and the provider modules it calls into) reads
// them, and only this server-side route (and its tests) ever imports that
// module.
export const runtime = "nodejs";

import { getLlmClient } from "@/lib/llm/get-llm-client";
import { runSearchLoop, type SearchResult } from "@/lib/search-loop";

const encoder = new TextEncoder();

// Wire shape (pinned for Story 3 / the frontend):
//   data: {"text":"..."}\n\n                      (repeated, incremental answer text)
//   event: done\ndata: {"citation":..., "noData":..., "candidates":...}\n\n  (once, terminal --
//     the search loop RAN TO COMPLETION: a real answer, a genuine
//     no-data/ambiguous tool result, but never a provider/infra failure)
//   event: error\ndata: {"message":"..."}\n\n                              (once, terminal --
//     the search loop or LLM client construction THREW: missing/invalid
//     API key, network error, rate limit, malformed provider response.
//     Distinct from event: done on purpose -- a provider/config failure
//     must never render identically to a genuine "no data for that"
//     answer. The specific underlying error is never sent to the client;
//     it's logged server-side via console.error only.)
function sseTextChunk(text: string): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({ text })}\n\n`);
}

function sseDone(result: Omit<SearchResult, "answerText">): Uint8Array {
  return encoder.encode(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
}

const SEARCH_UNAVAILABLE_MESSAGE = "Search is temporarily unavailable. Please try again shortly.";

function sseError(): Uint8Array {
  return encoder.encode(`event: error\ndata: ${JSON.stringify({ message: SEARCH_UNAVAILABLE_MESSAGE })}\n\n`);
}

// The loop's final answer text already exists in full (see
// lib/search-loop.ts) by the time we reach this point — this chunking is
// what makes the HTTP response to the browser genuinely incremental rather
// than one buffered blob, independent of whether the upstream Anthropic
// call itself was streamed.
function chunkText(text: string, size = 40): string[] {
  if (text.length === 0) return [];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

// A question long enough to need this many characters is already well past
// what any of the four tools can use; capping it bounds the token cost of a
// single request and rejects it before it ever reaches the model.
const MAX_QUESTION_LENGTH = 500;

export async function POST(request: Request): Promise<Response> {
  let question = "";
  try {
    const body = await request.json();
    if (typeof body?.question === "string") {
      question = body.question.trim();
    }
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  if (!question) {
    return new Response('Missing required field: "question"', { status: 400 });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return new Response(`"question" exceeds the ${MAX_QUESTION_LENGTH}-character limit`, {
      status: 400,
    });
  }

  let streamClosed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // enqueue() throws if the consumer already disconnected and the
      // stream was canceled — guard every call so that race never becomes
      // an unhandled rejection inside this async start().
      const safeEnqueue = (chunk: Uint8Array) => {
        if (streamClosed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          streamClosed = true;
        }
      };

      let result: SearchResult;
      try {
        const llmClient = getLlmClient();
        result = await runSearchLoop({ question, llmClient });
      } catch (error) {
        // A provider/infrastructure failure -- LLM client construction
        // throwing (e.g. no API key configured for the selected
        // SEARCH_LLM_PROVIDER) or a failure inside the loop itself
        // (network, auth, rate limit, malformed provider response, ...).
        // Deliberately a distinct event from `done`: a genuine "no data for
        // that" answer is the search loop running to completion and
        // reporting honestly (see search-loop.ts's CAP-5 handling); this is
        // the loop never completing at all, which the client must be able
        // to tell apart. The specific error is logged here, never sent to
        // the client.
        console.error("[api/search] runSearchLoop failed:", error);
        safeEnqueue(sseError());
        controller.close();
        return;
      }

      for (const chunk of chunkText(result.answerText)) {
        safeEnqueue(sseTextChunk(chunk));
      }
      safeEnqueue(
        sseDone({
          citation: result.citation,
          noData: result.noData,
          candidates: result.candidates,
        }),
      );
      controller.close();
    },
    cancel() {
      // Fires if the browser disconnects mid-stream. There is no
      // AbortController wired through runSearchLoop/callTool yet, so the
      // in-flight Anthropic/FastAPI calls still run to completion — this
      // only stops us from writing to a closed stream (via streamClosed
      // above). Aborting the upstream calls themselves is tracked as a
      // follow-up (see this story's PR description).
      streamClosed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Anti-buffering hint for reverse proxies (e.g. nginx) — same as
      // app/api/live/route.ts. Vercel's own buffering behavior is governed
      // by the runtime + streaming-Response pattern above, not this header
      // alone, but its presence is still correct.
      "X-Accel-Buffering": "no",
    },
  });
}
