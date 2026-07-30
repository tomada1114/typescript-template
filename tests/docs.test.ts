import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { normalizeIdentifier } from "../src/index.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const documentedSpecifier = "my-package";

describe("README quick start", () => {
  it("uses the public package root and matches runtime behavior", () => {
    expect(readme).toContain(
      `import { normalizeIdentifier } from "${documentedSpecifier}";`,
    );
    expect(readme).toContain('normalizeIdentifier("Hello World")');
    expect(readme).toContain('// => "hello-world"');
    expect(normalizeIdentifier("Hello World")).toBe("hello-world");
  });
});
