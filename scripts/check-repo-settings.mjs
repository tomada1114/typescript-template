#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import console from "node:console";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isMain } from "./lib/is-main.mjs";
import { parseJson, readKey, readString } from "./lib/json.mjs";

const CI_WORKFLOW_SOURCE = readFileSync(
  fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url)),
  "utf8",
);

// This repository's own ci.yml still runs the "Bootstrap generated
// repositories" job inside a `# template-only:start`/`# template-only:end`
// block; a generated repository has that block stripped out by bootstrap, so
// reading the job name out of ci.yml directly tells the two apart without
// depending on any other template-only path's existence.
const TEMPLATE_ONLY_STATUS_CHECKS = CI_WORKFLOW_SOURCE.includes(
  "Bootstrap generated repositories",
)
  ? ["Bootstrap generated repositories"]
  : [];

/**
 * The workflow job names `main`'s branch protection (or the ruleset that
 * replaces it) must require, byte-for-byte. `tests/workflows.test.ts` derives
 * this same list from the workflow sources — job `name:` values, expanded
 * across `strategy.matrix` — and asserts it matches exactly, so a renamed job
 * or a name this list has not caught up with fails there instead of only
 * showing up as silent branch-protection drift.
 */
export const REQUIRED_STATUS_CHECKS = [
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
 * Call the GitHub API, treating an HTTP 404 as "not found" rather than a
 * failure. Legacy branch protection and the code-scanning default-setup
 * endpoint both 404 when the feature simply is not configured, which is a
 * meaningful answer here, not an error to abort on. Any other failure — a
 * token without the permission, a 5xx, no network — is still raised, so an
 * unreadable setting is never reported as a disabled one.
 *
 * @param {string} endpoint
 * @returns {{found: true, stdout: string} | {found: false}}
 */
function requestOrNotFound(endpoint) {
  const result = gh(["api", endpoint]);
  if (result.status === 0) {
    return { found: true, stdout: result.stdout };
  }
  if (result.stderr.includes("HTTP 404")) {
    return { found: false };
  }
  throw new Error(
    `ERR_GH_API: ${endpoint} failed.\nActual: ${result.stderr.trim() || `exit ${String(result.status)}`}`,
  );
}

/**
 * {@link requestOrNotFound} with the body parsed.
 *
 * @param {string} endpoint
 * @returns {{found: true, body: unknown} | {found: false}}
 */
function apiOrNotFound(endpoint) {
  const result = requestOrNotFound(endpoint);
  return result.found
    ? { found: true, body: parseJson(result.stdout) }
    : { found: false };
}

/**
 * Whether an endpoint that answers through presence alone reports its feature
 * as enabled: 204 with no body when it is on, 404 when it is off.
 *
 * @param {string} endpoint
 * @returns {boolean}
 */
function apiPresence(endpoint) {
  return requestOrNotFound(endpoint).found;
}

/**
 * A single reported drift: what was expected, and what the repository
 * actually has.
 *
 * @typedef {(label: string, expected: unknown, actual: unknown) => void} ExpectSetting
 */

/**
 * Evaluate legacy branch-protection settings for `main`.
 *
 * @param {unknown} protection
 * @param {ExpectSetting} expectSetting
 * @returns {void}
 */
function evaluateLegacyProtection(protection, expectSetting) {
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
  checkRequiredStatusChecks(configuredChecks, expectSetting);
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
}

/**
 * @param {Set<string>} configuredChecks
 * @param {ExpectSetting} expectSetting
 * @returns {void}
 */
function checkRequiredStatusChecks(configuredChecks, expectSetting) {
  for (const requiredCheck of REQUIRED_STATUS_CHECKS) {
    expectSetting(
      `main requires status check "${requiredCheck}"`,
      true,
      configuredChecks.has(requiredCheck),
    );
  }
}

/**
 * @param {unknown} summary
 * @returns {boolean}
 */
function isActiveBranchRuleset(summary) {
  return (
    readString(summary, "target") === "branch" &&
    readString(summary, "enforcement") === "active"
  );
}

/**
 * @param {unknown} detail
 * @returns {boolean}
 */
function targetsMainBranch(detail) {
  const refName = readKey(readKey(detail, "conditions"), "ref_name");
  const include = readKey(refName, "include");
  const exclude = readKey(refName, "exclude");
  const includesMain =
    Array.isArray(include) &&
    include.some(
      (value) =>
        value === "~ALL" || value === "~DEFAULT_BRANCH" || value === "refs/heads/main",
    );
  const excludesMain =
    Array.isArray(exclude) &&
    exclude.some((value) => value === "~DEFAULT_BRANCH" || value === "refs/heads/main");
  return includesMain && !excludesMain;
}

/**
 * @param {unknown[]} rules
 * @param {string} type
 * @returns {boolean}
 */
function hasRuleType(rules, type) {
  return rules.some((rule) => readString(rule, "type") === type);
}

/**
 * @param {unknown[]} rules
 * @param {string} type
 * @returns {unknown}
 */
function ruleParameters(rules, type) {
  const rule = rules.find((rule) => readString(rule, "type") === type);
  return readKey(rule, "parameters");
}

/**
 * Evaluate the rules of every active ruleset that targets `main`, as an
 * alternative to legacy branch protection.
 *
 * @param {unknown[]} rules
 * @param {ExpectSetting} expectSetting
 * @returns {void}
 */
function evaluateRulesetRules(rules, expectSetting) {
  expectSetting(
    "main requires pull-request review",
    true,
    hasRuleType(rules, "pull_request"),
  );
  const pullRequestParameters = ruleParameters(rules, "pull_request");
  const approvingReviews = readKey(
    pullRequestParameters,
    "required_approving_review_count",
  );
  expectSetting(
    "main requires at least one approving review",
    true,
    typeof approvingReviews === "number" && approvingReviews >= 1,
  );
  expectSetting(
    "main requires conversation resolution",
    true,
    readKey(pullRequestParameters, "required_review_thread_resolution"),
  );

  expectSetting(
    "main requires status checks",
    true,
    hasRuleType(rules, "required_status_checks"),
  );
  const statusCheckParameters = ruleParameters(rules, "required_status_checks");
  const requiredChecksValue = readKey(statusCheckParameters, "required_status_checks");
  const configuredChecks = new Set(
    Array.isArray(requiredChecksValue)
      ? requiredChecksValue
          .map((value) => readString(value, "context"))
          .filter((value) => value !== undefined)
      : [],
  );
  checkRequiredStatusChecks(configuredChecks, expectSetting);

  expectSetting(
    "main requires linear history",
    true,
    hasRuleType(rules, "required_linear_history"),
  );
  // A ruleset's `non_fast_forward` rule is what disallows a force-push.
  expectSetting(
    "main force-push is disabled",
    true,
    hasRuleType(rules, "non_fast_forward"),
  );
  // A ruleset's `deletion` rule is what disallows deleting the branch.
  expectSetting("main deletion is disabled", true, hasRuleType(rules, "deletion"));
}

/**
 * Collect the rules of every active, `main`-targeting ruleset and evaluate
 * them as the ruleset alternative to legacy branch protection.
 *
 * @param {string} repository
 * @param {ExpectSetting} expectSetting
 * @returns {void}
 */
function checkRulesetProtection(repository, expectSetting) {
  const rulesets = api(`repos/${repository}/rulesets`);
  const summaries = Array.isArray(rulesets) ? rulesets : [];
  const candidates = summaries.filter(isActiveBranchRuleset);

  /** @type {unknown[]} */
  const rules = [];
  for (const summary of candidates) {
    const id = readKey(summary, "id");
    if (typeof id !== "number") {
      continue;
    }
    // `repos/{repo}/rulesets` includes rulesets inherited from the
    // organization, and the repository-scoped detail endpoint 404s on those
    // ids. Skipping them keeps the rest of the branch-protection group
    // running instead of aborting it, which is the whole point of this file.
    const detail = apiOrNotFound(`repos/${repository}/rulesets/${String(id)}`);
    if (!detail.found || !targetsMainBranch(detail.body)) {
      continue;
    }
    const detailRules = readKey(detail.body, "rules");
    if (Array.isArray(detailRules)) {
      /** @type {unknown[]} */
      const detailRulesArray = detailRules;
      rules.push(...detailRulesArray);
    }
  }

  expectSetting(
    "main is protected by a branch-protection rule or an active ruleset",
    true,
    rules.length > 0,
  );
  evaluateRulesetRules(rules, expectSetting);
}

/**
 * @param {string} repository
 * @param {ExpectSetting} expectSetting
 * @returns {void}
 */
function checkBranchProtection(repository, expectSetting) {
  const legacy = apiOrNotFound(`repos/${repository}/branches/main/protection`);
  if (legacy.found) {
    evaluateLegacyProtection(legacy.body, expectSetting);
    return;
  }
  checkRulesetProtection(repository, expectSetting);
}

/**
 * @param {unknown} repositorySettings the `repos/{owner}/{repo}` body
 * @param {ExpectSetting} expectSetting
 * @returns {void}
 */
function checkSecurityAnalysis(repositorySettings, expectSetting) {
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
  expectSetting(
    "secret scanning non-provider patterns are enabled",
    "enabled",
    readString(readKey(security, "secret_scanning_non_provider_patterns"), "status"),
  );
  expectSetting(
    "secret scanning validity checks are enabled",
    "enabled",
    readString(readKey(security, "secret_scanning_validity_checks"), "status"),
  );
  expectSetting(
    "Dependabot security updates are enabled",
    "enabled",
    readString(readKey(security, "dependabot_security_updates"), "status"),
  );
}

/**
 * Dependabot vulnerability alerts, which the API reports through presence
 * rather than a body: 204 when enabled, 404 when disabled.
 *
 * @param {string} repository
 * @param {ExpectSetting} expectSetting
 * @returns {void}
 */
function checkVulnerabilityAlerts(repository, expectSetting) {
  expectSetting(
    "Dependabot vulnerability alerts are enabled",
    true,
    apiPresence(`repos/${repository}/vulnerability-alerts`),
  );
}

/**
 * @param {string} repository
 * @param {ExpectSetting} expectSetting
 * @returns {void}
 */
function checkCodeScanningDefaultSetup(repository, expectSetting) {
  const result = apiOrNotFound(`repos/${repository}/code-scanning/default-setup`);
  const state = result.found ? readString(result.body, "state") : undefined;
  expectSetting("CodeQL default setup is configured", "configured", state);
}

/**
 * @param {unknown} repositorySettings the `repos/{owner}/{repo}` body
 * @param {ExpectSetting} expectSetting
 * @returns {void}
 */
function checkMergeButtons(repositorySettings, expectSetting) {
  expectSetting(
    "main branch merges use squash or rebase only (no merge commits)",
    false,
    readKey(repositorySettings, "allow_merge_commit"),
  );
  expectSetting(
    "branches are deleted automatically after merge",
    true,
    readKey(repositorySettings, "delete_branch_on_merge"),
  );
  expectSetting(
    "auto-merge is enabled for pull requests",
    true,
    readKey(repositorySettings, "allow_auto_merge"),
  );
}

/**
 * @param {string} repository
 * @param {ExpectSetting} expectSetting
 * @returns {void}
 */
function checkReleaseEnvironment(repository, expectSetting) {
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
}

/**
 * @param {string} repository
 * @param {ExpectSetting} expectSetting
 * @returns {void}
 */
function checkWorkflowPermissions(repository, expectSetting) {
  const workflowPermissions = api(`repos/${repository}/actions/permissions/workflow`);
  expectSetting(
    "GitHub Actions default workflow token permissions are read-only",
    "read",
    readString(workflowPermissions, "default_workflow_permissions"),
  );
  expectSetting(
    "GitHub Actions may create and approve pull requests",
    true,
    readKey(workflowPermissions, "can_approve_pull_request_reviews"),
  );
}

/**
 * @param {string} repository
 * @param {ExpectSetting} expectSetting
 * @returns {void}
 */
function checkActionsPermissions(repository, expectSetting) {
  const permissions = api(`repos/${repository}/actions/permissions`);
  expectSetting(
    "GitHub Actions is restricted to selected actions",
    "selected",
    readString(permissions, "allowed_actions"),
  );
  expectSetting(
    "GitHub Actions requires actions to be pinned to a full-length SHA",
    true,
    readKey(permissions, "sha_pinning_required"),
  );
}

/**
 * Private vulnerability reporting, which — unlike the vulnerability-alerts
 * endpoint above — answers 200 with `{"enabled": false}` when it is off. Its
 * state is in the body, so exit status says nothing about it.
 *
 * @param {string} repository
 * @param {ExpectSetting} expectSetting
 * @returns {void}
 */
function checkPrivateVulnerabilityReporting(repository, expectSetting) {
  const reporting = apiOrNotFound(
    `repos/${repository}/private-vulnerability-reporting`,
  );
  expectSetting(
    "private vulnerability reporting is enabled",
    true,
    reporting.found ? readKey(reporting.body, "enabled") : false,
  );
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
  /** @type {ExpectSetting} */
  const expectSetting = (label, expected, actual) => {
    if (actual !== expected) {
      differences.push(
        `${label}\n  Expected: ${String(expected)}\n  Actual: ${String(actual)}`,
      );
    }
  };

  // Two groups below read the same `repos/{owner}/{repo}` body. Fetching it
  // once keeps a single outage a single reported failure rather than one per
  // group, and halves the requests this makes against the API rate limit.
  /** @type {{value: unknown} | undefined} */
  let repositorySettings;
  const readRepositorySettings = () => {
    repositorySettings ??= { value: api(`repos/${repository}`) };
    return repositorySettings.value;
  };

  // Each group below owns its own try/catch and reports its own failure onto
  // `differences` instead of returning early: a repository that 404s on one
  // endpoint (branch protection replaced by a ruleset, code scanning never
  // enabled) must not hide every check that would otherwise have run after
  // it. A run that reports one aborted check is what this file used to do,
  // and is exactly the bug this structure fixes.
  /** @type {[string, () => void][]} */
  const checks = [
    [
      "main branch protection",
      () => {
        checkBranchProtection(repository, expectSetting);
      },
    ],
    [
      "repository security-and-analysis settings",
      () => {
        checkSecurityAnalysis(readRepositorySettings(), expectSetting);
      },
    ],
    [
      "Dependabot vulnerability alerts",
      () => {
        checkVulnerabilityAlerts(repository, expectSetting);
      },
    ],
    [
      "CodeQL default setup",
      () => {
        checkCodeScanningDefaultSetup(repository, expectSetting);
      },
    ],
    [
      "merge button settings",
      () => {
        checkMergeButtons(readRepositorySettings(), expectSetting);
      },
    ],
    [
      "release environment",
      () => {
        checkReleaseEnvironment(repository, expectSetting);
      },
    ],
    [
      "GitHub Actions workflow permissions",
      () => {
        checkWorkflowPermissions(repository, expectSetting);
      },
    ],
    [
      "GitHub Actions repository permissions",
      () => {
        checkActionsPermissions(repository, expectSetting);
      },
    ],
    [
      "private vulnerability reporting",
      () => {
        checkPrivateVulnerabilityReporting(repository, expectSetting);
      },
    ],
  ];

  for (const [label, run] of checks) {
    try {
      run();
    } catch (error) {
      differences.push(
        `${label} could not be checked\n  Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
