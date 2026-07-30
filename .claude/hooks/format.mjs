// PostToolUse hook: lint and format the single file that was just edited.
//
// Reads the hook payload from stdin and runs ESLint's autofix and then Prettier
// on that one file, so an agent never has to remember to re-run a formatter and
// never pays for a whole-tree pass after a one-line change.
//
// Exit code 2 feeds the remaining, unfixable violations back to Claude as
// context. It does not block anything: the edit has already happened, and the
// point is to tell the agent what is still wrong.
import console from "node:console";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { isMain } from "../../scripts/lib/is-main.mjs";
import { readKey, readString } from "../../scripts/lib/json.mjs";
import {
  repoRoot,
  resolveDependencyBin,
  runNode,
} from "../../scripts/lib/node-tools.mjs";
import { readPayload } from "./lib/payload.mjs";

/** Extensions ESLint is configured to parse. */
const LINTABLE = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

/**
 * Extensions Prettier formats in this repository.
 *
 * @remarks
 * Listing them is what makes "an unrelated file is a no-op" true without
 * spawning Prettier just to have it decline. Prettier still applies
 * `.prettierignore` on top of this, so a generated file passed here is skipped
 * rather than rewritten.
 */
const FORMATTABLE = new Set([
  ...LINTABLE,
  ".json",
  ".jsonc",
  ".md",
  ".yml",
  ".yaml",
  ".html",
  ".css",
]);

/**
 * Decide which tools apply to a file, if any.
 *
 * @param {string} filePath - Path reported in the hook payload.
 * @returns {{ absolute: string, lint: boolean, format: boolean } | null} The
 * resolved target, or null when the file is out of scope for this hook.
 */
export function planFor(filePath) {
  if (filePath === "") {
    return null;
  }
  const absolute = path.resolve(repoRoot, filePath);
  const relative = path.relative(repoRoot, absolute);
  // A path outside the repository is not this repository's to format.
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  if (!existsSync(absolute)) {
    return null;
  }
  const extension = path.extname(absolute);
  if (!FORMATTABLE.has(extension)) {
    return null;
  }
  return { absolute, lint: LINTABLE.has(extension), format: true };
}

/**
 * Run ESLint's autofix and Prettier over one file.
 *
 * @param {{ absolute: string, lint: boolean, format: boolean }} plan - Target
 * produced by {@link planFor}.
 * @returns {number} 0 when everything passed, 2 when something remains broken.
 */
function applyPlan(plan) {
  /** @type {{ label: string, script: string, args: string[] }[]} */
  const steps = [];
  if (plan.lint) {
    steps.push({
      label: "eslint --fix",
      script: resolveDependencyBin("eslint"),
      // `--max-warnings 0` matches `pnpm run lint`, so the hook and the gate
      // agree on what counts as a failure. `--no-warn-ignored` keeps a
      // generated file from being reported as a problem when it is simply out
      // of scope.
      args: ["--fix", "--no-warn-ignored", "--max-warnings", "0", plan.absolute],
    });
  }
  if (plan.format) {
    steps.push({
      label: "prettier --write",
      script: resolveDependencyBin("prettier"),
      args: ["--write", "--ignore-unknown", plan.absolute],
    });
  }

  let failed = false;
  for (const step of steps) {
    const result = runNode(step.script, step.args);
    if (result.status !== 0) {
      failed = true;
      console.error(`${step.label} reported problems in ${plan.absolute}:`);
      console.error(result.stdout);
      console.error(result.stderr);
    }
  }
  return failed ? 2 : 0;
}

/**
 * Format the file named in the payload on stdin.
 *
 * @returns {Promise<number>} The process exit code: 2 surfaces problems, 0 is quiet.
 */
export async function main() {
  const payload = await readPayload();
  const plan = planFor(readString(readKey(payload, "tool_input"), "file_path") ?? "");
  if (plan === null) {
    return 0;
  }
  return applyPlan(plan);
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
