// PreToolUse hook: block edits to protected files and dangerous commands.
//
// This is one of three enforcement layers (see "Enforcement layers" in
// AGENTS.md): `.claude/settings.json`'s `permissions.deny` handles clean
// path/command matches declaratively; this hook catches the semantic cases a
// deny pattern cannot express reliably — the official Claude Code docs warn
// that Bash permission patterns constraining arguments are fragile (they
// won't tell `git commit` from `git commit --no-verify`, or see through an
// `&&` chain, an env-var prefix, or a wrapper). It fires even in
// bypassPermissions mode.
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
// Exit code 2 blocks the tool call and shows the reason to Claude.
import console from "node:console";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { isMain } from "../../scripts/lib/is-main.mjs";
import { readKey, readString } from "../../scripts/lib/json.mjs";
import { repoRoot } from "../../scripts/lib/node-tools.mjs";
import { checkBash } from "../../scripts/lib/guard/commands.mjs";
import { checkCredentials } from "../../scripts/lib/guard/credentials.mjs";
import { checkGateRemoval } from "../../scripts/lib/guard/gates.mjs";
import { checkRead, checkWrite } from "../../scripts/lib/guard/paths.mjs";
import { readPayload } from "./lib/payload.mjs";

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
 * Decide whether a pending tool call must be blocked.
 *
 * @param {unknown} payload - The hook payload read from stdin.
 * @returns {string | null} The block reason, or null when the call may proceed.
 */
export function evaluate(payload) {
  const toolName = readString(payload, "tool_name") ?? "";
  const toolInput = readKey(payload, "tool_input");
  const filePath = readString(toolInput, "file_path") ?? "";

  if (toolName === "Read") {
    return checkRead(filePath);
  }

  if (toolName === "Edit" || toolName === "Write") {
    const writeReason = checkWrite(filePath);
    if (writeReason !== null) {
      return writeReason;
    }
    const oldString = readString(toolInput, "old_string");
    const after =
      readString(toolInput, "new_string") ?? readString(toolInput, "content");
    if (after === undefined) {
      return null;
    }
    const credentialReason = checkCredentials(after);
    if (credentialReason !== null) {
      return credentialReason;
    }
    // An Edit says what it replaces; a Write replaces the whole file, so the
    // current content on disk is what it is being compared against. The path
    // is resolved against the repository root, the same base isGateFile uses,
    // so a relative path cannot be judged a gate file here and read from
    // somewhere else.
    const before = oldString ?? readIfPresent(path.resolve(repoRoot, filePath));
    return checkGateRemoval(filePath, before, after);
  }

  if (toolName === "Bash") {
    return checkBash(readString(toolInput, "command") ?? "");
  }

  return null;
}

/**
 * Inspect the pending tool call on stdin and block protected operations.
 *
 * @returns {Promise<number>} The process exit code: 2 blocks, 0 allows.
 */
export async function main() {
  const reason = evaluate(await readPayload());
  if (reason !== null) {
    console.error(`Blocked: ${reason}`);
    return 2;
  }
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
