// Gate files: the config files that hold a quality or supply-chain gate, and
// the markers inside them whose disappearance means a gate was removed.
//
// Used by the pre-commit staged-content check (scripts/check-staged.mjs), the
// one enforcement layer that inspects a diff's content rather than a
// declarative pattern.
import path from "node:path";

import { repoRoot } from "../node-tools.mjs";

/**
 * Config files whose contents are a quality or supply-chain gate, checked for
 * both {@link isGateFile} (deletion protection) and marker-removal scanning.
 *
 * @remarks
 * Restricting marker scanning to these paths is what keeps a word like
 * "audit" from tripping the guard when it appears in prose inside a Markdown
 * document. Patterns are anchored against a path relative to the repository
 * root — see {@link isGateFile}.
 */
export const CONFIG_GATE_FILES = [
  /^\.github\/workflows\/[^/]+\.ya?ml$/,
  /^\.github\/dependabot\.yml$/,
  /^\.github\/zizmor\.yml$/,
  /^eslint\.config\.mjs$/,
  /^vitest\.config\.ts$/,
  /^pnpm-workspace\.yaml$/,
  /^package\.json$/,
  /^tsconfig(?:\.[^/]+)?\.json$/,
  /^typedoc\.json$/,
  /^lefthook\.yml$/,
  /^\.claude\/settings\.json$/,
  // Ignore files are gates too: .gitignore's `.env` lines are what keeps a
  // real dotenv out of a commit in the first place, and .prettierignore's
  // docs/template-requirements/ entry is the only thing enforcing AGENTS.md's
  // "never reflow the verbatim upstream copies" rule.
  /^\.gitignore$/,
  /^\.prettierignore$/,
];

/**
 * The guard engine's own implementation files: protected from deletion via
 * {@link isGateFile}, but deliberately excluded from marker-removal
 * scanning.
 *
 * @remarks
 * `scripts/lib/guard/gates.mjs` — this file — is where {@link GATE_MARKERS}'
 * regex patterns live as source text, so its own content necessarily
 * contains every marker's literal substring. Scanning it for "did a marker's
 * text disappear" produces a false positive on any edit that moves that text
 * between files, without ever checking anything real — the markers a config
 * file actually needs are the ones in {@link CONFIG_GATE_FILES}.
 */
export const ENFORCEMENT_FILES = [
  // The whole directory, not a fixed list of today's three modules: a rule
  // module added later must inherit the same deletion protection without
  // anyone remembering to name it here.
  /^scripts\/lib\/guard\/(?:[^/]+\/)*[^/]+\.mjs$/,
  /^scripts\/check-staged\.mjs$/,
];

/**
 * Markers whose disappearance from a config gate file means a gate was
 * removed.
 *
 * @type {{ pattern: RegExp, name: string }[]}
 */
export const GATE_MARKERS = [
  { pattern: /--frozen-lockfile/, name: "the frozen-lockfile install" },
  { pattern: /--max-warnings\s+0/, name: "the zero-warning lint budget" },
  { pattern: /reportUnusedDisableDirectives/, name: "the unused-disable check" },
  { pattern: /minimumReleaseAge/, name: "the dependency cooldown" },
  // The four below are the settings AGENTS.md's "pnpm-workspace.yaml supply-chain
  // policy" section names but that, unlike minimumReleaseAge/strictDepBuilds/
  // strictPeerDependencies above, previously had no marker at all: deleting the
  // line outright was indistinguishable from never having written it. Whether
  // the *value* on a surviving line was weakened is checked separately, by
  // GATE_VALUES below.
  {
    pattern: /minimumReleaseAgeStrict/,
    name: "the cooldown's apply-to-already-lockfiled-versions setting",
  },
  {
    pattern: /minimumReleaseAgeIgnoreMissingTime/,
    name: "the fail-closed setting for missing publish-time metadata",
  },
  { pattern: /trustPolicy/, name: "the trust-policy downgrade guard" },
  { pattern: /trustLockfile/, name: "the lockfile trust re-verification setting" },
  { pattern: /blockExoticSubdeps/, name: "the exotic-subdependency block" },
  { pattern: /strictDepBuilds/, name: "the lifecycle-script allowlist" },
  { pattern: /strictPeerDependencies/, name: "the peer dependency check" },
  { pattern: /verifyDepsBeforeRun/, name: "the node_modules freshness check" },
  // Line-anchored on the YAML key, not on the bare word: "cooldown" also
  // appears in pnpm-workspace.yaml's prose explaining minimumReleaseAge, and
  // rewording a comment is not removing Dependabot's cooldown block.
  { pattern: /^\s*cooldown:/m, name: "the Dependabot update cooldown" },
  { pattern: /fail-on-severity/, name: "the dependency-review severity gate" },
  // Quoted, so it tracks package.json's `publishConfig.provenance` rather
  // than a `--provenance` flag on a publish command. Marker scanning is
  // presence-based: this is inert until that field exists, and protective
  // from the moment it does.
  { pattern: /"provenance"/, name: "the npm provenance contract" },
  // The release workflow's own two provenance markers: package.json's
  // publishConfig.provenance (above) is the *content* of the contract, but
  // the release workflow is what actually exercises it — the `id-token: write`
  // permission is what lets `npm publish` mint a signed provenance attestation
  // at all, and the comment naming `--provenance` records the deliberate
  // choice to drive it through publishConfig rather than a CLI flag.
  {
    pattern: /--provenance/,
    name: "the release workflow's npm provenance flag reference",
  },
  {
    pattern: /id-token/,
    name: "the OIDC id-token permission a workflow needs for npm trusted publishing",
  },
  { pattern: /^\s*permissions:/m, name: "a workflow's least-privilege permissions" },
  // Deliberately not line-anchored, unlike the YAML marker above, and it
  // requires the array to hold at least one entry: a settings.json rewritten
  // on one line, or left as `"deny": []`, has lost the gate just as completely
  // as one with the key deleted.
  { pattern: /"deny"\s*:\s*\[\s*"/, name: "the agent permission deny list" },
  { pattern: /thresholds/, name: "the coverage thresholds" },
  { pattern: /publint/, name: "the publint gate" },
  { pattern: /check-attw|arethetypeswrong/, name: "the type-resolution gate" },
  { pattern: /codeql/i, name: "the CodeQL analysis" },
  { pattern: /zizmor/, name: "the workflow security audit" },
  { pattern: /persist-credentials/, name: "the checkout credential hardening" },
  // Wiring, not content: scripts/check-staged.mjs is protected from deletion
  // by ENFORCEMENT_FILES, but the pre-commit layer disappears just as
  // completely if the job that runs it is dropped from lefthook.yml or the
  // script from package.json.
  { pattern: /check[-:]staged/, name: "the staged-content pre-commit check" },
  // .gitignore's dotenv exclusion, one marker per line: dropping either one
  // is what makes a real `.env` committable, whatever the read/write rules in
  // paths.mjs say about the agent touching it.
  { pattern: /^\.env$/m, name: "the .gitignore exclusion of .env" },
  { pattern: /^\.env\.\*$/m, name: "the .gitignore exclusion of .env.*" },
  {
    pattern: /docs\/template-requirements/,
    name: "the verbatim-copy formatting exemption",
  },
];

/** The coverage floor that spec 02 §3.3 fixes; the guard refuses to see it lowered. */
export const COVERAGE_FLOOR = 80;

/** Coverage threshold assignments, as written in vitest.config.ts. */
export const COVERAGE_THRESHOLD =
  /\b(lines|functions|statements|branches)\s*:\s*(\d+)/g;

/**
 * The only `verifyDepsBeforeRun` setting that stops a gate from running
 * against a stale node_modules; every other value merely reports it.
 */
export const VERIFY_DEPS_REQUIRED = "error";

/**
 * The one file every pnpm-specific value check below applies to:
 * `verifyDepsBeforeRun`, {@link GATE_VALUES}, and the
 * `minimumReleaseAgeExclude` check all read a setting pnpm resolves from
 * `pnpm-workspace.yaml` and nowhere else.
 *
 * @remarks
 * Restricting each of those checks to this file is what keeps a mention of
 * the same setting name in prose elsewhere — a comment in `eslint.config.mjs`
 * explaining why it exists, for instance — from becoming a hard block on an
 * edit that changes no setting at all.
 */
export const PNPM_WORKSPACE_FILE = /^pnpm-workspace\.yaml$/;

/**
 * `verifyDepsBeforeRun` assignments, as written in pnpm-workspace.yaml.
 *
 * @remarks
 * Line-anchored on the YAML key, for the same reason the Dependabot cooldown
 * marker is: a mention inside a comment is not an assignment. The optional
 * quotes matter because YAML parses `warn`, `"warn"` and `'warn'` identically,
 * so an unquoted-only pattern reads a quoted downgrade as no assignment at
 * all.
 */
export const VERIFY_DEPS_SETTING =
  /^\s*verifyDepsBeforeRun\s*:\s*["']?([A-Za-z-]+)["']?/gm;

/** The dependency cooldown AGENTS.md fixes at 7 days; the guard refuses to see it shortened. */
export const MINIMUM_RELEASE_AGE_FLOOR = 10080;

/**
 * `pnpm-workspace.yaml` supply-chain settings AGENTS.md's
 * "`pnpm-workspace.yaml` supply-chain policy" section forbids relaxing,
 * checked against the *after* text.
 *
 * @remarks
 * Generalizes the coverage-floor and `verifyDepsBeforeRun` checks above into
 * a table: each entry's `pattern` captures the assigned value from a single
 * YAML key, and `expected` reports whether that value keeps the gate at
 * least as strict as the settings the honest file ships with today. A
 * pattern that finds no match — the key was never present, or was deleted
 * outright — is not evaluated here; {@link GATE_MARKERS} is what catches a
 * key disappearing entirely, this table is what catches one kept but
 * weakened. `strictDepBuilds` and `strictPeerDependencies` read `true` for
 * "on"; `minimumReleaseAgeIgnoreMissingTime` and `trustLockfile` read
 * `false` for "on" — each one fails closed by design (ignoring missing
 * publish-time metadata, or trusting a lockfile's recorded trust level
 * without re-verifying it, is the *weaker* behavior), so "must stay at its
 * safe value" is not the same literal boolean for every entry.
 *
 * @type {{ pattern: RegExp, expected: (value: string) => boolean, name: string }[]}
 */
export const GATE_VALUES = [
  {
    pattern: /^\s*strictDepBuilds\s*:\s*["']?(\w+)["']?/m,
    expected: (value) => value === "true",
    name: "strictDepBuilds",
  },
  {
    pattern: /^\s*strictPeerDependencies\s*:\s*["']?(\w+)["']?/m,
    expected: (value) => value === "true",
    name: "strictPeerDependencies",
  },
  {
    pattern: /^\s*minimumReleaseAgeStrict\s*:\s*["']?(\w+)["']?/m,
    expected: (value) => value === "true",
    name: "minimumReleaseAgeStrict",
  },
  {
    pattern: /^\s*minimumReleaseAgeIgnoreMissingTime\s*:\s*["']?(\w+)["']?/m,
    expected: (value) => value === "false",
    name: "minimumReleaseAgeIgnoreMissingTime",
  },
  {
    pattern: /^\s*trustLockfile\s*:\s*["']?(\w+)["']?/m,
    expected: (value) => value === "false",
    name: "trustLockfile",
  },
  {
    pattern: /^\s*blockExoticSubdeps\s*:\s*["']?(\w+)["']?/m,
    expected: (value) => value === "true",
    name: "blockExoticSubdeps",
  },
  {
    // pnpm accepts exactly two values for this setting: "no-downgrade" and
    // "off". There is no intermediate value, so "must not be downgraded"
    // and "must equal no-downgrade" are the same requirement.
    pattern: /^\s*trustPolicy\s*:\s*["']?([\w-]+)["']?/m,
    expected: (value) => value === "no-downgrade",
    name: "trustPolicy",
  },
  {
    // Anchored the same way VERIFY_DEPS_SETTING is: the `\s*:` right after
    // the key name means this never matches `minimumReleaseAgeStrict`,
    // `minimumReleaseAgeIgnoreMissingTime`, or `minimumReleaseAgeExclude` —
    // each has a suffix immediately after "minimumReleaseAge" where `\s*`
    // would need a colon.
    pattern: /^\s*minimumReleaseAge\s*:\s*["']?(\d+)["']?/m,
    expected: (value) => Number(value) >= MINIMUM_RELEASE_AGE_FLOOR,
    name: "minimumReleaseAge",
  },
];

/**
 * Extract `minimumReleaseAgeExclude`'s entries from `pnpm-workspace.yaml`
 * text, as pnpm writes them: a YAML block sequence indented under the key.
 *
 * @remarks
 * Line-based, like every other pattern in this file, rather than a full YAML
 * parse: entries are the bullet lines immediately following the key, ending
 * at the first line that is blank or indented at or below the key's own
 * indentation.
 *
 * @param {string} text - `pnpm-workspace.yaml` content, before or after.
 * @returns {string[]} Each entry's text, trimmed.
 */
function minimumReleaseAgeExcludeEntries(text) {
  const keyMatch = /^([ \t]*)minimumReleaseAgeExclude\s*:\s*$/m.exec(text);
  if (keyMatch === null) {
    return [];
  }
  const indent = (keyMatch[1] ?? "").length;
  const rest = text.slice(keyMatch.index + keyMatch[0].length).split("\n");
  /** @type {string[]} */
  const entries = [];
  for (const line of rest) {
    if (line.trim() === "") {
      continue;
    }
    const lineIndent = /^[ \t]*/.exec(line)?.[0].length ?? 0;
    const item = /^[ \t]*-\s*(.+)$/.exec(line);
    if (item !== null && lineIndent > indent) {
      entries.push((item[1] ?? "").trim());
      continue;
    }
    break;
  }
  return entries;
}

/**
 * Resolve a path to repo-relative POSIX form for matching against the
 * pattern lists above.
 *
 * @remarks
 * An absolute `filePath` — which a real Claude Edit/Write call routinely
 * carries — resolves the same way regardless of the base, since
 * `path.resolve` discards a relative base once the path being resolved is
 * already absolute. Without this resolution step, an absolute-path edit of a
 * gate file silently skipped gate-removal detection: `/^package\.json$/`
 * never matches `/Users/x/repo/package.json`.
 *
 * @param {string} filePath - Path the call targets, absolute or relative.
 * @returns {string} Path relative to the repository root, POSIX-separated.
 */
function toRepoRelative(filePath) {
  const absolute = path.resolve(repoRoot, filePath.replace(/\\/g, "/"));
  return path.relative(repoRoot, absolute).split(path.sep).join("/");
}

/**
 * Report whether a path must not be deleted without a human decision: a
 * config file holding a quality gate, or the guard engine's own
 * implementation.
 *
 * @param {string} filePath - Path the call targets, absolute or relative.
 * @returns {boolean} True when deleting this file needs a human decision.
 */
export function isGateFile(filePath) {
  const relative = toRepoRelative(filePath);
  return [...CONFIG_GATE_FILES, ...ENFORCEMENT_FILES].some((pattern) =>
    pattern.test(relative),
  );
}

/**
 * Return a block reason when an edit strips a gate out of a config gate
 * file.
 *
 * @remarks
 * Scans only {@link CONFIG_GATE_FILES}, not {@link ENFORCEMENT_FILES} — see
 * that constant's remarks for why the guard engine's own implementation
 * files are excluded here.
 *
 * @param {string} filePath - Path the call targets.
 * @param {string} before - Text being replaced, or the file's current content.
 * @param {string} after - Text replacing it.
 * @returns {string | null} The reason, or null when every gate survives.
 */
export function checkGateRemoval(filePath, before, after) {
  const relative = toRepoRelative(filePath);
  if (!CONFIG_GATE_FILES.some((pattern) => pattern.test(relative))) {
    return null;
  }
  for (const { pattern, name } of GATE_MARKERS) {
    if (pattern.test(before) && !pattern.test(after)) {
      return `This edit removes ${name} from ${relative}. Weakening a quality or supply-chain gate needs a human decision, not an agent edit.`;
    }
  }
  for (const match of after.matchAll(COVERAGE_THRESHOLD)) {
    const value = Number(match[2]);
    if (value < COVERAGE_FLOOR) {
      return `This edit sets the ${String(match[1])} coverage threshold to ${String(value)}, below the ${String(COVERAGE_FLOOR)}% floor. Add tests instead of lowering the floor.`;
    }
  }
  // Same shape as the coverage floor above: the marker only proves the setting
  // is still named somewhere, so the value it is set to is checked separately.
  if (PNPM_WORKSPACE_FILE.test(relative)) {
    for (const match of after.matchAll(VERIFY_DEPS_SETTING)) {
      if (match[1] !== VERIFY_DEPS_REQUIRED) {
        return `This edit sets verifyDepsBeforeRun to ${String(match[1])} in ${relative}. Anything other than "${VERIFY_DEPS_REQUIRED}" lets a gate run against a node_modules that no longer matches the lockfile — run \`pnpm install\` instead.`;
      }
    }
    for (const { pattern, expected, name } of GATE_VALUES) {
      const match = pattern.exec(after);
      const value = match?.[1];
      if (value !== undefined && !expected(value)) {
        return `This edit sets ${name} to ${value} in ${relative}, weakening a pnpm supply-chain gate. See AGENTS.md's "pnpm-workspace.yaml supply-chain policy" section for why this setting must not be relaxed without a human decision.`;
      }
    }
    const addedExclude = minimumReleaseAgeExcludeEntries(after).find(
      (entry) => !minimumReleaseAgeExcludeEntries(before).includes(entry),
    );
    if (addedExclude !== undefined) {
      return `This edit adds "${addedExclude}" to minimumReleaseAgeExclude in ${relative}. Excluding a package from the dependency cooldown needs a human's explicit approval — see AGENTS.md's "minimumReleaseAge (supply-chain cooldown)" section: the same PR must cite the advisory, explain why waiting is riskier, and state when the exception will be removed.`;
    }
  }
  return null;
}
