// Server-only: the Anthropic API key never reaches the browser (same
// discipline as lib/fastapi-client.ts's API_SERVICE_KEY). Only ever
// imported from a Route Handler (app/api/search/route.ts), never from a
// client component.

import Anthropic from "@anthropic-ai/sdk";

let cachedClient: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!cachedClient) {
    cachedClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
  }
  return cachedClient;
}
