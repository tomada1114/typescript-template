#!/usr/bin/env node
import { Buffer } from "node:buffer";
import console from "node:console";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import { isMain } from "./lib/is-main.mjs";
import { parseJson, readKey, readString } from "./lib/json.mjs";

const TEMPLATE_PACKAGE = "my-package";
const TEMPLATE_REPOSITORY = "your-name/my-package";
const TEMPLATE_USAGE = "Usage: my-package";
const TEMPLATE_AUTHOR = "Your Name";
const TEMPLATE_EMAIL = "you@example.com";
const TEMPLATE_DESCRIPTION = "A short description.";
const TEMPLATE_REPORT = `etc/${TEMPLATE_PACKAGE}.api.md`;
const DEFAULT_PROFILE = "node-library";
const DEFAULT_LICENSE = "MIT";
const DEFAULT_DESCRIPTION = "A TypeScript package.";
const PROFILES = new Set(["node-library", "node-cli", "universal-library"]);
const LICENSES = new Set(["MIT", "ISC"]);
const PLACEHOLDERS = [
  TEMPLATE_PACKAGE,
  TEMPLATE_REPOSITORY,
  TEMPLATE_AUTHOR,
  TEMPLATE_EMAIL,
  TEMPLATE_DESCRIPTION,
];
const SCRIPT_STRING_PLACEHOLDERS = new Set([
  TEMPLATE_AUTHOR,
  TEMPLATE_EMAIL,
  TEMPLATE_DESCRIPTION,
]);
const RESERVED_NAMES = new Set(["node_modules", "favicon.ico"]);

// Keep this list explicit. Bootstrap is a one-time rewrite of known template
// targets, not a repository-wide search-and-replace. Add a target here when a
// new generated file intentionally contains one of the template placeholders.
const PLACEHOLDER_TARGETS = [
  { file: ".devcontainer/devcontainer.json", placeholder: TEMPLATE_PACKAGE },
  { file: ".github/ISSUE_TEMPLATE/config.yml", placeholder: TEMPLATE_REPOSITORY },
  { file: "CONTRIBUTING.md", placeholder: TEMPLATE_PACKAGE },
  { file: "LICENSE", placeholder: TEMPLATE_AUTHOR },
  { file: "README.md", placeholder: TEMPLATE_REPOSITORY },
  { file: "README.md", placeholder: TEMPLATE_PACKAGE },
  { file: "README.md", placeholder: TEMPLATE_AUTHOR },
  { file: "README.md", placeholder: TEMPLATE_DESCRIPTION },
  { file: "SECURITY.md", placeholder: TEMPLATE_REPOSITORY },
  { file: "SECURITY.md", placeholder: TEMPLATE_PACKAGE },
  { file: "docs/getting-started.md", placeholder: TEMPLATE_PACKAGE },
  { file: "docs/reference.md", placeholder: TEMPLATE_PACKAGE },
  { file: TEMPLATE_REPORT, placeholder: TEMPLATE_PACKAGE },
  { file: "package.json", placeholder: TEMPLATE_REPOSITORY },
  { file: "package.json", placeholder: TEMPLATE_PACKAGE },
  { file: "package.json", placeholder: TEMPLATE_AUTHOR },
  { file: "package.json", placeholder: TEMPLATE_EMAIL },
  { file: "package.json", placeholder: TEMPLATE_DESCRIPTION },
  { file: "scripts/bootstrap.mjs", placeholder: TEMPLATE_REPOSITORY },
  { file: "scripts/bootstrap.mjs", placeholder: TEMPLATE_USAGE },
  { file: "scripts/bootstrap.mjs", placeholder: TEMPLATE_PACKAGE },
  { file: "scripts/bootstrap.mjs", placeholder: TEMPLATE_AUTHOR },
  { file: "scripts/bootstrap.mjs", placeholder: TEMPLATE_EMAIL },
  { file: "scripts/bootstrap.mjs", placeholder: TEMPLATE_DESCRIPTION },
  { file: "src/cli.ts", placeholder: TEMPLATE_USAGE },
  { file: "tests/docs.test.ts", placeholder: TEMPLATE_PACKAGE },
  { file: "tests/package.test.ts", placeholder: TEMPLATE_PACKAGE },
  { file: "typedoc.json", placeholder: TEMPLATE_REPOSITORY },
];

// These files carry bootstrap-only blocks. They are deliberately enumerated so
// adding an unrelated tracked file cannot make bootstrap rewrite it.
const MARKER_TARGETS = [
  "AGENTS.md",
  "README.md",
  "tests/AGENTS.md",
  ".github/workflows/ci.yml",
];

// The AI-layer assertion retains the profile/reference guard without walking
// the repository. Extend this list when a new AI-layer file becomes part of
// the template.
const AI_LAYER_TARGETS = [
  "AGENTS.md",
  "CLAUDE.md",
  "tests/AGENTS.md",
  "tests/CLAUDE.md",
  ".claude/settings.json",
  ".claude/skills/merge-dependabot/SKILL.md",
  ".claude/skills/merge-dependabot/references/failure-modes.md",
  ".claude/skills/merge-dependabot/scripts/survey-prs.mjs",
];

// Bootstrap-only Markdown markers. `template-only` blocks are removed from
// every generated repository; a `profile:<name>` block keeps its contents only
// when the selected profile matches. HTML comments survive Prettier and make
// the source-to-generated relationship explicit to reviewers.
const TEMPLATE_ONLY_BLOCK =
  /<!-- template-only:start -->[\s\S]*?<!-- template-only:end -->/g;
const TEMPLATE_ONLY_YAML_BLOCK =
  /^[ \t]*# template-only:start\s*$[\s\S]*?^[ \t]*# template-only:end\s*$\n?/gm;
const PROFILE_BLOCK =
  /<!-- profile:([a-z0-9-]+):start -->([\s\S]*?)<!-- profile:\1:end -->/g;
const REMOVED_TEMPLATE_PATHS = [
  "docs/template-requirements",
  "docs/template-implementation",
];
const REMOVED_CLI_REFERENCES =
  /(?:src\/cli\.ts|src\/bin\.ts|tests\/cli\.test\.ts|cli\.ts|bin\.ts|runCli|CliIo|dist\/bin\.js)/;

const USAGE = `Usage: node scripts/bootstrap.mjs

With no arguments, bootstrap prompts for the package metadata.

Non-interactive fallback:
  node scripts/bootstrap.mjs <package-name> [options]

Required:
  --profile <node-library|node-cli|universal-library>
  --author <name>
  --email <address>
  --github-user <owner>
  --license <MIT|ISC>

Optional:
  --bin-name <name>       Command name for node-cli (defaults to package name)
  --description <text>    Package description
  --dry-run               Validate and show the planned changes only`;

/** Error with a stable code and an actionable message. */
export class BootstrapError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "BootstrapError";
    this.code = code;
  }
}

/**
 * Convert either path separator to the repository's canonical separator.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeRelativePath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

/**
 * Validate an npm package name without invoking npm or a shell.
 *
 * @param {string} packageName
 * @returns {void}
 */
export function validatePackageName(packageName) {
  if (packageName.length === 0) {
    throw new BootstrapError("ERR_PACKAGE_NAME_EMPTY", "package name is required.");
  }
  if (packageName.length > 214) {
    throw new BootstrapError(
      "ERR_PACKAGE_NAME_LENGTH",
      "package name must be no more than 214 characters.",
    );
  }
  if (packageName !== packageName.toLowerCase()) {
    throw new BootstrapError(
      "ERR_PACKAGE_NAME_CASE",
      `package name must be lowercase: ${packageName}`,
    );
  }
  const match = /^(?:@([a-z0-9][a-z0-9._-]*)\/)?([a-z0-9][a-z0-9._-]*)$/.exec(
    packageName,
  );
  if (match === null || packageName.includes("..")) {
    throw new BootstrapError(
      "ERR_PACKAGE_NAME_INVALID",
      `invalid npm package name: ${packageName}`,
    );
  }
  const unscoped = match[2] ?? "";
  if (RESERVED_NAMES.has(unscoped)) {
    throw new BootstrapError(
      "ERR_PACKAGE_NAME_RESERVED",
      `reserved npm package name: ${packageName}`,
    );
  }
}

/**
 * Derive names used outside package.json.
 *
 * @param {string} packageName
 * @returns {{unscoped: string, identifier: string, apiReport: string, tarball: string}}
 */
export function deriveNames(packageName) {
  validatePackageName(packageName);
  const [scope, unscoped] = packageName.startsWith("@")
    ? packageName.slice(1).split("/")
    : [undefined, packageName];
  const safeUnscoped = unscoped;
  let identifier = safeUnscoped.replace(/[^a-zA-Z0-9_$]+(.)?/g, (_match, next) =>
    typeof next === "string" ? next.toUpperCase() : "",
  );
  if (!/^[A-Za-z_$]/.test(identifier)) {
    identifier = `package${identifier}`;
  }
  return {
    unscoped: safeUnscoped,
    identifier,
    apiReport: `${safeUnscoped}.api.md`,
    tarball: scope === undefined ? safeUnscoped : `${scope}-${safeUnscoped}`,
  };
}

/**
 * Parse the bootstrap command line.
 *
 * @param {readonly string[]} argv
 * @returns {{
 *   packageName: string,
 *   profile: string,
 *   author: string,
 *   email: string,
 *   githubUser: string,
 *   license: string,
 *   binName?: string,
 *   description: string,
 *   dryRun: boolean
 * }}
 */
export function parseArguments(argv) {
  const packageName = argv[0] ?? "";
  const allowedFlags = new Set([
    "--profile",
    "--author",
    "--email",
    "--github-user",
    "--license",
    "--bin-name",
    "--description",
  ]);
  /** @type {Map<string, string>} */
  const values = new Map();
  let dryRun = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      throw new BootstrapError(
        "ERR_ARGUMENT_UNKNOWN",
        `unexpected argument: ${argument}`,
      );
    }
    if (!allowedFlags.has(argument)) {
      throw new BootstrapError("ERR_ARGUMENT_UNKNOWN", `unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new BootstrapError("ERR_ARGUMENT_VALUE", `${argument} requires a value.`);
    }
    values.set(argument, value);
    index += 1;
  }

  validatePackageName(packageName);
  const required = ["--profile", "--author", "--email", "--github-user", "--license"];
  for (const flag of required) {
    if ((values.get(flag) ?? "").trim() === "") {
      throw new BootstrapError("ERR_ARGUMENT_REQUIRED", `${flag} is required.`);
    }
  }
  const profile = values.get("--profile") ?? "";
  if (!PROFILES.has(profile)) {
    throw new BootstrapError("ERR_PROFILE_INVALID", `unsupported profile: ${profile}`);
  }
  const license = values.get("--license") ?? "";
  if (!LICENSES.has(license)) {
    throw new BootstrapError("ERR_LICENSE_INVALID", `unsupported license: ${license}`);
  }
  const email = values.get("--email") ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new BootstrapError("ERR_EMAIL_INVALID", `invalid author email: ${email}`);
  }
  const githubUser = values.get("--github-user") ?? "";
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(githubUser)) {
    throw new BootstrapError(
      "ERR_GITHUB_USER_INVALID",
      `invalid GitHub owner: ${githubUser}`,
    );
  }

  const names = deriveNames(packageName);
  const binName = values.get("--bin-name");
  if (binName !== undefined && !/^[a-z0-9][a-z0-9._-]*$/.test(binName)) {
    throw new BootstrapError(
      "ERR_BIN_NAME_INVALID",
      `invalid command name: ${binName}`,
    );
  }
  if (profile !== "node-cli" && binName !== undefined) {
    throw new BootstrapError(
      "ERR_BIN_PROFILE",
      "--bin-name is only valid with the node-cli profile.",
    );
  }

  return {
    packageName,
    profile,
    author: values.get("--author") ?? "",
    email,
    githubUser,
    license,
    ...(profile === "node-cli" ? { binName: binName ?? names.unscoped } : {}),
    description: values.get("--description") ?? DEFAULT_DESCRIPTION,
    dryRun,
  };
}

/**
 * Collect bootstrap values from an interactive question function.
 *
 * @param {(prompt: string) => Promise<string>} question
 * @returns {Promise<ReturnType<typeof parseArguments>>}
 */
export async function promptArguments(question) {
  const packageName = (await question("Package name: ")).trim();
  const profile =
    (await question(`Profile [${DEFAULT_PROFILE}]: `)).trim() || DEFAULT_PROFILE;
  const author = (await question("Author name: ")).trim();
  const email = (await question("Author email: ")).trim();
  const githubUser = (await question("GitHub user: ")).trim();
  const license =
    (await question(`License [${DEFAULT_LICENSE}]: `)).trim() || DEFAULT_LICENSE;
  const description =
    (await question(`Description [${DEFAULT_DESCRIPTION}]: `)).trim() ||
    DEFAULT_DESCRIPTION;
  const binName =
    profile === "node-cli"
      ? (await question("Command name (blank for package name): ")).trim()
      : "";

  const argv = [
    packageName,
    "--profile",
    profile,
    "--author",
    author,
    "--email",
    email,
    "--github-user",
    githubUser,
    "--license",
    license,
    "--description",
    description,
  ];
  if (binName !== "") {
    argv.push("--bin-name", binName);
  }
  return parseArguments(argv);
}

/**
 * Escape a value that will be inserted inside a JavaScript string literal.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeJavaScriptString(value) {
  return JSON.stringify(value).slice(1, -1);
}

/**
 * Replace placeholders in UTF-8 text and leave binary files unchanged.
 *
 * @param {string} file
 * @param {readonly [string, string][]} replacements
 * @param {string} profile
 * @param {boolean} write
 * @returns {{changed: boolean, text: string}}
 */
function replaceText(file, replacements, profile, write) {
  const buffer = readFileSync(file);
  if (buffer.includes(0)) {
    return { changed: false, text: buffer.toString("utf8") };
  }
  const original = buffer.toString("utf8");
  if (Buffer.from(original, "utf8").compare(buffer) !== 0) {
    return { changed: false, text: original };
  }
  const isMarkdown = file.endsWith(".md");
  const isInstructionFile = ["AGENTS.md", "CLAUDE.md"].includes(path.basename(file));
  let updated = original.replace(TEMPLATE_ONLY_YAML_BLOCK, "");
  if (isMarkdown || isInstructionFile) {
    updated = updated.replace(TEMPLATE_ONLY_BLOCK, "");
    /** @type {(match: string, markedProfile: string, contents: string) => string} */
    const selectProfileBlock = (_match, markedProfile, contents) =>
      markedProfile === profile ? contents : "";
    updated = updated.replace(PROFILE_BLOCK, selectProfileBlock);
    if (updated !== original) {
      updated = updated.replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
    }
  }
  for (const [before, after] of replacements) {
    updated = updated.replaceAll(before, () => after);
  }
  if (updated === original) {
    return { changed: false, text: original };
  }
  if (write) {
    writeFileSync(file, updated);
  }
  return { changed: true, text: updated };
}

/**
 * Verify that generated instructions do not describe template-only or
 * profile-incompatible paths.
 *
 * @param {string} root
 * @param {string} profile
 * @param {Map<string, string | null>} [preview]
 */
function assertGeneratedAiLayer(root, profile, preview) {
  /** @type {string[]} */
  const problems = [];
  for (const relative of AI_LAYER_TARGETS) {
    const file = path.join(root, relative);
    /** @type {string} */
    let text;
    if (preview?.has(relative)) {
      const projected = preview.get(relative);
      if (projected === null || projected === undefined) {
        continue;
      }
      text = projected;
    } else {
      if (!existsSync(file) || lstatSync(file).isSymbolicLink()) {
        continue;
      }
      const buffer = readFileSync(file);
      if (buffer.includes(0)) {
        continue;
      }
      text = buffer.toString("utf8");
    }
    if (text.includes("docs/template-requirements")) {
      problems.push(`${relative}: docs/template-requirements`);
    }
    if (text.includes("docs/template-implementation")) {
      problems.push(`${relative}: docs/template-implementation`);
    }
    if (text.includes("<!-- template-only:") || text.includes("<!-- profile:")) {
      problems.push(`${relative}: bootstrap marker`);
    }
    if (profile !== "node-cli" && REMOVED_CLI_REFERENCES.test(text)) {
      problems.push(`${relative}: CLI-only path or symbol`);
    }
  }

  const requiredBySkill = [
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/workflows/check-pr-title.yml",
    "scripts/lib/is-main.mjs",
    "scripts/lib/json.mjs",
  ];
  for (const relative of requiredBySkill) {
    if (!existsSync(path.join(root, relative))) {
      problems.push(`missing ${relative}`);
    }
  }

  if (problems.length > 0) {
    throw new BootstrapError(
      "ERR_AI_LAYER_REFERENCE",
      `generated AI-native instructions are inconsistent for profile ${profile}.\n` +
        "Expected: no removed or profile-incompatible references, and all skill dependencies present.\n" +
        `Actual:\n${problems.join("\n")}\n` +
        "Next: update the marked source instructions, then rerun bootstrap.",
    );
  }
}

/**
 * Parse JSON and require an object.
 *
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
function readObject(file) {
  const value = parseJson(readFileSync(file, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BootstrapError(
      "ERR_JSON_SHAPE",
      `${path.basename(file)} must contain an object.`,
    );
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * Produce the complete ISC license text.
 *
 * @param {string} author
 * @param {number} year
 * @returns {string}
 */
function iscLicense(author, year) {
  return `Copyright ${String(year)} ${author}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
`;
}

/**
 * Apply the explicit text targets and bootstrap-only marker blocks.
 *
 * @param {string} root
 * @param {Map<string, string>} replacements
 * @param {string} profile
 * @param {string} reportPath
 * @param {boolean} write
 * @param {Map<string, string | null>} [preview]
 * @returns {string[]}
 */
function replaceTargets(root, replacements, profile, reportPath, write, preview) {
  /** @type {Map<string, [string, string][]>} */
  const byFile = new Map();
  for (const { file, placeholder } of PLACEHOLDER_TARGETS) {
    const relative = file === TEMPLATE_REPORT ? reportPath : file;
    // package.json is rewritten structurally below so quotes and control
    // characters in interactive metadata cannot make its JSON invalid.
    if (relative === "package.json") {
      continue;
    }
    const replacement = replacements.get(placeholder);
    if (replacement === undefined) {
      continue;
    }
    const safeReplacement =
      relative === "scripts/bootstrap.mjs" &&
      SCRIPT_STRING_PLACEHOLDERS.has(placeholder)
        ? escapeJavaScriptString(replacement)
        : replacement;
    const fileReplacements = byFile.get(relative) ?? [];
    fileReplacements.push([placeholder, safeReplacement]);
    byFile.set(relative, fileReplacements);
  }
  for (const relative of MARKER_TARGETS) {
    if (!byFile.has(relative)) {
      byFile.set(relative, []);
    }
  }

  /** @type {string[]} */
  const changed = [];
  for (const [relative, fileReplacements] of byFile) {
    const file = path.join(root, relative);
    if (!existsSync(file) || lstatSync(file).isSymbolicLink()) {
      continue;
    }
    const result = replaceText(file, fileReplacements, profile, write);
    if (preview !== undefined) {
      preview.set(relative, result.text);
    }
    if (result.changed) {
      changed.push(relative);
    }
  }
  return changed;
}

/**
 * Apply profile and metadata changes directly to the supplied repository.
 *
 * @param {string} root
 * @param {ReturnType<typeof parseArguments>} options
 * @param {number} year
 * @param {Map<string, string | null>} [preview]
 * @returns {string[]}
 */
function transform(root, options, year, preview) {
  const names = deriveNames(options.packageName);
  const repository = `${options.githubUser}/${names.unscoped}`;
  /** @type {Map<string, string>} */
  const replacements = new Map([
    [TEMPLATE_REPOSITORY, repository],
    [TEMPLATE_USAGE, `Usage: ${options.binName ?? names.unscoped}`],
    [TEMPLATE_PACKAGE, options.packageName],
    [TEMPLATE_AUTHOR, options.author],
    [TEMPLATE_EMAIL, options.email],
    [TEMPLATE_DESCRIPTION, options.description],
  ]);
  /** @type {string[]} */
  const changed = [];
  const write = !options.dryRun;

  const reportFrom = path.join(root, TEMPLATE_REPORT);
  const reportTo = path.join(root, "etc", names.apiReport);
  if (reportFrom !== reportTo && existsSync(reportTo)) {
    throw new BootstrapError(
      "ERR_RENAME_DESTINATION",
      `API report destination already exists: etc/${names.apiReport}`,
    );
  }

  for (const relative of REMOVED_TEMPLATE_PATHS) {
    const target = path.join(root, relative);
    if (existsSync(target)) {
      if (write) {
        rmSync(target, { recursive: true });
      }
      if (preview !== undefined) {
        preview.set(relative, null);
      }
      changed.push(`${relative}/ (removed)`);
    }
  }

  const changesetDirectory = path.join(root, ".changeset");
  if (existsSync(changesetDirectory)) {
    for (const entry of readdirSync(changesetDirectory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md") {
        if (write) {
          rmSync(path.join(changesetDirectory, entry.name));
        }
        changed.push(`.changeset/${entry.name} (removed)`);
      }
    }
  }

  if (existsSync(reportFrom) && reportFrom !== reportTo) {
    if (preview !== undefined) {
      const report = replaceText(
        reportFrom,
        [[TEMPLATE_PACKAGE, options.packageName]],
        options.profile,
        false,
      );
      preview.set(TEMPLATE_REPORT, null);
      preview.set(`etc/${names.apiReport}`, report.text);
    }
    if (write) {
      renameSync(reportFrom, reportTo);
    }
    changed.push(`${TEMPLATE_REPORT} -> etc/${names.apiReport}`);
  }

  if (options.profile !== "node-cli") {
    for (const relative of ["src/cli.ts", "src/bin.ts", "tests/cli.test.ts"]) {
      const target = path.join(root, relative);
      if (existsSync(target)) {
        if (write) {
          rmSync(target);
        }
        if (preview !== undefined) {
          preview.set(relative, null);
        }
        changed.push(`${relative} (removed)`);
      }
    }
  }

  for (const relative of ["tests/bootstrap.test.ts", "scripts/verify-bootstrap.mjs"]) {
    const target = path.join(root, relative);
    if (existsSync(target)) {
      if (write) {
        rmSync(target);
      }
      if (preview !== undefined) {
        preview.set(relative, null);
      }
      changed.push(`${relative} (removed)`);
    }
  }

  changed.push(
    ...replaceTargets(
      root,
      replacements,
      options.profile,
      `etc/${names.apiReport}`,
      write,
      preview,
    ),
  );

  const manifestPath = path.join(root, "package.json");
  const manifest = readObject(manifestPath);
  manifest["name"] = options.packageName;
  manifest["description"] = options.description;
  manifest["license"] = options.license;
  manifest["author"] = `${options.author} <${options.email}>`;
  manifest["repository"] = {
    type: "git",
    url: `git+https://github.com/${repository}.git`,
  };
  manifest["bugs"] = { url: `https://github.com/${repository}/issues` };
  manifest["homepage"] = `https://github.com/${repository}#readme`;
  const scripts = readKey(manifest, "scripts");
  if (typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)) {
    delete (/** @type {Record<string, unknown>} */ (scripts)["bootstrap:e2e"]);
  }
  if (options.profile === "node-cli") {
    manifest["bin"] = { [options.binName ?? names.unscoped]: "./dist/bin.js" };
    manifest["sideEffects"] = ["./dist/bin.js"];
  } else {
    delete manifest["bin"];
    manifest["sideEffects"] = false;
  }
  if (options.profile === "universal-library") {
    delete manifest["engines"];
  } else {
    manifest["engines"] = { node: ">=22.14" };
  }
  if (write) {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  if (preview !== undefined) {
    preview.set("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  }
  changed.push("package.json");

  const buildConfigPath = path.join(root, "tsconfig.build.json");
  let buildConfig = readFileSync(buildConfigPath, "utf8");
  if (options.profile === "universal-library") {
    buildConfig = buildConfig.replace(
      /^ {4}"types": \["node"\]$/m,
      '    "types": [],\n    "lib": ["ES2023", "DOM", "DOM.Iterable"]',
    );
  }
  if (write) {
    writeFileSync(buildConfigPath, buildConfig);
  }
  if (preview !== undefined) {
    preview.set("tsconfig.build.json", buildConfig);
  }
  changed.push("tsconfig.build.json");

  if (options.license === "ISC") {
    if (write) {
      writeFileSync(path.join(root, "LICENSE"), iscLicense(options.author, year));
    }
    if (preview !== undefined) {
      preview.set("LICENSE", iscLicense(options.author, year));
    }
    changed.push("LICENSE");
  } else {
    const licensePath = path.join(root, "LICENSE");
    const license = readFileSync(licensePath, "utf8");
    const copyrightYear = /^Copyright \(c\) \d{4} /m;
    if (!copyrightYear.test(license)) {
      throw new BootstrapError(
        "ERR_LICENSE_YEAR",
        "MIT license has no replaceable copyright year.\n" +
          "Expected: `Copyright (c) <year> <author>`\n" +
          "Next: restore the standard MIT copyright line, then rerun bootstrap.",
      );
    }
    const dated = license.replace(copyrightYear, `Copyright (c) ${String(year)} `);
    if (write) {
      writeFileSync(licensePath, dated);
    }
    if (preview !== undefined) {
      preview.set(
        "LICENSE",
        dated.replaceAll(TEMPLATE_AUTHOR, () => options.author),
      );
    }
    changed.push("LICENSE");
  }

  return [...new Set(changed)].sort();
}

/**
 * Refuse a second run and validate the source package shape.
 *
 * @param {string} root
 */
function assertTemplate(root) {
  if (!existsSync(path.join(root, "docs", "template-implementation"))) {
    throw new BootstrapError(
      "ERR_ALREADY_BOOTSTRAPPED",
      "template implementation documents are absent; this repository was already bootstrapped.",
    );
  }
  const manifest = readObject(path.join(root, "package.json"));
  const currentName = readString(manifest, "name");
  if (currentName !== TEMPLATE_PACKAGE) {
    throw new BootstrapError(
      "ERR_ALREADY_BOOTSTRAPPED",
      `expected template package ${TEMPLATE_PACKAGE}, found ${currentName ?? "no name"}.`,
    );
  }
}

/**
 * Find any placeholder remaining in the explicit generated targets.
 *
 * @param {string} root
 * @param {string} [packageName]
 * @param {Map<string, string | null>} [preview]
 * @returns {string[]}
 */
export function findPlaceholders(root, packageName, preview) {
  let reportPath = TEMPLATE_REPORT;
  if (packageName !== undefined) {
    reportPath = `etc/${deriveNames(packageName).apiReport}`;
  } else {
    const manifestPath = path.join(root, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = readObject(manifestPath);
      const currentName = readString(manifest, "name");
      if (currentName !== undefined) {
        reportPath = `etc/${deriveNames(currentName).apiReport}`;
      }
    }
  }
  const targets = new Set(PLACEHOLDER_TARGETS.map(({ file }) => file));
  targets.add(reportPath);

  /** @type {string[]} */
  const found = [];
  for (const relative of targets) {
    const absolute = path.join(root, relative);
    if (preview?.has(relative)) {
      const text = preview.get(relative);
      if (text === null || text === undefined) {
        continue;
      }
      for (const placeholder of PLACEHOLDERS) {
        if (text.includes(placeholder)) {
          found.push(`${relative}: ${placeholder}`);
        }
      }
      continue;
    }
    if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink()) {
      continue;
    }
    const buffer = readFileSync(absolute);
    if (buffer.includes(0)) {
      continue;
    }
    const text = buffer.toString("utf8");
    for (const placeholder of PLACEHOLDERS) {
      if (text.includes(placeholder)) {
        found.push(`${relative}: ${placeholder}`);
      }
    }
  }
  return found;
}

/**
 * Bootstrap the repository in place.
 *
 * @param {string} root
 * @param {ReturnType<typeof parseArguments>} options
 * @param {object} [context] - Injectable run context for deterministic tests.
 * @param {number} [context.year] - Copyright year; defaults to the current UTC year.
 * @returns {string[]}
 */
export function bootstrap(
  root,
  options,
  context = { year: new Date().getUTCFullYear() },
) {
  assertTemplate(root);
  const year = context.year ?? new Date().getUTCFullYear();
  /** @type {Map<string, string | null> | undefined} */
  const preview = options.dryRun ? new Map() : undefined;
  const changed = transform(root, options, year, preview);

  const placeholders = findPlaceholders(root, options.packageName, preview);
  if (placeholders.length > 0) {
    throw new BootstrapError(
      "ERR_PLACEHOLDER_REMAINING",
      `generated repository still contains placeholders:\n${placeholders.join("\n")}`,
    );
  }
  assertGeneratedAiLayer(root, options.profile, preview);
  return changed;
}

/**
 * Open the real terminal prompt used by the command-line entry point.
 *
 * @returns {Promise<ReturnType<typeof parseArguments>>}
 */
async function interactiveArguments() {
  if (!process.stdin.isTTY) {
    const answers = readFileSync(0, "utf8").split(/\r?\n/);
    let index = 0;
    return promptArguments((prompt) => {
      process.stdout.write(prompt);
      return Promise.resolve(answers[index++] ?? "");
    });
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await promptArguments((prompt) => readline.question(prompt));
  } finally {
    readline.close();
  }
}

/**
 * Collect command-line or interactive input and run bootstrap.
 *
 * @param {readonly string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  try {
    const options =
      argv.length === 0 ? await interactiveArguments() : parseArguments(argv);
    const changed = bootstrap(process.cwd(), options);
    console.log(
      options.dryRun
        ? `Dry run: ${String(changed.length)} path(s) would change.`
        : `Bootstrapped ${options.packageName} as ${options.profile}.`,
    );
    for (const file of changed) {
      console.log(`- ${file}`);
    }
    console.log(
      options.dryRun
        ? "No repository files were changed."
        : "Next: run `pnpm install --frozen-lockfile`, then `pnpm check`.",
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    console.error(USAGE);
    return error instanceof BootstrapError ? 2 : 1;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
