#!/usr/bin/env node
// Remove build output without depending on a shell or an extra package.
// Only paths passed on the command line are removed, and only when they sit
// inside the repository, so a typo can never reach outside the project.
// Node globals are imported explicitly rather than declared as ESLint globals:
// one convention for every .mjs file here, and no extra dependency.
import console from "node:console";
import { rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = process.argv.slice(2);

if (targets.length === 0) {
  console.error("clean: no targets given. Usage: node scripts/clean.mjs <path>...");
  process.exit(2);
}

for (const target of targets) {
  const resolved = path.resolve(repoRoot, target);
  const relative = path.relative(repoRoot, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    console.error(`clean: refusing to remove a path outside the repository: ${target}`);
    process.exit(2);
  }
  rmSync(resolved, { recursive: true, force: true });
}
