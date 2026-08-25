#!/usr/bin/env node
// Pre-commit gate: refuse a commit whose staged content is unsafe, from the
// git index alone — no tool call, no running agent.
//
// This is the third of the four layers described in AGENTS.md's
// "Enforcement layers": the Claude Code guard hook (.claude/hooks/guard.mjs)
// only ever sees what happens inside a Claude Code session; this script sees
// what actually reaches `git commit`, from any author — a human, Codex, or
// any other tool. It shares its rule engine with that hook
// (scripts/lib/guard/) so the two never drift out of sync, but it does not
// duplicate every rule the hook enforces:
//
//   - Lockfile hand-editing is guard.mjs-only. A regenerated lockfile
//     (`pnpm install`) is an ordinary, expected commit, and a git diff
//     cannot tell that apart from a hand edit — only a tool call that shows
//     which command produced the change can.
//   - `git commit --no-verify`, a bare force-push, and publish/workflow
//     dispatch are guard.mjs-only: none of them leave anything in a diff for
//     this script to see. `--no-verify` in particular disables this script
//     along with the rest of the hook chain, so no git hook can catch it —
//     the guard hook, which runs before the commit is even attempted, is the
//     only layer that can.
//
// What this script adds that the hook cannot: it also protects a commit made
// by a tool the guard hook was never wired into.
//
// Exit codes:
//   0  every staged change is safe to commit
//   1  a staged change was blocked
import { spawnSync } from "node:child_process";
import console from "node:console";
import process from "node:process";

import { checkCredentials } from "./lib/guard/credentials.mjs";
import { checkGateRemoval, isGateFile } from "./lib/guard/gates.mjs";
import { checkRead } from "./lib/guard/paths.mjs";
import { isolatedGitEnv } from "./lib/git-env.mjs";
import { isMain } from "./lib/is-main.mjs";
import { repoRoot } from "./lib/node-tools.mjs";

/**
 * One line of `git diff --cached --name-status`.
 *
 * @typedef {object} StagedChange
 * @property {string} status - The first letter of the status code (`A`,
 * `M`, `D`, `T`, `C` — renames are disabled, so `R` never appears).
 * @property {string} path - Path relative to the repository root.
 */

/**
 * Run git and return its stdout, throwing on a non-zero exit.
 *
 * @param {readonly string[]} args - Arguments after `git`.
 * @param {string} cwd - Repository to run git in.
 * @returns {string} Standard output.
 */
function git(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    // `cwd` names the repository, so an inherited GIT_DIR must not outrank it —
    // see scripts/lib/git-env.mjs. Under pre-commit the two agree; under a test
    // driving a fixture repository they do not.
    env: isolatedGitEnv(),
  });
  // `status` is null when git never ran or was killed — a missing binary, or
  // output past maxBuffer. Reporting "exited null" with an empty stderr would
  // tell the reader nothing about which of those happened.
  if (result.error !== undefined) {
    throw new Error(
      `ERR_GIT_UNAVAILABLE: git ${args.join(" ")} could not be run to completion.\n` +
        `Actual: ${result.error.message}\n` +
        "Next: check that git is on PATH and that the staged file is not larger than 32 MiB.",
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `ERR_GIT_FAILED: git ${args.join(" ")} exited ${String(result.status)}.\n` +
        `Actual: ${result.stderr}`,
    );
  }
  return result.stdout;
}

/**
 * List the changes currently staged for commit.
 *
 * @param {string} [cwd] - Repository to inspect; defaults to this repository.
 * @returns {StagedChange[]}
 */
export function stagedChanges(cwd = repoRoot) {
  const output = git(["diff", "--cached", "--name-status", "--no-renames", "-z"], cwd);
  /** @type {StagedChange[]} */
  const changes = [];
  const fields = output.split("\0").filter((field) => field !== "");
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const path = fields[index + 1];
    if (status === undefined || path === undefined) {
      continue;
    }
    changes.push({ status: status.charAt(0), path });
  }
  return changes;
}

/**
 * Read a staged file's content as it will be committed.
 *
 * @param {string} path - Path relative to the repository root.
 * @param {string} cwd - Repository the path is staged in.
 * @returns {string} The staged blob's content.
 */
function readStaged(path, cwd) {
  return git(["show", `:${path}`], cwd);
}

/**
 * Read a path's content at HEAD, or "" when it did not exist there.
 *
 * @param {string} path - Path relative to the repository root.
 * @param {string} cwd - Repository to read from.
 * @returns {string} The committed content, or an empty string for a new file.
 */
function readAtHead(path, cwd) {
  const result = spawnSync("git", ["show", `HEAD:${path}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: isolatedGitEnv(),
  });
  return result.status === 0 ? result.stdout : "";
}

/**
 * Check one staged change against every rule this script enforces.
 *
 * @param {StagedChange} change - One entry from {@link stagedChanges}.
 * @param {string} [cwd] - Repository the change is staged in; defaults to
 * this repository.
 * @returns {string | null} The block reason, or null when the change is safe.
 */
export function checkStagedChange(change, cwd = repoRoot) {
  if (change.status === "D") {
    if (isGateFile(change.path)) {
      return `Deleting ${change.path} removes a quality or supply-chain gate. That needs a human decision.`;
    }
    return null;
  }

  // Reuses the same .env*/secrets/** classification checkRead applies to an
  // agent's Read call — the rule is "this path is secret-shaped", independent
  // of who or what is about to expose it. Decided before the blob is read, so
  // a secret file's content is never pulled into this process to reach a
  // verdict the path alone already gives.
  if (checkRead(change.path) !== null) {
    return `${change.path} looks like it holds secrets and must not be committed. Add it to .gitignore instead, or commit a .example/.sample/.template variant.`;
  }

  const after = readStaged(change.path, cwd);

  const credentialReason = checkCredentials(after);
  if (credentialReason !== null) {
    return credentialReason;
  }

  const before = change.status === "A" ? "" : readAtHead(change.path, cwd);
  return checkGateRemoval(change.path, before, after);
}

/**
 * Check every staged change and report every violation found.
 *
 * @param {string} [cwd] - Repository to inspect; defaults to this repository.
 * @returns {number} The process exit code: 1 blocks the commit, 0 allows it.
 */
export function main(cwd = repoRoot) {
  let blocked = false;
  for (const change of stagedChanges(cwd)) {
    const reason = checkStagedChange(change, cwd);
    if (reason !== null) {
      console.error(`Blocked: ${reason}`);
      blocked = true;
    }
  }
  return blocked ? 1 : 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = main();
}
