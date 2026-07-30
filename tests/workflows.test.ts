import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// GitHub Actions cannot be executed from here, so the properties spec 02 §5.1
// requires of every workflow are asserted against the files instead. This is
// the local evidence for DoD G; the maintainer checklist in
// docs/template-implementation/phase-2-ci-and-supply-chain.md covers what only
// a real pull request can show.
//
// The scanner below is deliberately not a YAML parser. A parser would be a new
// dependency for a repository whose whole point is a small, reviewable
// dependency surface, and every rule here is about the *text* of a line — a
// pinned SHA, a trailing release-tag comment, a flag on a command — which
// survives round-tripping through a parser only by accident.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workflowsDir = path.join(repoRoot, ".github", "workflows");

// --- scanning ----------------------------------------------------------------

/** One structurally significant line: blanks, comments and block scalars are out. */
interface Line {
  /** Leading space count, which is what nesting is expressed with in YAML. */
  indent: number;
  /** Trimmed content with any trailing comment removed. */
  text: string;
  /** Original line including its trailing comment. */
  raw: string;
  /** 1-based line number, so a failure names a place a reader can open. */
  number: number;
}

/**
 * Split a workflow into structural lines.
 *
 * @remarks
 * Content of a block scalar (`run: |`) is skipped: a shell script contains
 * `#` comments, colons and `-` list markers that would otherwise read as YAML
 * structure. {@link runCommands} reads those bodies separately.
 */
function scan(source: string): Line[] {
  const lines: Line[] = [];
  let scalarIndent: number | null = null;

  source.split("\n").forEach((raw, index) => {
    // Trailing comments are dropped so that documenting a permission scope, as
    // zizmor's undocumented-permissions audit asks for, does not change what a
    // line means here. A `#` inside a quoted value would be cut too, which is
    // why shell bodies are read from the raw source by `runCommands` instead.
    const text = raw.trim().replace(/\s+#.*$/, "");
    const indent = raw.length - raw.trimStart().length;

    if (scalarIndent !== null) {
      if (text === "" || indent > scalarIndent) {
        return;
      }
      scalarIndent = null;
    }
    if (text === "" || raw.trimStart().startsWith("#")) {
      return;
    }

    lines.push({ indent, text, raw, number: index + 1 });
    if (/:\s*[|>][+-]?\d*$/.test(text)) {
      scalarIndent = indent;
    }
  });

  return lines;
}

/** The lines nested under `lines[headerIndex]`. */
function blockOf(lines: Line[], headerIndex: number): Line[] {
  const header = lines[headerIndex];
  if (header === undefined) {
    return [];
  }

  const body: Line[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.indent <= header.indent) {
      break;
    }
    body.push(line);
  }
  return body;
}

/** The value written after `key:` on the same line, or `""` when the value is a block. */
function inlineValue(line: Line): string {
  return line.text.slice(line.text.indexOf(":") + 1).trim();
}

function topLevel(lines: Line[], key: string): Line | undefined {
  return lines.find((line) => line.indent === 0 && line.text.startsWith(`${key}:`));
}

interface Job {
  name: string;
  header: Line;
  body: Line[];
}

function jobsOf(lines: Line[]): Job[] {
  const jobsIndex = lines.findIndex(
    (line) => line.indent === 0 && line.text === "jobs:",
  );
  if (jobsIndex === -1) {
    return [];
  }

  const body = blockOf(lines, jobsIndex);
  const jobs: Job[] = [];
  body.forEach((line, index) => {
    const name = /^([A-Za-z0-9_-]+):$/.exec(line.text)?.[1];
    if (line.indent === 2 && name !== undefined) {
      jobs.push({ name, header: line, body: blockOf(body, index) });
    }
  });
  return jobs;
}

/** Each step as its list-item line plus everything nested under it. */
function stepsOf(job: Job): Line[][] {
  const stepsIndex = job.body.findIndex(
    (line) => line.indent === job.header.indent + 2 && line.text === "steps:",
  );
  if (stepsIndex === -1) {
    return [];
  }

  const body = blockOf(job.body, stepsIndex);
  const first = body[0];
  if (first === undefined) {
    return [];
  }

  const steps: Line[][] = [];
  body.forEach((line, index) => {
    if (line.indent === first.indent && line.text.startsWith("- ")) {
      steps.push([line, ...blockOf(body, index)]);
    }
  });
  return steps;
}

/**
 * A key declared directly on the job, not somewhere inside one of its steps.
 *
 * @remarks
 * The depth matters: a `timeout-minutes` on a single step would otherwise read
 * as a timeout on the whole job, which is the opposite of what it means.
 */
function jobKey(job: Job, key: string): Line | undefined {
  return job.body.find(
    (line) => line.indent === job.header.indent + 2 && line.text.startsWith(`${key}:`),
  );
}

interface UsesRef {
  line: Line;
  ref: string;
}

function usesOf(lines: Line[]): UsesRef[] {
  const refs: UsesRef[] = [];
  for (const line of lines) {
    const ref = /^(?:- )?uses:\s*(\S+)/.exec(line.text)?.[1];
    if (ref !== undefined) {
      refs.push({ line, ref });
    }
  }
  return refs;
}

interface RunCommand {
  line: number;
  command: string;
}

/** Every `run:` body, single line or block scalar, with its starting line number. */
function runCommands(source: string): RunCommand[] {
  const rawLines = source.split("\n");
  const commands: RunCommand[] = [];

  rawLines.forEach((raw, index) => {
    const match = /^(\s*)(?:- )?run:\s*(.*)$/.exec(raw);
    const indentText = match?.[1];
    const value = match?.[2];
    if (indentText === undefined || value === undefined) {
      return;
    }

    if (!/^[|>][+-]?\d*$/.test(value.trim())) {
      commands.push({ line: index + 1, command: value });
      return;
    }

    const indent = indentText.length;
    const body: string[] = [];
    for (let next = index + 1; next < rawLines.length; next += 1) {
      const bodyLine = rawLines[next];
      if (bodyLine === undefined) {
        break;
      }
      const bodyIndent = bodyLine.length - bodyLine.trimStart().length;
      if (bodyLine.trim() !== "" && bodyIndent <= indent) {
        break;
      }
      body.push(bodyLine);
    }
    commands.push({ line: index + 1, command: body.join("\n") });
  });

  return commands;
}

// --- rules -------------------------------------------------------------------

/** One workflow property that spec 02 §5.1 requires and this file does not have. */
interface Problem {
  /** Stable identifier, safe to match in a test. */
  code: string;
  /** Line the reader should open. */
  line: number;
  /** What is wrong and what it should be instead. */
  message: string;
}

/** A third-party or first-party action reference that must carry a full SHA. */
const PINNED_REF = /^[^@\s]+@[0-9a-f]{40}$/;
/** The release tag a pinned SHA must be annotated with, so the pin stays readable. */
const TAG_COMMENT = /#\s*v\d+\.\d+\.\d+/;

function lintWorkflow(source: string): Problem[] {
  const lines = scan(source);
  const problems: Problem[] = [];
  const report = (code: string, line: number, message: string): void => {
    problems.push({ code, line, message });
  };

  for (const line of lines) {
    if (/^pull_request_target\b/.test(line.text)) {
      report(
        "ERR_WORKFLOW_PULL_REQUEST_TARGET",
        line.number,
        "pull_request_target runs fork code with a writable token. Use pull_request.",
      );
    }
  }

  // Actions are pinned to a full commit SHA and annotated with their release tag.
  for (const { line, ref } of usesOf(lines)) {
    if (ref.startsWith("./")) {
      continue;
    }
    if (!PINNED_REF.test(ref)) {
      report(
        "ERR_WORKFLOW_ACTION_NOT_PINNED",
        line.number,
        `${ref} is not pinned to a 40-character commit SHA.`,
      );
      continue;
    }
    if (!TAG_COMMENT.test(line.raw)) {
      report(
        "ERR_WORKFLOW_ACTION_TAG_COMMENT_MISSING",
        line.number,
        `${ref} has no trailing "# vX.Y.Z" comment, so the pin cannot be read.`,
      );
    }
  }

  // Top-level permissions are empty or read-only; jobs opt in to what they need.
  const permissions = topLevel(lines, "permissions");
  if (permissions === undefined) {
    report(
      "ERR_WORKFLOW_PERMISSIONS_MISSING",
      1,
      "No top-level permissions. Declare `permissions: {}` and grant per job.",
    );
  } else {
    const inline = inlineValue(permissions);
    const block = blockOf(lines, lines.indexOf(permissions)).map((line) => line.text);
    const readOnly =
      inline === "{}" ||
      (inline === "" && block.every((entry) => entry === "contents: read"));
    if (!readOnly) {
      report(
        "ERR_WORKFLOW_PERMISSIONS_TOO_BROAD",
        permissions.number,
        "Top-level permissions must be `{}` or `contents: read`.",
      );
    }
  }

  const jobs = jobsOf(lines);
  if (jobs.length === 0) {
    report("ERR_WORKFLOW_NO_JOBS", 1, "The workflow declares no jobs.");
  }

  for (const job of jobs) {
    if (jobKey(job, "timeout-minutes") === undefined) {
      report(
        "ERR_WORKFLOW_JOB_TIMEOUT_MISSING",
        job.header.number,
        `Job "${job.name}" has no timeout-minutes.`,
      );
    }

    const jobPermissions = jobKey(job, "permissions");
    if (jobPermissions === undefined) {
      report(
        "ERR_WORKFLOW_PERMISSIONS_MISSING",
        job.header.number,
        `Job "${job.name}" does not declare its own permissions.`,
      );
    } else {
      const scopes = [
        inlineValue(jobPermissions),
        ...blockOf(job.body, job.body.indexOf(jobPermissions)).map((line) => line.text),
      ];
      if (scopes.includes("write-all")) {
        report(
          "ERR_WORKFLOW_PERMISSIONS_TOO_BROAD",
          jobPermissions.number,
          `Job "${job.name}" grants write-all. List the scopes it actually needs.`,
        );
      }
    }

    // Checkout must not leave a usable credential behind for later steps.
    for (const step of stepsOf(job)) {
      const checkout = usesOf(step).find(({ ref }) =>
        ref.startsWith("actions/checkout@"),
      );
      if (checkout === undefined) {
        continue;
      }
      const persists = step.some((line) => line.text === "persist-credentials: false");
      if (!persists) {
        report(
          "ERR_WORKFLOW_CHECKOUT_CREDENTIALS",
          checkout.line.number,
          "actions/checkout needs `persist-credentials: false`.",
        );
      }
    }
  }

  // A pull request that is pushed to again must not keep the superseded run alive.
  const on = topLevel(lines, "on");
  const triggers = on === undefined ? [] : blockOf(lines, lines.indexOf(on));
  const onPullRequest = triggers.some((line) => line.text.startsWith("pull_request"));
  if (onPullRequest && topLevel(lines, "concurrency") === undefined) {
    report(
      "ERR_WORKFLOW_CONCURRENCY_MISSING",
      on?.number ?? 1,
      "A pull-request workflow needs `concurrency` so superseded runs are cancelled.",
    );
  }

  // An install that may resolve something other than the committed lockfile
  // would make every other gate advisory.
  for (const { line, command } of runCommands(source)) {
    for (const part of command.split("\n")) {
      if (
        /\bpnpm\b[^\n;&|]*\binstall\b/.test(part) &&
        !part.includes("--frozen-lockfile")
      ) {
        report(
          "ERR_WORKFLOW_INSTALL_NOT_FROZEN",
          line,
          `"${part.trim()}" installs without --frozen-lockfile.`,
        );
      }
    }
  }

  return problems;
}

// --- version agreement -------------------------------------------------------

/** Values of a `node:` matrix key, which is how the test matrix is written. */
function matrixNodeVersions(source: string): string[] {
  const versions: string[] = [];
  for (const line of scan(source)) {
    const version = /^(?:- )?node:\s*"?(\d[\d.]*)"?$/.exec(line.text)?.[1];
    if (version !== undefined) {
      versions.push(version);
    }
  }
  return versions;
}

/** The `version:` given to every pnpm/action-setup step. */
function pnpmSetupVersions(source: string): string[] {
  const lines = scan(source);
  const versions: string[] = [];

  for (const job of jobsOf(lines)) {
    for (const step of stepsOf(job)) {
      if (!usesOf(step).some(({ ref }) => ref.startsWith("pnpm/action-setup@"))) {
        continue;
      }
      const version = step
        .map((line) => /^version:\s*"?([\w.-]+)"?$/.exec(line.text)?.[1])
        .find((value) => value !== undefined);
      if (version !== undefined) {
        versions.push(version);
      }
    }
  }
  return versions;
}

function versionParts(version: string): number[] {
  return version.split(".").map((part) => Number(part));
}

/** Compare two dotted numeric versions, shorter meaning "unspecified, so equal". */
function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/** Whether `version` satisfies a `^x.y.z` range. Only the form this repo declares. */
function satisfiesCaret(version: string, range: string): boolean {
  const floor = /^\^(\d+\.\d+\.\d+)$/.exec(range)?.[1];
  if (floor === undefined) {
    throw new Error(
      `Unsupported range: ${range}. Extend satisfiesCaret if this is intended.`,
    );
  }
  return (
    versionParts(version)[0] === versionParts(floor)[0] &&
    compareVersions(version, floor) >= 0
  );
}

// --- fixtures ----------------------------------------------------------------

/** A workflow that satisfies every rule; each test below breaks exactly one thing. */
const CLEAN_WORKFLOW = `name: Example

on:
  pull_request:

permissions: {}

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - name: Install dependencies
        run: pnpm install --frozen-lockfile
`;

function codesOf(problems: Problem[]): string[] {
  return problems.map((problem) => problem.code);
}

function withoutLine(source: string, needle: string): string {
  return source
    .split("\n")
    .filter((line) => !line.includes(needle))
    .join("\n");
}

// --- the rules, against synthetic workflows ----------------------------------

describe("lintWorkflow", () => {
  it("accepts a workflow that satisfies every rule", () => {
    expect(lintWorkflow(CLEAN_WORKFLOW)).toEqual([]);
  });

  it("rejects an action referenced by tag instead of SHA", () => {
    const source = CLEAN_WORKFLOW.replace(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/checkout@v7",
    );

    expect(codesOf(lintWorkflow(source))).toContain("ERR_WORKFLOW_ACTION_NOT_PINNED");
  });

  it("rejects a short SHA", () => {
    const source = CLEAN_WORKFLOW.replace(
      "3d3c42e5aac5ba805825da76410c181273ba90b1",
      "3d3c42e",
    );

    expect(codesOf(lintWorkflow(source))).toContain("ERR_WORKFLOW_ACTION_NOT_PINNED");
  });

  it("rejects a pinned SHA with no release tag comment", () => {
    const source = CLEAN_WORKFLOW.replace(" # v7.0.1", "");

    expect(codesOf(lintWorkflow(source))).toEqual([
      "ERR_WORKFLOW_ACTION_TAG_COMMENT_MISSING",
    ]);
  });

  it("allows a local action, which has no SHA to pin", () => {
    const source = CLEAN_WORKFLOW.replace(
      "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile\n",
      "      - uses: ./.github/actions/setup\n",
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("rejects a job with no timeout", () => {
    const source = withoutLine(CLEAN_WORKFLOW, "timeout-minutes:");

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_JOB_TIMEOUT_MISSING"]);
  });

  it("does not accept a step timeout in place of the job's", () => {
    const source = withoutLine(CLEAN_WORKFLOW, "    timeout-minutes:").replace(
      "      - name: Install dependencies\n",
      "      - name: Install dependencies\n        timeout-minutes: 10\n",
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_JOB_TIMEOUT_MISSING"]);
  });

  it("rejects a workflow with no top-level permissions", () => {
    const source = withoutLine(CLEAN_WORKFLOW, "permissions: {}");

    expect(codesOf(lintWorkflow(source))).toContain("ERR_WORKFLOW_PERMISSIONS_MISSING");
  });

  it("rejects top-level permissions wider than contents: read", () => {
    const source = CLEAN_WORKFLOW.replace(
      "permissions: {}",
      "permissions:\n  contents: write",
    );

    expect(codesOf(lintWorkflow(source))).toContain(
      "ERR_WORKFLOW_PERMISSIONS_TOO_BROAD",
    );
  });

  it("accepts contents: read as the top-level default", () => {
    const source = CLEAN_WORKFLOW.replace(
      "permissions: {}",
      "permissions:\n  contents: read",
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("rejects a job that does not declare its own permissions", () => {
    const source = withoutLine(
      withoutLine(CLEAN_WORKFLOW, "      contents: read"),
      "    permissions:",
    );

    expect(codesOf(lintWorkflow(source))).toContain("ERR_WORKFLOW_PERMISSIONS_MISSING");
  });

  it("rejects a job that grants write-all", () => {
    const source = CLEAN_WORKFLOW.replace(
      "    permissions:\n      contents: read",
      "    permissions: write-all",
    );

    expect(codesOf(lintWorkflow(source))).toContain(
      "ERR_WORKFLOW_PERMISSIONS_TOO_BROAD",
    );
  });

  it("rejects a checkout that keeps its credentials", () => {
    const source = withoutLine(CLEAN_WORKFLOW, "persist-credentials: false");

    expect(codesOf(lintWorkflow(source))).toEqual([
      "ERR_WORKFLOW_CHECKOUT_CREDENTIALS",
    ]);
  });

  it("rejects a pull-request workflow with no concurrency group", () => {
    const source = CLEAN_WORKFLOW.replace(
      "concurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\n\n",
      "",
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_CONCURRENCY_MISSING"]);
  });

  it("does not require concurrency for a scheduled workflow", () => {
    const source = CLEAN_WORKFLOW.replace(
      "  pull_request:",
      '  schedule:\n    - cron: "0 6 * * 1"',
    ).replace(
      "concurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\n\n",
      "",
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("rejects pull_request_target", () => {
    const source = CLEAN_WORKFLOW.replace("  pull_request:", "  pull_request_target:");

    expect(codesOf(lintWorkflow(source))).toContain("ERR_WORKFLOW_PULL_REQUEST_TARGET");
  });

  it("rejects an install that is not frozen", () => {
    const source = CLEAN_WORKFLOW.replace(
      "pnpm install --frozen-lockfile",
      "pnpm install",
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_INSTALL_NOT_FROZEN"]);
  });

  it("finds an unfrozen install inside a multi-line run block", () => {
    const source = CLEAN_WORKFLOW.replace(
      "        run: pnpm install --frozen-lockfile\n",
      "        run: |\n          set -euo pipefail\n          pnpm install\n",
    );

    expect(codesOf(lintWorkflow(source))).toEqual(["ERR_WORKFLOW_INSTALL_NOT_FROZEN"]);
  });

  it("accepts an install carrying extra pnpm flags", () => {
    const source = CLEAN_WORKFLOW.replace(
      "pnpm install --frozen-lockfile",
      "pnpm $PNPM_RUNTIME_FLAG install --frozen-lockfile",
    );

    expect(lintWorkflow(source)).toEqual([]);
  });

  it("ignores YAML-looking text inside a shell script", () => {
    const source = CLEAN_WORKFLOW.replace(
      "        run: pnpm install --frozen-lockfile\n",
      [
        "        run: |",
        "          set -euo pipefail",
        "          # uses: not-an-action@v1",
        '          echo "permissions: write-all"',
        "          - not a list item",
        "",
      ].join("\n"),
    );

    expect(lintWorkflow(source)).toEqual([]);
  });
});

// --- the rules, against the workflows this repository ships -------------------

const workflowNames = readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();

function workflowSource(name: string): string {
  return readFileSync(path.join(workflowsDir, name), "utf8");
}

describe("the workflows in .github/workflows", () => {
  it("includes every workflow spec 02 §5.2 makes mandatory", () => {
    expect(workflowNames).toEqual([
      "check-pr-title.yml",
      "ci.yml",
      "codeql.yml",
      "dependency-review.yml",
      "pr-label.yml",
      "release.yml",
      "scorecard.yml",
      "security-audit.yml",
      "typos.yml",
      "version.yml",
    ]);
  });

  it.each(workflowNames)("%s satisfies every rule", (name) => {
    expect(lintWorkflow(workflowSource(name))).toEqual([]);
  });

  // The rules above are only worth anything if the scanner actually reaches
  // every job and every step. These two compare what it found against a plain
  // text count, so a silently skipped block fails here rather than passing as
  // "no problems found".
  it.each(workflowNames)("%s: the scanner sees every job", (name) => {
    const source = workflowSource(name);
    const declared = source
      .split("\n")
      // Job level only: four spaces of indent, which is where jobsOf looks.
      .filter((line) => /^ {4}timeout-minutes:/.test(line)).length;

    expect(jobsOf(scan(source))).toHaveLength(declared);
  });

  it.each(workflowNames)("%s: the scanner sees every action reference", (name) => {
    const source = workflowSource(name);
    const declared = source
      .split("\n")
      .filter((line) => /^\s*(?:- )?uses:/.test(line)).length;

    expect(usesOf(scan(source))).toHaveLength(declared);
  });

  it("pins every action, so nothing is fetched by a movable ref", () => {
    const refs = workflowNames.flatMap((name) =>
      usesOf(scan(workflowSource(name))).map(({ ref }) => ref),
    );

    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((ref) => !PINNED_REF.test(ref))).toEqual([]);
  });

  it("collects coverage exactly once across the whole matrix", () => {
    // Spec 02 §5.2: the minimum-Node Ubuntu leg is the source of truth, and a
    // second collector would make the threshold depend on which leg finished.
    const collectors = runCommands(workflowSource("ci.yml")).filter(({ command }) =>
      command.includes("test:coverage"),
    );

    expect(collectors).toHaveLength(1);
  });

  it("grants a write scope only where the job cannot do its work without one", () => {
    // codeql and scorecard upload to the security tab; pr-label writes a label
    // and tolerates the read-only token a fork PR gets. Everything else, and in
    // particular everything that runs repository code, stays read-only.
    const writers = workflowNames.filter((name) =>
      scan(workflowSource(name)).some((line) => line.text.endsWith(": write")),
    );

    expect(writers.sort()).toEqual([
      "codeql.yml",
      "pr-label.yml",
      "release.yml",
      "scorecard.yml",
      "version.yml",
    ]);
  });
});

describe("the release workflow preserves the reviewed artifact", () => {
  const source = workflowSource("release.yml");
  const publish = jobsOf(scan(source)).find((job) => job.name === "publish");

  it("uses only read access and OIDC in the publish job", () => {
    expect(publish).toBeDefined();
    if (publish === undefined) {
      return;
    }
    const permissions = jobKey(publish, "permissions");
    expect(permissions).toBeDefined();
    if (permissions === undefined) {
      return;
    }
    expect(
      blockOf(publish.body, publish.body.indexOf(permissions)).map((line) => line.text),
    ).toEqual(["contents: read", "id-token: write"]);
    expect(jobKey(publish, "environment")?.text).toBe("environment: release");
  });

  it("does not refer to a long-lived npm token or a dependency cache", () => {
    expect(source).not.toContain("NPM_TOKEN");
    expect(source).not.toMatch(/cache:/);
  });

  it("checks the tag before publishing", () => {
    expect(source.indexOf("Verify tag matches package version")).toBeGreaterThan(-1);
    expect(source.indexOf("Verify tag matches package version")).toBeLessThan(
      source.indexOf("npm publish dist/package.tgz"),
    );
  });

  it("packs once and reuses the fixed tarball path", () => {
    expect(source.match(/\bpnpm pack\b/g)).toHaveLength(1);
    expect(source).toContain(
      "node scripts/smoke-package.mjs --tarball dist/package.tgz",
    );
    expect(source).toContain(
      "npm publish dist/package.tgz --access public --provenance",
    );
    expect(source).toContain("path: dist/package.tgz");
  });
});

// --- agreement with package.json and .node-version ---------------------------

interface Manifest {
  engines?: { node?: string };
  devEngines?: { packageManager?: { version?: string } };
}

const manifest = JSON.parse(
  readFileSync(path.join(repoRoot, "package.json"), "utf8"),
) as Manifest;
const nodeVersionFile = readFileSync(
  path.join(repoRoot, ".node-version"),
  "utf8",
).trim();

describe("the CI matrix agrees with the package contract", () => {
  const matrix = matrixNodeVersions(workflowSource("ci.yml"));

  it("runs the minimum Node that engines.node promises when one is declared", () => {
    const minimum = /(\d+(?:\.\d+)*)/.exec(manifest.engines?.node ?? "")?.[1];
    if (minimum === undefined) {
      expect(manifest.engines).toBeUndefined();
      return;
    }

    // Compared by the precision engines.node states: ">=22.14" is satisfied by
    // the matrix entry 22.14.0, and only by a 22.14 patch of it.
    const depth = minimum.split(".").length;
    expect(
      matrix.filter(
        (version) => version.split(".").slice(0, depth).join(".") === minimum,
      ),
    ).not.toEqual([]);
  });

  it("runs the Node in .node-version", () => {
    const depth = nodeVersionFile.split(".").length;
    expect(
      matrix.filter(
        (version) => version.split(".").slice(0, depth).join(".") === nodeVersionFile,
      ),
    ).not.toEqual([]);
  });

  it("runs nothing else, so a stale entry is noticed", () => {
    expect(matrix).toHaveLength(2);
  });
});

describe("the pnpm version in CI agrees with devEngines", () => {
  const declared = manifest.devEngines?.packageManager?.version;

  it("is declared in package.json", () => {
    expect(declared).toBeTypeOf("string");
  });

  it.each(workflowNames)("%s sets up a pnpm the range allows", (name) => {
    if (declared === undefined) {
      throw new Error("package.json declares no devEngines.packageManager.version");
    }

    for (const version of pnpmSetupVersions(workflowSource(name))) {
      expect(satisfiesCaret(version, declared)).toBe(true);
    }
  });

  it("uses one pnpm version everywhere", () => {
    const versions = new Set(
      workflowNames.flatMap((name) => pnpmSetupVersions(workflowSource(name))),
    );

    expect([...versions]).toHaveLength(1);
  });
});
