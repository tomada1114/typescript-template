#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import console from "node:console";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isMain } from "./lib/is-main.mjs";
import { parseJson, readKey } from "./lib/json.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 */
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "inherit",
    timeout: 900_000,
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
  });
  if (result.status !== 0) {
    throw new Error(
      `ERR_BOOTSTRAP_E2E: ${command} ${args.join(" ")} failed with exit ${String(result.status)}.`,
    );
  }
}

/**
 * @param {string} destination
 */
function copyTemplate(destination) {
  const files = spawnSync(
    "git",
    ["-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (files.status !== 0) {
    throw new Error(`ERR_GIT_FILES: ${files.stderr.trim()}`);
  }
  for (const relative of files.stdout.split("\0").filter(Boolean)) {
    const source = path.join(ROOT, relative);
    if (!existsSync(source)) {
      continue;
    }
    const target = path.join(destination, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

/**
 * @returns {number}
 */
export function main() {
  const workspace = mkdtempSync(path.join(tmpdir(), "typescript-template-e2e-"));
  try {
    const cases = [
      ["node-library", "acme-node-library"],
      ["node-cli", "acme-node-cli"],
      ["universal-library", "acme-universal-library"],
      ["node-cli", "zukai"],
    ];
    for (const [profile, packageName] of cases) {
      if (profile === undefined || packageName === undefined) {
        throw new Error("ERR_E2E_CASE: malformed bootstrap test case.");
      }
      const destination = path.join(workspace, packageName);
      mkdirSync(destination);
      copyTemplate(destination);
      run("git", ["init", "-q"], destination);
      run("git", ["add", "-A"], destination);
      run(
        process.execPath,
        [
          "scripts/bootstrap.mjs",
          packageName,
          "--profile",
          profile,
          "--author",
          "Ada Lovelace",
          "--email",
          "ada@example.com",
          "--github-user",
          "ada",
          "--license",
          "MIT",
        ],
        destination,
      );
      run("corepack", ["pnpm@11.18.0", "install", "--frozen-lockfile"], destination);
      run("corepack", ["pnpm@11.18.0", "run", "check"], destination);
      if (packageName === "zukai") {
        const manifest = parseJson(
          readFileSync(path.join(destination, "package.json"), "utf8"),
        );
        if (
          typeof manifest !== "object" ||
          manifest === null ||
          readKey(manifest, "dependencies") !== undefined
        ) {
          throw new Error(
            "ERR_ZUKAI_RUNTIME_DEPENDENCIES: generated zukai must have zero runtime dependencies.",
          );
        }
      }
      console.log(`bootstrap-e2e: ${packageName} (${profile}) passed`);
    }
    return 0;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = main();
}
