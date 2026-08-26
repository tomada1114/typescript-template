// PreToolUse hook: block edits to protected files and dangerous commands.
//
// This is one of four enforcement layers (see "Enforcement layers" in
// AGENTS.md). Claude Code also has declarative `permissions.deny` rules; Codex
// CLI has no project-level equivalent, so this hook enforces those path and
// command rules for every supported local tool path on both hosts.
//
// Bash commands are split on shell control operators and each segment's argv
// is inspected on its own, so a flag in one command can neither trigger nor
// excuse a block for another. Static inspection stays best-effort: it catches
// the plain spellings an agent reaches for, not every shell construction. A
// command hidden behind `eval`, a variable, or a here-document will get
// through, which is why CI and branch protection remain the real gates.
//
// The rule engine itself lives in scripts/lib/guard/ and is shared with
// scripts/check-staged.mjs (the pre-commit layer, which sees a git diff
// instead of a pending tool call and so cannot enforce everything this hook
// does — see that script's own header for the split).
//
// Exit code 2 blocks the tool call and shows the reason to the agent. Both
// hosts treat every *other* non-zero exit as a non-blocking error, so a guard
// that cannot start at all — a bad path, a missing Node, a syntax error — would
// let the call through. That is why both host configurations run this hook as
// `node … || exit 2`: the failure to decide is itself a block. The Stop hook is
// deliberately not wired that way, because a stop this hook can never allow is
// a turn that can never end.
import console from "node:console";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { isMain } from "../../scripts/lib/is-main.mjs";
import { readKey, readString } from "../../scripts/lib/json.mjs";
import { checkBash } from "../../scripts/lib/guard/commands.mjs";
import { checkCredentials } from "../../scripts/lib/guard/credentials.mjs";
import { checkGateRemoval, isGateFile } from "../../scripts/lib/guard/gates.mjs";
import { checkRead, checkWrite } from "../../scripts/lib/guard/paths.mjs";
import { fromPayload, loadEvent, patchFiles, projectRoot } from "./hook_payload.mjs";

const repoRoot = projectRoot(import.meta.url);

/**
 * Read a file that may not exist.
 *
 * @param {string} filePath - Path to read.
 * @returns {string} The file's content, or an empty string when unreadable.
 */
function readIfPresent(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Extract the content added or removed by one apply_patch file section.
 *
 * @param {string} body - Section body.
 * @param {"+" | "-"} prefix - Which side to collect.
 * @returns {string} Joined patch lines without the prefix.
 */
function patchSide(body, prefix) {
  return body
    .split("\n")
    .filter(
      (line) =>
        line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`),
    )
    .map((line) => line.slice(1))
    .join("\n");
}

/**
 * Apply the textual hunks from one update section to current file content.
 *
 * @param {string} current - Current file contents.
 * @param {string} body - apply_patch section body.
 * @returns {string | null} Simulated result, or null when a hunk cannot match.
 */
function applyUpdate(current, body) {
  let result = current;
  const hunks = body.split(/^@@.*$/m);
  for (const hunk of hunks) {
    const lines = hunk
      .split("\n")
      .filter(
        (line) => line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"),
      );
    const before = lines
      .filter((line) => line.startsWith(" ") || line.startsWith("-"))
      .map((line) => line.slice(1))
      .join("\n");
    const after = lines
      .filter((line) => line.startsWith(" ") || line.startsWith("+"))
      .map((line) => line.slice(1))
      .join("\n");
    if (before === "") {
      if (after !== "") {
        result = `${result}\n${after}`;
      }
      continue;
    }
    const index = result.indexOf(before);
    if (index < 0) {
      return null;
    }
    result = `${result.slice(0, index)}${after}${result.slice(index + before.length)}`;
  }
  return result;
}

/**
 * Inspect all file sections in a Codex apply_patch command.
 *
 * @param {import("./hook_payload.mjs").Event} event - Normalized edit event.
 * @returns {string | null} Block reason, or null when the patch may proceed.
 */
function checkPatch(event) {
  if (event.patch === null) {
    return null;
  }
  for (const file of patchFiles(event.patch, event.cwd)) {
    for (const candidate of [file.path, file.destination]) {
      if (candidate === null) {
        continue;
      }
      const writeReason = checkWrite(candidate);
      if (writeReason !== null) {
        return writeReason;
      }
    }
    if (
      (file.action === "delete" || file.destination !== null) &&
      isGateFile(file.path)
    ) {
      return `Deleting or moving ${path.relative(repoRoot, file.path)} removes a quality or supply-chain gate and needs a human decision.`;
    }

    const added = patchSide(file.body, "+");
    const credentialReason = checkCredentials(added);
    if (credentialReason !== null) {
      return credentialReason;
    }

    const current = file.action === "add" ? "" : readIfPresent(file.path);
    const simulated =
      file.action === "add"
        ? added
        : file.action === "delete"
          ? ""
          : applyUpdate(current, file.body);
    if (simulated !== null) {
      const gateReason = checkGateRemoval(file.path, current, simulated);
      if (gateReason !== null) {
        return gateReason;
      }
    } else {
      const removed = patchSide(file.body, "-");
      const gateReason = checkGateRemoval(file.path, removed, added);
      if (gateReason !== null) {
        return gateReason;
      }
      if (removed !== "" && isGateFile(file.path)) {
        return `This patch changes ${path.relative(repoRoot, file.path)}, but its result could not be verified for gate preservation; split or rebase the patch and try again.`;
      }
    }
  }
  return null;
}

/**
 * Decide whether a normalized pending tool call must be blocked.
 *
 * @param {import("./hook_payload.mjs").Event} event - Normalized hook event.
 * @returns {string | null} The block reason, or null when the call may proceed.
 */
function evaluateEvent(event) {
  if (event.tool === "read") {
    for (const file of event.files) {
      const reason = checkRead(file);
      if (reason !== null) {
        return reason;
      }
    }
    return null;
  }

  if (event.tool === "shell") {
    return checkBash(event.command ?? "");
  }

  if (event.tool !== "edit") {
    return null;
  }

  const patchReason = checkPatch(event);
  if (patchReason !== null || event.patch !== null) {
    return patchReason;
  }

  const toolInput = readKey(event.raw, "tool_input");
  const filePath = readString(toolInput, "file_path") ?? "";
  const writeReason = checkWrite(filePath);
  if (writeReason !== null) {
    return writeReason;
  }
  const oldString = readString(toolInput, "old_string");
  const after = readString(toolInput, "new_string") ?? readString(toolInput, "content");
  if (after === undefined) {
    return null;
  }
  const credentialReason = checkCredentials(after);
  if (credentialReason !== null) {
    return credentialReason;
  }
  const before = oldString ?? readIfPresent(path.resolve(repoRoot, filePath));
  return checkGateRemoval(filePath, before, after);
}

/**
 * Decide whether a pending tool call must be blocked.
 *
 * @param {unknown} payload - The hook payload read from stdin.
 * @returns {string | null} The block reason, or null when the call may proceed.
 */
export function evaluate(payload) {
  return evaluateEvent(fromPayload(payload));
}

/**
 * Inspect the pending tool call on stdin and block protected operations.
 *
 * @returns {Promise<number>} The process exit code: 2 blocks, 0 allows.
 */
export async function main() {
  const event = await loadEvent();
  if (event.name !== "PreToolUse") {
    return 0;
  }
  const reason = evaluateEvent(event);
  if (reason !== null) {
    console.error(`Blocked: ${reason}`);
    return 2;
  }
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
