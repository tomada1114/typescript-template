---
name: authoring-skills
description: >
  Covers where agent guidance in this repository belongs — a config, AGENTS.md, a
  path-scoped rule under .claude/rules/, or a skill under .claude/skills/ — and how a
  SKILL.md is shaped and checked so it does not silently fail to load. Use when adding,
  editing, or reviewing a skill or rule, deciding where new guidance goes, or
  investigating why a skill never fires.
---

# Authoring Skills

**Owns:** where a piece of agent guidance lives, and the shape of a skill or rule file.
**Does not own:** the content of any one skill; the `.mjs` contract for a script a skill
ships (`writing-repo-scripts`); `.claude/agents/`, which is generated outside this
repository and never edited here.

## Where guidance belongs

Put each rule in exactly one place, the first that fits:

1. **A config** (`eslint.config.mjs`, `tsconfig.json`, `vitest.config.ts`, a test) when
   a machine can check it. Then write nothing; the gate teaches it.
2. **`AGENTS.md`** when it must hold before the task is known, or is a prohibition an
   agent meets while its declared task is something else ("never weaken a gate").
3. **`.claude/rules/<area>.md`** when it is judgment about a kind of file. A rule loads
   when a file matching its `paths:` is opened, with no description to miss.
4. **`.claude/skills/<name>/`** when it is a recurring workflow or decision someone asks
   for by name (shipping an issue, landing bot PRs, deciding a semver level).

A rule stated in two places costs context twice and the copies drift. Extend an existing
skill rather than adding a near-duplicate, and add none for a fact stated once.

## Shape of a skill

- `.claude/skills/<name>/SKILL.md`, one directory level, `name` byte-identical to the
  directory. No nested file named `SKILL.md`; name reference files for their content.
- Frontmatter has exactly `name` and `description`. The description is a retrieval
  string — the situation, file globs, commands and errors that should load it — never a
  summary of the workflow. English only; length-capped.
- Open with `**Owns:**` / `**Does not own:**`, naming the neighbor that owns each
  adjacent decision. Point at another skill by name with `**REQUIRED:**` (must load) or
  `**BACKGROUND:**` (explains why).
- Do not restate what a config enforces: `Enforced by: <file> "<setting>".` and spend
  the words on the judgment the config cannot express.
- Target 150 body lines, never over 200; a `references/*.md` file under 400 lines,
  linked relatively, one level deep.
- Name sub-agents by tier (`executor`, `architect`, `scout`, `worker`), never a model or
  effort.
- Do not name the template's sample exports in a description; a generated project
  deletes them.

## Shape of a rule

`.claude/rules/<area>.md` starts with a `paths:` list of globs and holds only judgment
the configs cannot express for those files. Because it loads only once a matching file
is opened, AGENTS.md tells agents to read it before designing a change.

## Checks

Enforced by: `tests/skills-frontmatter.test.ts` (frontmatter keys, `name` match, length
cap, English). Prettier and `typos` cover `.claude/skills/` and `.claude/rules/`; run
`pnpm fix` before committing. Any backticked repository path in a skill, rule or
AGENTS.md must exist in the repository; in the template itself, bootstrap also checks it
against every generated project.

```bash
pnpm exec vitest run tests/skills-frontmatter.test.ts
pnpm fix
```
