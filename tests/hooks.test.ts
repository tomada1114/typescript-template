import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { evaluate } from "../.claude/hooks/guard.mjs";
import {
  CHECKS,
  checkCommand,
  hasRelevantChanges,
} from "../.claude/hooks/stop-check.mjs";
import { readKey, readString } from "../scripts/lib/json.mjs";

// Claude Code hooks are separate processes that read a JSON payload on stdin
// and answer with an exit code, so the cases below drive the real executables
// the way Claude Code does. The pure helpers are also imported directly, which
// is what makes a failure point at the rule that broke instead of at "exit 2".
//
// Secret-shaped fixtures are assembled from fragments rather than written out.
// A literal token or key header in this file would be a real finding for every
// secret scanner pointed at the repository — and guard.mjs would refuse to let
// an agent write this file at all.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const hooksDir = path.join(repoRoot, ".claude", "hooks");

interface HookResult {
  status: number;
  stderr: string;
}

/** Run one hook the way Claude Code runs it: payload on stdin, answer as an exit code. */
function runHook(hook: string, payload: unknown, cwd: string = repoRoot): HookResult {
  const result = spawnSync(process.execPath, [path.join(hooksDir, hook)], {
    cwd,
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status ?? 1, stderr: result.stderr };
}

/** A PreToolUse payload for an Edit or Write call. */
function writePayload(filePath: string, content?: string): unknown {
  return {
    tool_name: "Write",
    tool_input:
      content === undefined
        ? { file_path: filePath }
        : { file_path: filePath, content },
  };
}

/** A PreToolUse payload for a Bash call. */
function bashPayload(command: string): unknown {
  return { tool_name: "Bash", tool_input: { command } };
}

describe("guard: calls that must be allowed", () => {
  // Completion condition 4 of spec 02 §8: ordinary development finishes without
  // anyone reaching for a bypass. Every one of these is ordinary development.
  const allowed: [string, unknown][] = [
    [
      "editing a source file",
      writePayload("src/identifier.ts", "export const a = 1;\n"),
    ],
    ["writing the env example", writePayload(".env.example", "API_TOKEN=\n")],
    ["reading the env example", bashPayload("cat .env.example")],
    ["a conventional commit", bashPayload('git commit -m "feat: add x"')],
    ["a commit with clustered -am", bashPayload('git commit -am "feat: add x"')],
    [
      "a message containing shell operators",
      bashPayload('git commit -m "chore: a && b"'),
    ],
    [
      "a lease-checked force push",
      bashPayload("git push --force-with-lease origin feature"),
    ],
    [
      "a lease-checked force push in a chain",
      bashPayload("git push --force-with-lease origin feature && echo ok"),
    ],
    ["an ordinary push", bashPayload("git push origin feature")],
    ["running the tests", bashPayload("pnpm test")],
    ["running the full gate", bashPayload("pnpm check")],
    ["packing a tarball", bashPayload("pnpm pack --pack-destination .smoke")],
    ["installing dependencies", bashPayload("pnpm install --frozen-lockfile")],
    [
      "reading a source file",
      { tool_name: "Read", tool_input: { file_path: "src/index.ts" } },
    ],
  ];

  it.each(allowed)("allows %s", (_label, payload) => {
    expect(runHook("guard.mjs", payload).status).toBe(0);
  });
});

describe("guard: calls that must be blocked", () => {
  const blocked: [string, unknown, RegExp][] = [
    [
      "editing the lockfile",
      writePayload("pnpm-lock.yaml"),
      /pnpm-lock\.yaml is generated/,
    ],
    [
      "redirecting into the lockfile",
      bashPayload("echo x > pnpm-lock.yaml"),
      /pnpm-lock\.yaml is generated/,
    ],
    [
      "appending to the lockfile without a space",
      bashPayload("echo x >>pnpm-lock.yaml"),
      /pnpm-lock\.yaml is generated/,
    ],
    ["writing a dotenv file", writePayload(".env", "API_TOKEN=live\n"), /\.env\*/],
    [
      "writing a staged dotenv file",
      writePayload(".env.production", "API_TOKEN=live\n"),
      /\.env\*/,
    ],
    ["reading a dotenv file", bashPayload("cat .env"), /\.env\*/],
    [
      "reading a dotenv file through a pipe",
      bashPayload("grep TOKEN .env | head -1"),
      /\.env\*/,
    ],
    ["copying a dotenv file away", bashPayload("cp .env /tmp/leak"), /\.env\*/],
    ["reading a dotenv file by redirect", bashPayload("base64 <.env"), /\.env\*/],
    ["writing under secrets/", writePayload("secrets/token.txt", "value"), /secrets\//],
    [
      "reading under secrets/",
      { tool_name: "Read", tool_input: { file_path: "secrets/token.txt" } },
      /secrets\//,
    ],
    [
      "skipping the commit hooks",
      bashPayload('git commit --no-verify -m "x"'),
      /--no-verify/,
    ],
    [
      "skipping the commit hooks with a cluster",
      bashPayload('git commit -nm "x"'),
      /--no-verify/,
    ],
    [
      "skipping the hooks from a subdirectory",
      bashPayload('git -C packages/a commit --no-verify -m "x"'),
      /--no-verify/,
    ],
    [
      "skipping the hooks through the environment",
      bashPayload('LEFTHOOK=0 git commit -m "x"'),
      /environment/,
    ],
    [
      "skipping the push gate",
      bashPayload("git push --no-verify origin main"),
      /--no-verify/,
    ],
    ["a plain force push", bashPayload("git push --force origin main"), /force-push/],
    ["a clustered force push", bashPayload("git push -f origin main"), /force-push/],
    [
      "a force push after a passing test run",
      bashPayload("pnpm test && git push --force origin main"),
      /force-push/,
    ],
    ["publishing with npm", bashPayload("npm publish"), /releases to the registry/],
    [
      "publishing with pnpm",
      bashPayload("pnpm publish --dry-run"),
      /releases to the registry/,
    ],
    [
      "publishing through a script",
      bashPayload("pnpm run publish"),
      /releases to the registry/,
    ],
    [
      "dispatching a workflow",
      bashPayload("gh workflow run release.yml"),
      /Dispatching a workflow/,
    ],
    [
      "creating a GitHub release",
      bashPayload("gh release create v1.0.0"),
      /publishing/,
    ],
    [
      "deleting a security workflow",
      bashPayload("rm .github/workflows/codeql.yml"),
      /quality or supply-chain gate/,
    ],
    [
      "deleting the lockfile",
      bashPayload("rm -f pnpm-lock.yaml"),
      /pnpm-lock\.yaml is generated/,
    ],
  ];

  it.each(blocked)("blocks %s", (_label, payload, reason) => {
    const result = runHook("guard.mjs", payload);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(reason);
  });

  it("blocks removing a gate marker through an absolute file_path", () => {
    // Claude Code always sends an absolute file_path for Edit/Write. Gate-file
    // detection is anchored against a path relative to the repository root
    // (isGateFile in scripts/lib/guard/gates.mjs), so this only catches the
    // removal when that absolute path is resolved back to a relative one
    // first — the regression this guards against left every Edit/Write call
    // to a gate file unchecked.
    const result = runHook("guard.mjs", {
      tool_name: "Edit",
      tool_input: {
        file_path: path.join(repoRoot, "eslint.config.mjs"),
        old_string: "reportUnusedDisableDirectives",
        new_string: "// removed",
      },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/unused-disable check/);
  });

  it.each([
    [
      "the repository-root lockfile",
      writePayload(path.join(repoRoot, "pnpm-lock.yaml")),
      /pnpm-lock\.yaml is generated/,
    ],
    [
      "the repository-root dotenv file",
      { tool_name: "Read", tool_input: { file_path: path.join(repoRoot, ".env") } },
      /\.env\*/,
    ],
  ])("blocks %s from a non-root cwd", (_label, payload, reason) => {
    const result = runHook("guard.mjs", payload, path.join(repoRoot, "src"));
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(reason);
  });
});

/**
 * Assemble a secret-shaped fixture at run time.
 *
 * @remarks
 * A function call is what keeps the fragments apart. Writing them as adjacent
 * string literals instead would let ESLint's autofix fold them back into one
 * literal, putting a scannable secret shape into a tracked file — which is
 * exactly what the rule under test exists to prevent.
 */
function secretShaped(...parts: string[]): string {
  return parts.join("");
}

describe("guard: credentials", () => {
  const npmToken = secretShaped("npm_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8");
  const authTokenLine = secretShaped("//registry.npmjs.org/:_auth", "Token=", npmToken);

  it("blocks writing a registry auth token into an npmrc", () => {
    const result = runHook("guard.mjs", writePayload(".npmrc", `${authTokenLine}\n`));
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/auth token/);
  });

  it("blocks appending a registry auth token from the shell", () => {
    const result = runHook(
      "guard.mjs",
      bashPayload(`echo "${authTokenLine}" >> .npmrc`),
    );
    expect(result.status).toBe(2);
  });

  it("allows an npmrc that only configures a registry", () => {
    const result = runHook(
      "guard.mjs",
      writePayload(".npmrc", "registry=https://registry.npmjs.org/\n"),
    );
    expect(result.status).toBe(0);
  });
});

// Pure-function coverage for the rule engine itself — checkCredentials,
// checkGateRemoval, segments, shortClusterHas, writtenFiles, and friends —
// lives in tests/guard-rules.test.ts. What stays here is the integration
// contract: that .claude/hooks/guard.mjs, run as a real process against a
// real payload, produces the right exit code.
describe("guard: dispatch", () => {
  it("evaluates an unknown tool as harmless", () => {
    expect(
      evaluate({ tool_name: "Glob", tool_input: { pattern: "**/*.ts" } }),
    ).toBeNull();
  });

  it("treats an unreadable payload as harmless", () => {
    expect(runHook("guard.mjs", "this is not json").status).toBe(0);
  });
});

describe("format hook", () => {
  // The format hook rewrites the file it is given, so it is never pointed at a
  // tracked source file: a test suite that reformats the working tree on the
  // way past is a surprise nobody asked for. The scratch directory sits under
  // `tests/` so that the file is inside the tsconfig program — typed lint needs
  // that — but outside Vitest's `*.test.ts` collection glob. It is deliberately
  // *not* in .gitignore: Prettier honours .gitignore by default, so an ignored
  // scratch file would be silently skipped and prove nothing.
  const scratchDir = path.join(repoRoot, "tests", "tmp-hooks");

  beforeAll(() => {
    // Also clears anything a previous, hard-killed run left behind.
    rmSync(scratchDir, { recursive: true, force: true });
    mkdirSync(scratchDir, { recursive: true });
  });
  afterAll(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it("is a no-op for a file it does not format", () => {
    expect(runHook("format.mjs", writePayload("docs/example.txt")).status).toBe(0);
  });

  it("is a no-op for a file that does not exist", () => {
    expect(runHook("format.mjs", writePayload("src/absent.ts")).status).toBe(0);
  });

  it("is a no-op for a path outside the repository", () => {
    expect(
      runHook("format.mjs", writePayload(path.join(repoRoot, "..", "elsewhere.ts")))
        .status,
    ).toBe(0);
  });

  it("is a no-op for a generated file both tools ignore", () => {
    // dist/ is in ESLint's global ignores and in .gitignore, which Prettier
    // reads too. Neither tool should turn that into a reported failure.
    expect(runHook("format.mjs", writePayload("dist/index.js")).status).toBe(0);
  });

  it("is a no-op when the payload carries no file path", () => {
    expect(runHook("format.mjs", { tool_name: "Write", tool_input: {} }).status).toBe(
      0,
    );
  });

  it("lints and formats the one file it was given", () => {
    const target = path.join(scratchDir, "sample.ts");
    writeFileSync(target, "export const value   =    1\n", "utf8");

    expect(runHook("format.mjs", writePayload(target)).status).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("export const value = 1;\n");
  });

  it("leaves a sibling file in the same directory untouched", () => {
    const target = path.join(scratchDir, "edited.ts");
    const sibling = path.join(scratchDir, "untouched.ts");
    const original = "export const other   =    2\n";
    writeFileSync(target, "export const value   =    1\n", "utf8");
    writeFileSync(sibling, original, "utf8");

    expect(runHook("format.mjs", writePayload(target)).status).toBe(0);
    // Formatting one edited file must not turn into a whole-tree pass.
    expect(readFileSync(sibling, "utf8")).toBe(original);
  });
});

describe("stop-check hook", () => {
  it("does not run again once it has already blocked one stop", () => {
    // Without this the hook would block, be re-entered, and block again forever.
    expect(runHook("stop-check.mjs", { stop_hook_active: true }).status).toBe(0);
  });

  it("treats an unreadable payload as harmless", () => {
    expect(runHook("stop-check.mjs", "this is not json").status).toBe(0);
  });

  it.each([
    [" M src/index.ts", true],
    ["?? scripts/tool.mjs", true],
    [" M package.json", true],
    [" M tsconfig.build.json", true],
    ["R  tests/old.ts -> tests/new.ts", true],
    [" M README.md", false],
    [" M .github/workflows/ci.yml", false],
    ["", false],
  ])("decides on %j that the gate is needed: %s", (line, expected) => {
    expect(hasRelevantChanges(line)).toBe(expected);
  });

  it("runs exactly what `pnpm check:quick` runs", () => {
    // Completion condition 3 of spec 02 §8: the local hook, the package script
    // and CI must never disagree about the same change. They cannot, as long as
    // this holds.
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    );
    const scripts = readKey(manifest, "scripts");

    const expand = (name: string): string[] => {
      const body = readString(scripts, name);
      expect(body, `package.json has no "${name}" script`).toBeTypeOf("string");
      return (body ?? "").split("&&").flatMap((part) => {
        const trimmed = part.trim();
        const nested = /^pnpm run (\S+)$/.exec(trimmed);
        return nested?.[1] === undefined ? [trimmed] : expand(nested[1]);
      });
    };

    expect(CHECKS.map(checkCommand)).toEqual(expand("check:quick"));
  });
});
