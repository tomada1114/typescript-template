import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { checkCredentials } from "../scripts/lib/guard/credentials.mjs";
import { checkGateRemoval, isGateFile } from "../scripts/lib/guard/gates.mjs";
import { checkRead } from "../scripts/lib/guard/paths.mjs";
import { repoRoot } from "../scripts/lib/node-tools.mjs";

// Pure-function coverage for the shared rule engine under scripts/lib/guard/,
// used by scripts/check-staged.mjs. Nothing here spawns a process —
// tests/check-staged.test.ts covers that caller's own contract (staged
// content, exit codes).
//
// Secret-shaped fixtures are assembled from fragments rather than written
// out. A literal token or key header in this file would be a real finding
// for every secret scanner pointed at the repository.
function secretShaped(...parts: string[]): string {
  return parts.join("");
}

describe("paths: checkRead", () => {
  it("blocks reading a dotenv file", () => {
    expect(checkRead(".env")).toMatch(/\.env\*/);
  });

  it("allows reading the env example", () => {
    expect(checkRead(".env.example")).toBeNull();
  });

  it("blocks a path under secrets/", () => {
    expect(checkRead("secrets/token.txt")).toMatch(/secrets\//);
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

  const settingsWithDeny = JSON.stringify(
    { permissions: { deny: ["Read(.env)"], allow: [] } },
    null,
    2,
  );

  it.each([
    ["the key is deleted", JSON.stringify({ permissions: { allow: [] } }, null, 2)],
    // Emptying the array leaves every declarative rule gone while the key
    // survives, so a marker that only looked for `"deny": [` would pass it.
    [
      "the list is emptied",
      JSON.stringify({ permissions: { deny: [], allow: [] } }, null, 2),
    ],
    // The guard sees the text a tool call is about to write, before Prettier
    // ever runs on it.
    [
      "the file is rewritten on one line without it",
      JSON.stringify({ permissions: { allow: [] } }),
    ],
  ])("blocks the settings permission deny list going away when %s", (_label, after) => {
    expect(checkGateRemoval(".claude/settings.json", settingsWithDeny, after)).toMatch(
      /permission deny list/,
    );
  });

  it("allows a settings.json rewritten on one line that keeps the deny list", () => {
    const after = JSON.stringify({
      permissions: { deny: ["Read(.env)", "Edit(.env)"], allow: [] },
    });

    expect(
      checkGateRemoval(".claude/settings.json", settingsWithDeny, after),
    ).toBeNull();
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

  it("blocks dropping the dotenv exclusion from .gitignore", () => {
    // The read/write rules in paths.mjs keep the agent out of a .env file;
    // this line is what keeps one out of a commit.
    const before = "# Environment variables\n.env\n.env.*\n!.env.example\n";
    const after = "# Environment variables\n!.env.example\n";
    expect(checkGateRemoval(".gitignore", before, after)).toMatch(/exclusion of \.env/);
  });

  it("blocks dropping the verbatim-copy exemption from .prettierignore", () => {
    expect(
      checkGateRemoval(
        ".prettierignore",
        "docs/template-requirements/\n",
        "# reformat everything\n",
      ),
    ).toMatch(/verbatim-copy formatting exemption/);
  });

  it("blocks dropping the cooldown block from dependabot.yml", () => {
    const before =
      '    schedule:\n      interval: "weekly"\n    cooldown:\n      default-days: 7\n';
    const after = '    schedule:\n      interval: "weekly"\n';
    expect(checkGateRemoval(".github/dependabot.yml", before, after)).toMatch(
      /Dependabot update cooldown/,
    );
  });

  it("leaves prose about the cooldown alone", () => {
    // The marker is anchored on the YAML key, so rewording pnpm-workspace.yaml's
    // comment explaining minimumReleaseAge is not "the cooldown was removed".
    const before =
      "# Supply-chain cooldown: refuse new versions.\nminimumReleaseAge: 10080\n";
    const after = "# Refuse versions published recently.\nminimumReleaseAge: 10080\n";
    expect(checkGateRemoval("pnpm-workspace.yaml", before, after)).toBeNull();
  });

  it("blocks dropping the dependency-review severity gate", () => {
    expect(
      checkGateRemoval(
        ".github/workflows/dependency-review.yml",
        "        with:\n          fail-on-severity: moderate\n",
        "        with:\n",
      ),
    ).toMatch(/dependency-review severity gate/);
  });

  it("blocks weakening the node_modules freshness check", () => {
    // Marker plus value, the same pair the coverage floor uses: keeping the
    // setting named while downgrading it to a warning removes the gate.
    const before = "verifyDepsBeforeRun: error\n";
    const after = "verifyDepsBeforeRun: warn\n";
    expect(checkGateRemoval("pnpm-workspace.yaml", before, after)).toMatch(
      /verifyDepsBeforeRun/,
    );
    expect(checkGateRemoval("pnpm-workspace.yaml", before, "")).toMatch(
      /node_modules freshness check/,
    );
  });

  it("blocks a quoted downgrade of the node_modules freshness check", () => {
    // YAML parses `warn`, `"warn"` and `'warn'` identically, so a pattern that
    // cannot see past a leading quote reads a real downgrade as no assignment.
    const before = "verifyDepsBeforeRun: error\n";
    for (const after of [
      'verifyDepsBeforeRun: "warn"\n',
      "verifyDepsBeforeRun: 'warn'\n",
    ]) {
      expect(checkGateRemoval("pnpm-workspace.yaml", before, after)).toMatch(
        /verifyDepsBeforeRun/,
      );
    }
  });

  it("leaves prose about the freshness check in another gate file alone", () => {
    // The value check belongs to the one file pnpm reads it from. Without that
    // restriction, a comment quoting the setting anywhere else — eslint.config.mjs
    // here — is a hard block on an edit that changes no setting at all.
    const before = "// nothing about pnpm yet\n";
    // Both spellings a comment can take: indented behind `//`, and — inside a
    // block comment or a template literal — flush against the line start,
    // where only the file restriction stops the check from reading it as an
    // assignment.
    for (const after of [
      "// pnpm sets verifyDepsBeforeRun: warn nowhere; this repo pins it to error.\n",
      "/*\nverifyDepsBeforeRun: warn\nis what this repo refuses.\n*/\n",
    ]) {
      expect(checkGateRemoval("eslint.config.mjs", before, after)).toBeNull();
    }
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

  it.each([[".gitignore"], [".prettierignore"], ["typedoc.json"]])(
    "treats %s as a gate file",
    (target) => {
      expect(isGateFile(target)).toBe(true);
    },
  );

  it("protects the guard engine's own implementation from deletion", () => {
    expect(isGateFile("scripts/lib/guard/gates.mjs")).toBe(true);
    expect(isGateFile("scripts/lib/guard/credentials.mjs")).toBe(true);
    expect(isGateFile("scripts/lib/guard/paths.mjs")).toBe(true);
    expect(isGateFile("scripts/check-staged.mjs")).toBe(true);
  });

  it("does not scan the guard engine's own files for marker text", () => {
    // Regression: gates.mjs's own source necessarily contains every marker's
    // literal substring (it is where GATE_MARKERS is defined), so scanning
    // an ENFORCEMENT_FILES path for that text produces a false positive on
    // any edit that merely rewords a comment referencing a marker.
    const before = "reportUnusedDisableDirectives\n--frozen-lockfile\n";
    const after = "// see GATE_MARKERS in this file\n";
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

describe("gates: pnpm-workspace.yaml value negation (GATE_VALUES)", () => {
  // Marker-presence scanning alone lets `strictPeerDependencies: true` become
  // `strictPeerDependencies: false` without tripping anything: the marker's
  // literal text survives the edit. Each case here flips one setting's value
  // while keeping its line (and therefore its marker) intact, and must be
  // blocked on the value alone.
  it.each([
    ["strictDepBuilds", "strictDepBuilds: true\n", "strictDepBuilds: false\n"],
    [
      "strictPeerDependencies",
      "strictPeerDependencies: true\n",
      "strictPeerDependencies: false\n",
    ],
    [
      "minimumReleaseAgeStrict",
      "minimumReleaseAgeStrict: true\n",
      "minimumReleaseAgeStrict: false\n",
    ],
    [
      "minimumReleaseAgeIgnoreMissingTime",
      "minimumReleaseAgeIgnoreMissingTime: false\n",
      "minimumReleaseAgeIgnoreMissingTime: true\n",
    ],
    ["trustLockfile", "trustLockfile: false\n", "trustLockfile: true\n"],
    ["blockExoticSubdeps", "blockExoticSubdeps: true\n", "blockExoticSubdeps: false\n"],
    ["trustPolicy", "trustPolicy: no-downgrade\n", "trustPolicy: off\n"],
    ["minimumReleaseAge", "minimumReleaseAge: 10080\n", "minimumReleaseAge: 60\n"],
  ])("blocks weakening %s without removing its line", (name, before, after) => {
    const reason = checkGateRemoval("pnpm-workspace.yaml", before, after);
    expect(reason).toMatch(new RegExp(name));
    expect(reason).toMatch(/human decision/);
  });

  it("allows raising minimumReleaseAge above the floor", () => {
    expect(
      checkGateRemoval(
        "pnpm-workspace.yaml",
        "minimumReleaseAge: 10080\n",
        "minimumReleaseAge: 20160\n",
      ),
    ).toBeNull();
  });

  it("does not apply pnpm-workspace.yaml's value checks to another gate file", () => {
    // Same restriction as verifyDepsBeforeRun's file check: a comment
    // elsewhere mentioning one of these setting names by name is not an
    // assignment.
    expect(
      checkGateRemoval(
        "eslint.config.mjs",
        "// nothing about pnpm yet\n",
        "// pnpm sets strictDepBuilds: false nowhere; this repo pins it to true.\n",
      ),
    ).toBeNull();
  });

  it("blocks adding an entry to minimumReleaseAgeExclude", () => {
    const before = "minimumReleaseAge: 10080\n";
    const after = "minimumReleaseAge: 10080\nminimumReleaseAgeExclude:\n  - left-pad\n";
    expect(checkGateRemoval("pnpm-workspace.yaml", before, after)).toMatch(
      /human's explicit approval/,
    );
  });

  it("blocks adding a second entry to an existing minimumReleaseAgeExclude list", () => {
    const before = "minimumReleaseAgeExclude:\n  - left-pad\n";
    const after = "minimumReleaseAgeExclude:\n  - left-pad\n  - is-odd\n";
    expect(checkGateRemoval("pnpm-workspace.yaml", before, after)).toMatch(/is-odd/);
  });

  it("allows keeping the same minimumReleaseAgeExclude entries unchanged", () => {
    const yaml = "minimumReleaseAgeExclude:\n  - left-pad\n";
    expect(checkGateRemoval("pnpm-workspace.yaml", yaml, yaml)).toBeNull();
  });

  it("allows removing an entry from minimumReleaseAgeExclude", () => {
    const before = "minimumReleaseAgeExclude:\n  - left-pad\n  - is-odd\n";
    const after = "minimumReleaseAgeExclude:\n  - left-pad\n";
    expect(checkGateRemoval("pnpm-workspace.yaml", before, after)).toBeNull();
  });
});

describe("gates: the release workflow's provenance markers", () => {
  it("blocks dropping the id-token permission from the release workflow", () => {
    const before = "permissions:\n  contents: read\n  id-token: write\n";
    const after = "permissions:\n  contents: read\n";
    expect(checkGateRemoval(".github/workflows/release.yml", before, after)).toMatch(
      /id-token/,
    );
  });

  it("blocks dropping the --provenance flag reference from the release workflow", () => {
    const before =
      "# No --access/--provenance/--registry flags: publishConfig is the source.\n";
    const after = "# publishConfig is the source.\n";
    expect(checkGateRemoval(".github/workflows/release.yml", before, after)).toMatch(
      /provenance/,
    );
  });
});

describe("gates: the real pnpm-workspace.yaml and release workflow still pass", () => {
  // The hard bar every check above must clear: the honest, currently
  // committed files must never trip their own new checks.
  it("passes GATE_VALUES and the minimumReleaseAgeExclude check unchanged", () => {
    const workspace = readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8");
    expect(checkGateRemoval("pnpm-workspace.yaml", workspace, workspace)).toBeNull();
  });

  it("passes the id-token and --provenance markers unchanged", () => {
    const release = readFileSync(
      path.join(repoRoot, ".github/workflows/release.yml"),
      "utf8",
    );
    expect(
      checkGateRemoval(".github/workflows/release.yml", release, release),
    ).toBeNull();
  });
});
