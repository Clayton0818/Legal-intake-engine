import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // The isolation test writes/reads real rows against DATABASE_URL and
    // cleans up in afterAll — running suites in parallel workers against
    // the same shared database risks interleaving that afterAll cleanup
    // isn't designed to handle. Single-threaded is the right default for
    // this test suite's current size.
    fileParallelism: false,
  },
});
