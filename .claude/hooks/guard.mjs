// PreToolUse hook: block edits to protected files and dangerous commands.
//
// This is one of four enforcement layers (see "Enforcement layers" in
// AGENTS.md). It is Claude Code-only: Codex CLI has no hook here, so for a
// Codex session `lefthook` and CI are the real gates instead.
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
// Exit code 2 blocks the tool call and shows the reason to the agent. Claude
// Code treats every *other* non-zero exit as a non-blocking error, so a guard
// that cannot start at all — a bad path, a missing Node, a syntax error — would
// let the call through. That is why `.claude/settings.json` runs this hook as
// `node … || exit 2`: the failure to decide is itself a block. The Stop hook is
// deliberately not wired that way, because a stop this hook can never allow is
// a turn that can never end.
import console from "node:console";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { repoRoot } from "../../scripts/lib/node-tools.mjs";
import { isMain } from "../../scripts/lib/is-main.mjs";
import { readKey, readString } from "../../scripts/lib/json.mjs";
import { checkBash } from "../../scripts/lib/guard/commands.mjs";
import { checkCredentials } from "../../scripts/lib/guard/credentials.mjs";
import { checkGateRemoval } from "../../scripts/lib/guard/gates.mjs";
import { checkRead, checkWrite } from "../../scripts/lib/guard/paths.mjs";
import { fromPayload, loadEvent } from "./payload.mjs";

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
 * Decide whether a normalized pending tool call must be blocked.
 *
 * @param {import("./payload.mjs").Event} event - Normalized hook event.
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
