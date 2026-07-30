// Read the JSON payload Claude Code writes to a hook's stdin.
//
// Every hook here starts the same way, and every one of them treats an
// unreadable payload as "nothing to say" rather than as a failure: a hook that
// cannot parse its input has no evidence of a problem, and refusing the tool
// call on that basis would block work for the wrong reason.
import process from "node:process";

import { parseJson } from "../../../scripts/lib/json.mjs";

/**
 * Read stdin to the end and parse it as JSON.
 *
 * @returns {Promise<unknown>} The parsed payload, or null when stdin held no
 * readable JSON document.
 */
export async function readPayload() {
  // Decoding in the stream keeps this to string concatenation. Chunks arrive
  // untyped from the iterator, and a Buffer round trip would only add a cast.
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
  }
  try {
    return parseJson(text);
  } catch {
    return null;
  }
}
