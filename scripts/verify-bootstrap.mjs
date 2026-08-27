#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import console from "node:console";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { findPlaceholders } from "./bootstrap.mjs";
import { isolatedGitEnv } from "./lib/git-env.mjs";
import { isMain } from "./lib/is-main.mjs";
import { parseJson, readKey } from "./lib/json.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LEGACY_RELEASE_DIRECTORY = ".change" + "set";

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 */
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "inherit",
    timeout: 900_000,
    // Every command here runs against a throwaway workspace, so none of them
    // may inherit a hook's GIT_DIR — see scripts/lib/git-env.mjs.
    env: isolatedGitEnv(),
  });
  if (result.status !== 0) {
    throw new Error(
      `ERR_BOOTSTRAP_E2E: ${command} ${args.join(" ")} failed with exit ${String(result.status)}.`,
    );
  }
}

const MARKER_FILES = ["AGENTS.md", "README.md", ".github/workflows/ci.yml"];

/**
 * Check the lightweight, observable output of one bootstrap run.
 *
 * @param {string} destination
 * @param {string} packageName
 */
function assertGenerated(destination, packageName) {
  const placeholders = findPlaceholders(destination);
  if (placeholders.length > 0) {
    throw new Error(
      `ERR_PLACEHOLDER_REMAINING: generated ${packageName} still contains placeholders.\n` +
        placeholders.join("\n"),
    );
  }

  for (const relative of MARKER_FILES) {
    const file = path.join(destination, relative);
    if (
      /(?:template-only|profile:[a-z0-9-]+:)/.exec(readFileSync(file, "utf8")) !== null
    ) {
      throw new Error(
        `ERR_BOOTSTRAP_MARKER: generated ${packageName} retains a bootstrap marker in ${relative}.`,
      );
    }
  }

  if (existsSync(path.join(destination, LEGACY_RELEASE_DIRECTORY))) {
    throw new Error(
      `ERR_RELEASE_INTENT_PATH_REMAINING: generated ${packageName} retains the legacy release directory.`,
    );
  }

  const manifest = parseJson(
    readFileSync(path.join(destination, "package.json"), "utf8"),
  );
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error(
      `ERR_MANIFEST_SHAPE: generated ${packageName} has no object manifest.`,
    );
  }
  if (readKey(manifest, "name") !== packageName) {
    throw new Error(`ERR_PACKAGE_NAME: generated package name is not ${packageName}.`);
  }
  if (readKey(manifest, "bin") !== undefined) {
    throw new Error(
      "ERR_BIN_REMAINING: generated package still declares package.json#bin.\n" +
        "Expected: no bin entry in either remaining profile.\n" +
        "Next: remove bin metadata from the template, then rerun bootstrap:e2e.",
    );
  }
  if (readKey(manifest, "sideEffects") !== false) {
    throw new Error(
      "ERR_SIDE_EFFECTS_REMAINING: generated package does not declare sideEffects as false.\n" +
        "Expected: sideEffects: false in both remaining profiles.\n" +
        "Next: update the template manifest, then rerun bootstrap:e2e.",
    );
  }
  if (packageName === "zukai" && readKey(manifest, "dependencies") !== undefined) {
    throw new Error(
      "ERR_ZUKAI_RUNTIME_DEPENDENCIES: generated zukai must have zero runtime dependencies.",
    );
  }
}

/**
 * Decide whether a path `git ls-files` reported is safe to copy.
 *
 * `git`'s own untracked-file walk already keeps a genuine socket or FIFO out
 * of the list this guards (`git add`/`ls-files --others` silently drop them),
 * so in practice only a stale index entry or a tracked symlink reach here —
 * but the check is written against "not a regular file" rather than
 * "is a symlink" so it also holds if that git behavior ever changes, or a
 * caller feeds it a path some other way.
 *
 * @param {string} source - Absolute path on disk.
 * @param {string} relative - Repository-relative path, used in the error.
 * @returns {boolean} `true` when `source` is a regular file to copy, `false`
 * when it is a stale index entry to skip.
 */
export function assertCopyable(source, relative) {
  /** @type {import("node:fs").Stats} */
  let stats;
  try {
    stats = lstatSync(source);
  } catch (error) {
    // `git ls-files` lists a path that a later `rm` removed but no commit
    // recorded yet; that is a stale entry, not a file to copy.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (stats.isFile()) {
    return true;
  }
  throw new Error(
    `ERR_BOOTSTRAP_UNSUPPORTED_ENTRY: ${relative} is not a regular file.\n` +
      "Expected: a regular file, so the copy faithfully reproduces the source tree.\n" +
      `Actual: ${stats.isSymbolicLink() ? "a symlink" : "a socket, FIFO, or device entry"}.\n` +
      "Next: replace it with a real file, or remove it from git, then rerun bootstrap:e2e.",
  );
}

/**
 * Copy every file `git ls-files` reports from `root` into `destination`,
 * preserving relative paths.
 *
 * @param {string} destination
 * @param {string} [root] - Repository root to copy from. Defaults to this
 * template's own checkout.
 */
export function copyTemplate(destination, root = ROOT) {
  const files = spawnSync(
    "git",
    ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8", timeout: 30_000, env: isolatedGitEnv() },
  );
  if (files.status !== 0) {
    throw new Error(`ERR_GIT_FILES: ${files.stderr.trim()}`);
  }
  for (const relative of files.stdout.split("\0").filter(Boolean)) {
    const source = path.join(root, relative);
    if (!assertCopyable(source, relative)) {
      continue;
    }
    const target = path.join(destination, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

/**
 * @returns {number}
 */
export function main() {
  const workspace = mkdtempSync(path.join(tmpdir(), "typescript-template-e2e-"));
  try {
    const cases = [
      ["node-library", "acme-node-library"],
      ["universal-library", "acme-universal-library"],
      ["node-library", "zukai"],
    ];
    for (const [profile, packageName] of cases) {
      if (profile === undefined || packageName === undefined) {
        throw new Error("ERR_E2E_CASE: malformed bootstrap test case.");
      }
      const destination = path.join(workspace, packageName);
      mkdirSync(destination);
      copyTemplate(destination);
      run(
        process.execPath,
        [
          "scripts/bootstrap.mjs",
          packageName,
          "--profile",
          profile,
          "--author",
          "Ada Lovelace",
          "--email",
          "ada@example.com",
          "--github-user",
          "ada",
          "--license",
          "MIT",
        ],
        destination,
      );
      assertGenerated(destination, packageName);
      console.log(`bootstrap-e2e: ${packageName} (${profile}) passed`);
    }
    return 0;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = main();
}
