// Normalize Claude Code hook payloads.
//
// Claude file tools send one `tool_input.file_path`; a Bash call sends a
// `tool_input.command`. Hooks consume the Event below so payload details stay
// in one adapter instead of being re-parsed by every hook.
import path from "node:path";
import process from "node:process";

import { parseJson, readKey, readString } from "../../scripts/lib/json.mjs";

const SHELL_TOOLS = new Set(["bash"]);
const READ_TOOLS = new Set(["read"]);
const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit"]);

/**
 * @typedef {object} Event
 * @property {string | null} name
 * @property {"shell" | "read" | "edit" | "other" | null} tool
 * @property {string | null} toolName
 * @property {string | null} command
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
 * Build one normalized event from an already-parsed payload.
 *
 * @param {unknown} payload - Candidate hook payload.
 * @returns {Event} Normalized event.
 */
export function fromPayload(payload) {
  const toolInput = readKey(payload, "tool_input");
  const toolName = readString(payload, "tool_name") ?? null;
  const key = (toolName ?? "").toLowerCase();
  // `NotebookEdit` names its target `notebook_path`; every other file tool
  // uses `file_path`. Reading only the latter left a notebook edit with no
  // path at all, so the path rules had nothing to judge.
  const filePath =
    readString(toolInput, "file_path") ?? readString(toolInput, "notebook_path");
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
  const files = [];
  if (filePath !== undefined) {
    files.push(absolute(filePath, cwd));
  }

  return {
    name: readString(payload, "hook_event_name") ?? null,
    tool,
    toolName,
    command: tool === "shell" ? inputCommand : null,
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
