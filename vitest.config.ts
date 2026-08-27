import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Repository automation tests shell out to git/node in temp directories,
    // which is slower than a unit test but must not be allowed to hang CI.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Cleanup is the runner's job, not each test's. A spy, a stubbed env var or
    // a stubbed global that outlives the test that created it turns a later
    // failure into a mystery whose cause is in a different file, and makes the
    // "each test passes when run alone" rule in AGENTS.md unenforceable.
    restoreMocks: true,
    clearMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    // A focused test silently shrinks the suite to one case. Failing on it
    // everywhere — not only under CI, which is the default — means the author
    // finds it before the commit rather than the pipeline finding it after.
    allowOnly: false,
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
