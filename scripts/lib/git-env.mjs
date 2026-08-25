// Build an environment for a `git` process that must decide its own repository.
//
// Git exports `GIT_DIR` (and friends) to every hook it runs, and `lefthook.yml`
// runs this project's own test suite from two of them — `test:related` on
// pre-commit, `check:quick` on pre-push. A `git` spawned with only a `cwd`
// inherits those variables, and an inherited `GIT_DIR` outranks both the cwd and
// an explicit `-C`: git then treats the current directory as the work tree while
// writing to the *outer* repository's index, config, and object store. A
// throwaway fixture repository built that way stages its `.env` into the real
// index and rewrites the real `.git/config`.
//
// Every git spawn in this repository's automation and tests names the
// repository it means, as a `cwd` or an explicit `-C`, so every one of them
// clears these variables and lets that name decide. Under a hook the two agree;
// under a test driving a fixture repository they do not, and the inherited one
// wins by default.
import process from "node:process";

/**
 * Copy an environment with every `GIT_*` variable removed.
 *
 * @remarks
 * The whole prefix goes, not a hand-kept list: `GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_COMMON_DIR`, `GIT_NAMESPACE`,
 * `GIT_CEILING_DIRECTORIES` and the `GIT_CONFIG_*` family all redirect where git
 * reads and writes, and a list that has to be kept in step with git's own is a
 * list that will be out of date the next time one is added. A fixture repository
 * needs none of them.
 *
 * @param {NodeJS.ProcessEnv} [env] - Environment to copy. Defaults to the
 * current process environment.
 * @returns {NodeJS.ProcessEnv} A copy holding no `GIT_*` variable.
 *
 * @example
 * ```js
 * execFileSync("git", ["init", "-q"], { cwd: fixture, env: isolatedGitEnv() });
 * ```
 */
export function isolatedGitEnv(env = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const isolated = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("GIT_")) {
      isolated[key] = value;
    }
  }
  return isolated;
}
