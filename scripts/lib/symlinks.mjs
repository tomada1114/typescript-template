// Decide whether a path can be copied into a generated repository.
//
// `existsSync` follows symlinks, so it answers "absent" for a link whose target
// is gone — indistinguishable from a path that was never there. The template
// has such a link on purpose (`.agents/skills/merge-dependabot` bridges into
// `.claude/skills/**`), and a bridge that silently disappears from a generated
// repository is a bug in the template, not an optional file to skip.
//
// Both the copier (`scripts/bootstrap.mjs`) and the verifier
// (`scripts/verify-bootstrap.mjs`) ask this question and raise their own error
// types from the answer, so the predicate lives here rather than twice.
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The three states a candidate path can be in.
 *
 * @typedef {{ kind: "absent" }
 *   | { kind: "present" }
 *   | { kind: "dangling", target: string }} CopyPathState
 */

/**
 * Classify a path as absent, present, or a symlink pointing nowhere.
 *
 * @param {string} absolutePath - Path to classify.
 * @returns {CopyPathState} `absent` for a path that is not there at all,
 * `dangling` for a symlink whose target is missing, `present` otherwise.
 *
 * @example
 * ```js
 * const state = classifyCopyPath(path.join(root, relative));
 * if (state.kind === "dangling") {
 *   throw new Error(`ERR_BROKEN_SYMLINK: ... ${describeLinkTarget(state.target)}`);
 * }
 * ```
 */
export function classifyCopyPath(absolutePath) {
  let stat;
  try {
    stat = lstatSync(absolutePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { kind: "absent" };
    }
    throw error;
  }
  if (stat.isSymbolicLink() && !existsSync(absolutePath)) {
    return { kind: "dangling", target: readlinkSync(absolutePath) };
  }
  return { kind: "present" };
}

/**
 * Render a symlink target for an error message.
 *
 * @remarks
 * A link target is written by whoever created the link and may be an absolute
 * path into a home directory. AGENTS.md forbids automation from printing one,
 * so the home prefix collapses to `~`. A relative target — what this template's
 * own bridge uses — is already safe and passes through unchanged.
 *
 * @param {string} target - The target as `readlink` reports it.
 * @returns {string} The target with any home-directory prefix replaced by `~`.
 */
export function describeLinkTarget(target) {
  const home = os.homedir();
  if (home !== "" && (target === home || target.startsWith(`${home}${path.sep}`))) {
    return `~${target.slice(home.length)}`;
  }
  return target;
}
