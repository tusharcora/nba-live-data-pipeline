// Vercel-safe SSE passthrough for FastAPI's `GET /board/stream`.
//
// Same reasoning as the retired `app/api/live/route.ts` this replaces:
// `fetchFromApi` (lib/fastapi-client.ts) always calls `.json()`, which
// would try to buffer and parse the entire event-stream body as one JSON
// document -- the opposite of what an SSE proxy needs. This route reads
// the same server-only env vars and sends the same `X-API-Key` header, so
// the API key never reaches the browser (docs/prd.md §08).
//
// Required for the streaming pattern below to actually stream (rather
// than buffer) once deployed to Vercel -- see docs/prd.md §04/§13:
export const runtime = "nodejs";

// api/board/stream's own generator now self-closes after ~20s (see
// board.py's MAX_STREAM_DURATION_SECONDS) well before Vercel would force-kill
// this function -- this ceiling exists so that stays true even if the
// upstream fetch itself hangs, not because we expect to hit it.
export const maxDuration = 60;

const BASE_URL = process.env.FASTAPI_BASE_URL ?? "http://localhost:8000";
const API_KEY = process.env.API_SERVICE_KEY ?? "";

export async function GET() {
  let upstream: Response;
  try {
    upstream = await fetch(`${BASE_URL}/board/stream`, {
      headers: { "X-API-Key": API_KEY },
    });
  } catch {
    return new Response("Upstream /board/stream fetch failed", { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    return new Response("Upstream /board/stream unavailable", { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
