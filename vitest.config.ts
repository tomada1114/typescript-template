import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Repository automation tests shell out to git/node in temp directories,
    // which is slower than a unit test but must not be allowed to hang CI.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "lcov"],
      // Report every source file, so an untested module shows up as 0% instead
      // of vanishing from the denominator.
      include: ["src/**/*.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 80,
      },
    },
  },
});
