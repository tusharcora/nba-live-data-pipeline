import path from "path";
import { defineConfig } from "vitest/config";

// Minimal config: no test runner existed in web/ before this story. Node
// environment is enough — these are lib/route-handler tests, no DOM. The
// alias mirrors tsconfig.json's "@/*" -> "./*" so lib imports resolve the
// same way they do for the Next.js build.
export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
