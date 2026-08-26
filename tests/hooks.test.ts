import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { evaluate } from "../.claude/hooks/guard.mjs";
import { fromPayload } from "../.claude/hooks/payload.mjs";
import {
  CHECKS,
  STOP_EVENTS,
  checkCommand,
  hasRelevantChanges,
} from "../.claude/hooks/stop-check.mjs";
import { readKey, readString } from "../scripts/lib/json.mjs";

// Agent hooks are separate processes that read a JSON payload on stdin and
// answer with an exit code, so the cases below drive the real executables the
// way Claude Code does. The pure helpers are also imported directly, which
// is what makes a failure point at the rule that broke instead of at "exit 2".
//
// Secret-shaped fixtures are assembled from fragments rather than written out.
// A literal token or key header in this file would be a real finding for every
// secret scanner pointed at the repository — and guard.mjs would refuse to let
// an agent write this file at all.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const hooksDir = path.join(repoRoot, ".claude", "hooks");
const hookFixturesDir = path.join(repoRoot, "tests", "fixtures", "hooks");

interface HookResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run one hook the way Claude Code does: payload on stdin, answer as an exit code. */
function runHook(hook: string, payload: unknown, cwd: string = repoRoot): HookResult {
  const eventName =
    hook === "guard.mjs"
      ? "PreToolUse"
      : hook === "format.mjs"
        ? "PostToolUse"
        : "Stop";
  const input =
    typeof payload === "object" && payload !== null
      ? { cwd, hook_event_name: eventName, ...payload }
      : payload;
  const result = spawnSync(process.execPath, [path.join(hooksDir, hook)], {
    cwd,
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
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

/** Read a checked-in host payload fixture. */
function hookFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(hookFixturesDir, name), "utf8"));
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
      "writing a git hook",
      writePayload(".git/hooks/pre-commit", "#!/bin/sh\nexit 0\n"),
      /Git plumbing/,
    ],
    [
      "rewriting the git config",
      writePayload(".git/config", "[core]\n\thooksPath = /dev/null\n"),
      /Git plumbing/,
    ],
    [
      "redirecting into a git hook",
      bashPayload("echo 'exit 0' > .git/hooks/pre-push"),
      /Git plumbing/,
    ],
    [
      "granting itself permissions in the local settings file",
      writePayload(".claude/settings.local.json", '{ "permissions": {} }'),
      /personal permission grants/,
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

  it.each(["claude-edit.json", "claude-bash.json"])(
    "allows the ordinary %s fixture",
    (fixture) => {
      expect(runHook("guard.mjs", hookFixture(fixture)).status).toBe(0);
    },
  );

  it("blocks a gate removal spelled as a MultiEdit", () => {
    // The PreToolUse matcher routes MultiEdit here, and its hunks live in
    // `edits` rather than in a top-level old_string/new_string pair. Reading
    // only the Edit spelling made every content check silently no-op for it.
    const result = runHook("guard.mjs", {
      tool_name: "MultiEdit",
      tool_input: {
        file_path: path.join(repoRoot, "eslint.config.mjs"),
        edits: [
          { old_string: "// a comment", new_string: "// another comment" },
          { old_string: "reportUnusedDisableDirectives", new_string: "// removed" },
        ],
      },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/unused-disable check/);
  });

  it("blocks a NotebookEdit targeting a protected path", () => {
    // NotebookEdit names its target `notebook_path`, so a guard reading only
    // `file_path` had nothing to judge and let the call through.
    const result = runHook("guard.mjs", {
      tool_name: "NotebookEdit",
      tool_input: {
        notebook_path: path.join(repoRoot, "secrets", "keys.ipynb"),
        new_source: "print('hi')",
      },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/secrets\//);
  });

  it("blocks the protected claude-bash-noverify.json fixture", () => {
    expect(runHook("guard.mjs", hookFixture("claude-bash-noverify.json")).status).toBe(
      2,
    );
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
  // The name is unique per run, not a fixed path: `.claude/hooks/stop-check.mjs`
  // runs `vitest run`, so this suite re-enters itself, and Stop and
  // SubagentStop can each start a run while another is still in flight. A
  // shared directory is deleted out from under whichever run created it —
  // either before the fixture is written (ENOENT) or between the write and
  // ESLint's own read, which reports "no files matching" and fails the hook.
  // The flip side is that a hard-killed run leaves its own directory behind,
  // which is the safe failure: deleting a sibling run's fixtures is not.
  let scratchDir = "";

  beforeAll(() => {
    scratchDir = mkdtempSync(path.join(repoRoot, "tests", "tmp-hooks-"));
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

    const result = runHook("format.mjs", writePayload(target));
    // The hook reports what it could not fix on stderr; surfacing it here is
    // what makes a failure point at the rule rather than at "exit 2".
    expect(result.status, `format hook reported: ${result.stderr}`).toBe(0);
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
    ["claude-stop.json", "Stop"],
    ["claude-subagent-stop.json", "SubagentStop"],
  ])(
    "recognizes the already-continued %s fixture without looping",
    (fixture, eventName) => {
      const event = fromPayload(hookFixture(fixture));
      expect(event.name).toBe(eventName);
      expect(event.stopHookActive).toBe(false);
      const result = runHook("stop-check.mjs", {
        hook_event_name: event.name,
        stop_hook_active: true,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    },
  );

  it("answers SubagentStop as well as Stop", () => {
    // A subagent edits the same working tree the main agent does, so handing
    // work back is a stop that has to clear the same gate.
    expect([...STOP_EVENTS].sort()).toEqual(["Stop", "SubagentStop"]);
  });

  it("ignores an event it was not wired for", () => {
    const result = runHook("stop-check.mjs", { hook_event_name: "SessionEnd" });
    expect(result.status).toBe(0);
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

/** Top-level keys of a value that came out of `JSON.parse`. */
function topLevelKeys(value: unknown): string[] {
  return typeof value === "object" && value !== null ? Object.keys(value) : [];
}

/** Read a property that must be an array of strings. */
function readStringArray(value: unknown, key: string): string[] {
  const read = readKey(value, key);
  return Array.isArray(read) ? read.filter((item) => typeof item === "string") : [];
}

/** Every `command` string wired to one lifecycle event, across all matchers. */
function hookCommands(config: unknown, event: string): string[] {
  const entries = readKey(readKey(config, "hooks"), event);
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.flatMap((entry: unknown) => {
    const commands = readKey(entry, "hooks");
    return Array.isArray(commands)
      ? commands.flatMap((hook: unknown) => {
          const command = readString(hook, "command");
          return command === undefined ? [] : [command];
        })
      : [];
  });
}

/** Every `matcher` pattern wired to one lifecycle event. */
function hookMatchers(config: unknown, event: string): string[] {
  const entries = readKey(readKey(config, "hooks"), event);
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.flatMap((entry: unknown) => {
    const matcher = readString(entry, "matcher");
    return matcher === undefined ? [] : [matcher];
  });
}

describe("shared settings", () => {
  const settings: unknown = JSON.parse(
    readFileSync(path.join(repoRoot, ".claude", "settings.json"), "utf8"),
  );
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );

  it("holds nothing but the shared configuration", () => {
    // Every repository generated from this template inherits this file, so a
    // personal preference here is a preference imposed on all of them.
    // CLAUDE.md: model, output style, marketplaces, plugins and extra
    // permissions belong in the gitignored .claude/settings.local.json.
    expect(
      topLevelKeys(settings).sort(),
      "personal preferences belong in .claude/settings.local.json (see CLAUDE.md)",
    ).toEqual(["$schema", "hooks", "permissions"]);
  });

  it.each([
    ["PreToolUse", ["Edit", "MultiEdit", "NotebookEdit", "Write"]],
    ["PostToolUse", ["Edit", "MultiEdit", "NotebookEdit", "Write"]],
  ])("routes every file-editing tool into the %s hook", (event, tools) => {
    // payload.mjs recognizes all of these as edits. A matcher that leaves one
    // out makes that support unreachable rather than merely unused.
    const matchers = hookMatchers(settings, event).map((source) => new RegExp(source));
    for (const tool of tools) {
      expect(
        matchers.some((matcher) => matcher.test(tool)),
        `${event} does not route ${tool} to a hook`,
      ).toBe(true);
    }
  });

  it("fails the guard closed when it cannot run at all", () => {
    // Claude Code treats a non-zero exit other than 2 as a *non-blocking*
    // error, so a guard that dies before it can decide would let the call
    // through. `|| exit 2` is what turns "could not decide" into "blocked".
    for (const command of hookCommands(settings, "PreToolUse")) {
      expect(command, "a PreToolUse guard must not fail open").toMatch(/\|\| exit 2$/);
    }
  });

  it("does not fail the stop gate closed", () => {
    // The mirror image of the rule above: a stop hook that can never exit 0 is
    // a turn that can never end, so this one stays fail-open on its own crash.
    for (const event of STOP_EVENTS) {
      const commands = hookCommands(settings, event);
      expect(commands, `${event} is not wired`).not.toEqual([]);
      for (const command of commands) {
        expect(command).not.toMatch(/exit 2/);
      }
    }
  });

  it("wires every hook command to a script that actually exists", () => {
    // The one regression this move could plausibly introduce: a hook whose
    // script is missing exits non-zero-but-not-2, so a stale path is treated
    // as non-blocking instead of failing loudly.
    const events = ["PreToolUse", "PostToolUse", "Stop", "SubagentStop"];
    const commands = events.flatMap((event) => hookCommands(settings, event));
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      const match = /"([^"]+\.claude\/hooks\/[^"]+\.mjs)"/.exec(command);
      expect(match, `no .claude/hooks/*.mjs path found in: ${command}`).not.toBeNull();
      const resolved = (match?.[1] ?? "").replace("${CLAUDE_PROJECT_DIR}", repoRoot);
      expect(existsSync(resolved), `${resolved} does not exist`).toBe(true);
    }
  });

  it("allows every package script in both spellings", () => {
    // A new script must come with an allowlist decision: either it is safe to
    // run unattended and gets both entries, or it is listed here with why.
    const exceptions = new Map([
      ["test:watch", "a watcher never exits, so an agent must not start one"],
      ["changeset", "interactive TUI; only the --empty form is pre-approved"],
    ]);
    const allow = new Set(readStringArray(readKey(settings, "permissions"), "allow"));
    const scripts = topLevelKeys(readKey(manifest, "scripts"));

    expect(
      scripts.filter(
        (name) =>
          !exceptions.has(name) &&
          !(allow.has(`Bash(pnpm ${name})`) && allow.has(`Bash(pnpm run ${name})`)),
      ),
      "add `Bash(pnpm <name>)` and `Bash(pnpm run <name>)` to .claude/settings.json, or an exception with a reason",
    ).toEqual([]);
    // A script that was renamed or dropped must not leave a stale excuse here.
    expect([...exceptions.keys()].filter((name) => !scripts.includes(name))).toEqual(
      [],
    );
  });
});
