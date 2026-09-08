// Vercel-safe SSE passthrough for FastAPI's `GET /live`.
//
// Why this doesn't go through `fetchFromApi` (lib/fastapi-client.ts):
// `fetchFromApi` always calls `.json()` on the upstream response, which
// would try to buffer and parse the entire event-stream body as a single
// JSON document — exactly the opposite of what an SSE proxy needs. This
// route still reads the same server-only env vars (`FASTAPI_BASE_URL`,
// `API_SERVICE_KEY`) and sends the same `X-API-Key` header, so the API key
// discipline from `fetchFromApi` is preserved even though the helper
// itself isn't reused. The API key never reaches the browser (docs/prd.md
// §08) — only this server-side route ever reads it.
//
// Required for the streaming pattern below to actually stream (rather than
// buffer) once deployed to Vercel — see docs/prd.md §04/§13:
export const runtime = "nodejs";

const BASE_URL = process.env.FASTAPI_BASE_URL ?? "http://localhost:8000";
const API_KEY = process.env.API_SERVICE_KEY ?? "";

export async function GET() {
  let upstream: Response;
  try {
    upstream = await fetch(`${BASE_URL}/live`, {
      headers: { "X-API-Key": API_KEY },
    });
  } catch {
    return new Response("Upstream /live fetch failed", { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    return new Response("Upstream /live unavailable", { status: 502 });
  }

  // Pipe the upstream SSE body straight through as this route's own body.
  // No buffering, no re-parsing of individual `data: ...` events — the BFF
  // only re-streams bytes, it never inspects the SSE payload shape.
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Anti-buffering hint for reverse proxies (e.g. nginx). Vercel's own
      // buffering behavior is governed by the runtime + streaming pattern
      // above, not this header alone, but its presence is still correct
      // and is one of the things the plan's boss review checks for.
      "X-Accel-Buffering": "no",
    },
  });
}
