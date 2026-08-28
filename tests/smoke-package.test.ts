import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

import type * as NodeTools from "../scripts/lib/node-tools.mjs";

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

// scripts/smoke-package.mjs's checkRuntimeImports/checkRequireInterop/
// checkDeepImportBlocked/checkTypeScriptConsumers all write a generated
// script into a throwaway consumer directory and then run it through
// runNode(). Mocking runNode at the subprocess boundary (AGENTS.md's Testing
// conventions) exercises both outcomes of each check without installing a
// real tarball or compiling a real TypeScript project for every case.
// checkTarballContents (the other half of this file) already has real-fixture
// coverage in tests/package.test.ts from #83.
const runNodeMock =
  vi.fn<
    (
      script: string,
      args: readonly string[],
      options?: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => RunResult
  >();

vi.mock("../scripts/lib/node-tools.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeTools>();
  return {
    ...actual,
    runNode: (
      script: string,
      args: readonly string[],
      options?: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => runNodeMock(script, args, options),
  };
});

const {
  checkDeepImportBlocked,
  checkRequireInterop,
  checkRuntimeImports,
  checkTypeScriptConsumers,
  compileTypeScriptConsumer,
  isUniversalProfile,
} = await import("../scripts/smoke-package.mjs");
const { repoRoot } = await import("../scripts/lib/node-tools.mjs");

const workspaces: string[] = [];

function makeConsumer(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "smoke-package-test-"));
  workspaces.push(dir);
  return dir;
}

let stdoutSpy: MockInstance<typeof process.stdout.write>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  while (workspaces.length > 0) {
    const dir = workspaces.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("checkRuntimeImports", () => {
  it("passes and reports stdout when every subpath imports cleanly", () => {
    runNodeMock.mockReturnValue({ status: 0, stdout: "  ./ -> a, b\n", stderr: "" });
    const consumer = makeConsumer();

    expect(() => checkRuntimeImports(consumer, "fixture-package", [""])).not.toThrow();
    expect(stdoutSpy).toHaveBeenCalledWith("  ./ -> a, b\n");
  });

  it("throws ERR_SMOKE_IMPORT_FAILED, naming every subpath, when an import fails", () => {
    runNodeMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "Cannot find module",
    });
    const consumer = makeConsumer();

    expect(() =>
      checkRuntimeImports(consumer, "fixture-package", ["", "/sub"]),
    ).toThrow(/ERR_SMOKE_IMPORT_FAILED[\s\S]*fixture-package, fixture-package\/sub/);
  });
});

describe("checkRequireInterop", () => {
  it("passes when require() resolves the package and its package.json subpath", () => {
    runNodeMock.mockReturnValue({ status: 0, stdout: "  ok\n", stderr: "" });
    const consumer = makeConsumer();

    expect(() => checkRequireInterop(consumer, "fixture-package")).not.toThrow();
    expect(stdoutSpy).toHaveBeenCalledWith("  ok\n");
  });

  it("throws ERR_SMOKE_REQUIRE_FAILED when require() cannot resolve the package", () => {
    runNodeMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "ERR_PACKAGE_PATH_NOT_EXPORTED",
    });
    const consumer = makeConsumer();

    expect(() => checkRequireInterop(consumer, "fixture-package")).toThrow(
      /ERR_SMOKE_REQUIRE_FAILED/,
    );
  });
});

describe("checkDeepImportBlocked", () => {
  it("passes when the deep import is correctly refused", () => {
    runNodeMock.mockReturnValue({ status: 0, stdout: "  refused\n", stderr: "" });
    const consumer = makeConsumer();

    expect(() => checkDeepImportBlocked(consumer, "fixture-package")).not.toThrow();
  });

  it("throws ERR_SMOKE_DEEP_IMPORT_ALLOWED when the private module is reachable", () => {
    runNodeMock.mockReturnValue({ status: 1, stdout: "", stderr: "AssertionError" });
    const consumer = makeConsumer();

    expect(() => checkDeepImportBlocked(consumer, "fixture-package")).toThrow(
      /ERR_SMOKE_DEEP_IMPORT_ALLOWED/,
    );
  });
});

describe("compileTypeScriptConsumer", () => {
  it("returns the tsc --listFiles output on success", () => {
    runNodeMock.mockReturnValue({ status: 0, stdout: "/some/file.d.ts\n", stderr: "" });
    const consumer = makeConsumer();

    expect(compileTypeScriptConsumer(consumer, "fixture-package", "NodeNext")).toBe(
      "/some/file.d.ts\n",
    );
    expect(runNodeMock).toHaveBeenCalledWith(
      expect.stringContaining("typescript"),
      ["-p", "tsconfig.json", "--listFiles"],
      expect.objectContaining({ cwd: path.join(consumer, "ts-nodenext") }),
    );
  });

  it("throws ERR_SMOKE_CONSUMER_TSC_FAILED when the consumer does not compile", () => {
    runNodeMock.mockReturnValue({ status: 2, stdout: "", stderr: "error TS2307" });
    const consumer = makeConsumer();

    expect(() =>
      compileTypeScriptConsumer(consumer, "fixture-package", "NodeNext"),
    ).toThrow(/ERR_SMOKE_CONSUMER_TSC_FAILED/);
  });
});

describe("isUniversalProfile", () => {
  it("reflects this repository's own node-library profile", () => {
    // tsconfig.build.json sets compilerOptions.types to ["node"], not the
    // empty array that signals the universal-library profile, so this
    // repository is Node profile — which is what the checkTypeScriptConsumers
    // tests below rely on to skip the Bundler-resolution consumer.
    expect(isUniversalProfile()).toBe(false);
  });
});

describe("checkTypeScriptConsumers", () => {
  it("compiles only the NodeNext consumer for a Node profile and passes when nothing leaks", () => {
    runNodeMock.mockReturnValue({
      status: 0,
      stdout: [
        path.join(repoRoot, "node_modules", "fixture-package", "dist", "index.d.ts"),
        path.join(repoRoot, "node_modules", "typescript", "lib", "lib.es2023.d.ts"),
      ].join("\n"),
      stderr: "",
    });
    const consumer = makeConsumer();

    expect(() => checkTypeScriptConsumers(consumer, "fixture-package")).not.toThrow();
    // Node profile: only the NodeNext consumer compiles, never Bundler.
    expect(runNodeMock).toHaveBeenCalledTimes(1);
  });

  it("throws ERR_SMOKE_CONSUMER_READ_REPOSITORY when the compiler read this repository's src/", () => {
    runNodeMock.mockReturnValue({
      status: 0,
      stdout: [
        path.join(repoRoot, "src", "index.ts"),
        path.join(repoRoot, "node_modules", "fixture-package", "dist", "index.d.ts"),
      ].join("\n"),
      stderr: "",
    });
    const consumer = makeConsumer();

    expect(() => checkTypeScriptConsumers(consumer, "fixture-package")).toThrow(
      /ERR_SMOKE_CONSUMER_READ_REPOSITORY/,
    );
  });

  it("throws ERR_SMOKE_CONSUMER_READ_REPOSITORY when the compiler read this repository's dist/", () => {
    runNodeMock.mockReturnValue({
      status: 0,
      stdout: path.join(repoRoot, "dist", "index.js"),
      stderr: "",
    });
    const consumer = makeConsumer();

    expect(() => checkTypeScriptConsumers(consumer, "fixture-package")).toThrow(
      /ERR_SMOKE_CONSUMER_READ_REPOSITORY/,
    );
  });

  it("propagates ERR_SMOKE_CONSUMER_TSC_FAILED when the NodeNext consumer fails to compile", () => {
    runNodeMock.mockReturnValue({ status: 2, stdout: "", stderr: "error TS2307" });
    const consumer = makeConsumer();

    expect(() => checkTypeScriptConsumers(consumer, "fixture-package")).toThrow(
      /ERR_SMOKE_CONSUMER_TSC_FAILED/,
    );
  });
});
