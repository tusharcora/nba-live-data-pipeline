/**
 * Shared test helper: builds a fetch-like `Response` whose body streams the
 * given raw string chunks one at a time. Used by both
 * `lib/search-stream.test.ts` (the parsing layer) and
 * `app/components/sections/search-section.test.tsx` (the component layer)
 * to construct a synthetic `/api/search` SSE response without a real
 * network call -- lets a test control exactly where an SSE frame boundary
 * falls relative to a network chunk boundary.
 */
export function responseFromChunks(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream);
}
