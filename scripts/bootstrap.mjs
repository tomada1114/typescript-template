#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import console from "node:console";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { isolatedGitEnv } from "./lib/git-env.mjs";
import { isMain } from "./lib/is-main.mjs";
import { classifyCopyPath, describeLinkTarget } from "./lib/symlinks.mjs";
import { parseJson, readKey, readString } from "./lib/json.mjs";

const TEMPLATE_PACKAGE = "my-package";
const PROFILES = new Set(["node-library", "node-cli", "universal-library"]);
const LICENSES = new Set(["MIT", "ISC"]);
const PLACEHOLDERS = [
  "my-package",
  "your-name",
  "Your Name",
  "you@example.com",
  "A short description.",
];
const EXCLUDED_PARTS = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".cache",
  ".eslintcache",
  ".package",
  ".smoke",
  ".attw",
  "temp",
]);
const RESERVED_NAMES = new Set(["node_modules", "favicon.ico"]);

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
const AI_LAYER_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);
const REMOVED_TEMPLATE_PATHS = [
  "docs/template-requirements",
  "docs/template-implementation",
];
const REMOVED_CLI_REFERENCES =
  /(?:src\/cli\.ts|src\/bin\.ts|tests\/cli\.test\.ts|cli\.ts|bin\.ts|runCli|CliIo|dist\/bin\.js)/;

const USAGE = `Usage: node scripts/bootstrap.mjs <package-name> [options]

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
    description: values.get("--description") ?? "A TypeScript package.",
    dryRun,
  };
}

/**
 * Return repository files eligible for transformation.
 *
 * @param {string} root
 * @returns {string[]}
 */
function projectFiles(root) {
  const git = spawnSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    timeout: 30_000,
    env: isolatedGitEnv(),
  });
  if (git.status === 0) {
    return git.stdout
      .split("\0")
      .filter(Boolean)
      .map(normalizeRelativePath)
      .filter((relative) => isCopyablePath(root, relative));
  }

  /** @type {string[]} */
  const files = [];
  /** @param {string} directory */
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = normalizeRelativePath(path.relative(root, absolute));
      const parts = relative.split("/");
      if (
        relative === "docs/api" ||
        relative.startsWith("docs/api/") ||
        parts.some((part) => EXCLUDED_PARTS.has(part)) ||
        parts.some((part) => part === ".env" || part.startsWith(".env."))
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        visit(absolute);
      } else {
        files.push(relative);
      }
    }
  };
  visit(root);
  return files.filter((relative) => isCopyablePath(root, relative)).sort();
}

/**
 * Report whether a candidate path belongs in the copy set, refusing a symlink
 * that points nowhere rather than skipping it as absent.
 *
 * @param {string} root
 * @param {string} relative
 * @returns {boolean}
 */
function isCopyablePath(root, relative) {
  const state = classifyCopyPath(path.join(root, relative));
  if (state.kind === "dangling") {
    throw new BootstrapError(
      "ERR_BROKEN_SYMLINK",
      `Link: ${relative}\n` +
        "Expected: the symlink target to exist.\n" +
        `Actual: missing target ${describeLinkTarget(state.target)}.\n` +
        "Next: restore the target or remove the link, then rerun `node scripts/bootstrap.mjs` with the same arguments.",
    );
  }
  return state.kind === "present";
}

/**
 * Copy files without following symlinks.
 *
 * @param {string} sourceRoot
 * @param {string} destinationRoot
 * @param {readonly string[]} files
 */
function copyFiles(sourceRoot, destinationRoot, files) {
  for (const relative of files) {
    const source = path.join(sourceRoot, relative);
    const destination = path.join(destinationRoot, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) {
      // Unlike copyFileSync below, symlinkSync fails with EEXIST rather than
      // overwriting — this branch can run more than once at the same
      // destination (bootstrap copies root -> staged -> root again).
      rmSync(destination, { force: true, recursive: true });
      symlinkSync(readlinkSync(source), destination);
      continue;
    }
    copyFileSync(source, destination);
    chmodSync(destination, stat.mode);
  }
}

/**
 * Replace placeholders in UTF-8 text and leave binary files unchanged.
 *
 * @param {string} file
 * @param {readonly [string, string][]} replacements
 * @param {string} profile
 * @returns {boolean}
 */
function replaceText(file, replacements, profile) {
  const buffer = readFileSync(file);
  if (buffer.includes(0)) {
    return false;
  }
  const original = buffer.toString("utf8");
  if (Buffer.from(original, "utf8").compare(buffer) !== 0) {
    return false;
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
    updated = updated.replaceAll(before, after);
  }
  if (updated === original) {
    return false;
  }
  writeFileSync(file, updated);
  return true;
}

/**
 * Return the generated AI-native instruction files.
 *
 * @remarks
 * `AI_LAYER_FILES` is matched by basename, not the full relative path, so a
 * subdirectory master such as `tests/AGENTS.md` is included alongside the
 * root pair. A symlink — `.agents/skills/**` bridges into `.claude/skills/**`
 * — is excluded: it is scanned at its real path already, and `readFileSync`
 * on a symlink to a directory throws.
 *
 * @param {string} root
 * @returns {string[]}
 */
function aiLayerFiles(root) {
  return projectFiles(root).filter((relative) => {
    if (lstatSync(path.join(root, relative)).isSymbolicLink()) {
      return false;
    }
    return (
      AI_LAYER_FILES.has(path.basename(relative)) ||
      relative.startsWith(".claude/") ||
      relative.startsWith(".agents/")
    );
  });
}

/**
 * Verify that generated instructions do not describe template-only or
 * profile-incompatible paths.
 *
 * @param {string} root
 * @param {string} profile
 */
function assertGeneratedAiLayer(root, profile) {
  /** @type {string[]} */
  const problems = [];
  for (const relative of aiLayerFiles(root)) {
    const file = path.join(root, relative);
    const buffer = readFileSync(file);
    if (buffer.includes(0)) {
      continue;
    }
    const text = buffer.toString("utf8");
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
 * Apply profile and metadata changes inside a disposable copy.
 *
 * @param {string} root
 * @param {ReturnType<typeof parseArguments>} options
 * @param {number} year
 * @returns {string[]}
 */
function transform(root, options, year) {
  const names = deriveNames(options.packageName);
  const repository = `${options.githubUser}/${names.unscoped}`;
  /** @type {[string, string][]} */
  const replacements = [
    [`your-name/my-package`, repository],
    [`Usage: my-package`, `Usage: ${options.binName ?? names.unscoped}`],
    ["my-package", options.packageName],
    ["your-name", options.githubUser],
    ["Your Name", options.author],
    ["you@example.com", options.email],
    ["A short description.", options.description],
  ];
  /** @type {string[]} */
  const changed = [];

  for (const relative of REMOVED_TEMPLATE_PATHS) {
    const target = path.join(root, relative);
    if (existsSync(target)) {
      rmSync(target, { recursive: true });
      changed.push(`${relative}/ (removed)`);
    }
  }

  const changesetDirectory = path.join(root, ".changeset");
  if (existsSync(changesetDirectory)) {
    for (const entry of readdirSync(changesetDirectory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md") {
        rmSync(path.join(changesetDirectory, entry.name));
        changed.push(`.changeset/${entry.name} (removed)`);
      }
    }
  }

  const reportFrom = path.join(root, "etc", `${TEMPLATE_PACKAGE}.api.md`);
  const reportTo = path.join(root, "etc", names.apiReport);
  if (reportFrom !== reportTo && existsSync(reportTo)) {
    throw new BootstrapError(
      "ERR_RENAME_DESTINATION",
      `API report destination already exists: etc/${names.apiReport}`,
    );
  }
  if (existsSync(reportFrom) && reportFrom !== reportTo) {
    renameSync(reportFrom, reportTo);
    changed.push(`etc/${TEMPLATE_PACKAGE}.api.md -> etc/${names.apiReport}`);
  }

  if (options.profile !== "node-cli") {
    for (const relative of ["src/cli.ts", "src/bin.ts", "tests/cli.test.ts"]) {
      const target = path.join(root, relative);
      if (existsSync(target)) {
        rmSync(target);
        changed.push(`${relative} (removed)`);
      }
    }
  }

  for (const relative of ["tests/bootstrap.test.ts", "scripts/verify-bootstrap.mjs"]) {
    const target = path.join(root, relative);
    if (existsSync(target)) {
      rmSync(target);
      changed.push(`${relative} (removed)`);
    }
  }

  for (const relative of projectFiles(root)) {
    const absolute = path.join(root, relative);
    if (lstatSync(absolute).isSymbolicLink()) {
      continue;
    }
    if (replaceText(absolute, replacements, options.profile)) {
      changed.push(relative);
    }
  }

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
  // `packageManager` stays in the generated manifest. Corepack and Dependabot
  // read it and both need an exact version; without it, Dependabot's pnpm
  // updates fail against the `devEngines.packageManager` declaration.
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
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  changed.push("package.json");

  const buildConfigPath = path.join(root, "tsconfig.build.json");
  let buildConfig = readFileSync(buildConfigPath, "utf8");
  if (options.profile === "universal-library") {
    buildConfig = buildConfig.replace(
      /^ {4}"types": \["node"\]$/m,
      '    "types": [],\n    "lib": ["ES2023", "DOM", "DOM.Iterable"]',
    );
  }
  writeFileSync(buildConfigPath, buildConfig);
  changed.push("tsconfig.build.json");

  if (options.license === "ISC") {
    writeFileSync(path.join(root, "LICENSE"), iscLicense(options.author, year));
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
    writeFileSync(licensePath, dated);
    changed.push("LICENSE");
  }

  return [...new Set(changed)].sort();
}

/**
 * Verify toolchain metadata and regenerate the lockfile in the disposable copy.
 *
 * @param {string} root
 */
function regenerateLockfile(root) {
  const manifestPath = path.join(root, "package.json");
  const manifestText = readFileSync(manifestPath, "utf8");
  const manifest = readObject(manifestPath);
  const packageManager = readKey(readKey(manifest, "devEngines"), "packageManager");
  // Exact, not a range: pnpm warns on every command when this string differs
  // from the top-level `packageManager` field, and both must stay pinned to
  // the version the lockfile resolved.
  const declared = readString(packageManager, "version");
  const topLevel = readString(manifest, "packageManager");
  const lockfile = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
  const resolved = /pnpm:\s*\n\s*specifier:\s*([^\s]+)\s*\n\s*version:\s*([^\s]+)/.exec(
    lockfile,
  );
  if (
    declared !== "11.18.0" ||
    topLevel !== "pnpm@11.18.0" ||
    resolved?.[1] !== "11.18.0" ||
    resolved[2] !== "11.18.0"
  ) {
    throw new BootstrapError(
      "ERR_PACKAGE_MANAGER_MISMATCH",
      "packageManager, devEngines.packageManager and the lockfile pnpm resolution must all agree on pnpm 11.18.0.\n" +
        `Expected: packageManager "pnpm@11.18.0", devEngines.packageManager.version "11.18.0"\n` +
        `Actual: packageManager ${topLevel ?? "missing"}, devEngines.packageManager.version ${declared ?? "missing"}, lockfile ${resolved?.[2] ?? "missing"}\n` +
        "Next: restore the pinned versions in package.json, then rerun bootstrap.",
    );
  }
  const result = spawnSync(
    "corepack",
    ["pnpm@11.18.0", "--config.runtime-on-fail=ignore", "install", "--lockfile-only"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 300_000,
      env: {
        ...process.env,
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        // The version to run is supplied in argv and was validated against
        // the manifest and the lockfile immediately above, so Corepack has no
        // reason to re-derive it from the project it is about to rewrite.
        COREPACK_ENABLE_PROJECT_SPEC: "0",
      },
    },
  );
  // Corepack and pnpm may materialize their effective project settings in the
  // manifest. Bootstrap owns package.json and this step owns only the lockfile,
  // so restore the already-validated manifest byte-for-byte.
  writeFileSync(manifestPath, manifestText);
  if (result.status !== 0) {
    throw new BootstrapError(
      "ERR_LOCKFILE_GENERATION",
      `pnpm install --lockfile-only failed.\n${result.stdout.trim()}\n${result.stderr.trim()}\nNext: verify pnpm 11.18.0 is available, then rerun bootstrap.`,
    );
  }
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
 * Find any placeholder remaining in generated UTF-8 files.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function findPlaceholders(root) {
  /** @type {string[]} */
  const found = [];
  for (const relative of projectFiles(root)) {
    const absolute = path.join(root, relative);
    if (lstatSync(absolute).isSymbolicLink()) {
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
 * Bootstrap the repository transactionally.
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
  const files = projectFiles(root);
  const year = context.year ?? new Date().getUTCFullYear();
  const workspace = mkdtempSync(path.join(tmpdir(), "typescript-template-bootstrap-"));
  const staged = path.join(workspace, "repository");
  mkdirSync(staged);
  try {
    copyFiles(root, staged, files);
    const changed = transform(staged, options, year);
    if (!options.dryRun) {
      regenerateLockfile(staged);
    }
    const placeholders = findPlaceholders(staged);
    if (placeholders.length > 0) {
      throw new BootstrapError(
        "ERR_PLACEHOLDER_REMAINING",
        `generated repository still contains placeholders:\n${placeholders.join("\n")}`,
      );
    }
    assertGeneratedAiLayer(staged, options.profile);
    if (options.dryRun) {
      return changed;
    }

    const stagedFiles = projectFiles(staged);
    const backup = path.join(workspace, "backup");
    mkdirSync(backup);
    copyFiles(root, backup, files);
    try {
      for (const relative of REMOVED_TEMPLATE_PATHS) {
        rmSync(path.join(root, relative), { recursive: true, force: true });
      }
      for (const relative of files) {
        if (!stagedFiles.includes(relative)) {
          rmSync(path.join(root, relative), { force: true });
        }
      }
      copyFiles(staged, root, stagedFiles);
    } catch (error) {
      for (const relative of new Set([...files, ...stagedFiles])) {
        rmSync(path.join(root, relative), { force: true });
      }
      copyFiles(backup, root, files);
      throw error;
    }
    return changed;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/**
 * @param {readonly string[]} argv
 * @returns {number}
 */
export function main(argv) {
  try {
    const options = parseArguments(argv);
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
        : "Next: run `corepack pnpm@11.18.0 install --frozen-lockfile`, then `pnpm check`.",
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
  process.exitCode = main(process.argv.slice(2));
}
