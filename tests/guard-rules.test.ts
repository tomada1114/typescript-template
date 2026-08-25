import { describe, expect, it } from "vitest";

import { checkCredentials } from "../scripts/lib/guard/credentials.mjs";
import { checkGateRemoval, isGateFile } from "../scripts/lib/guard/gates.mjs";
import { checkRead, checkWrite } from "../scripts/lib/guard/paths.mjs";
import {
  segments,
  shortClusterHas,
  writtenFiles,
} from "../scripts/lib/guard/shell.mjs";
import { repoRoot } from "../scripts/lib/node-tools.mjs";

// Pure-function coverage for the shared rule engine under scripts/lib/guard/,
// used by both .claude/hooks/guard.mjs and scripts/check-staged.mjs. Nothing
// here spawns a process — tests/hooks.test.ts and tests/check-staged.test.ts
// cover the two callers' own contracts (payload shape, exit codes).
//
// Secret-shaped fixtures are assembled from fragments rather than written
// out. A literal token or key header in this file would be a real finding
// for every secret scanner pointed at the repository — and the guard hook
// would refuse to let an agent write this file at all.
function secretShaped(...parts: string[]): string {
  return parts.join("");
}

describe("paths: checkRead / checkWrite", () => {
  it("blocks reading a dotenv file", () => {
    expect(checkRead(".env")).toMatch(/\.env\*/);
  });

  it("allows reading the env example", () => {
    expect(checkRead(".env.example")).toBeNull();
  });

  it("blocks a path under secrets/", () => {
    expect(checkRead("secrets/token.txt")).toMatch(/secrets\//);
  });

  it("blocks hand-editing the lockfile", () => {
    expect(checkWrite("pnpm-lock.yaml")).toMatch(/pnpm-lock\.yaml is generated/);
  });

  it("carries the read block through to the write-side message", () => {
    expect(checkWrite(".env")).toMatch(/written by the agent/);
  });

  it("allows an ordinary source edit", () => {
    expect(checkWrite("src/identifier.ts")).toBeNull();
  });
});

describe("credentials: checkCredentials", () => {
  const privateKey = secretShaped("-----BEGIN RSA ", "PRIVATE ", "KEY-----");

  it("blocks a private key", () => {
    expect(checkCredentials(`${privateKey}\nMIIE…\n`)).toMatch(/private key/);
  });

  it("does not flag ordinary prose", () => {
    expect(
      checkCredentials("Store the token in the environment, never in a file."),
    ).toBeNull();
  });
});

describe("gates: isGateFile / checkGateRemoval", () => {
  it("blocks lowering a coverage threshold", () => {
    const before = "thresholds: { lines: 80, branches: 80 }";
    const after = "thresholds: { lines: 50, branches: 80 }";
    expect(checkGateRemoval("vitest.config.ts", before, after)).toMatch(
      /coverage threshold/,
    );
  });

  it("allows raising a coverage threshold", () => {
    const before = "thresholds: { lines: 80 }";
    const after = "thresholds: { lines: 90 }";
    expect(checkGateRemoval("vitest.config.ts", before, after)).toBeNull();
  });

  it("blocks dropping a workflow's permissions block", () => {
    const before = "jobs:\n  build:\n    permissions:\n      contents: read\n";
    const after = "jobs:\n  build:\n    runs-on: ubuntu-latest\n";
    expect(checkGateRemoval(".github/workflows/ci.yml", before, after)).toMatch(
      /least-privilege/,
    );
  });

  it("blocks dropping the settings permission deny list", () => {
    const before = JSON.stringify(
      { permissions: { deny: ["Read(.env)"], allow: [] } },
      null,
      2,
    );
    const after = JSON.stringify({ permissions: { allow: [] } }, null, 2);

    expect(checkGateRemoval(".claude/settings.json", before, after)).toMatch(
      /permission deny list/,
    );
  });

  it("blocks dropping --frozen-lockfile from a workflow", () => {
    expect(
      checkGateRemoval(
        ".github/workflows/ci.yml",
        "run: pnpm install --frozen-lockfile",
        "run: pnpm install",
      ),
    ).toMatch(/frozen-lockfile/);
  });

  it("blocks dropping the staged-content check from the git hooks", () => {
    // The script file is protected from deletion, but removing the job that
    // runs it takes the whole pre-commit layer out just as effectively.
    expect(
      checkGateRemoval(
        "lefthook.yml",
        "    - name: check:staged\n      run: pnpm run check:staged\n",
        "",
      ),
    ).toMatch(/staged-content pre-commit check/);
  });

  it("leaves prose that merely mentions a gate alone", () => {
    // Gate rules apply to gate files, not to every file that says the word.
    expect(
      checkGateRemoval("docs/notes.md", "we use --frozen-lockfile", "we removed it"),
    ).toBeNull();
  });

  it("does not fire when a gate file is edited without touching a gate", () => {
    const before = "  timeout-minutes: 10\n  permissions:\n    contents: read\n";
    const after = "  timeout-minutes: 15\n  permissions:\n    contents: read\n";
    expect(checkGateRemoval(".github/workflows/ci.yml", before, after)).toBeNull();
  });

  it("recognizes a gate file given as a repo-relative path", () => {
    expect(isGateFile("package.json")).toBe(true);
    expect(isGateFile("README.md")).toBe(false);
  });

  it("protects the guard engine's own implementation from deletion", () => {
    expect(isGateFile(".claude/hooks/guard.mjs")).toBe(true);
    expect(isGateFile("scripts/lib/guard/gates.mjs")).toBe(true);
    expect(isGateFile("scripts/check-staged.mjs")).toBe(true);
  });

  it("does not scan the guard engine's own files for marker text", () => {
    // Regression: gates.mjs's own source necessarily contains every marker's
    // literal substring (it is where GATE_MARKERS is defined), so scanning
    // an ENFORCEMENT_FILES path for that text produces a false positive on
    // any edit that merely moves the definition between files — as
    // extracting this engine out of the old single-file guard.mjs did.
    const before = "reportUnusedDisableDirectives\n--frozen-lockfile\n";
    const after = "// moved to scripts/lib/guard/gates.mjs\n";
    expect(checkGateRemoval(".claude/hooks/guard.mjs", before, after)).toBeNull();
    expect(checkGateRemoval("scripts/lib/guard/gates.mjs", before, after)).toBeNull();
  });

  it("recognizes a gate file given as an absolute path", () => {
    // Claude Code always sends an absolute file_path for Edit/Write; a
    // GATE_FILES pattern anchored with `^` never matches an absolute path
    // directly, so isGateFile must resolve it back to repo-relative first.
    expect(isGateFile(`${repoRoot}/package.json`)).toBe(true);
    expect(isGateFile(`${repoRoot}/README.md`)).toBe(false);
  });
});

describe("shell: segments / shortClusterHas / writtenFiles", () => {
  it("splits on control operators", () => {
    expect(segments("pnpm test && git push -f origin main")).toEqual([
      ["pnpm", "test"],
      ["git", "push", "-f", "origin", "main"],
    ]);
  });

  it("keeps a quoted control operator inside its token", () => {
    expect(segments('git commit -m "a && b"')).toEqual([
      ["git", "commit", "-m", "a && b"],
    ]);
  });

  it("joins a line continuation", () => {
    expect(segments("pnpm run \\\n  build")).toEqual([["pnpm", "run", "build"]]);
  });

  it("stops reading a short cluster at an option that takes a value", () => {
    // In `-mn` the `n` is part of the commit message, not --no-verify.
    expect(shortClusterHas("-mn", "n", "mFCct")).toBe(false);
    expect(shortClusterHas("-nm", "n", "mFCct")).toBe(true);
    expect(shortClusterHas("--no-verify", "n", "mFCct")).toBe(false);
  });

  it("finds redirection targets in both spellings", () => {
    expect(writtenFiles(["echo", "x", ">", "out.txt"])).toContain("out.txt");
    expect(writtenFiles(["echo", "x", ">>out.txt"])).toContain("out.txt");
    expect(writtenFiles(["tee", "out.txt"])).toContain("out.txt");
    expect(writtenFiles(["sed", "-i", "s/a/b/", "out.txt"])).toContain("out.txt");
  });
});
