import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { isolatedGitEnv } from "../scripts/lib/git-env.mjs";
import { assertCopyable, copyTemplate } from "../scripts/verify-bootstrap.mjs";

// This suite itself runs from a git hook (`lefthook.yml` runs `test:related`
// on pre-commit), and git hands a hook GIT_DIR. `copyTemplate` already spawns
// git through `isolatedGitEnv()`, but the fixture repositories below still
// call `git init`/`git add` directly, so those calls need the same isolation —
// see scripts/lib/git-env.mjs and tests/git-env.test.ts.
const directories: string[] = [];

/** A fresh, empty git repository to copy from, isolated from the surrounding one. */
function makeSourceRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "verify-bootstrap-source-"));
  directories.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir, env: isolatedGitEnv() });
  return dir;
}

/** An empty directory to copy into. */
function makeDestination(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "verify-bootstrap-dest-"));
  directories.push(dir);
  return dir;
}

/** Stage a relative path in the fixture repository. */
function stage(source: string, relative: string): void {
  execFileSync("git", ["add", relative], { cwd: source, env: isolatedGitEnv() });
}

afterEach(() => {
  while (directories.length > 0) {
    const dir = directories.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("copyTemplate", () => {
  it("copies an ordinary tracked file", () => {
    const source = makeSourceRepo();
    const destination = makeDestination();
    writeFileSync(path.join(source, "kept.txt"), "hello\n");
    stage(source, "kept.txt");

    copyTemplate(destination, source);

    expect(readFileSync(path.join(destination, "kept.txt"), "utf8")).toBe("hello\n");
  });

  it("skips a stale index entry whose file was removed without a commit", () => {
    const source = makeSourceRepo();
    const destination = makeDestination();
    const removed = path.join(source, "removed.txt");
    writeFileSync(removed, "gone\n");
    stage(source, "removed.txt");
    rmSync(removed);

    expect(() => copyTemplate(destination, source)).not.toThrow();
    expect(existsSync(path.join(destination, "removed.txt"))).toBe(false);
  });

  it("refuses a tracked dangling symlink instead of silently skipping it", () => {
    const source = makeSourceRepo();
    const destination = makeDestination();
    symlinkSync("does-not-exist", path.join(source, "dangling-link"));
    stage(source, "dangling-link");

    expect(() => copyTemplate(destination, source)).toThrow(
      /ERR_BOOTSTRAP_UNSUPPORTED_ENTRY/,
    );
    expect(existsSync(path.join(destination, "dangling-link"))).toBe(false);
  });

  it("refuses a tracked symlink to a directory instead of throwing a bare EISDIR", () => {
    const source = makeSourceRepo();
    const destination = makeDestination();
    mkdirSync(path.join(source, "real-dir"));
    symlinkSync("real-dir", path.join(source, "link-to-dir"), "dir");
    stage(source, "link-to-dir");

    expect(() => copyTemplate(destination, source)).toThrow(
      /ERR_BOOTSTRAP_UNSUPPORTED_ENTRY/,
    );
  });

  // `git`'s own untracked-file walk drops a genuine socket before it ever
  // reaches `ls-files --others` (confirmed against the git this suite runs
  // under: neither `ls-files --others` nor `git add` will surface one), so
  // this exercises `assertCopyable` directly rather than through
  // `copyTemplate`. It reproduces the shape of the failure found while
  // shipping #67 — an untracked `.pnpm-store/` holding a unix socket, where
  // the old `existsSync` guard let a bare ENOTSUP take down the suite — for
  // whichever entry point a non-regular file does reach this check through.
  it.skipIf(process.platform === "win32")(
    "refuses a non-regular file such as a unix socket",
    async () => {
      const source = makeSourceRepo();
      const socketPath = path.join(source, "untracked.sock");
      const server = createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, resolve);
        });

        expect(() => assertCopyable(socketPath, "untracked.sock")).toThrow(
          /ERR_BOOTSTRAP_UNSUPPORTED_ENTRY/,
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});

describe("assertCopyable", () => {
  it("returns true for a regular file", () => {
    const source = makeSourceRepo();
    const file = path.join(source, "kept.txt");
    writeFileSync(file, "hello\n");

    expect(assertCopyable(file, "kept.txt")).toBe(true);
  });

  it("returns false for a path that no longer exists", () => {
    const source = makeSourceRepo();

    expect(assertCopyable(path.join(source, "missing.txt"), "missing.txt")).toBe(false);
  });
});
