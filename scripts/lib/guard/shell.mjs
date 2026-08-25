// Pure shell lexing: split a command line into segments and pull facts out
// of one segment's argv (which command it runs, which files it touches).
// Nothing here decides policy — that lives in commands.mjs, which is the
// only module that imports this one for a "should this be blocked" answer.
import path from "node:path";

/** git global options that consume the following token (`git -C dir push …`). */
export const GIT_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
]);

/** Environment assignments that turn the local hooks off for one command. */
export const HOOK_BYPASS_ENV =
  /^(?:LEFTHOOK|HUSKY|SKIP_SIMPLE_GIT_HOOKS)=(?:0|false|off)$/i;

/** Commands whose last file argument is the destination they write. */
export const DEST_LAST_COMMANDS = new Set(["cp", "mv", "install", "rsync"]);

/** Commands that open every file argument for reading. */
export const READ_COMMANDS = new Set([
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
export const DELETE_COMMANDS = new Set(["rm", "unlink", "shred", "trash"]);

/** Package manager front-ends whose `publish` subcommand ships a release. */
export const PACKAGE_MANAGERS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "pnpx",
  "bun",
  "bunx",
]);

/** Wrappers to look through when identifying the command a segment runs. */
export const COMMAND_WRAPPERS = new Set([
  "sudo",
  "command",
  "corepack",
  "time",
  "env",
  "nice",
]);

/** Subcommands after which a package manager still takes a further subcommand. */
export const PACKAGE_MANAGER_PASSTHROUGH = new Set([
  "run",
  "run-script",
  "exec",
  "dlx",
  "--",
]);

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
export function gitSubcommand(tokens) {
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
 * Strip environment assignments and wrappers off the front of a segment.
 *
 * @param {readonly string[]} tokens - The segment's argv.
 * @returns {string[]} The argv of the command actually being run.
 */
export function unwrapCommand(tokens) {
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
export function commandName(token) {
  return path.posix.basename(token.replace(/\\/g, "/")).replace(/@.+$/, "");
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
