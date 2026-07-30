#!/usr/bin/env node
// Prove the tarball works for someone who does not have this repository.
//
// Every check below runs against a throwaway consumer in the OS temp directory
// that installed the packed tarball. This script never imports `src/` or
// `dist/`, and the TypeScript step asserts that the consumer's compiler never
// read them either — which is what turns "the published declarations are
// self-contained" from a hope into a fact (spec 02 §4).
//
// Build and pack happen in the package.json script that calls this one, because
// pnpm's own path is not discoverable from a `.mjs` under pnpm 11.
import console from "node:console";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import {
  findAbsoluteMapSources,
  inspectPackageEntries,
  readTarEntries,
} from "./check-package.mjs";
import { isMain } from "./lib/is-main.mjs";
import { parseJson, readKey, readString } from "./lib/json.mjs";
import {
  npmCliPath,
  repoRoot,
  resolveDependencyBin,
  runNode,
} from "./lib/node-tools.mjs";
import { findSingleTarball } from "./lib/tarball.mjs";

const USAGE = `Usage: node scripts/smoke-package.mjs (--pack-dir <dir> | --tarball <file>)

Installs an already-packed tarball into a throwaway consumer and exercises it.

Exit codes:
  0  the tarball is usable by a consumer
  1  a check failed
  2  the arguments were wrong`;

/** Raised for a check failure whose message is already agent-readable. */
class SmokeError extends Error {}

/**
 * What a CLI invocation is required to produce.
 *
 * @typedef {object} CliExpectation
 * @property {number} status - Required exit code.
 * @property {"empty"} [stdout] - Require stdout to be empty.
 * @property {"nonempty"} [stderr] - Require stderr to carry an explanation.
 */

/**
 * Fail the smoke test with a message shaped for spec 02 §7.3.
 *
 * @param {string} code - Stable error code.
 * @param {object} detail - What went wrong.
 * @param {string} detail.what - The failed check, in one sentence.
 * @param {string} [detail.subject] - Path, export or profile concerned.
 * @param {string} [detail.expected] - Expected value.
 * @param {string} [detail.actual] - Observed value.
 * @param {string} detail.next - The next safe command or edit.
 * @returns {never}
 * @throws SmokeError always.
 */
function fail(code, detail) {
  const lines = [`${code}: ${detail.what}`];
  if (detail.subject !== undefined) {
    lines.push(`Subject: ${detail.subject}`);
  }
  if (detail.expected !== undefined) {
    lines.push(`Expected: ${detail.expected}`);
  }
  if (detail.actual !== undefined) {
    lines.push(`Actual: ${detail.actual}`);
  }
  lines.push(`Next: ${detail.next}`);
  throw new SmokeError(lines.join("\n"));
}

/**
 * Report progress, so a failure is easy to place in the sequence.
 *
 * @param {string} message - What is about to happen.
 * @returns {void}
 */
function step(message) {
  console.log(`smoke: ${message}`);
}

/**
 * Truncate captured output so a failure message stays readable.
 *
 * @param {string} text - Captured stream.
 * @returns {string} At most a dozen lines of it.
 */
function excerpt(text) {
  const trimmed = text.trim();
  if (trimmed === "") {
    return "<empty>";
  }
  const lines = trimmed.split("\n");
  return lines.length <= 12 ? trimmed : `${lines.slice(0, 12).join("\n")}\n…`;
}

/**
 * Read the profile this template is configured as.
 *
 * @remarks
 * `tsconfig.build.json`'s `compilerOptions.types` is the single source of truth
 * for the profile — an empty array means `src/` may not use Node built-ins — so
 * the bundler-resolution check is driven by the same value that decides what
 * actually compiles, and cannot drift from it.
 *
 * @returns {boolean} True for the `universal-library` profile.
 */
function isUniversalProfile() {
  const raw = readFileSync(path.join(repoRoot, "tsconfig.build.json"), "utf8");
  // The build config is JSONC; drop full-line comments before parsing.
  const parsed = parseJson(raw.replace(/^\s*\/\/.*$/gm, ""));
  const types = readKey(readKey(parsed, "compilerOptions"), "types");
  return Array.isArray(types) && types.length === 0;
}

/**
 * Public subpaths a consumer is allowed to import.
 *
 * @param {unknown} manifest - The packed `package.json`.
 * @returns {string[]} Specifier suffixes, `""` for the package root.
 */
function publicSubpaths(manifest) {
  const exports = readKey(manifest, "exports");
  if (typeof exports !== "object" || exports === null) {
    return [""];
  }
  const keys = Object.keys(/** @type {Record<string, unknown>} */ (exports));
  // A conditions-only `exports` object, with no "." key, still describes the root.
  if (!keys.some((key) => key.startsWith("."))) {
    return [""];
  }
  return keys
    .filter((key) => key.startsWith(".") && !key.includes("*"))
    .map((key) => (key === "." ? "" : key.slice(1)))
    .sort();
}

// -----------------------------------------------------------------------------
// Checks
// -----------------------------------------------------------------------------

/**
 * Steps 3 to 5: what the tarball contains, and what it must not.
 *
 * @param {readonly import("./check-package.mjs").TarEntry[]} entries - Tarball entries.
 * @param {unknown} manifest - Repository `package.json`.
 * @param {string} label - Tarball file name, for error messages.
 * @returns {void}
 */
function checkTarballContents(entries, manifest, label) {
  step("inspecting tarball paths, forbidden paths and size limits");
  const problems = inspectPackageEntries(entries, { manifest });
  if (problems.length > 0) {
    fail("ERR_SMOKE_TARBALL_CONTENTS", {
      what: `The tarball failed ${String(problems.length)} content check(s).`,
      subject: label,
      actual: problems
        .map((problem) => `[${problem.code}] ${problem.message}`)
        .join("\n\n"),
      next: "Fix the paths listed above, then run `pnpm run package:smoke` again.",
    });
  }

  step("checking that no published map leaks an absolute path");
  const leaks = findAbsoluteMapSources(entries);
  if (leaks.length > 0) {
    fail("ERR_SMOKE_MAP_ABSOLUTE_PATH", {
      what: "A published map references its sources by absolute path, exposing the build machine's layout.",
      subject: leaks.map((leak) => leak.path).join(", "),
      expected: "every `sources` entry relative to the map file",
      actual: `${String(leaks.length)} absolute reference(s)`,
      next: "Check `rootDir` and `outDir` in tsconfig.build.json, then rebuild.",
    });
  }
}

/**
 * Step 6: a throwaway consumer that installed the tarball.
 *
 * @param {string} workspace - Temp directory to build inside.
 * @param {string} tarball - Path to the packed `.tgz`.
 * @returns {string} The consumer's directory.
 */
function installConsumer(workspace, tarball) {
  step("installing the tarball into a throwaway consumer");
  const consumer = path.join(workspace, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(
    path.join(consumer, "package.json"),
    `${JSON.stringify(
      { name: "smoke-consumer", version: "0.0.0", private: true, type: "module" },
      null,
      2,
    )}\n`,
  );

  const result = runNode(
    npmCliPath(),
    [
      "install",
      tarball,
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      // A published package must be usable without running install scripts, and
      // this keeps the smoke test from executing anything the tarball ships.
      "--ignore-scripts",
    ],
    {
      cwd: consumer,
      env: {
        ...process.env,
        npm_config_cache: path.join(workspace, "npm-cache"),
      },
    },
  );
  if (result.status !== 0) {
    fail("ERR_SMOKE_INSTALL_FAILED", {
      what: "A consumer could not install the tarball.",
      subject: path.basename(tarball),
      expected: "npm install exits 0",
      actual: `exit ${String(result.status)}\n${excerpt(result.stderr || result.stdout)}`,
      next: "Run `pnpm run package:lint` to check the manifest, then pack again.",
    });
  }
  return consumer;
}

/**
 * Run a generated ESM script inside the consumer.
 *
 * @param {string} consumer - Consumer directory.
 * @param {string} name - File name to write.
 * @param {string} source - Script body.
 * @returns {import("./lib/node-tools.mjs").RunResult} The captured result.
 */
function runInConsumer(consumer, name, source) {
  const file = path.join(consumer, name);
  writeFileSync(file, source);
  return runNode(file, [], { cwd: consumer });
}

/**
 * Steps 7 and 8: import every public entry point and call the root API.
 *
 * @param {string} consumer - Consumer directory.
 * @param {string} packageName - Installed package name.
 * @param {readonly string[]} subpaths - From {@link publicSubpaths}.
 * @returns {void}
 */
function checkRuntimeImports(consumer, packageName, subpaths) {
  step(
    `importing ${String(subpaths.length)} public entry point(s) and calling the API`,
  );
  const result = runInConsumer(
    consumer,
    "check-runtime.mjs",
    `import assert from "node:assert/strict";

for (const subpath of ${JSON.stringify(subpaths)}) {
  const specifier = ${JSON.stringify(packageName)} + subpath;
  const module = await import(specifier);
  assert.equal(
    Object.hasOwn(module, "default"),
    false,
    \`\${specifier} exposes a default export; the contract is named exports only\`,
  );
  const names = Object.keys(module).filter((name) => name !== "__esModule");
  assert.ok(names.length > 0, \`\${specifier} exposes no named exports\`);
  console.log(\`  \${specifier} -> \${names.sort().join(", ")}\`);
}

// Exercise the root API for real: an entry point that resolves but throws on
// first use would otherwise pass.
const { normalizeIdentifier, withTimeout, InvalidInputError, TimeoutError } =
  await import(${JSON.stringify(packageName)});

assert.equal(normalizeIdentifier("Hello World"), "hello-world");
assert.equal(normalizeIdentifier("Hello World", { separator: "_" }), "hello_world");
assert.throws(() => normalizeIdentifier("   "), InvalidInputError);

assert.equal(await withTimeout(async () => "ok", { timeoutMs: 10_000 }), "ok");
await assert.rejects(
  withTimeout(
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { reject(signal.reason); }, { once: true });
      }),
    { timeoutMs: 1 },
  ),
  TimeoutError,
);
console.log("  root API behaved as documented");
`,
  );

  if (result.status !== 0) {
    fail("ERR_SMOKE_IMPORT_FAILED", {
      what: "A consumer could not import or use the published entry points.",
      subject: subpaths.map((subpath) => packageName + subpath).join(", "),
      expected: "every public subpath imports, and the root API behaves as documented",
      actual: `exit ${String(result.status)}\n${excerpt(result.stderr || result.stdout)}`,
      next: "Check `exports` in package.json and the re-exports in src/index.ts.",
    });
  }
  process.stdout.write(result.stdout);
}

/**
 * Step 12: a private module must not be reachable by deep import.
 *
 * @param {string} consumer - Consumer directory.
 * @param {string} packageName - Installed package name.
 * @returns {void}
 */
function checkDeepImportBlocked(consumer, packageName) {
  const specifier = `${packageName}/dist/internal/assert.js`;
  step(`checking that ${specifier} is not reachable`);
  const result = runInConsumer(
    consumer,
    "check-deep-import.mjs",
    `import assert from "node:assert/strict";

// The file is inside the tarball on purpose: index.js imports it. What must hold
// is that \`exports\` refuses to resolve it for a consumer.
await assert.rejects(
  import(${JSON.stringify(specifier)}),
  (error) => {
    assert.equal(
      error.code,
      "ERR_PACKAGE_PATH_NOT_EXPORTED",
      \`expected ERR_PACKAGE_PATH_NOT_EXPORTED, received \${String(error.code)}\`,
    );
    return true;
  },
);
console.log("  deep import correctly refused");
`,
  );

  if (result.status !== 0) {
    fail("ERR_SMOKE_DEEP_IMPORT_ALLOWED", {
      what: "A private module was reachable by deep import, or the import failed for the wrong reason.",
      subject: specifier,
      expected: "the import rejects with ERR_PACKAGE_PATH_NOT_EXPORTED",
      actual: `exit ${String(result.status)}\n${excerpt(result.stderr || result.stdout)}`,
      next: 'Keep `exports` an allowlist of subpaths and never add a "./*" pattern.',
    });
  }
  process.stdout.write(result.stdout);
}

/**
 * Compile a generated TypeScript consumer against the installed package.
 *
 * @remarks
 * The project is created *inside* the consumer directory so ordinary upward
 * `node_modules` resolution finds the installed package. No `paths` mapping is
 * involved, which means this exercises the same resolution a real consumer gets.
 *
 * @param {string} consumer - Directory holding the installed package.
 * @param {string} packageName - Installed package name.
 * @param {"NodeNext" | "Bundler"} resolution - `moduleResolution` under test.
 * @returns {string} `tsc --listFiles` output.
 */
function compileTypeScriptConsumer(consumer, packageName, resolution) {
  const project = path.join(consumer, `ts-${resolution.toLowerCase()}`);
  mkdirSync(project, { recursive: true });

  const nodeNext = resolution === "NodeNext";
  writeFileSync(
    path.join(project, "package.json"),
    `${JSON.stringify(
      {
        name: `ts-${resolution.toLowerCase()}`,
        version: "0.0.0",
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(project, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          // Bundler resolution is only valid with `module: Preserve`; NodeNext
          // pairs with itself. Both are what a real consumer would write.
          module: nodeNext ? "NodeNext" : "Preserve",
          moduleResolution: resolution,
          strict: true,
          noEmit: true,
          // Check the published declarations rather than trusting them.
          skipLibCheck: false,
          ...(nodeNext
            ? {
                // A Node consumer has @types/node. Borrowing this repository's
                // copy keeps the check offline; it is ambient environment for
                // the consumer, not this package's source, and the assertion
                // below still forbids reading src/ or dist/.
                lib: ["ES2023"],
                types: ["node"],
                typeRoots: [
                  path
                    .join(repoRoot, "node_modules", "@types")
                    .split(path.sep)
                    .join("/"),
                ],
              }
            : {
                // A bundler consumer may have no Node types at all, so the
                // declarations must rest on standard globals only.
                lib: ["ES2023", "DOM"],
                types: [],
              }),
        },
        include: ["index.ts"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(project, "index.ts"),
    `import {
  InvalidInputError,
  TimeoutError,
  normalizeIdentifier,
  withTimeout,
} from ${JSON.stringify(packageName)};
import type {
  NormalizeIdentifierOptions,
  WithTimeoutOptions,
} from ${JSON.stringify(packageName)};

// Exercise the inferred types, not merely the presence of the names.
const options: NormalizeIdentifierOptions = { separator: "_", maxLength: 8 };
const identifier: string = normalizeIdentifier("Hello World", options);
const deadline: WithTimeoutOptions = { timeoutMs: 1_000 };

export async function run(): Promise<string> {
  try {
    return await withTimeout<string>(async () => identifier, deadline);
  } catch (error: unknown) {
    if (error instanceof TimeoutError) {
      return \`timed out after \${String(error.timeoutMs)}ms\`;
    }
    if (error instanceof InvalidInputError) {
      // \`code\` and \`field\` are part of the published contract.
      return \`\${error.code}: \${error.field}\`;
    }
    throw error;
  }
}
`,
  );

  const tsc = resolveDependencyBin("typescript", "tsc");
  const result = runNode(tsc, ["-p", "tsconfig.json", "--listFiles"], { cwd: project });
  if (result.status !== 0) {
    fail("ERR_SMOKE_CONSUMER_TSC_FAILED", {
      what: `A TypeScript consumer using ${resolution} resolution did not compile.`,
      subject: `moduleResolution: ${resolution}`,
      expected: "tsc exits 0 against the published declarations",
      actual: `exit ${String(result.status)}\n${excerpt(result.stdout || result.stderr)}`,
      next: "Run `pnpm run build` and `pnpm run package:lint`, then check `exports.types`.",
    });
  }
  return result.stdout;
}

/**
 * Steps 9 and 10: the consumer compiles, and does so without this repository.
 *
 * @param {string} consumer - Directory holding the installed package.
 * @param {string} packageName - Installed package name.
 * @returns {void}
 */
function checkTypeScriptConsumers(consumer, packageName) {
  step("compiling a NodeNext TypeScript consumer");
  const listed = compileTypeScriptConsumer(consumer, packageName, "NodeNext");

  step("checking that the consumer's compiler never read this repository's code");
  // The proof that the published declarations are self-contained: if any file
  // under this repository's src/ or dist/ appears, the consumer only
  // type-checked because the repository happens to be on this disk.
  const forbiddenRoots = [path.join(repoRoot, "src"), path.join(repoRoot, "dist")];
  const offenders = listed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .filter((line) =>
      forbiddenRoots.some(
        (root) =>
          line === root ||
          line.startsWith(`${root}${path.sep}`) ||
          line.startsWith(`${root}/`),
      ),
    );
  if (offenders.length > 0) {
    fail("ERR_SMOKE_CONSUMER_READ_REPOSITORY", {
      what: "The consumer's compiler read this repository's own sources.",
      subject: offenders.slice(0, 5).join(", "),
      expected: "only the installed package and the TypeScript lib files",
      actual: `${String(offenders.length)} file(s) under src/ or dist/`,
      next: "Check that `exports.types` points into dist/ and that no published declaration re-exports a path outside the package.",
    });
  }

  if (isUniversalProfile()) {
    step("compiling a Bundler-resolution consumer (universal-library profile)");
    compileTypeScriptConsumer(consumer, packageName, "Bundler");
  } else {
    step(
      "skipping the Bundler-resolution consumer: this is a Node profile " +
        "(tsconfig.build.json sets compilerOptions.types to a non-empty list)",
    );
  }
}

/**
 * Step 11: the CLI that a `bin` field promises.
 *
 * @param {string} consumer - Directory holding the installed package.
 * @param {string} packageName - Installed package name.
 * @param {unknown} manifest - The packed `package.json`.
 * @param {readonly import("./check-package.mjs").TarEntry[]} entries - Tarball entries.
 * @returns {void}
 */
function checkCli(consumer, packageName, manifest, entries) {
  const bin = readKey(manifest, "bin");
  if (bin === undefined) {
    step("skipping CLI checks: package.json declares no bin");
    return;
  }

  /** @type {[string, unknown][]} */
  const binEntries =
    typeof bin === "string"
      ? [[readString(manifest, "name") ?? packageName, bin]]
      : Object.entries(/** @type {Record<string, unknown>} */ (bin));
  const version = readString(manifest, "version");

  for (const [binName, target] of binEntries) {
    if (typeof target !== "string") {
      continue;
    }
    const relative = target.startsWith("./") ? target.slice(2) : target;
    step(`checking the ${binName} CLI (${relative})`);
    const installed = path.join(consumer, "node_modules", packageName, relative);

    // Without a shebang the file cannot be executed directly, only through the
    // shim npm happens to create.
    const firstLine = readFileSync(installed, "utf8").split("\n", 1)[0] ?? "";
    if (!firstLine.startsWith("#!")) {
      fail("ERR_SMOKE_CLI_NO_SHEBANG", {
        what: "The published CLI entry has no shebang.",
        subject: relative,
        expected: "#!/usr/bin/env node on the first line",
        actual: excerpt(firstLine),
        next: "Keep the shebang as the first line of src/bin.ts.",
      });
    }

    // The execute bit as recorded in the tarball, not as found on disk: npm sets
    // the bit while linking, so an installed file would look fine either way.
    const packed = entries.find((entry) => entry.path === relative);
    if (packed === undefined || (packed.mode & 0o111) === 0) {
      fail("ERR_SMOKE_CLI_NOT_EXECUTABLE", {
        what: "The CLI entry is not marked executable inside the tarball.",
        subject: relative,
        expected: "a mode with at least one execute bit set",
        actual:
          packed === undefined
            ? "the file is not in the tarball at all"
            : `mode ${packed.mode.toString(8)}`,
        next: "Confirm src/bin.ts starts with a shebang so `tsc` emits an executable file, then rebuild and pack.",
      });
    }

    // The shim created from `bin`. Its extension differs per platform, so its
    // existence is checked while the CLI itself is run through Node below.
    const shimDir = path.join(consumer, "node_modules", ".bin");
    const linked = [binName, `${binName}.cmd`, `${binName}.ps1`].some((shim) =>
      existsSync(path.join(shimDir, shim)),
    );
    if (!linked) {
      fail("ERR_SMOKE_CLI_NOT_LINKED", {
        what: "Installing the package did not create the CLI shim.",
        subject: `node_modules/.bin/${binName}`,
        expected: "a shim generated from package.json#bin",
        actual: "absent",
        next: "Check that the `bin` key names the intended command and points at a packed file.",
      });
    }

    /**
     * Run the installed CLI and assert on its three observable outputs.
     *
     * @param {readonly string[]} args - CLI arguments.
     * @param {CliExpectation} expected - Required outcome.
     * @returns {import("./lib/node-tools.mjs").RunResult} The captured result.
     */
    const expectCli = (args, expected) => {
      const result = runNode(installed, args, { cwd: consumer });
      const label = `${binName} ${args.join(" ")}`.trim();
      if (result.status !== expected.status) {
        fail("ERR_SMOKE_CLI_EXIT_CODE", {
          what: "The CLI returned the wrong exit code.",
          subject: label,
          expected: `exit ${String(expected.status)}`,
          actual: `exit ${String(result.status)}\nstderr: ${excerpt(result.stderr)}`,
          next: "Check the exit codes in src/cli.ts: 0 success, 1 rejected input, 2 usage error.",
        });
      }
      if (expected.stdout === "empty" && result.stdout.trim() !== "") {
        fail("ERR_SMOKE_CLI_STREAM", {
          what: "The CLI wrote to stdout while failing, which corrupts a pipeline.",
          subject: label,
          expected: "empty stdout",
          actual: excerpt(result.stdout),
          next: "Route every diagnostic to stderr in src/cli.ts.",
        });
      }
      if (expected.stderr === "nonempty" && result.stderr.trim() === "") {
        fail("ERR_SMOKE_CLI_STREAM", {
          what: "The CLI failed without explaining why.",
          subject: label,
          expected: "a message on stderr",
          actual: "<empty>",
          next: "Write the reason and the usage text to stderr in src/cli.ts.",
        });
      }
      return result;
    };

    // `--version` must agree with the manifest, or a bug report names a release
    // that does not contain the code it was filed against.
    const reported = expectCli(["--version"], { status: 0 }).stdout.trim();
    if (version !== undefined && reported !== version) {
      fail("ERR_SMOKE_CLI_VERSION_MISMATCH", {
        what: "The CLI reports a different version than package.json declares.",
        subject: `${binName} --version`,
        expected: version,
        actual: reported === "" ? "<empty>" : reported,
        next: "Check how src/bin.ts reads the installed package.json.",
      });
    }

    const help = expectCli(["--help"], { status: 0 });
    if (help.stdout.trim() === "") {
      fail("ERR_SMOKE_CLI_STREAM", {
        what: "`--help` printed nothing to stdout.",
        subject: `${binName} --help`,
        expected: "usage text on stdout",
        actual: "<empty>",
        next: "Print the usage text to stdout for an explicit help request.",
      });
    }

    // A malformed command line is the caller's mistake: exit 2, nothing on
    // stdout, an explanation on stderr.
    expectCli(["--nonexistent-flag"], {
      status: 2,
      stdout: "empty",
      stderr: "nonempty",
    });
    expectCli([], { status: 2, stdout: "empty", stderr: "nonempty" });

    // Input that was understood but rejected is a different outcome: exit 1.
    expectCli(["normalize", "   "], { status: 1, stdout: "empty", stderr: "nonempty" });

    // And the success path still works.
    const normalized = expectCli(["normalize", "Hello World"], { status: 0 });
    if (normalized.stdout.trim() !== "hello-world") {
      fail("ERR_SMOKE_CLI_OUTPUT", {
        what: "The CLI produced unexpected output on the success path.",
        subject: `${binName} normalize "Hello World"`,
        expected: "hello-world",
        actual: excerpt(normalized.stdout),
        next: "Check the `normalize` command in src/cli.ts against normalizeIdentifier.",
      });
    }
  }
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

/**
 * Resolve the tarball to smoke test from the command line.
 *
 * @remarks
 * `--tarball` exists for the release workflow, which packs once and must verify
 * and publish that exact file rather than an equivalent rebuild.
 *
 * @param {readonly string[]} argv - Arguments after the script path.
 * @returns {string} Path to the tarball.
 * @throws Error when the arguments are unusable.
 */
export function resolveTarballArgument(argv) {
  /** @type {string | undefined} */
  let packDir;
  /** @type {string | undefined} */
  let tarball;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--pack-dir" && flag !== "--tarball") {
      throw new Error(`Unknown argument: ${String(flag)}\n\n${USAGE}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value.\n\n${USAGE}`);
    }
    if (flag === "--pack-dir") {
      packDir = value;
    } else {
      tarball = value;
    }
    index += 1;
  }

  if ((packDir === undefined) === (tarball === undefined)) {
    throw new Error(`Pass exactly one of --pack-dir or --tarball.\n\n${USAGE}`);
  }
  return tarball ?? findSingleTarball(/** @type {string} */ (packDir));
}

/**
 * Run the smoke test as a command.
 *
 * @param {readonly string[]} argv - Arguments after the script path.
 * @returns {number} Process exit code.
 */
function main(argv) {
  /** @type {string} */
  let tarball;
  try {
    tarball = path.resolve(resolveTarballArgument(argv));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const manifest = parseJson(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const packageName = readString(manifest, "name");
  if (packageName === undefined) {
    console.error(
      "ERR_SMOKE_NO_PACKAGE_NAME: package.json has no name field.\n" +
        "Next: restore the `name` field before packing.",
    );
    return 1;
  }

  // Created before the try block so the cleanup in `finally` always has
  // something to remove, whichever step fails.
  const workspace = mkdtempSync(path.join(tmpdir(), "package-smoke-"));
  try {
    step(`tarball: ${path.basename(tarball)}`);
    const entries = readTarEntries(readFileSync(tarball));
    checkTarballContents(entries, manifest, path.basename(tarball));

    const consumer = installConsumer(workspace, tarball);

    // From here the packed manifest is the authority: it is what a consumer
    // resolves against, and it can differ from the repository's working copy.
    const installedManifest = parseJson(
      readFileSync(
        path.join(consumer, "node_modules", packageName, "package.json"),
        "utf8",
      ),
    );

    checkRuntimeImports(consumer, packageName, publicSubpaths(installedManifest));
    checkTypeScriptConsumers(consumer, packageName);
    checkCli(consumer, packageName, installedManifest, entries);
    checkDeepImportBlocked(consumer, packageName);

    step("all checks passed");
    return 0;
  } catch (error) {
    if (error instanceof SmokeError) {
      console.error(`\n${error.message}`);
      return 1;
    }
    console.error(
      `\nERR_SMOKE_UNEXPECTED: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }`,
    );
    return 1;
  } finally {
    // Runs on success and on failure, so the throwaway consumer never survives.
    // The pack directory is left alone on purpose: it is gitignored, the next
    // run empties it before packing, and keeping it means a failed run leaves
    // the exact tarball available for inspection. `pnpm clean` removes it.
    rmSync(workspace, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
