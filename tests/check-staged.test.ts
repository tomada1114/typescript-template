import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkStagedChange, main, stagedChanges } from "../scripts/check-staged.mjs";

// scripts/check-staged.mjs is the pre-commit layer described in AGENTS.md's
// "Enforcement layers": it sees a staged git diff, not a tool call, so these
// tests drive it against a real throwaway repository rather than mocking git.
const repos: string[] = [];

/** A fresh, empty git repository with a local identity, isolated from real user config. */
function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "check-staged-test-"));
  repos.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

/** Write a file, stage it, and return the repo-relative path for convenience. */
function stage(dir: string, relativePath: string, content: string): string {
  const absolute = path.join(dir, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
  execFileSync("git", ["add", relativePath], { cwd: dir });
  return relativePath;
}

/** Commit whatever is currently staged, so a later change has a HEAD to diff against. */
function commit(dir: string, message = "initial"): void {
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir });
}

afterEach(() => {
  while (repos.length > 0) {
    const dir = repos.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("stagedChanges", () => {
  it("reports an added file as status A", () => {
    const dir = makeRepo();
    stage(dir, "notes.md", "hello\n");
    expect(stagedChanges(dir)).toEqual([{ status: "A", path: "notes.md" }]);
  });

  it("reports a deleted file as status D", () => {
    const dir = makeRepo();
    stage(dir, "notes.md", "hello\n");
    commit(dir);
    execFileSync("git", ["rm", "-q", "notes.md"], { cwd: dir });
    expect(stagedChanges(dir)).toEqual([{ status: "D", path: "notes.md" }]);
  });

  it("reports nothing when the index matches HEAD", () => {
    const dir = makeRepo();
    stage(dir, "notes.md", "hello\n");
    commit(dir);
    expect(stagedChanges(dir)).toEqual([]);
  });
});

describe("checkStagedChange", () => {
  it("blocks staging a real .env file", () => {
    const dir = makeRepo();
    const change = { status: "A", path: stage(dir, ".env", "API_TOKEN=live\n") };
    expect(checkStagedChange(change, dir)).toMatch(/must not be committed/);
  });

  it("allows staging a .env.example file", () => {
    const dir = makeRepo();
    const change = { status: "A", path: stage(dir, ".env.example", "API_TOKEN=\n") };
    expect(checkStagedChange(change, dir)).toBeNull();
  });

  it("blocks a staged file that embeds a credential", () => {
    const dir = makeRepo();
    const key = ["-----BEGIN RSA ", "PRIVATE ", "KEY-----"].join("");
    const change = { status: "A", path: stage(dir, "notes.txt", `${key}\n`) };
    expect(checkStagedChange(change, dir)).toMatch(/private key/);
  });

  it("blocks removing a gate marker from a gate file", () => {
    const dir = makeRepo();
    stage(dir, "eslint.config.mjs", "reportUnusedDisableDirectives\n");
    commit(dir);
    const change = {
      status: "M",
      path: stage(dir, "eslint.config.mjs", "// removed\n"),
    };
    expect(checkStagedChange(change, dir)).toMatch(/unused-disable check/);
  });

  it("blocks deleting a gate file outright", () => {
    const dir = makeRepo();
    stage(dir, "package.json", "{}\n");
    commit(dir);
    execFileSync("git", ["rm", "-q", "package.json"], { cwd: dir });
    const change = { status: "D", path: "package.json" };
    expect(checkStagedChange(change, dir)).toMatch(/quality or supply-chain gate/);
  });

  it("allows a re-generated lockfile", () => {
    // The pre-commit layer deliberately does not check lockfile content —
    // only the Claude Code guard hook, which sees the tool call that produced
    // it, can tell a hand edit apart from `pnpm install`'s own output. See
    // AGENTS.md's "Enforcement layers".
    const dir = makeRepo();
    stage(dir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    commit(dir);
    const change = {
      status: "M",
      path: stage(dir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\npackages: {}\n"),
    };
    expect(checkStagedChange(change, dir)).toBeNull();
  });

  it("allows an ordinary source change", () => {
    const dir = makeRepo();
    const change = {
      status: "A",
      path: stage(dir, "src/example.ts", "export const value = 1;\n"),
    };
    expect(checkStagedChange(change, dir)).toBeNull();
  });
});

describe("main", () => {
  it("returns 0 when nothing staged is unsafe", () => {
    const dir = makeRepo();
    stage(dir, "src/example.ts", "export const value = 1;\n");
    expect(main(dir)).toBe(0);
  });

  it("returns 1 when a staged change is blocked", () => {
    const dir = makeRepo();
    stage(dir, ".env", "API_TOKEN=live\n");
    expect(main(dir)).toBe(1);
  });
});
