#!/usr/bin/env node
// Remove build output without depending on a shell or an extra package.
// Only paths passed on the command line are removed, and only when they sit
// inside the repository, so a typo can never reach outside the project.
// Node globals are imported explicitly rather than declared as ESLint globals:
// one convention for every .mjs file here, and no extra dependency.
import console from "node:console";
import { realpathSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isMain } from "./lib/is-main.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function isInside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Remove each target path, refusing anything outside the repository.
 *
 * @remarks
 * Exported so `tests/clean.test.ts` can exercise both branches (no targets,
 * and a path outside the repository) directly, instead of only through a
 * spawned process. `root` defaults to this repository's own root and is
 * overridable so a test can point it at a throwaway `mkdtempSync` directory
 * instead of writing into the real project directory — the same
 * dependency-injection shape `sync-labels.mjs`'s `main` uses for `root`.
 *
 * @param {readonly string[]} targets - Paths to remove, relative to `root`
 * or already inside it.
 * @param {string} [root] - Directory targets must resolve inside; defaults
 * to this repository's own root.
 * @returns {number} Process exit code: 0 on success, 2 for bad usage.
 */
export function clean(targets, root = repoRoot) {
  if (targets.length === 0) {
    console.error("clean: no targets given. Usage: node scripts/clean.mjs <path>...");
    return 2;
  }

  try {
    const absoluteRoot = path.resolve(root);
    const physicalRoot = realpathSync(absoluteRoot);
    const resolvedTargets = targets.map((target) => path.resolve(absoluteRoot, target));
    for (const [index, resolved] of resolvedTargets.entries()) {
      let safe = isInside(absoluteRoot, resolved);
      // Removing a leaf symlink is safe; traversing its parent may reach outside.
      for (
        let parent = path.dirname(resolved);
        safe && parent !== absoluteRoot;
        parent = path.dirname(parent)
      ) {
        try {
          const physicalParent = realpathSync(parent);
          safe =
            physicalParent === physicalRoot || isInside(physicalRoot, physicalParent);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
          }
        }
      }
      if (!safe) {
        console.error(
          `clean: refusing to remove a path outside the repository: ${targets[index] ?? ""}`,
        );
        return 2;
      }
    }
    for (const resolved of resolvedTargets) {
      rmSync(resolved, { recursive: true, force: true });
    }
  } catch (error) {
    console.error(
      "ERR_CLEAN_FAILED: could not remove generated output.\n" +
        `Actual: ${error instanceof Error && "code" in error ? String(error.code) : "filesystem error"}.\n` +
        "Next: check output-directory permissions, then rerun the command.",
    );
    return 1;
  }
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = clean(process.argv.slice(2));
}
