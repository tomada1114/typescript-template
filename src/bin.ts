#!/usr/bin/env node
// Entry shim for the `bin` field. All testable behavior lives in src/cli.ts;
// this file only binds it to the real process, which is why it is the one
// source file without direct unit coverage. The published shim is exercised
// end to end by scripts/smoke-package.mjs against the packed tarball.
import { readFileSync } from "node:fs";
import process from "node:process";

import { runCli, type CliIo } from "./cli.js";

/**
 * Read the installed package's own version.
 *
 * @remarks
 * Resolved relative to this module rather than the working directory, so it
 * reports the installed package even when invoked from another project.
 */
function packageVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (
    typeof manifest === "object" &&
    manifest !== null &&
    "version" in manifest &&
    typeof manifest.version === "string"
  ) {
    return manifest.version;
  }
  throw new Error("Installed package.json has no version string.");
}

const io: CliIo = {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
  version: packageVersion(),
};

process.exitCode = runCli(process.argv.slice(2), io);
