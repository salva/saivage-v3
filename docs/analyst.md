# Analyst Operator Guide

<!-- doc-authority
status: current
disposition: keep
owner: docs-maintainers
superseded_by: none
last_verified_against: src/agents/analyst-handler.ts:1
-->

Use the analyst as Saivage's **general operator chat agent**.

The analyst's job is three things at once:

- **chat partner** — explain what Saivage is doing and answer operator questions in plain language;
- **inspector** — read non-secret files, list directories, inspect runtime state, read card/session history, and run bounded inspection shell commands;
- **director** — when something needs to change, route the work through cards, notes, or canonical control actions instead of doing the project work directly.

## What the analyst is for

The analyst is the operator-facing reasoning surface for the whole system.

Use it to:

- inspect the target project, docs, logs, runtime state, cards, notes, sessions, processes, and audit history;
- explain why work is blocked, stale, failing, or waiting;
- create or amend cards when project work needs to be delegated;
- add non-executable notes for planner/operator context;
- call canonical controls such as runtime `start_project`, `stop_project`, pause, freeze, and resume when those controls are the right operator action. Process termination controls are deferred in this cycle.

Do **not** use the analyst as a substitute executor.

Project work must still go through the normal owners:

- planner for decomposition and replanning;
- executor for implementation;
- reviewer for acceptance;
- runtime and canonical control services for lifecycle and administrative mutations.

## Secret-bearing path denylist

Analyst inspection uses one centralized denylist for secret-bearing paths.

The analyst must not read or expose the contents of paths such as:

- `.saivage/auth-profiles.json`
- provider tokens and auth files
- `.env` files and similar env fragments
- SSH keys and key directories
- cloud credential locations
- `.npmrc`, `.pypirc`, and similar secret-bearing config files
- `.git/` token or credential blobs

### File reads

If a requested path resolves to a denylisted secret-bearing path, the read is denied before file contents are returned.

### Directory listings

Directory listings omit secret-bearing child entries entirely.

When entries were hidden, the response reports a `redacted_count` and appends a single `<redacted>` summary row instead of leaking names. Treat that as an intentional safety boundary.

### Shell commands

If a shell command targets a denylisted secret-bearing path, the command is classified as unsafe. On analyst web chat, destructive shell commands return a redacted preview with a `preview_hash` and do not execute unless the caller re-submits with `confirmed: true` plus the matching hash under a surface/authz combination that permits preview-only confirmation. On Telegram, `run_shell_command` remains unavailable.

## Shell-command classification rules

The analyst can run **bounded inspection shell commands**. Each invocation is dynamically classified before authz is applied.

Possible classes:

- **`read_only`** — pure inspection; allowed on web chat; not audited as a mutating control action
- **`low`** — non-read-only but not obviously destructive; allowed on web chat; audited
- **`destructive`** — unsafe host mutation or secret-targeting behavior; preview-only on analyst web chat, and unavailable on Telegram

### Read-only examples

Examples of `read_only` inspection commands include:

- `ls -la`
- `cat docs/operator-runbook.md`
- `grep -r analyst docs/`
- `git status`
- `git diff --stat`
- `systemctl status saivage`
- `journalctl --no-pager -u saivage`
- `curl -fsS http://localhost:8080/health`
- `node --version`

Pipelines or chains remain read-only only when **every** segment is read-only, for example:

- `ls | grep foo`

### Low examples

Commands that are not on the read-only allowlist and are not obviously destructive are classified `low`.

Examples:

- `python3 scripts/report-state.py`
- `node tools/inspect-runtime.js`
- `bash -lc 'for f in docs/*.md; do echo "$f"; done'`

These are still inspection-oriented commands. Their output is bounded, timeout-limited, and redacted before persistence.

### Destructive or preview-only examples

Examples of commands treated as destructive on analyst web chat, so they return a redacted preview/confirmation flow instead of executing immediately:

- `sudo systemctl restart saivage`
- `rm -rf .saivage-work/tmp`
- `echo hi > /etc/foo`
- `apt-get install ...`
- `npm install`
- `git reset --hard`
- `git push --force`
- `cat .saivage/auth-profiles.json`

On Telegram, `run_shell_command` remains unavailable.

This `confirmed`/`preview_hash` handshake is a shell-tool safety contract only. It must not be copied into card CRUD, planner-state mutation, runtime start/stop, or `activate_card` semantics. Those surfaces either apply directly through their owner or return actionable precondition errors.

## Shell parameter bounds and confirmation semantics

`run_shell_command` accepts these parameters:

- `command` — required non-empty string
- `cwd` — optional working directory; defaults to the project root
- `timeoutMs` — optional timeout in milliseconds; default `15000`, clamped to a maximum of `60000`
- `maxOutputBytes` — optional per-stream output cap in bytes; default `65536`, clamped to a maximum of `1048576`
- `confirmed` — optional boolean used to confirm a preview-only action
- `preview_hash` — optional string returned by the prior preview response

Current hardening behavior:

- malformed parameter types are rejected before execution;
- `cwd` must stay within the project root;
- secret-bearing `cwd` paths are rejected before execution;
- preview hashing uses the normalized execution inputs, so over-large timeout/output values cannot bypass confirmation matching;
- stdout/stderr are redacted before return or persistence and may include a `[truncated N bytes]` footer when capped.

## Delegation invariant

The analyst may use shell and filesystem tools to **understand** the system, but not to do project delivery work.

The analyst must not use shell or other direct tools to:

- edit the target project's source tree;
- run builds or tests as a substitute for executor or reviewer delivery work;
- deploy or mutate the host outside canonical operator controls;
- overwrite cards, notes, or agent artifacts outside the canonical Saivage services.

When project work needs to happen, the analyst should:

- create or amend a card for planner consideration;
- add a non-executable note for operator/planner context;
- call the canonical control that already owns the action. Root work starts through `start_project`; child work starts through parent-planner `activate_card`, not by analyst status edits or directive files.

## Persistent web chat panel

The analyst chat panel is available from **every major workspace view**.

Operators can open it by:

- using the Analyst button in the workspace header;
- pressing **Ctrl+J** on Windows/Linux;
- pressing **Cmd+J** on macOS.

The panel stays persistent in the web shell so operators can keep investigating while moving between dashboard, cards, agents, files, and debug views.

## "Discuss with analyst" from card detail

Card detail provides a **Discuss with analyst** entry point.

Use it when a specific card needs explanation, triage, or follow-up delegation.

That action seeds the analyst conversation with card context so the new chat starts already grounded in the selected card. The seeded context is for inspection and reasoning; if the card needs changes, the analyst still routes those changes through card edits, notes, or canonical controls.

## Live attribution and transcript behavior

Analyst-driven mutations must surface back into the operator UI quickly and with attribution.

### Card history chips

When the analyst changes a card through canonical card mutation, the card's history view shows that the change came from an analyst chat turn.

### `analyst_tool_invoked` transcript chips

When the analyst invokes a visible operator-facing tool action, the transcript can show an `analyst_tool_invoked` chip so operators can see that the current state change was produced by the analyst's tool call rather than a manual page refresh or unrelated background event.

The `analyst_tool_invoked` broadcast is sanitized before emission. Operators should expect concise summaries rather than raw secret-bearing tool payloads.

### Toaster behavior

The app shell shows a small analyst-action toaster for live analyst mutations and related broadcasts. Use it as a freshness signal, then inspect the updated card, history, or notifications view for the authoritative state.

## Validation artifact recording convention

For future Analyst Operator validation or follow-up stages, record validation evidence in the stage report or summary in a consistent, easy-to-audit format.

Include:

- a `commands_run` list with the **exact command**, `cwd`, and pass/fail result for each validation step;
- stable `stdout`/`stderr` log paths or artifact paths when logs are saved, preferably under the current stage's `reports/` directory or another stage-local path;
- explicit validation outcomes for each required check, not just a generic success summary;
- a note when the worktree had unrelated dirty files so later reviewers can separate pre-existing state from stage changes.

When practical, prefer stage-local log or artifact paths over ad hoc temporary locations so future audits can find the evidence without re-running validation.

## Focused web validation cadence

Wave L-M analyst web validation runs under **Vitest from `/work/saivage-v3/web`**, not root Jest.

Use these suites for focused analyst UI regression checks:

- `src/__tests__/analyst-chat-panel.test.ts` — AnalystChatPanel rendering, tool chips, composer, unsaved new-chat behavior
- `src/__tests__/analyst-chat-store.test.ts` — analyst chat Pinia store seeding, synthetic hint draining, local new-chat state
- `src/__tests__/app-shell-analyst-drawer.test.ts` — persistent app-shell drawer entry points and keyboard shortcut
- `src/__tests__/analyst-toaster.test.ts` — live analyst mutation toaster behavior
- `src/__tests__/card-detail-view.test.ts` — card detail live refresh, `analyst_tool_invoked` reactions, and attribution-adjacent updates
- `src/__tests__/card-history-panel-analyst-filter.test.ts` — analyst-authored card history filtering and attribution copy
- `src/__tests__/ws-store.test.ts` — WebSocket store routing, reconnect, stale, and unauthorized behavior used by the analyst surfaces

Canonical focused command from the web workspace:

```bash
cd /work/saivage-v3/web
npm test -- src/__tests__/analyst-chat-panel.test.ts \
  src/__tests__/analyst-chat-store.test.ts \
  src/__tests__/app-shell-analyst-drawer.test.ts \
  src/__tests__/analyst-toaster.test.ts \
  src/__tests__/card-detail-view.test.ts \
  src/__tests__/card-history-panel-analyst-filter.test.ts \
  src/__tests__/ws-store.test.ts
```

Optional root convenience wrapper:

```bash
npm run web:test:analyst-ui
```

Do **not** try to run these Vue/Pinia suites through root `npm test`; the root Jest config only targets `tests/` and is not the Wave L-M analyst web validation path.

## Related operator docs

- [Operator Runbook](/operator-runbook)
- [Troubleshooting](/troubleshooting)

## Source anchors

Current analyst behavior is implemented by `src/agents/analyst-handler.ts:1`, exposed tool schemas by `src/agents/analyst-tool-schemas.ts:1`, tool authorization/execution by `src/agents/analyst-tools.ts:1`, and analyst session HTTP routes by `src/server/routes/chats-files-debug.ts:81`. The denylist/redaction rules cited above are centralized in `src/utils/file-access-security.ts:1`.
