// Command-shaped policy: what a Bash segment must never be allowed to do.
//
// These checks need a live tool call, not just a diff — they refuse a way of
// running a command (`--no-verify`, a bare `git push --force`, a workflow
// dispatch), which leaves no trace for a git-hook to see after the fact.
// This is why they live only in the Claude Code guard hook, and are not also
// wired into scripts/check-staged.mjs.
import { checkRead, checkWrite } from "./paths.mjs";
import { checkCredentials } from "./credentials.mjs";
import { isGateFile } from "./gates.mjs";
import {
  DELETE_COMMANDS,
  HOOK_BYPASS_ENV,
  PACKAGE_MANAGERS,
  PACKAGE_MANAGER_PASSTHROUGH,
  commandName,
  gitSubcommand,
  readFiles,
  segments,
  shortClusterHas,
  unwrapCommand,
  writtenFiles,
} from "./shell.mjs";

/**
 * Return a block reason when a git command bypasses the local gates.
 *
 * @param {readonly string[]} tokens - The segment's argv.
 * @returns {string | null} The reason, or null when the command is fine.
 */
export function checkGit(tokens) {
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
 * Return a block reason when a segment publishes a release.
 *
 * @param {readonly string[]} tokens - The segment's argv.
 * @returns {string | null} The reason, or null when nothing is being released.
 */
export function checkPublish(tokens) {
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
 * Return a block reason when a segment deletes a protected file.
 *
 * @param {readonly string[]} tokens - The segment's argv.
 * @returns {string | null} The reason, or null when nothing protected is removed.
 */
export function checkDeletion(tokens) {
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
