import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// AGENTS.md tells every agent to delegate by naming one of these tiers, so a
// missing file or a `name` that disagrees with its file stem leaves that
// delegation silently falling back to a default agent. The model and effort
// values are owned by the external generator and deliberately not pinned here.
const agentsDirectory = fileURLToPath(new URL("../.claude/agents/", import.meta.url));
const TIERS = ["executor", "architect", "scout", "worker"] as const;

/** The top-level keys of a `---`-delimited frontmatter block, with values. */
function frontmatterKeys(source: string): Map<string, string> {
  const lines = source.split("\n");
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end === -1) {
    throw new Error("no `---`-delimited frontmatter block");
  }
  const keys = new Map<string, string>();
  let current: string | undefined;
  for (const line of lines.slice(1, end)) {
    const keyed = /^([A-Za-z][\w-]*):[ \t]*(.*)$/u.exec(line);
    if (keyed) {
      const [, key = "", value = ""] = keyed;
      current = key;
      keys.set(key, value === ">" || value === ">-" ? "" : value.trim());
    } else if (current !== undefined && line.startsWith(" ")) {
      const folded = keys.get(current) ?? "";
      keys.set(current, `${folded} ${line.trim()}`.trim());
    }
  }
  return keys;
}

function readTier(name: string): Map<string, string> {
  return frontmatterKeys(
    readFileSync(path.join(agentsDirectory, `${name}.md`), "utf8"),
  );
}

describe("the sub-agent tier files", () => {
  it.each(TIERS)("names %s's frontmatter after its file", (name) => {
    expect(readTier(name).get("name")).toBe(name);
  });

  it.each(TIERS)("gives %s a non-empty description", (name) => {
    expect(readTier(name).get("description")).toMatch(/\S/u);
  });

  it.each(TIERS)("declares a model and an effort for %s", (name) => {
    const keys = readTier(name);
    expect(keys.has("model")).toBe(true);
    expect(keys.has("effort")).toBe(true);
  });
});

describe("frontmatterKeys", () => {
  it("folds a block scalar and reads plain scalars", () => {
    expect(
      frontmatterKeys("---\nname: a\ndescription: >\n  One\n  two.\nmodel: m\n---\n"),
    ).toEqual(
      new Map([
        ["name", "a"],
        ["description", "One two."],
        ["model", "m"],
      ]),
    );
  });

  it("rejects a file with no frontmatter", () => {
    expect(() => frontmatterKeys("# Title\n")).toThrow(/frontmatter/u);
  });
});
