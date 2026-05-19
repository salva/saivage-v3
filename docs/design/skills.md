# Skills

> Canonical design document consolidated from `docs/design/skills.md` during Stage 22. Stage 23 will reconcile detailed source anchors where needed.


Skills are contextual knowledge files injected into agent system
prompts. They provide domain-specific instructions, coding
standards, or project conventions without modifying the agent's
core behavior.

---

## Discovery

Skill files are discovered from two locations, in priority order:

1. **Project skills**: `.saivage/skills/` — project-specific,
   created by the user or the analyst.
2. **Built-in skills**: Bundled with the Saivage installation.

Project skills override built-in skills with the same name.

---

## Index

Each skills directory contains an `index.json` that lists available
skills:

```json
[
  {
    "name": "python-conventions",
    "file": "python-conventions.md",
    "target_agents": ["executor"],
    "triggers": [
      { "type": "path", "pattern": "**/*.py" },
      { "type": "keyword", "pattern": "python" }
    ],
    "updated_at": "2025-01-15T10:00:00Z"
  },
  {
    "name": "data-pipeline-patterns",
    "file": "data-pipeline-patterns.md",
    "target_agents": ["planner", "executor"],
    "triggers": [
      { "type": "tag", "pattern": "data-pipeline" },
      { "type": "keyword", "pattern": "ETL" }
    ],
    "updated_at": "2025-02-01T12:00:00Z"
  }
]
```

---

## Skill Entry Fields

| Field           | Type       | Description                                       |
|-----------------|------------|---------------------------------------------------|
| `name`          | string     | Unique skill identifier                           |
| `file`          | string     | Path to the skill file (relative to skills dir)   |
| `target_agents` | string[]   | Which agent roles can receive this skill           |
| `triggers`      | Trigger[]  | Conditions that activate this skill               |
| `updated_at`    | ISO string | Last modification timestamp                       |

---

## Trigger Types

| Type      | Matching logic                                        |
|-----------|-------------------------------------------------------|
| `keyword` | Substring match in the card description or goal title |
| `tool`    | Match against available tools in the agent session    |
| `path`    | Glob match on file paths involved in the card         |
| `tag`     | Match against the card's `tags` array                 |

---

## Matching Algorithm

When the runtime prepares an agent session, it selects skills:

1. **Score each skill**: For each skill in the index, score its
   triggers against the current card and context. Each matching
   trigger adds to the score.
2. **Filter by target**: Only skills whose `target_agents` include
   the current agent role are considered.
3. **Rank**: Sort by score (descending), then by `updated_at`
   (more recent first) for tie-breaking.
4. **Select top N**: Take the top N matching skills (default: 5).
   The limit prevents context window bloat.

---

## Loading

Selected skills are loaded and injected into the agent's system
prompt as delimited blocks:

```
--- SKILL: python-conventions ---
[contents of python-conventions.md]
--- END SKILL ---

--- SKILL: data-pipeline-patterns ---
[contents of data-pipeline-patterns.md]
--- END SKILL ---
```

The support software handles loading — agents do not read
`.saivage/skills/` directly.

---

## On-Demand Loading

If an agent determines it needs a skill that was not preloaded
(e.g., it encounters an unfamiliar framework mid-task), it can
request it via a `load_skill(name)` MCP tool call. The runtime
looks up the skill, loads it, and injects it into the conversation.

This is a fallback mechanism. The trigger-based preloading should
handle most cases.

---

## Planner Instructions

Planner instructions (`.saivage/instructions/planner.md`) are a
special case of skill-like content. They are always loaded for the
depth-0 planner and define the project's strategic direction. See
`agents.md §Planner` for details.

Unlike skills, planner instructions are not trigger-matched — they
are unconditionally loaded for the project-level planner.
