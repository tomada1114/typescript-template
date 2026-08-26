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
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { findPlaceholders } from "./bootstrap.mjs";
import { isolatedGitEnv } from "./lib/git-env.mjs";
import { isMain } from "./lib/is-main.mjs";
import { classifyCopyPath, describeLinkTarget } from "./lib/symlinks.mjs";
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

const MARKER_FILES = [
  "AGENTS.md",
  "README.md",
  "tests/AGENTS.md",
  ".github/workflows/ci.yml",
];

/**
 * Check the lightweight, observable output of one bootstrap run.
 *
 * @param {string} destination
 * @param {string} profile
 * @param {string} packageName
 */
function assertGenerated(destination, profile, packageName) {
  const placeholders = findPlaceholders(destination, packageName);
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

  for (const relative of [
    "docs/template-requirements",
    "docs/template-implementation",
  ]) {
    if (existsSync(path.join(destination, relative))) {
      throw new Error(
        `ERR_TEMPLATE_PATH_REMAINING: generated ${packageName} retains ${relative}.`,
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
  if (profile === "node-cli" && readKey(manifest, "bin") === undefined) {
    throw new Error(`ERR_CLI_PROFILE: generated ${packageName} has no bin entry.`);
  }
  if (profile !== "node-cli" && readKey(manifest, "bin") !== undefined) {
    throw new Error(`ERR_NON_CLI_PROFILE: generated ${packageName} has a bin entry.`);
  }
  if (packageName === "zukai" && readKey(manifest, "dependencies") !== undefined) {
    throw new Error(
      "ERR_ZUKAI_RUNTIME_DEPENDENCIES: generated zukai must have zero runtime dependencies.",
    );
  }
}

/**
 * Report whether a source path belongs in the copy set, refusing a symlink that
 * points nowhere rather than skipping it as absent.
 *
 * @param {string} source
 * @param {string} relative
 * @returns {boolean}
 */
function isCopyableSource(source, relative) {
  const state = classifyCopyPath(source);
  if (state.kind === "dangling") {
    throw new Error(
      `ERR_BROKEN_SYMLINK: Link: ${relative}\n` +
        "Expected: the symlink target to exist.\n" +
        `Actual: missing target ${describeLinkTarget(state.target)}.\n` +
        "Next: restore the target or remove the link, then rerun `pnpm run bootstrap:e2e`.",
    );
  }
  return state.kind === "present";
}

/**
 * @param {string} destination
 */
function copyTemplate(destination) {
  const files = spawnSync(
    "git",
    ["-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8", timeout: 30_000, env: isolatedGitEnv() },
  );
  if (files.status !== 0) {
    throw new Error(`ERR_GIT_FILES: ${files.stderr.trim()}`);
  }
  for (const relative of files.stdout.split("\0").filter(Boolean)) {
    const source = path.join(ROOT, relative);
    if (!isCopyableSource(source, relative)) {
      continue;
    }
    const target = path.join(destination, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    // A symlink (`.agents/skills/merge-dependabot` bridges into
    // `.claude/skills/**`) must be recreated as a symlink, not followed —
    // copyFileSync resolves it to the directory it points at and fails.
    if (lstatSync(source).isSymbolicLink()) {
      symlinkSync(readlinkSync(source), target);
      continue;
    }
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
      ["node-cli", "acme-node-cli"],
      ["universal-library", "acme-universal-library"],
      ["node-cli", "zukai"],
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
      assertGenerated(destination, profile, packageName);
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
