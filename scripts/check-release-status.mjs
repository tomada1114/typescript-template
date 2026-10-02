#!/usr/bin/env node
import console from "node:console";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { isMain } from "./lib/is-main.mjs";
import { parseJson, readKey, readString } from "./lib/json.mjs";
import { npmCliPath, repoRoot, runNode } from "./lib/node-tools.mjs";

/** Registry uncertainty must stop a release before any publish attempt. */
export class ReleaseStatusError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(
      `ERR_RELEASE_REGISTRY: ${message}\nExpected: the exact version or an explicit E404.\nNext: verify registry access and rerun release:status.`,
    );
    this.name = "ReleaseStatusError";
    this.code = "ERR_RELEASE_REGISTRY";
  }
}

/**
 * @param {import("./lib/node-tools.mjs").RunResult} result
 * @param {string} version
 * @returns {boolean}
 */
export function registryStatus(result, version) {
  /** @type {unknown} */
  let response;
  try {
    response = parseJson(result.stdout);
  } catch {
    throw new ReleaseStatusError("npm did not return a valid JSON response.");
  }
  if (result.status === 0 && response === version) {
    return true;
  }
  if (
    result.status !== 0 &&
    readString(readKey(response, "error"), "code") === "E404"
  ) {
    return false;
  }
  throw new ReleaseStatusError("npm could not establish whether the version exists.");
}

/**
 * @param {string} target
 * @param {string} registry
 * @returns {import("./lib/node-tools.mjs").RunResult}
 */
function queryRegistry(target, registry) {
  // Registry reads use npm independently of the repository's pnpm-only devEngines.
  const workspace = mkdtempSync(path.join(tmpdir(), "release-registry-"));
  try {
    writeFileSync(path.join(workspace, "package.json"), '{"private":true}\n');
    return runNode(
      npmCliPath(),
      ["view", target, "version", "--json", "--registry", registry],
      { cwd: workspace },
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/**
 * @param {readonly string[]} [argv]
 * @param {typeof queryRegistry} [query] - Registry subprocess boundary.
 * @param {string} [root]
 * @returns {number}
 */
export function main(argv = [], query = queryRegistry, root = repoRoot) {
  if (argv.length !== 0) {
    console.error(
      "ERR_RELEASE_ARGUMENT: release:status accepts no arguments.\nNext: run pnpm release:status.",
    );
    return 2;
  }
  try {
    const manifest = parseJson(readFileSync(path.join(root, "package.json"), "utf8"));
    const name = readString(manifest, "name");
    const version = readString(manifest, "version");
    const registry = readString(readKey(manifest, "publishConfig"), "registry");
    if (!name || !version || !registry) {
      throw new ReleaseStatusError(
        "package.json needs a package name, version, and publishConfig.registry.",
      );
    }
    const published = registryStatus(query(`${name}@${version}`, registry), version);
    const output = `published=${String(published)}\n`;
    const outputFile = process.env["GITHUB_OUTPUT"];
    if (outputFile !== undefined) {
      appendFileSync(outputFile, output);
    }
    console.log(output.trimEnd());
    return 0;
  } catch (error) {
    console.error(
      error instanceof ReleaseStatusError
        ? error.message
        : "ERR_RELEASE_STATUS: unable to inspect the manifest, query the registry, or record the result.\nNext: check the manifest, registry connection, and output-file permissions, then rerun release:status.",
    );
    return 1;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
