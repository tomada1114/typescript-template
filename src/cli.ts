#!/usr/bin/env node

import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the package command without coupling its behavior to process globals.
 *
 * @param argv Arguments after the executable name.
 * @param executable Name or path shown in the usage line.
 * @returns The process result a caller should observe.
 */
export function runCli(argv: readonly string[], executable = "package"): CliResult {
  let help: boolean | undefined;
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: { help: { type: "boolean", short: "h" } },
      strict: true,
      allowPositionals: false,
    });
    help = values.help;
  } catch {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `Invalid arguments. Run ${executable} --help for usage.\n`,
    };
  }
  if (help === true) {
    return {
      exitCode: 0,
      stdout:
        `Usage: ${executable} [options]\n\n` +
        "Options:\n" +
        "  -h, --help  Show this help message.\n",
      stderr: "",
    };
  }
  return { exitCode: 0, stdout: "", stderr: "" };
}

function canonicalize(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return (
    entry !== undefined &&
    canonicalize(entry) === canonicalize(fileURLToPath(moduleUrl))
  );
}

if (isMain(import.meta.url)) {
  const result = runCli(process.argv.slice(2), process.argv[1] ?? "package");
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
