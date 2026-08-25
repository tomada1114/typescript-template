// Gate files: the config files that hold a quality or supply-chain gate, and
// the markers inside them whose disappearance means a gate was removed.
//
// Shared by the Claude Code guard hook (an Edit/Write's before/after text, or
// a Bash `rm` target) and the pre-commit staged-content check (a staged
// file's before/after blob, or a staged deletion).
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
  /^api-extractor\.json$/,
  /^lefthook\.yml$/,
  /^\.claude\/settings\.json$/,
];

/**
 * The guard engine's own implementation files: protected from deletion via
 * {@link isGateFile}, but deliberately excluded from marker-removal
 * scanning.
 *
 * @remarks
 * `scripts/lib/guard/gates.mjs` — this file — is where {@link GATE_MARKERS}'
 * regex patterns live as source text, so its own content necessarily
 * contains every marker's literal substring. Scanning it (or a file that
 * used to hold that array, like `.claude/hooks/guard.mjs` before this
 * engine was extracted) for "did a marker's text disappear" produces a false
 * positive on any edit that moves that text between files, without ever
 * checking anything real — the markers a config file actually needs are the
 * ones in {@link CONFIG_GATE_FILES}.
 */
export const ENFORCEMENT_FILES = [
  /^\.claude\/hooks\/(?:[^/]+\/)*[^/]+\.mjs$/,
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
  { pattern: /strictDepBuilds/, name: "the lifecycle-script allowlist" },
  { pattern: /strictPeerDependencies/, name: "the peer dependency check" },
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
];

/** The coverage floor that spec 02 §3.3 fixes; the guard refuses to see it lowered. */
export const COVERAGE_FLOOR = 80;

/** Coverage threshold assignments, as written in vitest.config.ts. */
export const COVERAGE_THRESHOLD =
  /\b(lines|functions|statements|branches)\s*:\s*(\d+)/g;

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
  return null;
}
