// Secret-shaped content: text that must never land in a tracked file.
//
// Shared by the Claude Code guard hook (text about to be written, or a raw
// shell command) and the pre-commit staged-content check (a staged file's
// content).

/**
 * Secret shapes that must never be written into a tracked file.
 *
 * @remarks
 * Each pattern is written so that its own source text does not match it, which
 * is what lets this file be edited by an agent that the guard is protecting.
 *
 * @type {{ pattern: RegExp, name: string }[]}
 */
export const CREDENTIAL_PATTERNS = [
  { pattern: /_authToken\s*=\s*\S/, name: "an npm registry auth token" },
  { pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/, name: "a private key" },
  { pattern: /\bnpm_[A-Za-z0-9]{36,}\b/, name: "an npm access token" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, name: "a GitHub token" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, name: "an AWS access key id" },
];

/**
 * Return a block reason when text carries a credential.
 *
 * @param {string} text - Content about to be written, or a shell command.
 * @returns {string | null} The reason, or null when nothing matched.
 */
export function checkCredentials(text) {
  if (text === "") {
    return null;
  }
  for (const { pattern, name } of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      return `This write looks like it embeds ${name}. Credentials belong in the environment or a secret store, never in a tracked file.`;
    }
  }
  return null;
}
