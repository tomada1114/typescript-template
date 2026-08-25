// PreToolUse hook: block edits to protected files and dangerous commands.
//
// `.claude/settings.json`'s `permissions.deny` is a hard block in every mode,
// including bypassPermissions — it is not advisory. It is still fragile for
// constraining Bash arguments, though: the official Claude Code docs warn
// that a deny pattern cannot tell `git commit` from `git commit --no-verify`,
// does not see through an `&&` chain, and a wrapper like `sh -c '…'` defeats
// it entirely. This hook exists for exactly those semantic cases, and fires
// even in bypassPermissions mode.
//
// Bash commands are split on shell control operators and each segment's argv is
// inspected on its own, so a flag in one command can neither trigger nor excuse
// a block for another. Static inspection stays best-effort: it catches the plain
// spellings an agent reaches for, not every shell construction. A command hidden
// behind `eval`, a variable, or a here-document will get through, which is why
// CI and branch protection remain the real gates.
//
// Exit code 2 blocks the tool call and shows the reason to Claude.
import console from "node:console";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { isMain } from "../../scripts/lib/is-main.mjs";
import { readKey, readString } from "../../scripts/lib/json.mjs";
import { repoRoot } from "../../scripts/lib/node-tools.mjs";
import { readPayload } from "./lib/payload.mjs";

/** Suffixes that mark a committed, secret-free sample of a `.env` file. */
const ENV_EXAMPLE_SUFFIXES = [".example", ".sample", ".template"];

/** Lockfiles of every package manager, so a wrong-manager lockfile is caught too. */
const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lockb",
]);

/** git global options that consume the following token (`git -C dir push …`). */
const GIT_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
]);

/** Environment assignments that turn the local hooks off for one command. */
const HOOK_BYPASS_ENV = /^(?:LEFTHOOK|HUSKY|SKIP_SIMPLE_GIT_HOOKS)=(?:0|false|off)$/i;

/** Commands whose last file argument is the destination they write. */
const DEST_LAST_COMMANDS = new Set(["cp", "mv", "install", "rsync"]);

/** Commands that open every file argument for reading. */
const READ_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "bat",
  "nl",
  "od",
  "xxd",
  "strings",
  "base64",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "sed",
  "awk",
  "cut",
  "sort",
  "uniq",
  "wc",
  "cp",
  "mv",
  "source",
  ".",
  "dotenv",
]);

/** Commands that remove files. */
const DELETE_COMMANDS = new Set(["rm", "unlink", "shred", "trash"]);

/** Package manager front-ends whose `publish` subcommand ships a release. */
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "npx", "pnpx", "bun", "bunx"]);

/** Wrappers to look through when identifying the command a segment runs. */
const COMMAND_WRAPPERS = new Set([
  "sudo",
  "command",
  "corepack",
  "time",
  "env",
  "nice",
]);

/** Subcommands after which a package manager still takes a further subcommand. */
const PACKAGE_MANAGER_PASSTHROUGH = new Set(["run", "run-script", "exec", "dlx", "--"]);

/**
 * Files whose contents are a quality or supply-chain gate.
 *
 * @remarks
 * Gate-removal detection only runs on these paths. Restricting it this way is
 * what keeps a word like "audit" from tripping the guard when it appears in
 * prose inside a Markdown document.
 */
const GATE_FILES = [
  /^\.github\/workflows\/[^/]+\.ya?ml$/,
  /^\.github\/dependabot\.yml$/,
  /^\.github\/zizmor\.yml$/,
  /^eslint\.config\.mjs$/,
  /^vitest\.config\.ts$/,
  /^pnpm-workspace\.yaml$/,
  /^package\.json$/,
  /^tsconfig(?:\.[^/]+)?\.json$/,
  /^api-extractor\.json$/,
  /^lefthook\.yml$/,
  /^\.claude\/settings\.json$/,
  /^\.claude\/hooks\/(?:[^/]+\/)*[^/]+\.mjs$/,
];

/**
 * Markers whose disappearance from a gate file means a gate was removed.
 *
 * @type {{ pattern: RegExp, name: string }[]}
 */
const GATE_MARKERS = [
  { pattern: /--frozen-lockfile/, name: "the frozen-lockfile install" },
  { pattern: /--max-warnings\s+0/, name: "the zero-warning lint budget" },
  { pattern: /reportUnusedDisableDirectives/, name: "the unused-disable check" },
  { pattern: /minimumReleaseAge/, name: "the dependency cooldown" },
  { pattern: /strictDepBuilds/, name: "the lifecycle-script allowlist" },
  { pattern: /strictPeerDependencies/, name: "the peer dependency check" },
  { pattern: /^\s*permissions:/m, name: "a workflow's least-privilege permissions" },
  { pattern: /thresholds/, name: "the coverage thresholds" },
  { pattern: /publint/, name: "the publint gate" },
  { pattern: /check-attw|arethetypeswrong/, name: "the type-resolution gate" },
  { pattern: /codeql/i, name: "the CodeQL analysis" },
  { pattern: /zizmor/, name: "the workflow security audit" },
  { pattern: /persist-credentials/, name: "the checkout credential hardening" },
];

/** The coverage floor that spec 02 §3.3 fixes; the guard refuses to see it lowered. */
const COVERAGE_FLOOR = 80;

/** Coverage threshold assignments, as written in vitest.config.ts. */
const COVERAGE_THRESHOLD = /\b(lines|functions|statements|branches)\s*:\s*(\d+)/g;

/**
 * Secret shapes that must never be written into a tracked file.
 *
 * @remarks
 * Each pattern is written so that its own source text does not match it, which
 * is what lets this file be edited by an agent that the guard is protecting.
 *
 * @type {{ pattern: RegExp, name: string }[]}
 */
const CREDENTIAL_PATTERNS = [
  { pattern: /_authToken\s*=\s*\S/, name: "an npm registry auth token" },
  { pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/, name: "a private key" },
  { pattern: /\bnpm_[A-Za-z0-9]{36,}\b/, name: "an npm access token" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, name: "a GitHub token" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, name: "an AWS access key id" },
];

/**
 * Normalize a path the way the rules below expect to see it.
 *
 * @param {string} filePath - Path as it appeared in the tool call.
 * @returns {{ posix: string, name: string, parts: string[] }} Slash-separated
 * path, its basename, and its segments.
 */
function describePath(filePath) {
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
function isEnvExample(name) {
  return ENV_EXAMPLE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Return a block reason when a file must not be read by the agent.
 *
 * @param {string} filePath - Path the tool call targets.
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
 * @param {string} filePath - Path the tool call targets.
 * @returns {string | null} The reason, or null when the write is fine.
 */
export function checkWrite(filePath) {
  if (filePath === "") {
    return null;
  }
  const { name } = describePath(filePath);
  if (LOCKFILES.has(name)) {
    return `${name} is generated — run \`pnpm install\`, \`pnpm add\` or \`pnpm update\` instead of editing it.`;
  }
  // A read block is also a write block: the write-side counterpart of the
  // Read(.env)/Read(secrets/**) deny rules in .claude/settings.json.
  const readReason = checkRead(filePath);
  if (readReason !== null) {
    return readReason.replace("read by the agent", "written by the agent");
  }
  return null;
}

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

/**
 * Resolve a path to repo-relative POSIX form for matching against
 * {@link GATE_FILES}.
 *
 * @remarks
 * An absolute `filePath` — which a real Claude Edit/Write call routinely
 * carries — resolves the same way regardless of the base, since
 * `path.resolve` discards a relative base once the path being resolved is
 * already absolute. Without this resolution step, an absolute-path edit of a
 * gate file silently skipped gate-removal detection: `/^package\.json$/`
 * never matches `/Users/x/repo/package.json`.
 *
 * @param {string} filePath - Path the call targets, absolute or relative.
 * @returns {string} Path relative to the repository root, POSIX-separated.
 */
function toRepoRelative(filePath) {
  const absolute = path.resolve(repoRoot, filePath.replace(/\\/g, "/"));
  return path.relative(repoRoot, absolute).split(path.sep).join("/");
}

/**
 * Report whether a path is one of the files that hold a quality gate.
 *
 * @param {string} filePath - Path the tool call targets.
 * @returns {boolean} True when gate-removal rules apply to this file.
 */
function isGateFile(filePath) {
  const relative = toRepoRelative(filePath);
  return GATE_FILES.some((pattern) => pattern.test(relative));
}

/**
 * Return a block reason when an edit strips a gate out of a gate file.
 *
 * @param {string} filePath - Path the tool call targets.
 * @param {string} before - Text being replaced, or the file's current content.
 * @param {string} after - Text replacing it.
 * @returns {string | null} The reason, or null when every gate survives.
 */
export function checkGateRemoval(filePath, before, after) {
  if (!isGateFile(filePath)) {
    return null;
  }
  // The reported path is the repo-relative one: a real call carries an
  // absolute path, and an error an agent reads must never echo a home
  // directory back out.
  const relative = toRepoRelative(filePath);
  for (const { pattern, name } of GATE_MARKERS) {
    if (pattern.test(before) && !pattern.test(after)) {
      return `This edit removes ${name} from ${relative}. Weakening a quality or supply-chain gate needs a human decision, not an agent edit.`;
    }
  }
  for (const match of after.matchAll(COVERAGE_THRESHOLD)) {
    const value = Number(match[2]);
    if (value < COVERAGE_FLOOR) {
      return `This edit sets the ${String(match[1])} coverage threshold to ${String(value)}, below the ${String(COVERAGE_FLOOR)}% floor. Add tests instead of lowering the floor.`;
    }
  }
  return null;
}

/**
 * Split a shell command into one argv array per command segment.
 *
 * @remarks
 * Quoting is honoured while splitting, so a control operator inside a quoted
 * string — `git commit -m "a && b"` — does not start a new segment. Redirection
 * characters are left inside the token, exactly as a POSIX word splitter would
 * leave them, because {@link writtenFiles} reads them back out.
 *
 * @param {string} command - The full command line from the tool call.
 * @returns {string[][]} One argv array per segment, empties dropped.
 */
export function segments(command) {
  /** @type {string[][]} */
  const result = [];
  /** @type {string[]} */
  let tokens = [];
  let current = "";
  let started = false;
  let quote = "";

  const flushToken = () => {
    if (started) {
      tokens.push(current);
      current = "";
      started = false;
    }
  };
  const flushSegment = () => {
    flushToken();
    if (tokens.length > 0) {
      result.push(tokens);
      tokens = [];
    }
  };

  // A backslash-newline is a line continuation, not two tokens.
  const source = command.replace(/\\\n/g, " ");
  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index);

    if (quote !== "") {
      if (char === quote) {
        quote = "";
      } else if (quote === '"' && char === "\\" && index + 1 < source.length) {
        index += 1;
        current += source.charAt(index);
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\" && index + 1 < source.length) {
      index += 1;
      current += source.charAt(index);
      started = true;
      continue;
    }
    if (char === "&" || char === "|") {
      // `&&` and `||` separate the same way their single-character forms do.
      if (source.charAt(index + 1) === char) {
        index += 1;
      }
      flushSegment();
      continue;
    }
    if (char === ";" || char === "\n") {
      flushSegment();
      continue;
    }
    if (/\s/.test(char)) {
      flushToken();
      continue;
    }
    current += char;
    started = true;
  }
  flushSegment();

  return result;
}

/**
 * Report whether a clustered short-option argument contains a flag.
 *
 * @remarks
 * Characters after an option that takes a value (`-am"msg"`) are that option's
 * value rather than further flags, so scanning stops there.
 *
 * @param {string} arg - One argv entry.
 * @param {string} flag - The single-letter flag to look for.
 * @param {string} valueOptions - Letters whose option consumes a value.
 * @returns {boolean} True when the cluster sets the flag.
 */
export function shortClusterHas(arg, flag, valueOptions) {
  if (arg === "-" || !arg.startsWith("-") || arg.startsWith("--")) {
    return false;
  }
  for (const char of arg.slice(1)) {
    if (char === flag) {
      return true;
    }
    if (valueOptions.includes(char)) {
      return false;
    }
  }
  return false;
}

/**
 * Identify the git subcommand a segment runs.
 *
 * @param {readonly string[]} tokens - The segment's argv.
 * @returns {{ subcommand: string, args: string[] } | null} The subcommand and
 * its arguments, or null when the segment does not run git.
 */
function gitSubcommand(tokens) {
  const gitIndex = tokens.indexOf("git");
  if (gitIndex === -1) {
    return null;
  }
  const rest = tokens.slice(gitIndex + 1);
  let skipValue = false;
  for (const [index, token] of rest.entries()) {
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (GIT_VALUE_OPTIONS.has(token)) {
      skipValue = true;
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return { subcommand: token, args: rest.slice(index + 1) };
  }
  return null;
}

/**
 * Return a block reason when a git command bypasses the local gates.
 *
 * @param {readonly string[]} tokens - The segment's argv.
 * @returns {string | null} The reason, or null when the command is fine.
 */
function checkGit(tokens) {
  const parsed = gitSubcommand(tokens);
  if (parsed === null) {
    return null;
  }
  const { subcommand, args } = parsed;

  if (tokens.some((token) => HOOK_BYPASS_ENV.test(token))) {
    return "Disabling the Git hooks through the environment skips the same checks as --no-verify — fix the failing hook instead.";
  }

  // For commit, -m/-F/-C/-c/-t consume a value; -n anywhere else is --no-verify.
  if (subcommand === "commit") {
    if (
      args.includes("--no-verify") ||
      args.some((arg) => shortClusterHas(arg, "n", "mFCct"))
    ) {
      return "git commit --no-verify skips the pre-commit hooks — fix the failing hook instead.";
    }
  }

  if (subcommand === "push") {
    if (args.includes("--no-verify")) {
      return "git push --no-verify skips the pre-push gate — run `pnpm check:quick` and fix what it reports.";
    }
    // For push, -o consumes a value; -f anywhere in a cluster forces.
    const forced =
      args.includes("--force") || args.some((arg) => shortClusterHas(arg, "f", "o"));
    const withLease = args.some(
      (arg) => arg === "--force-with-lease" || arg.startsWith("--force-with-lease="),
    );
    if (forced && !withLease) {
      return "Plain force-push is blocked — use `git push --force-with-lease` if a force-push is really needed, and ask a human first.";
    }
  }

  return null;
}

/**
 * Strip environment assignments and wrappers off the front of a segment.
 *
 * @param {readonly string[]} tokens - The segment's argv.
 * @returns {string[]} The argv of the command actually being run.
 */
function unwrapCommand(tokens) {
  let rest = [...tokens];
  while (rest.length > 0) {
    const head = rest[0] ?? "";
    // `FOO=bar cmd` and `sudo cmd` both hide the real command one token further.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head) || COMMAND_WRAPPERS.has(head)) {
      rest = rest.slice(1);
      continue;
    }
    break;
  }
  return rest;
}

/**
 * Reduce a command word to the name it would be invoked by.
 *
 * @param {string} token - The first argv entry of a segment.
 * @returns {string} Basename with any `@version` suffix removed.
 */
function commandName(token) {
  return path.posix.basename(token.replace(/\\/g, "/")).replace(/@.+$/, "");
}

/**
 * Return a block reason when a segment publishes a release.
 *
 * @param {readonly string[]} tokens - The segment's argv.
 * @returns {string | null} The reason, or null when nothing is being released.
 */
function checkPublish(tokens) {
  const argv = unwrapCommand(tokens);
  const head = argv[0];
  if (head === undefined) {
    return null;
  }
  const name = commandName(head);

  if (PACKAGE_MANAGERS.has(name)) {
    // Look past `run`/`exec` so `pnpm run publish` is caught with `pnpm publish`.
    let rest = argv.slice(1).filter((arg) => !arg.startsWith("-"));
    while (rest.length > 0 && PACKAGE_MANAGER_PASSTHROUGH.has(rest[0] ?? "")) {
      rest = rest.slice(1);
    }
    if (rest[0] === "publish") {
      return `${name} publish releases to the registry. Publishing runs from the release workflow with trusted publishing, never from a local shell.`;
    }
  }

  if (name === "gh") {
    const argsAfterGh = argv.slice(1).filter((arg) => !arg.startsWith("-"));
    const [first, second] = argsAfterGh;
    if (first === "workflow" && second === "run") {
      return "Dispatching a workflow from here can start a release. Ask a human to run it from the GitHub UI.";
    }
    if (first === "release" && second === "create") {
      return "Creating a GitHub release is part of publishing — the release workflow does it, not the agent.";
    }
    if (first === "api" && argsAfterGh.some((arg) => arg.includes("/dispatches"))) {
      return "Dispatching a workflow through the API can start a release. Ask a human to run it from the GitHub UI.";
    }
  }

  return null;
}

/**
 * Best-effort list of files a command segment writes to.
 *
 * @param {readonly string[]} tokens - The segment's argv.
 * @returns {string[]} Paths the segment appears to write.
 */
export function writtenFiles(tokens) {
  /** @type {string[]} */
  const targets = [];
  for (const [index, token] of tokens.entries()) {
    if (/^\d?>>?$/.test(token)) {
      const next = tokens[index + 1];
      if (next !== undefined) {
        targets.push(next);
      }
      continue;
    }
    const attached = /^\d?>>?(.+)$/.exec(token);
    if (attached?.[1] !== undefined) {
      targets.push(attached[1]);
    }
  }

  const argv = unwrapCommand(tokens);
  const head = argv[0];
  if (head === undefined) {
    return targets;
  }
  const name = commandName(head);
  const args = argv.slice(1);
  const fileArgs = args.filter((arg) => !arg.startsWith("-"));

  if (DEST_LAST_COMMANDS.has(name) && fileArgs.length > 0) {
    targets.push(fileArgs[fileArgs.length - 1] ?? "");
  } else if (
    name === "tee" ||
    name === "truncate" ||
    (name === "sed" && args.some((arg) => arg.startsWith("-i")))
  ) {
    targets.push(...fileArgs);
  } else if (name === "dd") {
    targets.push(
      ...args.filter((arg) => arg.startsWith("of=")).map((arg) => arg.slice(3)),
    );
  }
  return targets;
}

/**
 * Best-effort list of files a command segment reads.
 *
 * @param {readonly string[]} tokens - The segment's argv.
 * @returns {string[]} Paths the segment appears to open for reading.
 */
export function readFiles(tokens) {
  /** @type {string[]} */
  const targets = [];
  for (const [index, token] of tokens.entries()) {
    if (token === "<") {
      const next = tokens[index + 1];
      if (next !== undefined) {
        targets.push(next);
      }
      continue;
    }
    if (token.startsWith("<") && token.length > 1 && !token.startsWith("<<")) {
      targets.push(token.slice(1));
    }
  }

  const argv = unwrapCommand(tokens);
  const head = argv[0];
  if (head === undefined) {
    return targets;
  }
  if (READ_COMMANDS.has(commandName(head))) {
    // A search pattern is indistinguishable from a path here. Treating one as a
    // path only ever costs a false positive on a pattern that spells a secret.
    targets.push(...argv.slice(1).filter((arg) => !arg.startsWith("-")));
  }
  return targets;
}

/**
 * Return a block reason when a segment deletes a protected file.
 *
 * @param {readonly string[]} tokens - The segment's argv.
 * @returns {string | null} The reason, or null when nothing protected is removed.
 */
function checkDeletion(tokens) {
  const argv = unwrapCommand(tokens);
  const head = argv[0];
  if (head === undefined) {
    return null;
  }
  const name = commandName(head);
  const parsed = gitSubcommand(tokens);
  const isDelete = DELETE_COMMANDS.has(name) || parsed?.subcommand === "rm";
  if (!isDelete) {
    return null;
  }
  const args = parsed?.subcommand === "rm" ? parsed.args : argv.slice(1);
  for (const arg of args.filter((entry) => !entry.startsWith("-"))) {
    if (isGateFile(arg)) {
      return `Deleting ${arg} removes a quality or supply-chain gate. That needs a human decision.`;
    }
    const writeReason = checkWrite(arg);
    if (writeReason !== null) {
      return writeReason;
    }
  }
  return null;
}

/**
 * Return a block reason when a shell command trips any guard.
 *
 * @param {string} command - The full command line from the tool call.
 * @returns {string | null} The reason, or null when the command is allowed.
 */
export function checkBash(command) {
  const credentialReason = checkCredentials(command);
  if (credentialReason !== null) {
    return credentialReason;
  }
  for (const tokens of segments(command)) {
    const reason =
      checkGit(tokens) ?? checkPublish(tokens) ?? checkDeletion(tokens) ?? null;
    if (reason !== null) {
      return reason;
    }
    for (const target of writtenFiles(tokens)) {
      const writeReason = checkWrite(target);
      if (writeReason !== null) {
        return writeReason;
      }
    }
    for (const target of readFiles(tokens)) {
      const readReason = checkRead(target);
      if (readReason !== null) {
        return readReason;
      }
    }
  }
  return null;
}

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
