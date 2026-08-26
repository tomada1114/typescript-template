#!/usr/bin/env node
import console from "node:console";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { isMain } from "./lib/is-main.mjs";
import { npmCliPath, runNode } from "./lib/node-tools.mjs";
import { findSingleTarball } from "./lib/tarball.mjs";

/**
 * @param {readonly string[]} argv
 * @returns {number}
 */
export function main(argv) {
  if (argv.length !== 2 || argv[0] !== "--pack-dir" || argv[1] === undefined) {
    console.error(
      "ERR_REHEARSAL_ARGUMENTS: use `node scripts/publish-rehearsal.mjs --pack-dir <dir>`.",
    );
    return 2;
  }

  const packDirectory = path.resolve(argv[1]);
  const relativePackDirectory = path.relative(process.cwd(), packDirectory);
  if (
    relativePackDirectory === "" ||
    relativePackDirectory.startsWith("..") ||
    path.isAbsolute(relativePackDirectory)
  ) {
    console.error(
      "ERR_REHEARSAL_PACK_DIR: the pack directory must be inside the repository.",
    );
    return 2;
  }

  let tarball;
  try {
    tarball = findSingleTarball(packDirectory);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const workspace = mkdtempSync(path.join(tmpdir(), "npm-publish-rehearsal-"));
  try {
    const publish = runNode(
      npmCliPath(),
      // No `--access`: the packed manifest's `publishConfig` carries it, and
      // stating it here too would let the rehearsal pass under a contract the
      // real publish does not use.
      ["publish", tarball, "--dry-run", "--ignore-scripts", "--json"],
      {
        cwd: workspace,
        env: {
          ...process.env,
          npm_config_cache: path.join(workspace, "npm-cache"),
        },
      },
    );
    if (publish.status !== 0) {
      console.error(
        `ERR_PUBLISH_DRY_RUN: npm rejected the exact packed tarball.\n${publish.stderr}\n${publish.stdout}`,
      );
      return 1;
    }

    const smoke = runNode(path.resolve("scripts/smoke-package.mjs"), [
      "--tarball",
      tarball,
    ]);
    process.stdout.write(smoke.stdout);
    process.stderr.write(smoke.stderr);
    if (smoke.status !== 0) {
      console.error(
        "ERR_REHEARSAL_CONSUMER: the tarball passed npm dry-run but failed consumer smoke.",
      );
      return 1;
    }

    console.log(
      "publish-rehearsal: npm accepted the tarball in dry-run and a throwaway consumer installed and imported the same file.",
    );
    return 0;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(packDirectory, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
