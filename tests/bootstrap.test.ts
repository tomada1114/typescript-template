import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { isolatedGitEnv } from "../scripts/lib/git-env.mjs";
import {
  BootstrapError,
  bootstrap,
  deriveNames,
  findPlaceholders,
  normalizeRelativePath,
  parseArguments,
  validatePackageName,
} from "../scripts/bootstrap.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaces: string[] = [];

function copyTemplate(withGit = true): string {
  const workspace = mkdtempSync(path.join(tmpdir(), "typescript-template-test-"));
  workspaces.push(workspace);
  const result = execFileSync(
    "git",
    ["-C", repoRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8", env: isolatedGitEnv() },
  );
  for (const relative of result.split("\0").filter(Boolean)) {
    const source = path.join(repoRoot, relative);
    if (!existsSync(source)) {
      continue;
    }
    const destination = path.join(workspace, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    // `recursive: true` is required for `cpSync` to accept a symlink whose
    // target is a directory (`.agents/skills/merge-dependabot`) at all, even
    // though `dereference: false` means it copies the symlink itself rather
    // than descending into what it points at. `verbatimSymlinks: true` keeps
    // that symlink's relative target relative — without it `cpSync` rewrites
    // the target to an absolute path back into this checkout, which would
    // make the copied workspace's bridge point outside itself.
    cpSync(source, destination, {
      dereference: false,
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  const binary = path.join(workspace, "tests", "fixtures", "binary.dat");
  mkdirSync(path.dirname(binary), { recursive: true });
  writeFileSync(
    binary,
    Buffer.from([0, 255, 1, 2, 109, 121, 45, 112, 97, 99, 107, 97, 103, 101]),
  );

  if (withGit) {
    execFileSync("git", ["init", "-q"], { cwd: workspace, env: isolatedGitEnv() });
    execFileSync("git", ["add", "-A"], { cwd: workspace, env: isolatedGitEnv() });
  }
  return workspace;
}

function relativeFiles(root: string, directory: string): string[] {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      // A symlink (`.agents/skills/merge-dependabot` bridges into
      // `.claude/skills/**`, already covered by that walk) is not followed:
      // reading it here would resolve to a directory and throw.
      if (entry.isSymbolicLink()) {
        continue;
      }
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else {
        files.push(path.relative(root, absolute));
      }
    }
  };
  visit(path.join(root, directory));
  return files.sort();
}

/**
 * Subdirectory AI-layer masters. `bootstrap.mjs` finds these by matching
 * `AI_LAYER_FILES` against the basename at any depth; this list is the
 * explicit enumeration of what that match currently selects outside the root,
 * and must be extended when a new subdirectory master is added.
 */
const AI_LAYER_SUBDIR_FILES = ["tests/AGENTS.md", "tests/CLAUDE.md"];

function generatedAiLayer(root: string): string {
  const files = [
    "AGENTS.md",
    "CLAUDE.md",
    ...AI_LAYER_SUBDIR_FILES,
    ...relativeFiles(root, ".claude"),
    ...relativeFiles(root, ".agents"),
  ];
  return files.map((file) => readFileSync(path.join(root, file), "utf8")).join("\n");
}

function aiLayerFiles(root: string): string[] {
  return [
    "AGENTS.md",
    "CLAUDE.md",
    ...AI_LAYER_SUBDIR_FILES,
    ...relativeFiles(root, ".claude"),
    ...relativeFiles(root, ".agents"),
  ];
}

function options(
  packageName: string,
  profile: "node-library" | "node-cli" | "universal-library",
  extra: string[] = [],
): ReturnType<typeof parseArguments> {
  return parseArguments([
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
    ...extra,
  ]);
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

describe("bootstrap validation", () => {
  it.each([
    "",
    "../evil",
    "Uppercase",
    "@scope",
    "@scope/",
    "name with spaces",
    "node_modules",
    "a".repeat(215),
  ])("rejects invalid package name %j", (name) => {
    expect(() => validatePackageName(name)).toThrow(BootstrapError);
  });

  it("derives safe names for a scoped package", () => {
    expect(deriveNames("@acme/widgets")).toEqual({
      unscoped: "widgets",
      identifier: "widgets",
      apiReport: "widgets.api.md",
      tarball: "acme-widgets",
    });
  });

  it("normalizes Windows separators without accepting traversal", () => {
    expect(normalizeRelativePath(".\\docs\\reference.md")).toBe("docs/reference.md");
    expect(() => validatePackageName("..\\evil")).toThrow(BootstrapError);
  });

  it("allows optional description and bin metadata to be omitted", () => {
    const parsed = options("acme-library", "node-library");
    expect(parsed.description).toBe("A TypeScript package.");
    expect(parsed.binName).toBeUndefined();
  });

  it("rejects unknown options instead of silently ignoring them", () => {
    expect(() =>
      parseArguments([
        "acme-library",
        "--profile",
        "node-library",
        "--author",
        "Ada Lovelace",
        "--email",
        "ada@example.com",
        "--github-user",
        "ada",
        "--license",
        "MIT",
        "--typo",
        "value",
      ]),
    ).toThrow(/ERR_ARGUMENT_UNKNOWN/);
  });
});

describe("bootstrap profiles", () => {
  it.each([
    ["acme-library", "node-library"],
    ["@acme/widgets", "node-cli"],
    ["browser-kit", "universal-library"],
  ] as const)("generates %s as %s", (packageName, profile) => {
    const root = copyTemplate();
    const binaryBefore = readFileSync(
      path.join(root, "tests", "fixtures", "binary.dat"),
    );
    const stableAiFiles = aiLayerFiles(root)
      .filter(
        (file) =>
          file.startsWith(".claude/hooks/") || file.startsWith(".claude/skills/"),
      )
      .map((file) => [file, readFileSync(path.join(root, file), "utf8")] as const);
    bootstrap(
      root,
      options(
        packageName,
        profile,
        profile === "node-cli" ? ["--bin-name", "widgets"] : [],
      ),
    );

    const manifest = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as {
      name: string;
      packageManager?: string;
      dependencies?: Record<string, string>;
      bin?: Record<string, string>;
      devEngines: { runtime: { onFail: string } };
      engines?: Record<string, string>;
      sideEffects: false | string[];
      repository: { url: string };
    };
    expect(manifest.name).toBe(packageName);
    // Corepack and Dependabot read this field and both need an exact version.
    expect(manifest.packageManager).toBe("pnpm@11.18.0");
    expect(manifest.devEngines.runtime.onFail).toBe("error");
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.repository.url).not.toContain("@acme/");
    expect(findPlaceholders(root)).toEqual([]);
    expect(readFileSync(path.join(root, "tests", "fixtures", "binary.dat"))).toEqual(
      binaryBefore,
    );
    expect(existsSync(path.join(root, "docs", "template-implementation"))).toBe(false);
    expect(relativeFiles(root, ".changeset")).toEqual([
      ".changeset/README.md",
      ".changeset/config.json",
    ]);
    expect(readFileSync(path.join(root, "README.md"), "utf8")).not.toContain(
      "Use this template",
    );

    const aiText = generatedAiLayer(root);
    expect(aiText).not.toMatch(/docs\/template-(?:requirements|implementation)/);
    if (profile === "node-cli") {
      expect(aiText).toContain("src/cli.ts");
      expect(aiText).toContain("src/bin.ts");
      expect(aiText).toContain("tests/cli.test.ts");
      expect(aiText).toContain("runCli");
      expect(aiText).toContain("CliIo");
      expect(aiText).toContain("dist/bin.js");
    } else {
      expect(aiText).not.toMatch(
        /(?:cli\.ts|bin\.ts|runCli|CliIo|dist\/bin\.js|tests\/cli\.test\.ts)/,
      );
    }

    for (const [file, contents] of stableAiFiles) {
      expect(readFileSync(path.join(root, file), "utf8")).toBe(contents);
    }
    expect(existsSync(path.join(root, ".claude", "hooks", "guard.mjs"))).toBe(true);
    expect(existsSync(path.join(root, ".claude", "hooks", "format.mjs"))).toBe(true);
    expect(existsSync(path.join(root, ".claude", "hooks", "stop-check.mjs"))).toBe(
      true,
    );
    const dependabotBridge = path.join(root, ".agents", "skills", "merge-dependabot");
    expect(lstatSync(dependabotBridge).isSymbolicLink()).toBe(true);
    expect(existsSync(dependabotBridge)).toBe(true);
    const dependabotSkill = readFileSync(
      path.join(root, ".claude", "skills", "merge-dependabot", "SKILL.md"),
      "utf8",
    );
    expect(dependabotSkill).toContain(".github/PULL_REQUEST_TEMPLATE.md");
    expect(existsSync(path.join(root, ".github", "PULL_REQUEST_TEMPLATE.md"))).toBe(
      true,
    );
    expect(
      existsSync(path.join(root, ".github", "workflows", "check-pr-title.yml")),
    ).toBe(true);
    expect(
      readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8"),
    ).not.toContain("bootstrap:e2e");
    expect(
      existsSync(
        path.join(
          root,
          ".claude",
          "skills",
          "merge-dependabot",
          "scripts",
          "survey-prs.mjs",
        ),
      ),
    ).toBe(true);
    expect(existsSync(path.join(root, "scripts", "lib", "is-main.mjs"))).toBe(true);
    expect(existsSync(path.join(root, "scripts", "lib", "json.mjs"))).toBe(true);

    const hasCli = profile === "node-cli";
    expect(existsSync(path.join(root, "src", "cli.ts"))).toBe(hasCli);
    expect(existsSync(path.join(root, "src", "bin.ts"))).toBe(hasCli);
    expect(existsSync(path.join(root, "tests", "cli.test.ts"))).toBe(hasCli);
    expect(manifest.bin !== undefined).toBe(hasCli);
    expect(manifest.sideEffects).toEqual(hasCli ? ["./dist/bin.js"] : false);

    const buildConfig = readFileSync(path.join(root, "tsconfig.build.json"), "utf8");
    if (profile === "universal-library") {
      expect(buildConfig).toContain('"types": []');
      expect(buildConfig).toContain('"DOM"');
      expect(manifest.engines).toBeUndefined();
    } else {
      expect(buildConfig).toContain('"types": ["node"]');
      expect(manifest.engines).toEqual({ node: ">=22.14" });
    }

    const report = path.join(
      root,
      "etc",
      `${deriveNames(packageName).unscoped}.api.md`,
    );
    expect(existsSync(report)).toBe(true);
  });

  it("uses the filtered walk outside a Git repository", () => {
    const root = copyTemplate(false);
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", "untouched.txt"), "my-package");
    bootstrap(root, options("walked-library", "node-library"));
    expect(readFileSync(path.join(root, "node_modules", "untouched.txt"), "utf8")).toBe(
      "my-package",
    );
    expect(findPlaceholders(root)).toEqual([]);
  });

  it("makes dry-run non-mutating", () => {
    const root = copyTemplate();
    const before = readFileSync(path.join(root, "package.json"), "utf8");
    const changed = bootstrap(root, {
      ...options("dry-library", "node-library"),
      dryRun: true,
    });
    expect(changed.length).toBeGreaterThan(0);
    expect(readFileSync(path.join(root, "package.json"), "utf8")).toBe(before);
    expect(existsSync(path.join(root, "docs", "template-implementation"))).toBe(true);
  });

  it("refuses an existing API report destination", () => {
    const root = copyTemplate();
    writeFileSync(path.join(root, "etc", "widgets.api.md"), "occupied");
    execFileSync("git", ["add", "etc/widgets.api.md"], {
      cwd: root,
      env: isolatedGitEnv(),
    });
    expect(() => bootstrap(root, options("widgets", "node-library"))).toThrow(
      /ERR_RENAME_DESTINATION/,
    );
  });

  it("does not apply any files when lockfile validation fails", () => {
    const root = copyTemplate();
    const manifestBefore = readFileSync(path.join(root, "package.json"), "utf8");
    const lockfilePath = path.join(root, "pnpm-lock.yaml");
    writeFileSync(
      lockfilePath,
      readFileSync(lockfilePath, "utf8").replaceAll(
        "specifier: 11.18.0",
        "specifier: 11.17.0",
      ),
    );
    expect(() => bootstrap(root, options("atomic-library", "node-library"))).toThrow(
      /ERR_PACKAGE_MANAGER_MISMATCH/,
    );
    expect(readFileSync(path.join(root, "package.json"), "utf8")).toBe(manifestBefore);
    expect(existsSync(path.join(root, "docs", "template-implementation"))).toBe(true);
  });

  it("keeps package metadata and the license text in sync", () => {
    const root = copyTemplate();
    const isc = parseArguments([
      "licensed-package",
      "--profile",
      "node-library",
      "--author",
      "Ada Lovelace",
      "--email",
      "ada@example.com",
      "--github-user",
      "ada",
      "--license",
      "ISC",
    ]);
    bootstrap(root, isc, { year: 2030 });
    const manifest = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { license: string };
    expect(manifest.license).toBe("ISC");
    expect(readFileSync(path.join(root, "LICENSE"), "utf8")).toContain(
      'THE SOFTWARE IS PROVIDED "AS IS"',
    );
    expect(readFileSync(path.join(root, "LICENSE"), "utf8")).toContain(
      "Copyright 2030 Ada Lovelace",
    );
  });

  it("uses the injected year in the generated MIT license", () => {
    const root = copyTemplate();
    bootstrap(root, options("mit-package", "node-library"), { year: 2042 });

    expect(readFileSync(path.join(root, "LICENSE"), "utf8")).toContain(
      "Copyright (c) 2042 Ada Lovelace",
    );
  });

  it("refuses a second run without changing generated files", () => {
    const root = copyTemplate();
    bootstrap(root, options("once-only", "node-library"));
    const before = readFileSync(path.join(root, "package.json"), "utf8");
    expect(() => bootstrap(root, options("twice", "node-library"))).toThrow(
      /ERR_ALREADY_BOOTSTRAPPED/,
    );
    expect(readFileSync(path.join(root, "package.json"), "utf8")).toBe(before);
  });
});
