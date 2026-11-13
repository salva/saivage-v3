---
name: opencode-skill-authoring
description: 'Create or revise OpenCode SKILL.md files. Use when adding project skills, editing .github/skills, .opencode/skills, skill frontmatter, skill descriptions, trigger wording, workflow instructions, or troubleshooting skill discovery/loading.'
---

# OpenCode Skill Authoring

Use this skill when creating or revising OpenCode-compatible skills in this project.

Authority sources:

- OpenCode Agent Skills documentation: `https://opencode.ai/docs/skills/`
- OpenCode config schema: `https://opencode.ai/config.json`
- Project guidance in `AGENTS.md`

## File Layout

Put each skill in its own directory named exactly like the skill:

```text
.github/skills/<skill-name>/SKILL.md
```

Project skills live under `.github/skills/` in this repository because root `opencode.json` loads that path. Do not add duplicate `.opencode/skills/`, `.claude/skills/`, or `.agents/skills/` trees unless the user explicitly asks for tool-specific copies.

## Frontmatter

Every `SKILL.md` starts with YAML frontmatter:

```markdown
---
name: skill-name
description: 'Concrete trigger-focused description. Use when ...'
---
```

Project conventions, checked by the validation snippet below and by review:

- `name` equals the containing directory and matches `^[a-z0-9]+(-[a-z0-9]+)*$`, at most 64 characters.
- `description` is present, front-loads user-visible triggers and filenames, and stays within 1024 characters.
- Single-quote a description that contains punctuation that could confuse YAML.
- Leave `license`, `compatibility`, and `metadata` out unless a need exists.

Documented host behavior, from the official OpenCode V2 skills documentation (`https://opencode.ai/docs/skills/`, read 2026-11-13):

- The skill ID comes from the file path. For `<dir>/SKILL.md` it is the directory name. The frontmatter `name` is only a display label. IDs are case-sensitive.
- A skill without `description` is not advertised to the model.
- `metadata.opencode/autoinvoke: false` (or `disable-model-invocation: true`) hides a skill from the model's list. It still loads by its exact ID.
- Loading is governed by the selected agent's `skill` permission, set in agent or root configuration, not in `SKILL.md`.
- V2 does not enforce the name pattern, the 64-character limit, the directory match, or a description length limit. The conventions above are project rules, not runtime rejections.

## Description Quality

Write descriptions so an agent can decide when to load the skill without opening it.

Good descriptions:

- Say what the skill does.
- Say when to use it.
- Include concrete triggers like filenames, commands, subsystem names, or user phrases.
- Use gating language such as `Use ONLY when...` for narrow skills.

Avoid vague descriptions like `Helps with development` or descriptions that overlap heavily with another skill.

## Skill Body

The body should be operational, not inspirational.

Include:

- Scope and trigger conditions.
- Preconditions and safety rules.
- Step-by-step workflow.
- Required artifacts and where to put them.
- Validation commands or checks.
- Reporting expectations.
- Anti-patterns or stop conditions when relevant.

Keep skills focused. Split a broad skill into separate skills if one description cannot clearly explain when to use it.

## Validation

Before committing a skill change, run the snippet below. It checks the project conventions above: frontmatter presence, directory-name match, name pattern and length, and description presence. It does not test OpenCode discovery or loading.

```bash
node - <<'NODE'
const fs = require('fs');
const path = require('path');
const root = '.github/skills';
for (const dir of fs.readdirSync(root)) {
  const file = path.join(root, dir, 'SKILL.md');
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error(`missing frontmatter: ${file}`);
  const name = match[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = match[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (name !== dir) throw new Error(`name mismatch: ${file}: ${name} !== ${dir}`);
  if (!description) throw new Error(`missing description: ${file}`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) throw new Error(`bad name: ${name}`);
  if (name.length > 64) throw new Error(`name too long: ${name}`);
}
console.log('skill frontmatter ok');
NODE
```

Also run `opencode debug config --pure` from the project root when changing root `opencode.json` or skill paths.

## Commit Hygiene

- Commit skill files that belong in Git.
- Do not commit `docs/working/` design, plan, or review artifacts.
- If a skill change supports a behavior or workflow change, update `AGENTS.md` or the relevant main docs at the same time.
- After skill or config changes, tell the user which surface changed and what it reaches. A stored agent body reaches only sessions launched afterwards. Ambient or configured instruction files and skills can reach a running session by their own loading rules, and an already-loaded skill keeps its earlier text. A change to `opencode.json` itself, such as skill paths or agent configuration, has no live-pickup behavior established here, so do not claim that a running session applied it without evidence. Restart OpenCode or reload sessions only when the user asks for it.
