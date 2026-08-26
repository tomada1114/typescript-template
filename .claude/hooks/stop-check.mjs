// Stop and SubagentStop hook: run the quick quality gate before the agent ends
// its turn.
//
// Claude Code fires `SubagentStop` when a delegated agent finishes, and a
// subagent edits the same working tree the main agent does. Wiring only `Stop`
// left work that a subagent finished and handed back ungated until the main
// agent happened to stop afterwards, so the same gate answers both events.
//
// Runs the same four tools as `pnpm check:quick`, with the same arguments, and
// only when the working tree actually contains changed TypeScript, JavaScript or
// package configuration. Exit code 2 blocks the stop and feeds the failures back
// so they get fixed before the turn is declared done.
//
// `tests/hooks.test.ts` asserts that {@link CHECKS} still spells out exactly
// what `check:quick` expands to. That test is what keeps this hook, the package
// script and CI from ever disagreeing about the same change.
//
// The wall-clock budget is the `timeout` on the Stop and SubagentStop entries
// in `.claude/settings.json`; a hook that times out cannot enforce the gate. If
// this template grows into a project whose test suite outgrows that budget,
// raise the timeout there rather than dropping a check from the list.
import { spawnSync } from "node:child_process";
import console from "node:console";
import process from "node:process";

import { isMain } from "../../scripts/lib/is-main.mjs";
import {
  repoRoot,
  resolveDependencyBin,
  runNode,
} from "../../scripts/lib/node-tools.mjs";
import { loadEvent } from "./payload.mjs";

/**
 * One command from `pnpm check:quick`.
 *
 * @typedef {object} Check
 * @property {string} package - Dependency that provides the executable.
 * @property {string} [bin] - Which `bin` entry to use, when there is more than one.
 * @property {string[]} args - Arguments, identical to the package script's.
 */

/**
 * The expansion of `check:quick`, in order.
 *
 * @type {readonly Check[]}
 */
export const CHECKS = [
  { package: "prettier", args: ["--check", "."] },
  { package: "eslint", args: [".", "--max-warnings", "0"] },
  { package: "typescript", bin: "tsc", args: ["-p", "tsconfig.json"] },
  { package: "vitest", args: ["run"] },
];

/**
 * Render a check the way `package.json` spells it, for comparison in tests.
 *
 * @param {Check} check - One entry of {@link CHECKS}.
 * @returns {string} The command line, e.g. `eslint . --max-warnings 0`.
 */
export function checkCommand(check) {
  return [check.bin ?? check.package, ...check.args].join(" ");
}

/** The events this hook answers; anything else exits without running a check. */
export const STOP_EVENTS = new Set(["Stop", "SubagentStop"]);

/** Extensions whose change means the gate has something to say. */
const WATCHED_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];

/** Configuration files that decide how the gate itself behaves. */
const WATCHED_FILES = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  ".prettierrc.json",
  ".prettierignore",
  "api-extractor.json",
]);

/** `tsconfig.json` and every variant of it. */
const TSCONFIG = /^tsconfig(?:\.[^/]+)?\.json$/;

/**
 * Report whether porcelain status output names a file this gate covers.
 *
 * @param {string} porcelain - Output of `git status --porcelain -uall`.
 * @returns {boolean} True when at least one changed path is in scope.
 */
export function hasRelevantChanges(porcelain) {
  for (const line of porcelain.split("\n")) {
    if (line.length <= 3) {
      continue;
    }
    // `XY path`, or `XY old -> new` for a rename; the new name is what matters.
    const raw = line.slice(3).split(" -> ").at(-1) ?? "";
    const filePath = raw.trim().replace(/^"|"$/g, "");
    const name = filePath.split("/").at(-1) ?? "";
    if (
      WATCHED_EXTENSIONS.some((extension) => filePath.endsWith(extension)) ||
      WATCHED_FILES.has(name) ||
      TSCONFIG.test(name)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Read the working tree status.
 *
 * @returns {string} Porcelain status output, or an empty string when git failed.
 */
function gitStatus() {
  const result = spawnSync("git", ["status", "--porcelain", "-uall"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  return result.status === 0 ? result.stdout : "";
}

/**
 * Run the quick gate unless this stop is already a hook-driven continuation.
 *
 * @returns {Promise<number>} The process exit code: 2 blocks the stop, 0 allows it.
 */
export async function main() {
  const event = await loadEvent();
  if (event.name === null || !STOP_EVENTS.has(event.name)) {
    return 0;
  }

  // A previous block already continued the turn once — never loop.
  if (event.stopHookActive) {
    return 0;
  }

  if (!hasRelevantChanges(gitStatus())) {
    return 0;
  }

  for (const check of CHECKS) {
    const result = runNode(resolveDependencyBin(check.package, check.bin), check.args);
    if (result.status !== 0) {
      console.error(`Quality gate failed (${checkCommand(check)}):`);
      console.error(result.stdout);
      console.error(result.stderr);
      console.error("Fix this, then run `pnpm check:quick` to confirm.");
      return 2;
    }
  }
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
