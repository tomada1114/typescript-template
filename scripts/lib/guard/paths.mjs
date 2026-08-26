// Path-shaped rules: which files must never be read, written, or hand-edited.
//
// These are the checks that "which path is this" alone decides, independent
// of what a tool call is or what it carries. Shared by the agent guard
// hook (.claude/hooks/guard.mjs, which sees a pending tool call) and the
// pre-commit staged-content check (scripts/check-staged.mjs, which sees a
// git diff) — with the lockfile rule left out of the latter on purpose: a
// re-generated lockfile is normal to commit, and a git diff cannot tell that
// apart from a hand edit. Only a tool-call-aware caller can, so lockfile
// hand-editing stays a guard.mjs-only check (see checkWrite below).

/** Suffixes that mark a committed, secret-free sample of a `.env` file. */
export const ENV_EXAMPLE_SUFFIXES = [".example", ".sample", ".template"];

/** Lockfiles of every package manager, so a wrong-manager lockfile is caught too. */
export const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lockb",
]);

/**
 * Normalize a path the way the rules below expect to see it.
 *
 * @param {string} filePath - Path as it appeared in the tool call.
 * @returns {{ posix: string, name: string, parts: string[] }} Slash-separated
 * path, its basename, and its segments.
 */
export function describePath(filePath) {
  const posix = filePath.replace(/\\/g, "/");
  const parts = posix.split("/").filter((part) => part !== "" && part !== ".");
  return { posix, name: parts.at(-1) ?? "", parts };
}

/**
 * Report whether a `.env` file is a committed example rather than a real one.
 *
 * @param {string} name - Basename of the file.
 * @returns {boolean} True when the file is a sample and holds no secrets.
 */
export function isEnvExample(name) {
  return ENV_EXAMPLE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Return a block reason when a file must not be read.
 *
 * @param {string} filePath - Path the call targets.
 * @returns {string | null} The reason, or null when the read is fine.
 */
export function checkRead(filePath) {
  if (filePath === "") {
    return null;
  }
  const { name, parts } = describePath(filePath);
  if ((name === ".env" || name.startsWith(".env.")) && !isEnvExample(name)) {
    return "Files named .env* may hold secrets and must not be read by the agent — read the matching .env.example instead.";
  }
  if (parts.slice(0, -1).includes("secrets")) {
    return "Files under secrets/ hold credentials and must not be read by the agent.";
  }
  return null;
}

/**
 * Return a block reason when a file must not be hand-edited.
 *
 * @remarks
 * The lockfile rule here is intent-based ("this call hand-edits the
 * lockfile"), which only a tool-call-aware caller can see — a `pnpm install`
 * regenerating the same file produces an indistinguishable diff. Do not call
 * this from a staged-content checker for that reason; see the module remark.
 *
 * @param {string} filePath - Path the call targets.
 * @returns {string | null} The reason, or null when the write is fine.
 */
export function checkWrite(filePath) {
  if (filePath === "") {
    return null;
  }
  const { name, parts } = describePath(filePath);
  if (LOCKFILES.has(name)) {
    return `${name} is generated — run \`pnpm install\`, \`pnpm add\` or \`pnpm update\` instead of editing it.`;
  }
  // Matched on any segment, not only the first: Claude Code sends an absolute
  // file_path, so the repository's own `.git` never is the first segment of a
  // real tool call. `.github` is a different name and stays editable.
  if (parts.includes(".git")) {
    return "The Git plumbing under .git/ is not edited by automation — a hook or config written there silently replaces the pre-commit enforcement layer for every later commit. Install hooks with `pnpm hooks:install`.";
  }
  if (name === "settings.local.json" && parts.at(-2) === ".claude") {
    return ".claude/settings.local.json holds personal permission grants, so an agent editing it would be granting itself permissions — that is a human edit; ask.";
  }
  // A read block is also a write block: the write-side counterpart of the
  // Read(/.env) and Read(/secrets/**) deny rules in .claude/settings.json.
  // Those are anchored to the settings file and cannot carry the
  // .env.example exception, which is why the rest of the .env.* family is
  // this layer's alone; this layer matches by path shape, so it holds from
  // any cwd.
  const readReason = checkRead(filePath);
  if (readReason !== null) {
    return readReason.replace("read by the agent", "written by the agent");
  }
  return null;
}
