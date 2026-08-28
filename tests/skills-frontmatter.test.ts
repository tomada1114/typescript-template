import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// A malformed skill is the one failure no other gate can see. `pnpm
// agents:check` compares two trees byte-for-byte, Prettier formats the file
// and `typos` spell-checks it, so a SKILL.md whose `name` disagrees with its
// directory — or whose frontmatter does not parse at all — mirrors cleanly,
// passes every check, and simply never loads in Claude Code or Codex CLI.
// Nothing reports it; the skill is just silently absent.
//
// The frontmatter this repository writes is deliberately small (two keys, one
// of them a folded block scalar), so it is parsed here rather than by adding a
// YAML dependency for a file format the repository itself controls.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const skillsDirectory = path.join(repoRoot, ".agents", "skills");

/**
 * The frontmatter keys a skill in this repository may declare. Claude Code
 * accepts a wider set and Codex CLI documents only these two, so the
 * intersection is what both hosts are guaranteed to honour.
 */
const ALLOWED_KEYS = ["name", "description"] as const;

/**
 * Selection is on the description's meaning, not on literal token match, so a
 * description carrying trigger keywords in a second language buys nothing and
 * contradicts the repository's English-only convention. CJK is the script that
 * would actually appear here.
 */
const NON_ENGLISH_SCRIPT = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/u;

/** Long enough for two sentences; short enough to survive host truncation. */
const DESCRIPTION_LIMIT = 600;

function listSkillNames(): string[] {
  return readdirSync(skillsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Parse the frontmatter block of a SKILL.md into its declared keys.
 *
 * Supports the two forms this repository uses: a plain `key: value` scalar and
 * a folded block scalar (`key: >`) whose continuation lines are indented.
 *
 * @param {string} source - The full contents of a SKILL.md file.
 * @returns {Record<string, string>} Every key declared in the frontmatter.
 * @throws {Error} When the file has no delimited frontmatter block, or a line
 *   inside it is neither a key nor a continuation.
 */
function parseFrontmatter(source: string): Record<string, string> {
  const lines = source.split("\n");
  if (lines[0] !== "---") {
    throw new Error("SKILL.md does not open with a `---` frontmatter delimiter");
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    throw new Error("SKILL.md frontmatter is never closed by a `---` delimiter");
  }

  const fields: Record<string, string> = {};
  let currentKey: string | undefined;
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") continue;
    const keyed = /^([A-Za-z][\w-]*):[ \t]*(.*)$/u.exec(line);
    if (keyed) {
      const [, key = "", rawValue = ""] = keyed;
      currentKey = key;
      // `>` and `>-` open a folded block; the value is on the lines below.
      fields[key] = rawValue === ">" || rawValue === ">-" ? "" : rawValue.trim();
      continue;
    }
    if (currentKey === undefined || !line.startsWith(" ")) {
      throw new Error(`frontmatter line is neither a key nor a continuation: ${line}`);
    }
    const folded = fields[currentKey] ?? "";
    fields[currentKey] = folded === "" ? line.trim() : `${folded} ${line.trim()}`;
  }
  return fields;
}

function readSkill(name: string): Record<string, string> {
  return parseFrontmatter(
    readFileSync(path.join(skillsDirectory, name, "SKILL.md"), "utf8"),
  );
}

/** Every path under a skill directory, relative to that directory. */
function listSkillFiles(name: string): string[] {
  const root = path.join(skillsDirectory, name);
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else found.push(path.relative(root, absolute));
    }
  };
  walk(root);
  return found;
}

const skillNames = listSkillNames();

describe("the authored skill tree", () => {
  it("holds at least one skill", () => {
    expect(skillNames.length).toBeGreaterThan(0);
  });

  it.each(skillNames)("gives %s a SKILL.md at its root", (name) => {
    expect(statSync(path.join(skillsDirectory, name, "SKILL.md")).isFile()).toBe(true);
  });

  it.each(skillNames)("names %s's frontmatter after its directory", (name) => {
    expect(readSkill(name)["name"]).toBe(name);
  });

  it.each(skillNames)("declares only the dual-host keys in %s", (name) => {
    expect(Object.keys(readSkill(name)).sort()).toEqual([...ALLOWED_KEYS].sort());
  });

  it.each(skillNames)("gives %s a description both hosts can match on", (name) => {
    const description = readSkill(name)["description"] ?? "";
    expect(description).not.toBe("");
    expect(description.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
  });

  it.each(skillNames)("keeps %s's description in English", (name) => {
    expect(readSkill(name)["description"]).not.toMatch(NON_ENGLISH_SCRIPT);
  });

  it.each(skillNames)("keeps SKILL.md unique within %s", (name) => {
    // A SKILL.md below the skill root registers as a second, nameless skill.
    expect(
      listSkillFiles(name).filter((file) => path.basename(file) === "SKILL.md"),
    ).toEqual(["SKILL.md"]);
  });
});

describe("parseFrontmatter", () => {
  it("reads a plain scalar", () => {
    expect(parseFrontmatter("---\nname: a-skill\n---\n# Title\n")).toEqual({
      name: "a-skill",
    });
  });

  it("folds a block scalar onto one line", () => {
    const source = "---\nname: a\ndescription: >\n  First line\n  second line.\n---\n";
    expect(parseFrontmatter(source)["description"]).toBe("First line second line.");
  });

  it("folds a stripped block scalar the same way", () => {
    const source = "---\nname: a\ndescription: >-\n  Only line.\n---\n";
    expect(parseFrontmatter(source)["description"]).toBe("Only line.");
  });

  it("rejects a file with no frontmatter", () => {
    expect(() => parseFrontmatter("# Title\n")).toThrow(/frontmatter delimiter/u);
  });

  it("rejects frontmatter that is never closed", () => {
    expect(() => parseFrontmatter("---\nname: a\n")).toThrow(/never closed/u);
  });

  it("rejects a line that is neither a key nor a continuation", () => {
    expect(() => parseFrontmatter("---\n- stray\n---\n")).toThrow(/neither a key/u);
  });
});
