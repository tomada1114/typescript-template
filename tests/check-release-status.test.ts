import consoleModule from "node:console";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ReleaseStatusError,
  main,
  registryStatus,
} from "../scripts/check-release-status.mjs";
import * as nodeTools from "../scripts/lib/node-tools.mjs";

const directories: string[] = [];

function makeRoot(
  manifest: unknown = {
    name: "release-fixture",
    version: "1.2.3",
    publishConfig: { registry: "https://registry.npmjs.org/" },
  },
): string {
  const root = mkdtempSync(path.join(tmpdir(), "release-status-"));
  directories.push(root);
  writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
  return root;
}

afterEach(() => {
  for (const root of directories.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("registryStatus", () => {
  it("recognizes the exact published version", () => {
    expect(
      registryStatus({ status: 0, stdout: '"1.2.3"\n', stderr: "" }, "1.2.3"),
    ).toBe(true);
  });

  it("recognizes only an explicit missing-version response as unpublished", () => {
    expect(
      registryStatus(
        { status: 1, stdout: '{"error":{"code":"E404"}}', stderr: "npm error E404" },
        "1.2.3",
      ),
    ).toBe(false);
  });

  it.each([
    [1, ""],
    [1, "registry unreachable"],
    [1, '{"error":{"code":"E401"}}'],
    [1, '{"error":{"code":"E500"}}'],
    [1, '{"error":{"code":"EBADDEVENGINES"}}'],
    [0, '"1.2.4"'],
    [0, "[]"],
    [0, '{"error":{"code":"E404"}}'],
  ])("stops on an uncertain response with exit %i and body %j", (status, stdout) => {
    expect(() => registryStatus({ status, stdout, stderr: "" }, "1.2.3")).toThrow(
      ReleaseStatusError,
    );
  });
});

describe("main", () => {
  it("queries the exact manifest version through the npm subprocess", () => {
    vi.stubEnv("GITHUB_OUTPUT", undefined);
    const run = vi
      .spyOn(nodeTools, "runNode")
      .mockReturnValue({ status: 0, stdout: '"1.2.3"', stderr: "" });
    expect(main([], undefined, makeRoot())).toBe(0);
    const cwd = run.mock.calls[0]?.[2]?.cwd;
    expect(cwd).toContain("release-registry-");
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining("npm-cli.js"),
      [
        "view",
        "release-fixture@1.2.3",
        "version",
        "--json",
        "--registry",
        "https://registry.npmjs.org/",
      ],
      { cwd },
    );
    expect(existsSync(cwd ?? "")).toBe(false);
  });

  it("isolates registry reads from devEngines and cleans up a failed subprocess", () => {
    let workspace = "";
    let manifest: unknown;
    vi.spyOn(nodeTools, "runNode").mockImplementation((_script, _args, options) => {
      workspace = options?.cwd ?? "";
      manifest = JSON.parse(readFileSync(path.join(workspace, "package.json"), "utf8"));
      throw new Error("subprocess unavailable");
    });

    expect(main([], undefined, makeRoot())).toBe(1);
    expect(manifest).toEqual({ private: true });
    expect(workspace).not.toBe("");
    expect(existsSync(workspace)).toBe(false);
  });

  it("records a confirmed result without replacing earlier GitHub outputs", () => {
    const root = makeRoot();
    const output = path.join(root, "github-output");
    writeFileSync(output, "earlier=value\n");
    vi.stubEnv("GITHUB_OUTPUT", output);
    const query = vi.fn(() => ({ status: 0, stdout: '"1.2.3"', stderr: "" }));

    expect(main([], query, root)).toBe(0);
    expect(query).toHaveBeenCalledWith(
      "release-fixture@1.2.3",
      "https://registry.npmjs.org/",
    );
    expect(readFileSync(output, "utf8")).toBe("earlier=value\npublished=true\n");
  });

  it("prints a confirmed absence when run outside GitHub Actions", () => {
    vi.stubEnv("GITHUB_OUTPUT", undefined);
    const log = vi.spyOn(consoleModule, "log").mockImplementation(() => undefined);
    expect(
      main(
        [],
        () => ({ status: 1, stdout: '{"error":{"code":"E404"}}', stderr: "" }),
        makeRoot(),
      ),
    ).toBe(0);
    expect(log).toHaveBeenCalledWith("published=false");
  });

  it("leaves existing outputs intact when the registry is unavailable", () => {
    const root = makeRoot();
    const output = path.join(root, "github-output");
    writeFileSync(output, "earlier=value\n");
    vi.stubEnv("GITHUB_OUTPUT", output);
    const error = vi.spyOn(consoleModule, "error").mockImplementation(() => undefined);

    expect(main([], () => ({ status: 1, stdout: "", stderr: "timeout" }), root)).toBe(
      1,
    );
    expect(readFileSync(output, "utf8")).toBe("earlier=value\n");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("ERR_RELEASE_REGISTRY"));
  });

  it.each([{ name: "fixture" }, { version: "1.2.3" }, { name: "", version: "" }])(
    "refuses incomplete manifest %j before querying npm",
    (manifest) => {
      const query = vi.fn(() => ({ status: 0, stdout: '"1.2.3"', stderr: "" }));
      expect(main([], query, makeRoot(manifest))).toBe(1);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("reports a missing manifest without querying npm", () => {
    const root = makeRoot();
    rmSync(path.join(root, "package.json"));
    const query = vi.fn(() => ({ status: 0, stdout: '"1.2.3"', stderr: "" }));
    expect(main([], query, root)).toBe(1);
    expect(query).not.toHaveBeenCalled();
  });

  it("reports an unusable output path as a failure", () => {
    const root = makeRoot();
    vi.stubEnv("GITHUB_OUTPUT", root);
    expect(main([], () => ({ status: 0, stdout: '"1.2.3"', stderr: "" }), root)).toBe(
      1,
    );
  });

  it("refuses unknown arguments before querying npm", () => {
    const query = vi.fn(() => ({ status: 0, stdout: '"1.2.3"', stderr: "" }));
    expect(main(["--unknown"], query, makeRoot())).toBe(2);
    expect(query).not.toHaveBeenCalled();
  });

  it("reports a registry subprocess failure", () => {
    expect(
      main(
        [],
        () => {
          throw new Error("subprocess unavailable");
        },
        makeRoot(),
      ),
    ).toBe(1);
  });
});
