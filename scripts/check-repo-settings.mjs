#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import console from "node:console";
import process from "node:process";

import { isMain } from "./lib/is-main.mjs";
import { parseJson, readKey, readString } from "./lib/json.mjs";

/**
 * @param {string[]} args
 * @returns {{status: number, stdout: string, stderr: string, missing: boolean}}
 */
function gh(args) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    missing:
      result.error !== undefined &&
      "code" in result.error &&
      result.error.code === "ENOENT",
  };
}

/**
 * @param {string} endpoint
 * @returns {unknown}
 */
function api(endpoint) {
  const result = gh(["api", endpoint]);
  if (result.status !== 0) {
    throw new Error(
      `ERR_GH_API: ${endpoint} failed.\nActual: ${result.stderr.trim() || `exit ${String(result.status)}`}`,
    );
  }
  return parseJson(result.stdout);
}

/**
 * @returns {number}
 */
export function main() {
  const version = gh(["--version"]);
  if (version.missing) {
    console.log("repo-settings: skipped (gh is not installed).");
    return 0;
  }
  const auth = gh(["auth", "status"]);
  if (auth.status !== 0) {
    console.log("repo-settings: skipped (gh is not authenticated).");
    return 0;
  }
  const repositoryResult = gh(["repo", "view", "--json", "nameWithOwner"]);
  if (repositoryResult.status !== 0) {
    console.log("repo-settings: skipped (no readable GitHub remote was found).");
    return 0;
  }
  const repository = readString(parseJson(repositoryResult.stdout), "nameWithOwner");
  if (repository === undefined) {
    console.log("repo-settings: skipped (GitHub remote has no nameWithOwner).");
    return 0;
  }

  /** @type {string[]} */
  const differences = [];
  /**
   * @param {string} label
   * @param {unknown} expected
   * @param {unknown} actual
   */
  const expectSetting = (label, expected, actual) => {
    if (actual !== expected) {
      differences.push(
        `${label}\n  Expected: ${String(expected)}\n  Actual: ${String(actual)}`,
      );
    }
  };

  try {
    const protection = api(`repos/${repository}/branches/main/protection`);
    expectSetting(
      "main requires pull-request review",
      true,
      readKey(protection, "required_pull_request_reviews") !== undefined,
    );
    expectSetting(
      "main requires status checks",
      true,
      readKey(protection, "required_status_checks") !== undefined,
    );
    expectSetting(
      "main force-push is disabled",
      false,
      readKey(readKey(protection, "allow_force_pushes"), "enabled"),
    );
    expectSetting(
      "main deletion is disabled",
      false,
      readKey(readKey(protection, "allow_deletions"), "enabled"),
    );

    const repositorySettings = api(`repos/${repository}`);
    const security = readKey(repositorySettings, "security_and_analysis");
    expectSetting(
      "secret scanning is enabled",
      "enabled",
      readString(readKey(security, "secret_scanning"), "status"),
    );
    expectSetting(
      "secret scanning push protection is enabled",
      "enabled",
      readString(readKey(security, "secret_scanning_push_protection"), "status"),
    );

    const environment = gh(["api", `repos/${repository}/environments/release`]);
    expectSetting("release environment exists", 0, environment.status);

    const reporting = gh([
      "api",
      `repos/${repository}/private-vulnerability-reporting`,
    ]);
    expectSetting("private vulnerability reporting is enabled", 0, reporting.status);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (differences.length > 0) {
    console.error(
      `ERR_REPOSITORY_SETTINGS_DRIFT: ${String(differences.length)} setting(s) differ.\n${differences.join("\n")}\nNext: review docs/maintainer-checklist.md and update the settings manually.`,
    );
    return 1;
  }
  console.log(`repo-settings: ${repository} matches the checked security baseline.`);
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = main();
}
