#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import console from "node:console";
import { existsSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isMain } from "./lib/is-main.mjs";
import { parseJson, readKey, readString } from "./lib/json.mjs";

const TEMPLATE_ONLY_STATUS_CHECKS = existsSync(
  fileURLToPath(new URL("../docs/template-implementation", import.meta.url)),
)
  ? ["Bootstrap generated repositories"]
  : [];
const REQUIRED_STATUS_CHECKS = [
  "Static checks",
  "Test (Node 22.14.0)",
  "Test (Node 24)",
  "Package artifact",
  ...TEMPLATE_ONLY_STATUS_CHECKS,
  "Package smoke (ubuntu-latest)",
  "Package smoke (macos-latest)",
  "Package smoke (windows-latest)",
  "Workflow security lint",
  "Analyze JavaScript/TypeScript",
  "Spell check code and docs",
  "Validate the Conventional Commit prefix",
  "Review new dependencies",
];

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
    console.error(
      "ERR_GH_MISSING: gh is required for the repository settings check.\n" +
        "Expected: an installed GitHub CLI\n" +
        "Actual: command not found\n" +
        "Next: install gh, authenticate it, and rerun `pnpm repo:check`.",
    );
    return 2;
  }
  const auth = gh(["auth", "status"]);
  if (auth.status !== 0) {
    console.error(
      "ERR_GH_AUTH: gh is not authenticated.\n" +
        "Expected: read access to the configured GitHub repository\n" +
        `Actual: ${auth.stderr.trim() || `exit ${String(auth.status)}`}\n` +
        "Next: run `gh auth login`, then rerun `pnpm repo:check`.",
    );
    return 2;
  }
  const repositoryResult = gh(["repo", "view", "--json", "nameWithOwner"]);
  if (repositoryResult.status !== 0) {
    console.error(
      "ERR_GH_REPOSITORY: no readable GitHub remote was found.\n" +
        "Expected: a GitHub repository configured as a git remote\n" +
        `Actual: ${repositoryResult.stderr.trim() || `exit ${String(repositoryResult.status)}`}\n` +
        "Next: configure the repository remote, then rerun `pnpm repo:check`.",
    );
    return 2;
  }
  const repository = readString(parseJson(repositoryResult.stdout), "nameWithOwner");
  if (repository === undefined) {
    console.error(
      "ERR_GH_REPOSITORY_SHAPE: GitHub returned no nameWithOwner.\n" +
        "Expected: owner/repository\n" +
        "Actual: missing\n" +
        "Next: update gh and rerun `pnpm repo:check`.",
    );
    return 2;
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
    const pullRequestReviews = readKey(protection, "required_pull_request_reviews");
    expectSetting(
      "main requires pull-request review",
      true,
      pullRequestReviews !== undefined,
    );
    const approvingReviews = readKey(
      pullRequestReviews,
      "required_approving_review_count",
    );
    expectSetting(
      "main requires at least one approving review",
      true,
      typeof approvingReviews === "number" && approvingReviews >= 1,
    );
    const statusChecks = readKey(protection, "required_status_checks");
    expectSetting("main requires status checks", true, statusChecks !== undefined);
    const contextsValue = readKey(statusChecks, "contexts");
    const checksValue = readKey(statusChecks, "checks");
    const configuredChecks = new Set([
      ...(Array.isArray(contextsValue)
        ? contextsValue.filter((value) => typeof value === "string")
        : []),
      ...(Array.isArray(checksValue)
        ? checksValue
            .map((value) => readString(value, "context"))
            .filter((value) => value !== undefined)
        : []),
    ]);
    for (const requiredCheck of REQUIRED_STATUS_CHECKS) {
      expectSetting(
        `main requires status check "${requiredCheck}"`,
        true,
        configuredChecks.has(requiredCheck),
      );
    }
    expectSetting(
      "main requires conversation resolution",
      true,
      readKey(readKey(protection, "required_conversation_resolution"), "enabled"),
    );
    expectSetting(
      "main requires linear history",
      true,
      readKey(readKey(protection, "required_linear_history"), "enabled"),
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

    const environment = api(`repos/${repository}/environments/release`);
    const protectionRules = readKey(environment, "protection_rules");
    const reviewerRule = Array.isArray(protectionRules)
      ? /** @type {unknown[]} */ (protectionRules).find(
          (rule) => readString(rule, "type") === "required_reviewers",
        )
      : undefined;
    const reviewers = readKey(reviewerRule, "reviewers");
    expectSetting(
      "release environment requires a human reviewer",
      true,
      Array.isArray(reviewers) && reviewers.length > 0,
    );

    const workflowPermissions = api(`repos/${repository}/actions/permissions/workflow`);
    expectSetting(
      "GitHub Actions may create and approve pull requests",
      true,
      readKey(workflowPermissions, "can_approve_pull_request_reviews"),
    );

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
