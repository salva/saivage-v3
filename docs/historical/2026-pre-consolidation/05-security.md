# Security & Content Supervision


> **Authority status: historical.** This page is retained for provenance only and has no current replacement yet. See `docs/documentation-inventory.md` for disposition `move-to-docs/historical/`.

## Content Supervisor

The content supervisor is a non-LLM layer that screens content
before it enters agent context. It sits between the outside world
and the agents.

### What it screens

- Tool results that contain external content (file reads, web
  downloads, command output, MCP responses).
- User messages from Telegram or web UI.
- Skill files loaded from disk.
- Any content loaded via `download_file`.

### What it does NOT screen

- Agent-to-runtime communication (card mutations, process
  management, notification acknowledgement) — these use structured,
  validated MCP calls and canonical services.
- Internal system prompts and instructions written by the project
  owner.

---

## Prompt Injection Scanner

The scanner uses a two-layer approach:

### Layer 1: Heuristic patterns

A set of regex patterns that detect common prompt injection
techniques. When any pattern matches, the content is flagged as
**suspicious** and escalated to Layer 2.

Heuristic pattern categories:

| Category               | Example patterns                                    |
|------------------------|-----------------------------------------------------|
| Instruction override   | "ignore previous instructions", "override system prompt", "disregard all prior" |
| Role hijacking         | "you are now", "act as", "pretend to be"            |
| Tool-use direction     | "call the tool", "use the function", "execute the command" |
| Secret exfiltration    | "output the system prompt", "reveal your instructions", "print the API key" |
| Destructive commands   | "delete all files", "rm -rf", "drop table"          |
| Self-labeled injection | "BEGIN INJECTION", "PROMPT INJECTION", "SYSTEM OVERRIDE" |

Layer 1 is fast (pure regex, no LLM call) and catches obvious
attempts. It has a configurable sensitivity level.

### Layer 2: LLM scan

When Layer 1 flags content as suspicious, a lightweight LLM is
invoked to analyze the content:

- **Input**: The suspicious content plus a system prompt explaining
  the injection detection task.
- **Output**: Structured verdict: `{ safe: boolean, confidence:
  number, reason: string }`.
- **Model**: Uses a separate, cheap model configured via
  `security.injectionModel` (see `docs/design/configuration.md`).
- **Size limit**: Content larger than `maxScanLengthBytes`
  (default: 100 KB) is truncated before scanning.

### Actions

- **Allow**: Content passes both layers → delivered to the agent
  normally.
- **Block**: Content is flagged as injection →
  - The original content is **quarantined** (saved under
    `.saivage-work/quarantine/<quarantine-id>/`).
  - The agent receives a sanitized summary:
    *"Content from [source] was blocked by the content supervisor
    (reason: [reason]). The original has been quarantined."*
  - A `warning`-severity event is published on the event bus.

---

## Mutating control safety model

Mutating control surfaces share one authorization and audit model.

Core rules:

- every mutating call declares a safety class:
  `read_only | low | high | destructive | deployment`
- a static authz table keyed by `(actor, surface, safety_class)`
  returns `allow | deny | preview_only`
- confirmation is driven by the verdict, not the safety class alone
- `preview_only` requires `confirmed: true` plus a matching preview
  hash derived from the request parameters
- every mutating call writes one control-action audit entry
- read-only inspection paths rely on transport auth plus redaction and
  do not fill the audit log

Default behavior highlights:

- analyst on `web-chat`: `preview_only` for `high` and `destructive`,
  `deny` for `deployment`
- analyst on `telegram`: `preview_only` for `high`, `deny` for
  `destructive` and `deployment`
- REST and CLI are more permissive by default

Operators customize the table in source instead of adding per-tool
confirmation drift.

---

## Agent write territories

Each agent role has advisory write territory rules — conventions
about which areas of the project each role should write to. These
are enforced as **warnings, not blocks**: violations are logged but
do not prevent the write.

| Role     | Write territory                                   | Exclude                          |
|----------|---------------------------------------------------|----------------------------------|
| Analyst  | Chat sessions and notes via runtime APIs under `.saivage/agents/` and `.saivage/notes/` | Project source files             |
| Planner  | Plan card diary (via runtime)                      | Source files, `.saivage/` directly|
| Executor | Project files per card type, `.saivage-work/cards/`, `.saivage-work/processes/` | `.saivage/` directly, other cards' artifacts |
| Reviewer | Review reports (appended to plan card via runtime) | Source files, `.saivage/` directly|

Territory enforcement means:
- If an executor tries to write to another card's artifact directory,
  a warning is logged.
- If an agent tries to read `.saivage/auth-profiles.json` or other
  sensitive config files, the request is blocked (not just warned).
- Territory violations are visible in the debug timeline.

---

## Sensitive File Protection

Certain files are protected from agent access regardless of role:

| Path                              | Protection         |
|-----------------------------------|--------------------|
| `.saivage/auth-profiles.json`     | No read, no write  |
| `.saivage/saivage.json` (secrets) | Redacted on read   |
| `.saivage-work/tmp/runtime/runtime.lock` | No write      |

API keys and tokens in config are redacted when served through the
config API, audit summaries, notification payloads, or when an agent
reads the config file.

`redactSecrets()` must be applied at boundaries that could leak
config-like material into notification or audit payloads.

---

## API Authentication

The HTTP server requires authentication on all `/api/*` endpoints:

- **Token**: `SAIVAGE_API_TOKEN` environment variable.
- **Enforcement**: Bearer token in `Authorization` header or
  `?token=` query parameter.
- **Public endpoints**: `/health` does not require authentication.
- **WebSocket**: Auth is checked on connection upgrade. Connections
  without valid auth are closed with code `1008` (policy violation).

See `docs/design/server-api.md` for endpoint details.

---

## File Access Security

The files API enforces:

- **Path traversal rejection**: Requests containing `..` or
  absolute paths outside the project root are blocked.
- **Hidden file blocking**: Requests for files under `.saivage/`
  that are in the sensitive file list are blocked.
- **Size limit**: File content responses are capped at 1 MB.
