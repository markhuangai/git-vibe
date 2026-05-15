import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts", "packages/*/src/**/*.ts", "scripts/smoke-test-ai.mjs"],
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
    include: ["tests/**/*.test.mjs", "packages/*/tests/**/*.test.mjs"],
  },
});
