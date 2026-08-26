// Normalize hook payloads from Claude Code and Codex CLI.
//
// Claude file tools send one `tool_input.file_path`; Codex sends an
// `apply_patch` command that may name several files. Hooks consume the Event
// below so host-specific payload details stay in one adapter.
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseJson, readKey, readString } from "../../scripts/lib/json.mjs";

const SHELL_TOOLS = new Set(["bash", "shell"]);
const READ_TOOLS = new Set(["read"]);
const EDIT_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "apply_patch",
]);

const PATCH_HEADER = /^\*\*\* (Add File|Update File|Delete File):\s*(\S.*?)\s*$/gm;
const PATCH_MOVE = /^\*\*\* Move to:\s*(\S.*?)\s*$/m;

/**
 * @typedef {object} PatchFile
 * @property {"add" | "update" | "delete"} action
 * @property {string} path
 * @property {string | null} destination
 * @property {string} body
 */

/**
 * @typedef {object} Event
 * @property {string | null} name
 * @property {"shell" | "read" | "edit" | "other" | null} tool
 * @property {string | null} toolName
 * @property {string | null} command
 * @property {string | null} patch
 * @property {string[]} files
 * @property {string} cwd
 * @property {boolean} stopHookActive
 * @property {unknown} raw
 */

/**
 * Resolve a payload path without trusting a host-specific root variable.
 *
 * @param {string} value - Absolute or event-cwd-relative path.
 * @param {string} base - Event working directory.
 * @returns {string} Absolute normalized path.
 */
function absolute(value, base) {
  return path.normalize(path.isAbsolute(value) ? value : path.join(base, value));
}

/**
 * Parse the file sections in a Codex apply_patch command.
 *
 * @param {string} patch - The patch from `tool_input.command`.
 * @param {string} base - Event working directory.
 * @returns {PatchFile[]} Sections in command order.
 */
export function patchFiles(patch, base) {
  const matches = [...patch.matchAll(PATCH_HEADER)];
  return matches.map((match, index) => {
    const label = match[1] ?? "";
    const source = absolute(match[2] ?? "", base);
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? patch.indexOf("*** End Patch", start);
    const body = patch.slice(start, end < 0 ? patch.length : end).replace(/^\r?\n/, "");
    const move = PATCH_MOVE.exec(body)?.[1];
    return {
      action:
        label === "Add File" ? "add" : label === "Delete File" ? "delete" : "update",
      path: source,
      destination: move === undefined ? null : absolute(move, base),
      body,
    };
  });
}

/**
 * Build one host-neutral event from an already-parsed payload.
 *
 * @param {unknown} payload - Candidate hook payload.
 * @returns {Event} Normalized event.
 */
export function fromPayload(payload) {
  const toolInput = readKey(payload, "tool_input");
  const toolName = readString(payload, "tool_name") ?? null;
  const key = (toolName ?? "").toLowerCase();
  const filePath = readString(toolInput, "file_path");
  const inputCommand = readString(toolInput, "command") ?? null;

  /** @type {Event["tool"]} */
  let tool = null;
  if (SHELL_TOOLS.has(key)) {
    tool = "shell";
  } else if (READ_TOOLS.has(key)) {
    tool = "read";
  } else if (EDIT_TOOLS.has(key) || filePath !== undefined) {
    tool = "edit";
  } else if (toolName !== null) {
    tool = "other";
  }

  const cwd = readString(payload, "cwd") ?? process.cwd();
  const patch = key === "apply_patch" ? inputCommand : null;
  const files = [];
  if (filePath !== undefined) {
    files.push(absolute(filePath, cwd));
  }
  if (patch !== null) {
    for (const file of patchFiles(patch, cwd)) {
      files.push(file.path);
      if (file.destination !== null) {
        files.push(file.destination);
      }
    }
  }

  return {
    name: readString(payload, "hook_event_name") ?? null,
    tool,
    toolName,
    command: tool === "shell" ? inputCommand : null,
    patch,
    files: [...new Set(files)],
    cwd,
    stopHookActive: readKey(payload, "stop_hook_active") === true,
    raw: payload,
  };
}

/** @returns {Event} An event that every hook treats as harmless. */
function emptyEvent() {
  return {
    name: null,
    tool: null,
    toolName: null,
    command: null,
    patch: null,
    files: [],
    cwd: process.cwd(),
    stopHookActive: false,
    raw: null,
  };
}

/**
 * Read and normalize one hook payload.
 *
 * @param {NodeJS.ReadableStream} [stream] - Hook stdin by default.
 * @returns {Promise<Event>} An empty event when the payload is unreadable.
 */
export async function loadEvent(stream = process.stdin) {
  stream.setEncoding("utf8");
  let text = "";
  try {
    for await (const chunk of stream) {
      text += String(chunk);
    }
    return fromPayload(parseJson(text));
  } catch {
    return emptyEvent();
  }
}

/**
 * Resolve the project root from the shared hook directory itself.
 *
 * @param {string} importMetaUrl - The calling hook's `import.meta.url`.
 * @returns {string} Project root, git top level, or the working directory.
 */
export function projectRoot(importMetaUrl) {
  let directory = path.dirname(fileURLToPath(importMetaUrl));
  for (;;) {
    const hooks = path.join(directory, ".agents", "hooks");
    if (existsSync(hooks) && statSync(hooks).isDirectory()) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
    return root === "" ? process.cwd() : root;
  } catch {
    return process.cwd();
  }
}
