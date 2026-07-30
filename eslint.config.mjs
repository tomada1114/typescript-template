import { readFileSync } from "node:fs";

import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

/**
 * Read one property off a value of unknown shape.
 *
 * @param {unknown} value - Candidate object.
 * @param {string} key - Property to read.
 * @returns {unknown} The property value, or undefined when absent.
 */
function readKey(value, key) {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  return /** @type {Record<string, unknown>} */ (value)[key];
}

/**
 * The `universal-library` profile forbids Node built-ins in `src/` by emptying
 * `compilerOptions.types` in the build config. Reading that back here keeps the
 * profile encoded in exactly one place instead of duplicating a profile flag
 * that could drift out of sync with what actually compiles.
 *
 * @returns {boolean} True when `src/` must stay runtime-agnostic.
 */
function isUniversalProfile() {
  const raw = readFileSync(new URL("tsconfig.build.json", import.meta.url), "utf8");
  // The build config is JSONC; strip full-line comments before parsing.
  /** @type {unknown} */
  const parsed = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
  const types = readKey(readKey(parsed, "compilerOptions"), "types");
  return Array.isArray(types) && types.length === 0;
}

/** @type {import("eslint").Linter.Config[]} */
const universalSourceRestrictions = isUniversalProfile()
  ? [
      {
        name: "universal-profile/no-node-builtins",
        files: ["src/**/*.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["node:*"],
                  message:
                    "The universal-library profile must run outside Node. Move Node-only code behind a separate conditional export entry.",
                },
              ],
            },
          ],
        },
      },
    ]
  : [];

export default defineConfig([
  // Only generated trees are ignored; everything hand-written is linted,
  // including repository automation and config files.
  globalIgnores(["dist/", "coverage/", "docs/api/"]),
  {
    linterOptions: {
      // A disable directive that no longer suppresses anything is dead weight
      // that hides the next real violation.
      reportUnusedDisableDirectives: "error",
    },
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          // `@ts-ignore` hides an error forever; `@ts-expect-error` fails once
          // the underlying problem is gone, so it is the only allowed escape
          // hatch and it must say why.
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-check": false,
          "ts-expect-error": "allow-with-description",
          minimumDescriptionLength: 10,
        },
      ],
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
      "no-console": "error",
    },
  },
  {
    name: "public-api/explicit-surface",
    files: ["src/**/*.ts"],
    rules: {
      // The published contract is named exports from src/index.ts. A default
      // export has no stable name for consumers to import or for API reports
      // to track.
      "no-restricted-exports": [
        "error",
        {
          restrictDefaultExports: {
            direct: true,
            named: true,
            defaultFrom: true,
            namedFrom: true,
            namespaceFrom: true,
          },
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExportAllDeclaration",
          message:
            "`export *` publishes symbols implicitly. Re-export each public symbol by name from src/index.ts.",
        },
      ],
    },
  },
  ...universalSourceRestrictions,
  {
    name: "cli/console-output",
    files: ["src/cli.ts", "src/bin.ts"],
    rules: {
      // A CLI's stdout/stderr is its interface, not stray debugging.
      "no-console": "off",
    },
  },
  {
    name: "automation/node-scripts",
    files: ["scripts/**/*.mjs", ".claude/hooks/*.mjs"],
    rules: {
      // These files are the CLI surface of repository automation.
      "no-console": "off",
    },
  },
  {
    name: "tests/relaxations",
    files: ["tests/**/*.ts"],
    rules: {
      // Tests deliberately construct invalid input to prove it is rejected.
      "@typescript-eslint/no-confusing-void-expression": "off",
    },
  },
  // Must stay last: turns off stylistic rules that would fight Prettier.
  eslintConfigPrettier,
]);
