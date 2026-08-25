import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function runTool(args: string[], input: string): number {
  const result = spawnSync("pnpm", ["exec", ...args], {
    cwd: repoRoot,
    input,
    encoding: "utf8",
    timeout: 60_000,
  });
  return result.status ?? 1;
}

describe("skill bridge ignores", () => {
  it("checks a non-bridge path under .agents/skills", () => {
    // The filename is virtual so this test does not leave a fixture in the
    // directory whose ignore behavior it verifies.
    const prettierStatus = runTool(
      [
        "prettier",
        "--check",
        "--ignore-unknown",
        "--stdin-filepath",
        ".agents/skills/probe.mjs",
      ],
      "const value={a:1}\n",
    );
    const eslintStatus = runTool(
      [
        "eslint",
        "--stdin",
        "--stdin-filename",
        ".agents/skills/probe.mjs",
        "--no-warn-ignored",
      ],
      "const value = 1;\n",
    );

    expect(prettierStatus).not.toBe(0);
    expect(eslintStatus).not.toBe(0);
  });

  it("continues to ignore the bridge path", () => {
    const prettierStatus = runTool(
      [
        "prettier",
        "--check",
        "--ignore-unknown",
        "--stdin-filepath",
        ".agents/skills/merge-dependabot/probe.mjs",
      ],
      "const value={a:1}\n",
    );
    const eslintStatus = runTool(
      [
        "eslint",
        "--stdin",
        "--stdin-filename",
        ".agents/skills/merge-dependabot/probe.mjs",
        "--no-warn-ignored",
      ],
      "const value = 1;\n",
    );

    expect(prettierStatus).toBe(0);
    expect(eslintStatus).toBe(0);
  });
});
