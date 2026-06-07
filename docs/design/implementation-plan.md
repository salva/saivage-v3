# Implementation Plan


> **Authority status: historical.** This page is retained for provenance only. Prefer `docs/historical/2026-05-remediation-dossiers/planner-redesign-plan.md` for current authority where applicable.

> Canonical design document consolidated from `docs/design/implementation-plan.md` during Stage 22. Stage 23 will reconcile detailed source anchors where needed.


This plan stages Saivage v3 implementation from a verifiable local
kernel to the full autonomous control room. Each stage has clear bounds
and acceptance criteria so the project can ship usable slices without
blurring architecture decisions.

The implementation target is the system defined by:

- `docs/design/card-model.md` for card semantics and planner/reviewer gates.
- `agents.md` for agent roles and tool boundaries.
- `runtime.md` for dispatch, recovery, locking, and processes.
- `security.md` for content supervision and access rules.
- `configuration.md` for configuration and provider routing.
- `server-api.md` for HTTP/WebSocket surface.
- `data-model.md` for schemas and file layout.
- `docs/design/ux-design.md` for the web UI.

---

## Delivery Principles

- Build from the persistence layer upward. Every stage should leave
  inspectable files under `.saivage/` and `.saivage-work/`.
- Keep the runtime deterministic before adding LLM behavior. Card
  transitions, queues, locking, and recovery should be testable without
  real model calls.
- Treat agents as replaceable adapters. The runtime owns sequencing;
  agents return structured results.
- Prefer narrow vertical slices over broad scaffolding. Each stage must
  demonstrate one working path end to end.
- Do not add parallel planner/executor/reviewer dispatch in the initial
  implementation.

---

## Stage 0 — Project Skeleton and Contracts

### Scope

- Create the application repository structure.
- Add TypeScript project configuration, linting, formatting, and test
  runner.
- Define shared schema/types package for cards, notes, diaries,
  runtime state, process records, config, provider/account/model
  routing, and API envelopes.
- Add schema validation using a runtime validator.
- Add fixture projects under `fixtures/` for tests.

### Out of Scope

- No LLM provider calls.
- No web UI beyond placeholder build wiring.
- No external MCP server support.

### Acceptance Criteria

- `npm test` runs schema/unit tests successfully.
- `npm run typecheck` passes.
- All records from `data-model.md` have corresponding TypeScript
  types and validators.
- Fixture JSON records round-trip through validators without data loss.
- Invalid fixture records fail validation with useful error messages.

---

## Stage 1 — Local Persistence and Card Store

### Scope

- Implement project discovery using `.saivage/saivage.json`.
- Initialize a project-local `.saivage/` and `.saivage-work/` tree.
- Implement card CRUD through a `CardStore` service.
- Implement note logs, plan diary append, review assessment append,
  artifact and attachment registration.
- Enforce hierarchy rules from `docs/design/card-model.md`.
- Implement atomic writes for metadata files.

### Out of Scope

- No agent execution.
- No HTTP API writes except optional internal smoke endpoint.
- No cleanup command beyond explicit test helpers.

### Acceptance Criteria

- A new project initializes the file tree from `data-model.md`.
- Creating a project card auto-creates no duplicate project roots.
- Activating any project/goal card auto-creates exactly one plan card.
- Terminal cards cannot have children.
- `depends_on` and computed `blocks` remain consistent after card
  updates and deletes.
- Notes are mutable only until marked handled.
- All card mutations are covered by unit tests, including invalid
  hierarchy moves and dependency cycles.

---

## Stage 2 — Runtime Kernel Without LLMs

### Scope

- Implement runtime state persistence at `.saivage/runtime/state.json`.
- Implement exclusive lock at `.saivage-work/tmp/runtime/runtime.lock`.
- Implement startup, stale lock detection, graceful shutdown, and crash
  recovery.
- Implement deterministic queue selection by `depends_on`, status, and
  priority.
- Implement a fake agent adapter that returns scripted planner,
  executor, and reviewer results from fixtures.
- Implement global pause/resume.

### Out of Scope

- No real model provider integration.
- No shell/process execution.
- No web UI.

### Acceptance Criteria

- A fixture goal can move from `backlog` to `done` through planner,
  executor, and reviewer fixture results.
- A reviewer failure re-invokes the planner and correction cards run
  before the next review.
- A failed terminal card re-invokes the parent planner.
- A second runtime instance cannot acquire the lock while the first is
  alive.
- Stale locks are removed only when the PID is dead or older than the
  configured age bound.
- After simulated crash, `active` and `running` cards are reset to
  `backlog` and the runtime can resume.

---

## Stage 3 — Process Execution and Artifacts

### Scope

- Implement process registry and async command execution.
- Implement `start_process`, `wait_process`, `start_and_wait`,
  `tail_output`, `kill_process`, and `list_processes`.
- Persist process metadata under `.saivage/runtime/` and output under
  `.saivage-work/processes/`.
- Register artifacts and attachments produced by executor work.
- Add safe cleanup for `.saivage-work/tmp/stash/` and card tmp files.

### Out of Scope

- No arbitrary remote command execution.
- No automatic cleanup of retained artifacts.
- No model-driven executor yet; use fake/scripted executor harness.

### Acceptance Criteria

- Long-running commands can be started, tailed, waited on, and killed.
- Timed-out waits do not kill the process.
- Process output survives runtime restart.
- A terminal card can produce retained and working artifacts, and the
  card record points to the correct files.
- Cleanup never removes retained artifacts, attachments, download
  reviews, or quarantine metadata.

---

## Stage 4 — Agent Adapter and Model Routing

### Scope

- Implement provider abstraction and model router from
  `configuration.md`.
- Load per-role ordered model lists, provider capabilities, provider
  priorities, account priorities, and routing profiles.
- Resolve each agent role to an ordered `provider/account/model`
  candidate chain.
- Implement provider/account cooldown so a failing provider is skipped
  before the router advances to the next model.
- Implement structured result parsing for planner, executor, and
  reviewer responses.
- Implement agent session/message persistence.
- Implement context compaction and max-compaction termination.
- Implement agent invocation recovery wrapper.

### Out of Scope

- No web UI conversation inspector yet.
- No external MCP servers.
- No Telegram.

### Acceptance Criteria

- Planner can create valid card mutations from a model response.
- Executor can complete a terminal card using runtime tools only.
- Reviewer can pass/fail a goal and append assessment to the plan diary.
- Invalid or partial model output produces a recoverable invocation
  failure, not corrupted card state.
- Role-to-model routing first chooses a configured model, then tries
  eligible providers/accounts for that model in priority order.
- If a provider/account fails, the router tries the next eligible
  provider/account for the same model before advancing to the next
  configured model.
- Failed provider/account/model candidates respect recovery delays and
  are retried only after their cooldown expires.
- Compaction triggers at the configured threshold and preserves enough
  state for recovery.

---

## Stage 5 — Security and Content Supervision

### Scope

- Implement prompt injection scanner with heuristic and LLM-assisted
  layers.
- Implement quarantine storage under `.saivage-work/quarantine/` with
  metadata under `.saivage/supervision/`.
- Implement sensitive file blocking and secret redaction.
- Implement write territory warnings.
- Implement stash for oversized tool results.

### Out of Scope

- No enterprise policy engine.
- No automatic remediation of blocked content.

### Acceptance Criteria

- Obvious injection strings are blocked or escalated to LLM scan.
- Blocked content is stored in quarantine and never injected into an
  agent context.
- Agents cannot read `.saivage/auth-profiles.json`.
- Config secrets are redacted through APIs and agent-readable config
  views.
- `read_stash` rejects path traversal and only reads stash files.
- Territory violations are logged as warnings without blocking normal
  safe writes.

---

## Stage 6 — HTTP API and WebSocket Runtime Feed

### Scope

- Implement Fastify server and `/health`.
- Implement API authentication using `SAIVAGE_API_TOKEN`.
- Implement card, runtime, agent conversation, config, notes, chat,
  files, and debug endpoints from `server-api.md`.
- Implement WebSocket auth and JSON event envelopes.
- Wire runtime event bus to WebSocket clients.

### Out of Scope

- No full web UI yet.
- No public multi-tenant auth.

### Acceptance Criteria

- `/health` works without auth and reports version/project/runtime.
- All `/api/*` endpoints reject unauthenticated requests.
- WebSocket rejects invalid auth with code `1008`.
- File APIs reject path traversal, sensitive files, and files above the
  size limit.
- Runtime events appear on connected WebSocket clients using the
  documented envelope.
- API tests cover success and failure cases for each endpoint group.

---

## Stage 7 — Analyst Chat and Basic Control Plane

### Scope

- Implement analyst agent sessions over API/WebSocket.
- Implement analyst tools for card management, notes, runtime control,
  process inspection, and process kill.
- Add action previews for destructive operations.
- Persist analyst conversations.

### Out of Scope

- No Telegram yet.
- No rich web UI beyond minimal chat/client harness.

### Acceptance Criteria

- User can create a goal via analyst chat and inspect the resulting
  card tree.
- User can pause/resume runtime through analyst chat.
- User can add an unhandled directive to a running/backlog card.
- Destructive analyst/tool actions require a structured preview/confirmation
  step where that surface permits preview-only safety; this does not authorize
  card/runtime/planner mutation or child activation outside canonical owners.
- Analyst cannot directly perform terminal task work; task work still
  goes through executor/runtime flow.

---

## Stage 8 — Web Control Room

### Scope

- Implement the Vue SPA from `docs/design/ux-design.md`.
- Build Dashboard, Cards, Agents, Files, and Debug sections.
- Render tree, board, leaderboard, and timeline views over the same
  card model.
- Render attachments inline in the web UI only.
- Add runtime status, queue, process, notes, and event views.

### Out of Scope

- No advanced dashboard customization.
- No mobile-specific workflow beyond responsive usability.

### Acceptance Criteria

- Dashboard shows analyst chat and live runtime status.
- Cards section can inspect project, goal, plan, and terminal cards.
- Plan diary and reviewer assessments render from structured JSON.
- Files section separates `.saivage/` metadata from `.saivage-work/`
  outputs and respects file API protections.
- Debug section shows runtime state, errors, and timeline.
- UI state updates from WebSocket events without manual refresh.

---

## Stage 9 — External Integrations

### Scope

- Implement external MCP server configuration and lifecycle.
- Implement Telegram bot channel with allowed user filtering,
  Markdown-to-HTML conversion, message splitting, and per-chat analyst
  sessions.
- Implement OAuth auth profile loading and refresh for providers that
  need it.
- Implement notification filters and channel routing.

### Out of Scope

- No plugin marketplace.
- No group chat collaboration model beyond allowed user IDs.

### Acceptance Criteria

- Configured stdio and SSE MCP servers start, stop, and report health.
- Disabled MCP servers are skipped.
- Telegram ignores unauthorized users.
- Long Telegram messages are split under the 4096-character limit.
- Telegram notifications link to cards and mention attachments without
  rendering them inline.
- OAuth profiles are stored with mode `0600` and are never exposed via
  API or agent file access.

---

## Stage 10 — Hardening and Release Candidate

### Scope

- Add end-to-end tests covering a realistic project lifecycle.
- Add observability for errors, event timeline, agent recovery, and
  process execution.
- Add packaging/install documentation.
- Run security review for file access, API auth, token redaction, and
  prompt-injection handling.
- Produce release checklist and operator runbook.

### Out of Scope

- No new product surface unless required by release-blocking bugs.
- No major architecture changes without updating the design docs first.

### Acceptance Criteria

- End-to-end test initializes a project, creates a goal, runs planner,
  executor, reviewer, produces artifacts, and displays results via API.
- Crash/restart test resumes safely without duplicate plan cards or
  corrupted runtime state.
- Security tests cover auth failures, path traversal, secret redaction,
  quarantine, and stash access.
- Documentation includes install, configuration, operation, backup, and
  troubleshooting paths.
- A release candidate can be installed and run from a clean checkout
  with only documented prerequisites.

---

## Agent Context Visibility Remediation

### Current Failure Mechanism

Provider/runtime diagnostics reach the agent because diagnostic messages and
agent conversation messages share the same persistence path:

1. `AgentInvocationRunner.invoke()` appends retry and failure diagnostics to
   the active session through `messageLog.append(session.id, ...)`.
2. `SessionMessageLog.append()` stamps `model_issue`, `model_recovered`,
   `model_repair`, and `context_compaction` as diagnostic rounds, but still
   writes them to the same session JSONL transcript as user, assistant, and
   tool messages.
3. `AgentSessionCoordinator.buildModelMessages()` reads the entire session
   transcript with `getSessionMessages()` and returns all persisted rows,
   optionally prepending queued notification text.
4. `InvocationModelContext.buildModelMessages()` passes those rows to
   `ContextCompactor.compactPlannerInMemory()` and then into the next model
   turn. Non-planner roles receive the rows unchanged; planner compaction
   currently prunes by completed planner invocation history, not by
   visibility/audience.
5. The analyst loop has a separate path: `analyst-handler.ts` reads session
   history with `getSessionMessages()`, runs `pruneToolBoundary()`, prepends
   workspace context, and passes that array to the analyst model. It does not
   call `AgentSessionCoordinator.buildModelMessages()`.
6. The outer recovery loop appends `model_issue` after a failed invocation
   attempt, then retries on the same session. The next model-context assembly
   reads that same row back unless the read boundary filters it.

The result is that `model_issue` rows containing rate limits, candidate
exhaustion, provider protocol failures, or orphan-session diagnostics become
future `system` messages to the agent even though the agent cannot fix them.
`model_recovered` rows also become model input; that is acceptable only when
they are sanitized retry guidance, not when they interpolate raw provider or
runtime errors.

### Implementation Plan

1. Add a small model-context visibility helper under `src/agents/` that takes
   an `AgentMessage` and returns whether it is safe for model input. The
   helper must exclude `kind: "model_issue"` for every role. It must include
   ordinary `text`, `tool_call`, `tool_result`, and `tool_error` rows;
   include `model_repair`; include `context_compaction`; and include
   `model_recovered` rows whose content matches the new sanitized retry
   directive shape. Legacy `model_recovered` rows that still contain the old
   raw-error directive text must be excluded.
2. Apply the helper in `AgentSessionCoordinator.buildModelMessages()` after
   reading `getSessionMessages()` and before queued notification injection is
   returned. This is the lowest central boundary before stored transcript rows
   become model input for planner, executor, and reviewer context assembly.
3. Replace `buildRecoveryDirective(previousError)` with a sanitized directive
   builder that does not accept or interpolate provider/runtime errors. The
   text should say that the previous invocation did not complete and instruct
   the agent to inspect current state with available tools.
4. Apply the same helper in the analyst model-input path after
   `getSessionMessages()` and before `pruneToolBoundary()`, so analyst context
   receives the same visibility policy as planner/executor/reviewer context.
5. Keep existing `model_issue` append sites writing to session JSONL for
   operator/audit/debug surfaces, including per-candidate failures, outer
   invocation failures, and orphan-session reconciliation. Do not redirect or
   duplicate them in this remediation. The enforcement point is model-context
   assembly: every path that turns session JSONL into model input must filter
   them out. Agent-actionable failures must be represented as `tool_error`,
   `tool_result`, or `model_repair` instead.
6. Replace agent-facing recovery and compaction text that says "read from
   disk" with tool-oriented language. The implementation targets are
   `invocation-runner.ts`, `context-compactor.ts`, and
   `persisted-planner-history.ts`.
7. Add regression tests that construct persisted session transcripts with
   provider diagnostics and verify `buildModelMessages()` excludes
   `model_issue` rows for planner, executor, and reviewer roles.
8. Add regression tests that verify `tool_error`, `tool_result`,
   `model_repair`, `context_compaction`, and sanitized `model_recovered`
   messages remain in model context.
9. Add analyst regression coverage proving the analyst model-input path also
   excludes `model_issue` rows while preserving ordinary text and tool-boundary
   behavior.

### Acceptance Criteria

- A persisted provider failure or candidate-exhaustion `model_issue` row never
  appears in model input for planner, executor, reviewer, or analyst roles.
- A retry attempt still gives the agent an actionable recovery directive, but
  the directive does not include raw provider, account, protocol, or runtime
  exception text.
- Existing unsanitized `model_recovered` rows that contain the old raw-error
  directive text are not sent to models.
- Contract verifier repair messages remain visible to the model.
- Tool errors and tool results remain visible to the model.
- Compaction text and retry text use tool-oriented phrasing rather than
  instructing agents to read from disk.

---

## Cross-Stage Acceptance Gates

These gates apply before moving to the next stage:

- **State integrity**: No stage may write state outside `.saivage/` and
  `.saivage-work/` except explicit project source edits by executors.
- **Card invariants**: Project singleton, one plan per goal,
  terminal-card leaf rule, dependency consistency, and reviewer gate
  must remain enforced.
- **Recovery**: Interrupted work must leave enough persisted state for
  the runtime to resume or report a precise failure.
- **Agent context visibility**: Model inputs must contain only
  agent-actionable transcript rows. Provider/account/protocol diagnostics
  and retry bookkeeping stay in audit/debug surfaces; sanitized retry
  directives, tool feedback, contract repair messages, and compaction
  summaries remain agent-visible.
- **Security**: Sensitive files remain blocked and secrets remain
  redacted in all user-facing and agent-facing surfaces.
- **Tests**: New behavior must include automated coverage at the
  narrowest useful level, with end-to-end coverage for runtime flows.

---

## Initial Milestone Cut

The first usable milestone is **Stage 0 through Stage 3**:

- Local project init.
- Valid card tree persistence.
- Deterministic runtime dispatch using fake agents.
- Real process execution and artifact registration.

This milestone proves the core non-LLM runtime before adding model
variability. After that, Stage 4 can integrate real agents with much
less uncertainty.
