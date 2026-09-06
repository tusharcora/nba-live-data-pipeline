import { defineConfig } from "vitest/config";
import path from "node:path";

// Default environment is jsdom (component tests need `document`/`window`).
// `web/lib/search-stream.test.ts` opts back into the plain `node`
// environment via a `// @vitest-environment node` docblock -- it exercises
// the real `Response`/`ReadableStream` globals Node's fetch implementation
// provides, and jsdom doesn't implement those.
export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
