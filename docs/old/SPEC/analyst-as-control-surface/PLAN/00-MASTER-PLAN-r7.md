# Master Plan — Analyst as the Sole User Control Surface

This master plan sequences the migration of saivage-v3 from its current state to the approved functional contract in [saivage-v3/SPEC/analyst-as-control-surface/SPEC-r7.md](saivage-v3/SPEC/analyst-as-control-surface/SPEC-r7.md). It is a top-level map: each stage will get its own design document and per-stage cards under the v2-on-v3 harness (see sections 6 and 7). Stages are published one by one via the protocol defined in [saivage-v3/SPEC/analyst-as-control-surface/PLAN/PROTOCOL-r4.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/PROTOCOL-r4.md).

## 1. Executive Summary

Today the analyst LLM resolver is a stub that throws (`LlmIntentResolver.chat` returns empty), so all user turns go through an offline keyword parser inside [saivage-v3/src/agents/analyst-handler.ts](saivage-v3/src/agents/analyst-handler.ts); the operator web UI is full of mutating buttons (new-card, move, delete, start/stop, terminate-process, note acknowledge / clear-all); the data model still treats notes as a v2-style managed inbox; the analyst itself lives in a togglable drawer rather than as a persistent right-side panel; and the e2e analyst suite at [saivage-e2e-checkers/e2e/analyst/findings/findings.md](saivage-e2e-checkers/e2e/analyst/findings/findings.md) shows 7 of 8 scenarios returning LIMITATION because of these gaps. The target state, per SPEC-r7, is a real LLM-driven analyst routed through the existing [saivage-v3/src/agents/llm-client.ts](saivage-v3/src/agents/llm-client.ts) / [saivage-v3/src/agents/agent-adapter.ts](saivage-v3/src/agents/agent-adapter.ts) pattern under `models.analyst`, with a queue-only ephemeral notification primitive, a bounded card-move + ordered children data model, a persistent always-visible right-side analyst panel driving an always-visible workspace area on the left, and zero user-facing mutating controls outside the bounded login + initial-provider-secret bootstrap.

A foundational stage S00 establishes a baseline breakage-detection harness BEFORE any product mutation lands, so every subsequent stage can be measured against a known-good gate set rather than discovering breakage retroactively. Because a redesign of this size cannot realistically keep the entire test suite green at every stage boundary, the acceptance discipline (section 3 and section 6) allows temporary breakages provided each is recorded in a single cumulative expected-breakage ledger with a named future repair stage; the final stage S10 is required to drain that ledger to empty.

## 2. Scope

In scope:

- Analyst handler and LLM resolver: [saivage-v3/src/agents/analyst-handler.ts](saivage-v3/src/agents/analyst-handler.ts), [saivage-v3/src/agents/analyst-llm-resolver.ts](saivage-v3/src/agents/analyst-llm-resolver.ts).
- Analyst tool surface: [saivage-v3/src/agents/analyst-tools.ts](saivage-v3/src/agents/analyst-tools.ts), [saivage-v3/src/agents/analyst-tool-schemas.ts](saivage-v3/src/agents/analyst-tool-schemas.ts), and the shared agent tool / role policy at [saivage-v3/src/tools/agent-tools.ts](saivage-v3/src/tools/agent-tools.ts) and [saivage-v3/src/agents/role-tool-policy.ts](saivage-v3/src/agents/role-tool-policy.ts), with system prompt in the resolver.
- Operator HTTP routes and contracts: [saivage-v3/src/server/routes](saivage-v3/src/server/routes), [saivage-v3/src/contracts/operator-api.ts](saivage-v3/src/contracts/operator-api.ts), plus the generated web client / types at [saivage-v3/web/src/api/client.ts](saivage-v3/web/src/api/client.ts) and [saivage-v3/web/src/api/types.ts](saivage-v3/web/src/api/types.ts).
- Card model: child ordering and bounded move (planner + analyst + persistence), plus ordered-child rendering across every existing child-rendering UI surface.
- Notification primitive: queue-only ephemeral semantics, internal producer surface for planner/executor/reviewer/runtime/error-reporter, retirement of operator note inbox.
- Web UI shell, views and components under [saivage-v3/web/src/views](saivage-v3/web/src/views), [saivage-v3/web/src/components](saivage-v3/web/src/components), and [saivage-v3/web/src/stores](saivage-v3/web/src/stores) (cards, chat, layout, nav, runtime store).
- Project config layout for `models.analyst` and provider profiles in [saivage-v3/.saivage/saivage.json](saivage-v3/.saivage/saivage.json) — schema validation only; values are project-local.
- Unit / integration / e2e test suites that exercise any of the above, including the analyst playwright suite in [saivage-e2e-checkers/e2e/analyst](saivage-e2e-checkers/e2e/analyst) and web tests under [saivage-v3/web/src/__tests__](saivage-v3/web/src/__tests__).
- Baseline gate harness, expected-breakage ledger, and validation cookbook at [saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json](saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json), [saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md), and [saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md).

Not in scope:

- Mobile or sub-desktop viewport layout (SPEC Q8).
- Voice IO.
- Telegram-specific surface audit (SPEC Out of Scope).
- MCP server protocol changes — only MCP entry CRUD via analyst tools is in scope; the wire protocol itself stays as-is.
- Multi-session / multi-user analyst conversations against the same project (SPEC Q3).
- A user-managed notification object class, an inbox, an acknowledge action, or any other notification management surface.
- Backward compatibility: no migration shims, no flags toggling old vs new, no read-only legacy panels. Dead code is deleted.

## 3. Acceptance discipline (cross-cutting)

The following requirements apply uniformly across every stage and are enforced at each stage's acceptance. They are stated once here, not duplicated in every stage block.

1. **Audit of every mutating analyst action.** Any mutating action introduced, modified, or re-routed by a stage MUST record `actor='analyst'` plus an originating-surface field (e.g. `surface='web-chat'` or `surface='telegram'`) in the control-action audit log, and that log MUST be inspectable through the analyst on request, per SPEC-r7. Stages where this applies are marked `[AUDIT]` in section 4. Stages that only delete code, restructure layout, or add read-only views do not introduce new audit entries but MUST NOT regress the rule.
2. **Stage close criterion: baseline-or-ledger.** Every stage from S01 onward runs the gate set captured in [saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json](saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json) using the commands in [saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md). The baseline gate harness from S00 MUST still run end-to-end (the harness itself is not allowed to break). A stage closes when EITHER:
   - (a) every gate is green relative to the S00 baseline (no failing test/scenario id observed by the gate that is not already in the baseline's failing-id set for the same gate id), OR
   - (b) every NEW failure relative to the baseline has a matching open entry in the cumulative expected-breakage ledger at [saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md), and every such entry names a later stage in the dependency DAG (section 5) as its target fix stage.

   The ledger is the only mechanism by which a stage may close with new failures. A stage that introduces a NEW failure without a corresponding open ledger entry naming a later stage is in violation and cannot close. See section 6 for the ledger format and the close-time bookkeeping required.
3. **Holistic fix first; localization-as-workaround forbidden.** The implementer MUST attempt the holistic fix described in the stage's `design.md` Downstream impact section before considering any failure "expected". Localized patches that mask a failure without addressing root cause remain forbidden. Declaring an expected breakage with a documented future-stage repair is NOT a workaround; it is a deferred fix, and is only acceptable when (i) the repair genuinely belongs in a later stage by the stage's scope or by the dependency DAG, and (ii) the design's Breakage forecast section either anticipated it or the stage's `plan.md` documents why the forecast was wrong.
4. **Forbidden patterns to silence failures.** Disabling tests, `.skip`ing tests, deleting tests that still describe valid SPEC-r7 behaviour, and removing assertions to silence failures are all forbidden as ways to satisfy the close criterion. None of these constitute a valid ledger entry. Tests are removed only when the behaviour they describe is genuinely no longer part of SPEC-r7; that removal is a real (not ledgered) change, must be justified in the stage's `design.md`, and updates [saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json](saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json) accordingly so the test no longer appears in either the green set or the ledger.
5. **Final reconciliation at S10.** S10's acceptance MUST require that the cumulative ledger is empty at close. If S10 cannot empty it, the redesign is not done; S10 owns the final reconciliation pass and any stage published after S10 is itself a follow-up correction per section 7.
6. **Architecture-first, no backward compatibility.** Dead code is removed. Migration shims, feature flags, and "legacy read-only" panels are forbidden. On-disk shapes are replaced wholesale, not migrated.
7. **No emojis** in any user-visible string introduced or modified by a stage.
8. **A stage cannot rely on a future revision of itself.** Each stage's acceptance gates are evaluated against the stage as published. If a published stage is wrong, the correction is published as a follow-up stage at the next free `NNN` prefix per section 7; the original stage's acceptance is not retroactively relaxed by the existence of the follow-up. The ledger mechanism does NOT relax this rule: a ledger entry's target fix stage MUST be a later stage already in the master plan, not a future revision of the stage that authored the entry.

## 4. Stage list

Stage ids (S00..S10) are stable. Effort hints (S, M, L) are coarse and only relative. Per PROTOCOL-r4, on-disk directory names use a `NNN-<slug>` prefix purely for sort order (`000-baseline-gates`, `001-llm-resolver-real`, `010-test-suite-update`); the `NNN` digits are not a dependency declaration. Stages marked `[AUDIT]` introduce or modify mutating analyst actions and MUST satisfy acceptance rule (1) from section 3.

Note: relative to r2, the route-pruning and UI-mutating-affordance stages have been swapped. UI callers of mutating routes are removed BEFORE the routes themselves, so the application is never knowingly in a broken intermediate state from a runtime-routing perspective; test-suite breakages that cross stage boundaries are managed via the expected-breakage ledger per section 6.

Every stage from S01 onward MUST also include in its `design.md` a "Breakage forecast" section (see section 6.1) anticipating what is likely to land in the ledger when this stage closes and which later stage repairs each entry, and in its `plan.md` an updated "Breakage triage" sub-step (see section 6.2) that records the actual ledger deltas at close time.

### S00 — Breakage detection harness (baseline gates + cookbook + ledger seed)

- Goal: Before any product mutation lands, prove that the existing baseline gates run cleanly to completion against the current code and capture the current failure set. Produce a small machine-readable baseline snapshot at [saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json](saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json), a short, exact-commands cookbook at [saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md), and seed the empty cumulative expected-breakage ledger at [saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md). Every later stage measures its own breakage discipline against this baseline and updates that ledger as part of its close.
- Inputs: WORKSPACE_HANDOFF and root validation skills; current state of [saivage-v3](saivage-v3); current state of the analyst suite [saivage-e2e-checkers/e2e/analyst/findings/findings.md](saivage-e2e-checkers/e2e/analyst/findings/findings.md).
- Acceptance:
  - The four baseline gates run end-to-end to completion (not aborted by environment errors) at least once: TypeScript build of [saivage-v3](saivage-v3), Vite build of [saivage-v3/web](saivage-v3/web), vitest in [saivage-v3](saivage-v3), playwright analyst suite in [saivage-e2e-checkers](saivage-e2e-checkers).
  - The baseline snapshot at [saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json](saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json) records, at minimum, for each gate: a stable gate id, the working directory, the exact shell command, the observed exit code, and the normalized set of failing test ids or scenario ids (collected by the gate's own runner, not by ad-hoc parsing). It also records a single explicit comparison rule: "a NEW failure is any failing test/scenario id observed by a stage gate run that is not in this snapshot's failing-id set for the same gate id". The full schema is pinned by S00's `design.md`; the fields just listed are the minimum required at the master-plan level so a reviewer can mechanically reject a baseline artifact that is human-readable but not machine-comparable.
  - The cookbook at [saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md) lists the exact commands a stage implementer runs per gate, the working directory for each, and the close criterion rule: "a stage may close only if every NEW failure relative to baseline-gates.json has an open ledger entry naming a later stage; otherwise the stage's acceptance fails".
  - The cookbook also documents the ledger update procedure each stage MUST follow at close time: identify the diff between the stage's gate run and the baseline, add a ledger entry per new failure (with the required fields from section 6.1), and remove every ledger entry whose target fix stage is the closing stage and whose underlying failure is now resolved (i.e. the failing id is no longer observed by the relevant gate). The procedure is mechanical and operator-runnable.
  - The cookbook also documents a non-secret activation preflight for the v2-on-v3 bootstrap moment (see section 8): service health for the `saivage-v3` harness, protocol-consumer presence, stages tree visible at the expected in-container path, no stale shutdown handoff state under [saivage-v3/.saivage/tmp/state](saivage-v3/.saivage/tmp/state). The preflight is operator-runnable and verifies the consumer is ready to pick up the first published stage.
  - The cumulative ledger file [saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md) is created with a short header that explains its purpose, the entry shape required by section 6.1, and the close-time bookkeeping rules; the entry body starts empty.
  - No product code is modified by S00; only the artifacts above are added.
- Dependencies: none. S00 is the entry point.
- Effort: S.
- Risk: a baseline gate may not currently run to completion (e.g. playwright dependencies missing, vitest config broken). Mitigation: design doc S00 enumerates the smallest set of infrastructure fixes needed to make the gate runnable, and explicitly forbids product-code changes; environment-only fixes are recorded in the cookbook.
- Rollback: revert the commit; the artifacts disappear; no product impact.
- Likely downstream impact: none on product code; downstream impact for S00 is purely infrastructural (CI/scripts that assume a working test runner). Captured in S00's `design.md` Downstream impact section.

### S01 — Real LLM analyst resolver via existing LlmClient pipeline `[AUDIT]`

- Goal: Replace the `LlmIntentResolver` stub and its offline keyword pathway with a real implementation that routes through [saivage-v3/src/agents/llm-client.ts](saivage-v3/src/agents/llm-client.ts) / [saivage-v3/src/agents/agent-adapter.ts](saivage-v3/src/agents/agent-adapter.ts) under role `analyst`. When no analyst-capable provider is configured or auth fails, the chat returns the explicit "analyst is offline" message defined in SPEC-r7 §Failure and audit and performs no mutations. This stage also owns the conversation-shape primitives that the resolver enforces independent of any individual tool: one-clarification-question handling for genuine ambiguity, immediate-prior-context carry-over across turns within the same conversation, and refusal to invoke any mutating tool when the provider is offline.
- Inputs: SPEC-r7 sections "The Analyst chat", "Failure and audit — analyst provider unavailable", "Multi-turn ambiguity", "Confirmation behavior".
- Acceptance:
  - `parseIntent` and `runOfflineFallback` deleted from [saivage-v3/src/agents/analyst-handler.ts](saivage-v3/src/agents/analyst-handler.ts), and every call site removed; `grep -RE 'parseIntent|runOfflineFallback' saivage-v3/src` returns no source matches.
  - `LlmIntentResolver.chat` performs a real LLM exchange with tool calls using the existing agent tool-loop; `isAvailable` reflects actual provider config under `models.analyst`.
  - When `models.analyst` resolves to no candidate or the provider call fails authentication, the chat reply contains the substring "analyst is offline" and no mutating tool is invoked. Unit tests assert both branches.
  - The resolver carries immediate prior context (last user turn + analyst turn) into the next turn's prompt, and an integration test asserts that a follow-up like "do it" or "and the other one too" resolves against the immediately preceding turn.
  - When the user's request is genuinely ambiguous (multiple equally plausible target entities, conflicting constraints) the resolver asks exactly one clarifying question and invokes no mutating tool until the user answers; covered by an integration test.
  - `cd saivage-v3 && npm run build` succeeds.
  - E2E S1 (project status cold start) and the offline-message branch of the failure-mode tests pass.
  - Cross-cutting rules from section 3 hold; in particular, the resolver's mutating tool calls flow through the shared audit-wrapped invocation entry point added in S02 (this stage does not bypass it). Any NEW gate failure introduced by this stage that depends on the S02 audit wrapper landing first is recorded as a ledger entry naming S02 as the target fix stage.
- Dependencies: S00.
- Effort: L.
- Risk: tool-loop divergence between analyst and planner/executor. Mitigation: design doc S01 captures the exact loop reused, with one entry-point function called by `AnalystHandler`.
- Rollback: revert the stage commit; no on-disk schema changes in this stage, so the chat goes back to the stub error.
- Likely downstream impact: backend unit/integration tests that mock the analyst stub; the e2e analyst suite verdicts; the existing `LlmClient` retry/backoff/observability hooks; logging schema for assistant turns; provider-rate-limit handling shared with planner/executor; any operator dashboards reading assistant-turn logs. Full enumeration and holistic fix per concern in S01's `design.md` Downstream impact section.

### S02 — Tool surface alignment with SPEC capability classes `[AUDIT]`

- Goal: Bring the analyst tool surface into 1:1 correspondence with the SPEC-r7 capability classes. Add every tool the SPEC requires; remove every tool the SPEC retires; centralize the audit-wrapped invocation path that every mutating analyst tool funnels through; pin the response-shape guarantees that are independent of any individual tool (unsupported-action reply, partial-success reporting, unknown-internal-capability handling); and enforce the SPEC-r7 non-secret boundary on every inspect, file, directory, transcript, and process-output tool. Keep [saivage-v3/src/agents/analyst-tool-schemas.ts](saivage-v3/src/agents/analyst-tool-schemas.ts), [saivage-v3/src/agents/analyst-tools.ts](saivage-v3/src/agents/analyst-tools.ts), the shared registry in [saivage-v3/src/tools/agent-tools.ts](saivage-v3/src/tools/agent-tools.ts), the role policy in [saivage-v3/src/agents/role-tool-policy.ts](saivage-v3/src/agents/role-tool-policy.ts), and the system prompt in [saivage-v3/src/agents/analyst-llm-resolver.ts](saivage-v3/src/agents/analyst-llm-resolver.ts) in sync.
- Inputs: SPEC-r7 sections "Analyst Capability Classes" (Inspect, Navigate, Mutate cards, Queue notifications, Control runtime, Reconfigure, Investigate and repair), "Acceptance Criteria — Conversational equivalence", "Failure and audit".
- Required tool coverage (no more, no less):
  - Inspect: enumerate the full inspect inventory the SPEC requires (cards/history, runtime state/events/errors, audit log, agent transcripts, process registry/output, directory listings, file contents). Each is reachable by at least one tool.
  - Navigate: `navigate_workspace` (its UI wiring is S08), plus a "go back" affordance.
  - Mutate cards: create, edit, delete (single and batch/set), and `reorder_child`. Batch and set-based card mutations resolve in a single tool call where the SPEC's conversational equivalence requires it.
  - Queue notifications: `queue_notification` (semantics in S04).
  - Control runtime — full SPEC-r7 verb set: `start_project`, `stop_project`, `pause_runtime`, `resume_runtime`, `abort_goal_subtree`, `restart_card_or_subtree`, `mark_goal_needs_corrections`, `terminate_process`. Destructive runtime controls (`abort_goal_subtree`, `restart_card_or_subtree`, `mark_goal_needs_corrections`, bulk `delete_card`) go through the conversational confirmation flow defined by S01's primitives.
  - Reconfigure: typed sub-tools (or a single discriminated tool) for role/model routing, failover order, MCP entry add/edit/remove, runtime settings, server settings. `restart_server` requires conversational confirmation. A `show_config` returns a redacted view (secret values absent or visibly redacted).
  - Investigate and repair: tools that the resolver chains across artifacts to produce a narrative answer + concrete mutations.
- Acceptance:
  - Tool registry and schemas have exactly the tools needed to cover every utterance in SPEC-r7 "Acceptance Criteria — Conversational equivalence" — including all runtime-control verbs above — without invented capabilities.
  - Note-inbox tools (`mark_note_handled`, `list_notes`, `get_note`, anything equivalent) deleted; `grep -RE 'mark_note_handled|list_notes|get_note' saivage-v3/src/agents` returns no matches.
  - Every mutating tool invocation funnels through one audit-wrapped entry point that writes `actor='analyst'` plus the originating-surface field to the control-action audit log on success and on rejection. The stage's `design.md` is required to identify a single source of truth for this wrapper (the exact module shape is a design choice, not pinned here).
  - **Non-secret inspection boundary (SPEC-r7).** Every inspect-class tool that can return file contents, directory listings, agent transcripts, process output, or environment-like state enforces a non-secret deny/redaction policy. Concretely, the following classes of values MUST never appear in any tool result returned to the analyst LLM or to the chat: provider API keys and provider tokens; contents of [saivage-v3/.saivage/auth-profiles.json](saivage-v3/.saivage/auth-profiles.json) and any sibling auth/profile/credential file under `.saivage/`; runtime tokens, session cookies, and bearer tokens; environment variables flagged as secret in the project config; values of any field marked secret in the schemas under [saivage-v3/src/schemas](saivage-v3/src/schemas). A single source of truth (a secret-classification module identified by S02's `design.md`) governs the policy; every inspect/file/directory/transcript/process-output tool calls into it. The same module backs `show_config`. The decision on each request (allow whole, allow redacted, deny) is itself recorded in the audit log when the requesting actor is the analyst.
  - When the resolver decides the requested action is not supported (no matching tool, or out-of-scope by SPEC), it returns an "unsupported action" reply with the reason and does not invoke any tool. Unit + integration tests cover this branch.
  - When a mutating tool succeeds for some inputs in a batch and fails for others, the analyst's reply explicitly reports each per-item outcome (partial-success reporting). Unit tests cover this branch for at least `delete_card` and a reconfigure batch.
  - When an internal capability is referenced that the analyst does not know how to use (an unknown tool name or an unimplemented sub-action), the analyst reports the unknown capability honestly and does not fabricate success. Unit tests cover this branch.
  - System prompt updated to describe the new vocabulary (notifications, not notes; bounded move; navigate_workspace; deictic resolution; the conversation-shape rules from S01; the non-secret inspection boundary).
  - Unit and integration gates assert the non-secret boundary directly: an inspect of `.saivage/auth-profiles.json`, a directory listing that would expose a provider config file's secret values, a transcript that contains a provider token in a tool argument, and a process-output dump that would include a secret env var each return a denied-or-redacted result, while sibling non-secret artifacts under the same parent return their content unchanged.
  - `cd saivage-v3 && npm run build` and `cd saivage-v3 && npm test` succeed (existing tool tests updated, not skipped). Any test that depends on data-model changes from S03 or notification primitive changes from S04 may close as a ledger entry naming the relevant later stage rather than as a green test, provided the entry meets section 6.1.
  - Cross-cutting rules from section 3 hold.
- Dependencies: S00, S01.
- Effort: L.
- Risk: schema/implementation drift across many tools; secret classification missing a code path that already reads sensitive files. Mitigation: the stage's `design.md` must identify a single source of truth for tool schemas AND for the secret-classification module, and must enumerate every tool that ingests file or process state so the classification gate is reachable from each.
- Rollback: revert the commit; restored tool registry matches S01 state.
- Likely downstream impact: tests under [saivage-v3/src/agents](saivage-v3/src/agents) that reference removed tools; the analyst system prompt that enumerates available tools; consumers of the analyst tool registry in other agents (planner, executor, reviewer); shared agent tools at [saivage-v3/src/tools/agent-tools.ts](saivage-v3/src/tools/agent-tools.ts); the role-tool policy at [saivage-v3/src/agents/role-tool-policy.ts](saivage-v3/src/agents/role-tool-policy.ts); the secret-bearing schemas under [saivage-v3/src/schemas](saivage-v3/src/schemas); documentation/skill files describing the analyst tool vocabulary; e2e scenarios that hard-code a tool name. Holistic fix and validation gates per concern in S02's `design.md` Downstream impact section.

### S03 — Card model: ordered children + bounded move + ordered rendering `[AUDIT]`

- Goal: Add a persistent ordered `position` to each card within its parent's child list (default = append on creation), expose a `reorder_child` mutation to planner and analyst, and constrain server-side `move_card` to the two SPEC-allowed operations: down into a current sibling, or up to grandparent. Reject cross-tree moves with a clear error that the analyst can surface verbatim. The planner does not treat user-visible child order as a hard schedule. Make the persisted `position` the authoritative render order in every backend projection and read endpoint that returns a card's children, so every consumer (UI and analyst tools alike) receives children already in the correct order.
- Inputs: SPEC-r7 sections "Mutate cards — Child ordering within a parent", "Mutate cards — Bounded card move", "UI Behavior — ordered-child rendering", and the corresponding "Acceptance Criteria — Cards" items.
- Acceptance:
  - Card record persists an explicit `position` integer per child within its parent; reads in the cards tree and detail view honor that order without re-sorting on another key.
  - New child creation appends to the end of its parent's child list.
  - `move_card` accepts only (a) into a current sibling, (b) up to current grandparent; any other target returns a typed error with a SPEC-aligned phrase. Root-card moves are also refused.
  - `reorder_child` tool repositions a card within its parent's child list and persists the new order.
  - Every backend projection or read endpoint that returns a card's children returns them in persisted `position` order. Endpoints in scope: every reader of children under [saivage-v3/src/server/routes](saivage-v3/src/server/routes), every projection under [saivage-v3/src/projections](saivage-v3/src/projections), and the analyst inspect tool surface from S02 that exposes card children. Integration tests assert the order matches an explicitly shuffled persisted `position` vector for at least one nested subtree.
  - Analyst-issued card mutations introduced or modified here flow through the audit wrapper from S02 with `actor='analyst'` plus surface; unit tests assert the audit entry exists for `move_card`, `reorder_child`, and any other mutator touched by the stage.
  - `cd saivage-v3 && npm test` passes new unit tests for ordered children, bounded move (both directions), cross-tree refusal, and root-card move refusal. UI-side ordered-rendering tests for views owned by later stages (S06, S08) may close as ledger entries naming the relevant later stage.
  - Cross-cutting rules from section 3 hold.
- Dependencies: S00, S02.
- Effort: M.
- Risk: on-disk card record migration. Architecture-first applies: rewrite the on-disk shape, do not migrate. Mitigation: design doc S03 specifies the new shape and the deletion of any legacy shape readers.
- Rollback: revert the commit; on-disk shape changes are project-local under `.saivage/` and can be regenerated by `init`.
- Likely downstream impact: card schema validators; card stores and on-disk readers; history / audit format for card events; card-tree builders; planner activation rules where child ordering is currently a soft hint vs a hard schedule (the design must decide this explicitly); UI rendering across cards tree, board lanes, detail-view child list, dashboard child panels, files tree (when it lists card-bound files), debug-view child lists, leaderboard, and timeline — though the mechanical UI gates for current views are owned by S06 and S08 per the matrix in section 4.1. Holistic fix per concern in S03's `design.md` Downstream impact section.

#### 4.1 Ordered-child rendering — UI-surface ownership matrix

SPEC-r7 requires every UI view that renders a card's children to present the explicit persisted child order without resorting on another key. The current child-rendering surfaces are owned as follows. Each owning stage MUST include a mechanical acceptance gate asserting render order matches persisted `position` for at least one shuffled subtree.

| UI surface | File(s) | Owner |
| --- | --- | --- |
| Cards tree (left navigation tree) | [saivage-v3/web/src/components/cards/CardsTreeView.vue](saivage-v3/web/src/components/cards/CardsTreeView.vue), [saivage-v3/web/src/views/CardsView.vue](saivage-v3/web/src/views/CardsView.vue) | S03 |
| Card detail view child list | [saivage-v3/web/src/components/cards/CardDetailView.vue](saivage-v3/web/src/components/cards/CardDetailView.vue) | S03 |
| Card history child references | [saivage-v3/web/src/components/cards/CardHistoryPanel.vue](saivage-v3/web/src/components/cards/CardHistoryPanel.vue) | S03 |
| Dashboard child-of-goal panels (any panel grouping card children) | [saivage-v3/web/src/views/DashboardView.vue](saivage-v3/web/src/views/DashboardView.vue) | S06 |
| Files view child-of-card listings (where files are grouped by card and the card has children) | [saivage-v3/web/src/views/FilesView.vue](saivage-v3/web/src/views/FilesView.vue) | S06 |
| Debug view child lists (whenever the debug surface renders a card's children) | [saivage-v3/web/src/views/DebugView.vue](saivage-v3/web/src/views/DebugView.vue) | S06 |
| Analyst chat context lists (when the chat panel renders the current card's children as part of contextual awareness) | [saivage-v3/web/src/components](saivage-v3/web/src/components) (AnalystChatPanel and its descendants) | S08 |

Stages S06 and S08 each carry a corresponding acceptance bullet in their own blocks below. S10 closes the matrix end-to-end (one e2e per surface).

### S04 — Notification primitive: queue-only ephemeral `[AUDIT]`

- Goal: Replace v2 note semantics with the SPEC-r7 notification primitive: queue-only, immutable, ephemeral, no inbox, no list/get, no acknowledge, no delete, no edit. Define one internal producer surface used by planner, executor, reviewer, runtime, error-reporter, and the analyst's `queue_notification` tool. Deliveries are forgotten after injection into the receiving agent session.
- Inputs: SPEC-r7 sections "Terminology: from notes to notifications", "Analyst Capability Classes — Queue notifications", "Out of Scope — user-managed notification object class".
- Acceptance:
  - Notification storage holds only the pending queue per (card-id or role); delivered notifications are dropped, not archived.
  - No `list_notifications`, `get_notification`, `acknowledge_notification`, `delete_notification`, `mark_notification_handled` exist anywhere in `src/` or in the operator API contract.
  - `queue_notification` is the only public producer for the analyst; planner/executor/reviewer/runtime/error-reporter use the same internal producer (one entry point).
  - The analyst's `queue_notification` invocation records an audit entry via the S02 wrapper with `actor='analyst'` plus surface. The entry records the fact of queueing, not the inspectable content of the notification (notifications are not an inspectable object class).
  - Delivery can be confirmed only by inspecting the receiving agent session transcript; a unit/integration test asserts this round-trip.
  - `cd saivage-v3 && npm test` covers: queue, deliver, ephemeral drop, follow-up retraction (a follow-up notification supersedes a pending one for the same target), audit entry for analyst queueing. UI-side note-inbox panels are removed by S06/S09; if vitest detects orphaned references in views owned by later stages, those failures close as ledger entries naming S06 or S09.
  - Cross-cutting rules from section 3 hold.
- Dependencies: S00, S02. Independent of S03.
- Effort: M.
- Risk: legacy code paths in planner/executor that read the v2 note inbox. Mitigation: design doc S04 enumerates every reader; all are rewritten to the producer + injection model, none retain a read-after-deliver path.
- Rollback: revert the commit; `.saivage/` notification state is project-local.
- Likely downstream impact: planner / executor / reviewer producers of notes; [saivage-v3/src/cards/notes.ts](saivage-v3/src/cards/notes.ts); [saivage-v3/src/notifications](saivage-v3/src/notifications); [saivage-v3/src/projections/ledger-projections.ts](saivage-v3/src/projections/ledger-projections.ts); [saivage-v3/src/persistence/file-tree.ts](saivage-v3/src/persistence/file-tree.ts); [saivage-v3/src/workspace/write-territories.ts](saivage-v3/src/workspace/write-territories.ts); [saivage-v3/src/schemas](saivage-v3/src/schemas); runtime-state schema; on-disk persistence (notes were durable; notifications are ephemeral — explicit deletion of any prior on-disk note store is required); operator notes API; tests and skill files that read the legacy note store; debug-view widgets that listed notes. Holistic fix per concern in S04's `design.md` Downstream impact section.

### S05 — Persistent right-side analyst panel + workspace shell restructure

- Goal: Restructure the operator UI shell so the analyst chat is always rendered at the right 20–30% of the viewport and the left workspace area is always rendered at 70–80%. No drawer, no modal, no slide-over, no toggle. Remove every UI control whose action is to open, close, expand, hide, or otherwise toggle the analyst panel. Repurpose "Discuss with analyst" to stage a contextual seed in the always-visible composer.
- Inputs: SPEC-r7 sections "Spatial division in the operator UI", "Persistent panel layout and contextual awareness", "Acceptance Criteria — Persistent panel layout".
- Acceptance:
  - First paint of the operator UI shows both regions; chat composer focusable without a click.
  - No `toggleAnalyst`, `openAnalyst`, `closeAnalyst`, `analyst-drawer` symbols in [saivage-v3/web/src](saivage-v3/web/src); `grep -RE 'toggleAnalyst|analyst-drawer|openAnalyst|closeAnalyst' saivage-v3/web/src` returns no matches.
  - The "Discuss with analyst" affordance on cards stages a seed in the composer instead of opening anything.
  - Layout proportions enforced at typical desktop widths (CSS guarantees 70–80 / 20–30 split; behavior at narrower widths is intentionally unspecified per SPEC).
  - `cd saivage-v3/web && npm run build` succeeds.
  - Cross-cutting rules from section 3 hold.
- Dependencies: S00.
- Effort: M.
- Risk: Vue SFC edits across many files in one stage can leave a build broken if any single SFC is corrupted. Mitigation: S05's `plan.md` pins the per-file edit and verification workflow used inside the stage (including the verification command that catches duplicate SFC blocks before invoking the Vite build); the master plan does not pin specific edit tooling.
- Rollback: revert the commit; old drawer reinstated.
- Likely downstream impact: root layout grid in [saivage-v3/web/src/App.vue](saivage-v3/web/src/App.vue); CSS variables / theming files; nav rail interaction with the now-persistent panel; focus / keyboard accessibility on the always-visible chat; any Vue component that imported the drawer-toggle store. Holistic fix per concern in S05's `design.md` Downstream impact section.

### S06 — UI: remove mutating affordances and their backend callers; preserve read-only affordances; ordered-child rendering in workspace views

- Goal: Strip every mutating affordance from the operator UI and from the generated web client: new-card, action-menu, delete-draft, context-menu mutations, start-project, stop-project, pause/resume, abort subtree, restart card/subtree, mark goal as needing corrections, terminate-process, per-note acknowledge / delete / clear-all, per-notification acknowledge, drag-to-reparent, and every keyboard shortcut that mutates. Update child-component copy. Crucially, also remove every web-client function and pinia-store action whose only purpose is to call a soon-to-be-deleted mutating route, so that after this stage no UI code path attempts to call a route that S07 will remove. The bounded bootstrap (login/sign-out, initial analyst-provider-secret entry) is preserved. Read-only affordances stay fully functional, and the dashboard, files view, and debug view render card children in persisted `position` order.
- Inputs: SPEC-r7 sections "UI Behavior", "Acceptance Criteria — UI removal", "Bounded authentication-bootstrap exception", "UI Behavior — read-only affordances kept", "UI Behavior — ordered-child rendering".
- Acceptance:
  - No mutating controls remain in [saivage-v3/web/src/views/CardsView.vue](saivage-v3/web/src/views/CardsView.vue), [saivage-v3/web/src/views/DashboardView.vue](saivage-v3/web/src/views/DashboardView.vue), [saivage-v3/web/src/views/DebugView.vue](saivage-v3/web/src/views/DebugView.vue), [saivage-v3/web/src/views/FilesView.vue](saivage-v3/web/src/views/FilesView.vue), [saivage-v3/web/src/components/cards/CardsTreeView.vue](saivage-v3/web/src/components/cards/CardsTreeView.vue), [saivage-v3/web/src/components/cards/CardDetailView.vue](saivage-v3/web/src/components/cards/CardDetailView.vue), [saivage-v3/web/src/components/cards/CardHistoryPanel.vue](saivage-v3/web/src/components/cards/CardHistoryPanel.vue), [saivage-v3/web/src/components/cards/NotificationsPanel.vue](saivage-v3/web/src/components/cards/NotificationsPanel.vue).
  - Web-client mutation functions are removed from [saivage-v3/web/src/api/client.ts](saivage-v3/web/src/api/client.ts) and corresponding types from [saivage-v3/web/src/api/types.ts](saivage-v3/web/src/api/types.ts); the runtime store at [saivage-v3/web/src/stores/runtime.ts](saivage-v3/web/src/stores/runtime.ts) and other stores have no actions that POST/PUT/DELETE/PATCH outside the bounded bootstrap.
  - `grep -RnE "(POST|PUT|DELETE|PATCH).*'/api/" saivage-v3/web/src` returns only bootstrap calls and the analyst chat write endpoint.
  - Helper copy referencing removed controls is removed; no "click + New Card", "Acknowledge", "Clear all", "Terminate" remain in user-visible strings outside bootstrap copy.
  - **Read-only affordance preservation.** A positive checklist exercises representative read-only controls across cards, dashboard, files, agents, and debug views after the stage's removals: refresh, filter, sort, search, expand/collapse, copy-to-clipboard, and direct navigation each still function. A web test (or playwright snippet driven from this stage) asserts each control category remains operational on at least one representative surface.
  - **Ordered-child rendering in workspace views.** Dashboard child-of-goal panels, files view card-bound child listings, and debug view child lists render card children in persisted `position` order. Web tests fixture a shuffled `position` vector and assert the rendered order matches it.
  - Web tests under [saivage-v3/web/src/__tests__](saivage-v3/web/src/__tests__) that exercised removed UI/client are deleted (not skipped) or rewritten to assert the absence of the affordance. Removals update the baseline snapshot per section 3 rule (4) so the test ids do not become orphaned ledger entries.
  - `cd saivage-v3/web && npm run build` and `cd saivage-v3/web && npm test` succeed; the application running against the still-existing backend routes does NOT call any mutating endpoint outside the bounded bootstrap. A live probe gate verifies this: with the app running and a test user logged in, exercising every view emits zero non-bootstrap mutating HTTP requests.
  - **Bootstrap boundary live probe.** The same live-probe gate runs in two bootstrap states. (a) No analyst-capable provider is configured: only the bounded bootstrap controls (login/sign-out, initial analyst-provider secret entry) are reachable; no other mutating affordance, provider profile selector, profile-management screen, or additional-secret-entry surface is reachable from any view. (b) At least one analyst-capable provider is configured: the initial-secret-entry surface is not reachable from any view; provider profile selection, additional-secret entry, and profile management are reachable only through the analyst chat, never outside it.
  - Cross-cutting rules from section 3 hold. Backend gate failures caused by S07's pending route deletions may close as ledger entries naming S07.
- Dependencies: S00, S02 (analyst tools cover the equivalent capability), S03 (move/order semantics), S04 (notification semantics), S05 (persistent shell already exists).
- Effort: L.
- Risk: hidden mutating callers in nav, layout, or context-menus. Mitigation: file-by-file checklist driven from the SPEC enumerations plus the live-probe gate above.
- Rollback: revert the commit; mutating UI returns.
- Likely downstream impact: Vue child components transitively used by the removed forms; events emitted by those components and consumed elsewhere (e.g. toast/notification stores); tests that simulate click-to-mutate flows; e2e scenarios that depend on a clickable affordance; any keyboard-shortcut registry; [saivage-v3/web/src/api/client.ts](saivage-v3/web/src/api/client.ts), [saivage-v3/web/src/api/types.ts](saivage-v3/web/src/api/types.ts), [saivage-v3/web/src/stores/runtime.ts](saivage-v3/web/src/stores/runtime.ts), [saivage-v3/web/src/__tests__](saivage-v3/web/src/__tests__). Holistic fix per concern in S06's `design.md` Downstream impact section.

### S07 — Operator API pruning: delete mutating routes

- Goal: With the web UI no longer calling any non-bootstrap mutating endpoint (guaranteed by S06's live-probe gate), delete every user-facing mutation route from the operator HTTP API and from [saivage-v3/src/contracts/operator-api.ts](saivage-v3/src/contracts/operator-api.ts). Card mutations, runtime start/stop/pause/resume/abort/restart/mark-corrections/terminate-process, note CRUD, config writes — all gone from HTTP. Read routes stay. The analyst becomes the only path to mutate, internally.
- Inputs: SPEC-r7 sections "Vision", "UI Behavior", "Acceptance Criteria — UI removal", "Bounded authentication-bootstrap exception".
- Acceptance:
  - Mutating handlers removed from [saivage-v3/src/server/routes/cards.ts](saivage-v3/src/server/routes/cards.ts), [saivage-v3/src/server/routes/runtime-config-notes.ts](saivage-v3/src/server/routes/runtime-config-notes.ts), [saivage-v3/src/server/routes/processes.ts](saivage-v3/src/server/routes/processes.ts), and [saivage-v3/src/server/routes/chats-files-debug.ts](saivage-v3/src/server/routes/chats-files-debug.ts). The bounded bootstrap (login/logout + initial analyst-provider-secret entry) is kept.
  - Corresponding `operator-api.ts` contract entries removed; the contract enumerates only reads + the bounded bootstrap + the analyst chat endpoint.
  - `grep -REn 'POST|PUT|DELETE|PATCH' saivage-v3/src/server/routes` returns only the bounded-bootstrap and analyst chat write endpoints.
  - Route-level tests for removed mutations are deleted (not skipped); the baseline snapshot is updated to drop those ids so they cannot reappear in the ledger.
  - The S06 live-probe gate is re-run as part of this stage in both bootstrap states (no analyst-capable provider configured, and at least one analyst-capable provider configured): with the app running against the pruned backend, no view produces a 404 or 405 (because S06 already removed every caller); if a 404/405 surfaces, S06 was incomplete and this stage MUST stop and request a follow-up stage per section 7 rather than apply a localized patch or a ledger entry.
  - `cd saivage-v3 && npm run build` and `cd saivage-v3 && npm test` succeed.
  - Cross-cutting rules from section 3 hold. Any ledger entries authored by earlier stages and naming S07 as the target fix stage MUST be removed at S07's close (i.e. the underlying failure is no longer observed by the relevant gate after this stage lands).
- Dependencies: S00, S02, S03, S04, S06 (UI no longer calls the routes about to be deleted).
- Effort: M.
- Risk: a UI caller missed by S06. Mitigated by the explicit live-probe gate above and by S06 owning the removal of callers.
- Rollback: revert the commit; HTTP surface restored.
- Likely downstream impact: contract validator that may verify completeness of [saivage-v3/src/contracts/operator-api.ts](saivage-v3/src/contracts/operator-api.ts); CLI / scripts that call mutating routes (any `fetch('/api/...')` outside tests, including operator dashboards in sibling projects); route-level tests in [saivage-v3](saivage-v3); any external integrations (e.g. Telegram bot scripts) that still poke the HTTP surface. Holistic fix per concern in S07's `design.md` Downstream impact section.

### S08 — UI: analyst-driven navigation + contextual awareness wiring + chat context ordered-child rendering `[AUDIT]`

- Goal: Wire the workspace area so the analyst can navigate it (`navigate_workspace` tool effects an actual route change in the SPA) and so every user turn carries the current view category, active entity id, and any active refinement to the analyst as part of its context. Deictic phrases ("this", "here", "the current") resolve via that context. When the current view has no active entity and the user uses a deictic phrase that needs one, the analyst asks one clarifying question and performs no mutation. General workspace-context ambiguity (multiple plausible referents) follows the one-clarification rule from S01. Any analyst chat panel surface that renders the current card's children as part of contextual awareness renders them in persisted `position` order.
- Inputs: SPEC-r7 sections "Navigate the workspace area", "Persistent panel layout and contextual awareness", "Multi-turn ambiguity", "Acceptance Criteria — Contextual awareness", "Acceptance Criteria — Analyst-driven navigation", "UI Behavior — ordered-child rendering".
- Acceptance:
  - The analyst chat composer attaches current view category, active entity id, and active refinement to each user turn (server-side context, not visible to user).
  - `navigate_workspace` tool changes the left-panel route; a chat utterance "open card code-3" causes the SPA to route to that card and the analyst confirms in chat.
  - "Go back to where I was before" returns to the previously active view + entity.
  - When the current view has no active entity and the user uses a deictic phrase that needs one, the analyst replies that no entity is in focus and asks which one was meant (no wrong-scope mutation). Same behavior for multiple plausible referents: one clarifying question, no mutation, until the user answers.
  - Analyst-driven navigation that triggers a follow-up mutation in the same turn still records that mutation through the S02 audit wrapper with `actor='analyst'` plus surface.
  - Analyst chat context lists (any analyst panel descendant that renders a card's children for contextual awareness) render children in persisted `position` order; a web test asserts this against a shuffled `position` vector.
  - The stage's `design.md` is required to identify a single source of truth for the SPA route state shared between the analyst tool and direct user-driven navigation (the exact module shape is a design choice, not pinned here).
  - `cd saivage-v3/web && npm run build` and `cd saivage-v3 && npm run build` succeed.
  - Cross-cutting rules from section 3 hold.
- Dependencies: S00, S02 (`navigate_workspace` tool defined), S05 (persistent shell exists), S06 (no competing mutation controls inject route changes from button clicks).
- Effort: M.
- Risk: SPA route state desync between analyst-driven navigation and user-driven navigation. Mitigation: the design must pin one shared source of truth as described above.
- Rollback: revert the commit; analyst chat keeps working but cannot navigate.
- Likely downstream impact: SPA router and route store integration between the left panel and the analyst; current-view propagation from web to backend on each chat turn; deixis resolution layering in the analyst system prompt and in tool-call argument defaults; any component that reads the route store; existing analyst e2e scenarios that assumed a static workspace. Holistic fix per concern in S08's `design.md` Downstream impact section.

### S09 — Operator events surface cleanup (no notification-content read surface)

- Goal: Either delete or convert to a genuinely generic read-only "recent runtime events" surface any panel whose only purpose was operator-side notification or runtime mutation: the v2-style operator note inbox, the notifications panel's acknowledge surface, the debug-view terminate-process control. If a recent-runtime-events surface is preserved, it MUST be renamed to a notification-agnostic name (e.g. `RuntimeEventsPanel`) and MUST NOT list notification content as an inspectable object. SPEC-r7 explicitly forbids treating notifications as an inspectable object class.
- Inputs: SPEC-r7 sections "UI Behavior", "Acceptance Criteria — UI removal", "Out of Scope — user-managed notification object class".
- Acceptance:
  - [saivage-v3/web/src/components/cards/NotificationsPanel.vue](saivage-v3/web/src/components/cards/NotificationsPanel.vue) is either deleted or renamed to a notification-agnostic component (no `Notification*` identifier in file name, exported symbol name, route name, or user-visible string). It exposes no per-row mutation; no `acknowledge`, `delete`, `clear-all`, or `mark-handled` actions remain.
  - The stage adds an explicit mechanical gate: no UI string, web-client function, web-client type, API contract entry, or backend route mentions a "notification" as an inspectable or listable object. `grep -REn 'list[_-]?notification|get[_-]?notification|notification[_-]?inbox' saivage-v3/src saivage-v3/web/src saivage-v3/src/contracts` returns no matches. The events surface, if kept, lists runtime/platform events (card transitions, process starts, reviewer assessments) and never notification deliveries.
  - [saivage-v3/web/src/views/DebugView.vue](saivage-v3/web/src/views/DebugView.vue) has no terminate-process control, no per-note acknowledge / delete / clear-all controls; filters, refresh, copy-to-clipboard kept.
  - Subtitles and helper copy updated so they no longer direct the user to removed controls.
  - `cd saivage-v3/web && npm run build` succeeds.
  - Cross-cutting rules from section 3 hold.
- Dependencies: S00, S04 (notification primitive defined), S06 (mutating UI already stripped).
- Effort: S.
- Risk: stranded references from removed routes leaving the panel empty at runtime. Mitigation: design doc S09 explicitly lists which read endpoint replaces each removed listing, or accepts the deletion.
- Rollback: revert the commit; panel returns.
- Likely downstream impact: any view that imported components from the removed panels; the debug-view tab structure; operator workflow tests; skill files / docs that mention the operator note inbox or notifications acknowledge flow. Holistic fix per concern in S09's `design.md` Downstream impact section.

### S10 — Test suite update: analyst playwright + unit/integration; final ledger reconciliation `[AUDIT]`

- Goal: Bring the e2e analyst suite at [saivage-e2e-checkers/e2e/analyst](saivage-e2e-checkers/e2e/analyst) green for the 8 scenarios in [saivage-e2e-checkers/e2e/analyst/findings/findings.md](saivage-e2e-checkers/e2e/analyst/findings/findings.md), and add new scenarios for every SPEC-r7 acceptance criterion not yet mechanically covered. Update or delete unit and integration tests whose subject was removed. The audit cross-cutting rule from section 3 is exercised end-to-end here, as is the non-secret inspection boundary and the ordered-child rendering matrix. S10 also owns the final reconciliation of the cumulative expected-breakage ledger: every entry authored by S01–S09 MUST be either repaired (entry removed) or escalated by S10 itself; at S10's close the ledger MUST be empty.
- Inputs: SPEC-r7 section "Acceptance Criteria" in full; current findings file; the cumulative ledger at [saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md).
- Required new test coverage (named so reviewers can mechanically check the matrix):
  - Inspect inventory: at least one scenario per inspect category (cards/history, runtime state/events/errors, audit log, agent transcripts, process registry/output, directory listings, file contents).
  - **Non-secret inspection boundary.** At least one scenario per inspect category attempts to read a secret-bearing artifact and asserts the result is denied or redacted, while a sibling non-secret artifact returns its content. Concrete probes: provider API key in [saivage-v3/.saivage/saivage.json](saivage-v3/.saivage/saivage.json), full contents of [saivage-v3/.saivage/auth-profiles.json](saivage-v3/.saivage/auth-profiles.json), a runtime token surfaced through a process output dump, an env var flagged secret. The scenarios assert the analyst's reply does not contain the secret values and that the redaction decision is recorded in the audit log.
  - Analyst-driven navigation, deictic resolution against the workspace area, "go back".
  - General ambiguity: one-clarification-question behavior for non-deictic ambiguous requests.
  - Card mutations including batch/set in one turn (e.g. "delete all cancelled cards under goal-7").
  - Bounded move both directions; cross-tree move refusal; root-card move refusal; child reorder.
  - **Ordered-child rendering matrix (closes section 4.1).** One e2e per current child-rendering UI surface listed in section 4.1: cards tree, card detail view, card history child references, dashboard child-of-goal panels, files view card-bound child listings, debug view child lists, analyst chat context lists. Each scenario fixtures a shuffled `position` vector and asserts the rendered order matches it.
  - Notification queue round-trip via planner session inspection; follow-up retraction; absence of any list/get/acknowledge analyst tool.
  - Full runtime-control verb coverage: start, stop, pause, resume, abort goal subtree, restart card or subtree, mark goal as needing corrections, terminate process. Destructive verbs exercise the conversational confirmation flow (affirm / cancel / amend / stale).
  - Reconfigure: role/model routing, failover order, MCP entry add/edit/remove, runtime setting, server setting, restart-server-when-required prompt, redacted `show_config`.
  - Investigate-and-repair narrative + "apply that fix" follow-up; partial-success reporting when the fix is multi-step and some steps fail.
  - Failure modes: provider offline (no mutation, explicit phrase), unsupported action reply, unknown internal capability reply, stale destructive confirmation.
  - Read-only affordance preservation: a playwright scenario exercises refresh, filter, sort, search, expand/collapse, copy-to-clipboard, and navigation across cards, dashboard, files, agents, and debug after the mutation surface is gone.
  - Bootstrap boundary: the S06 live-probe gate is exercised through the playwright surface in both bootstrap states (no analyst-capable provider configured; at least one configured), asserting the post-bootstrap boundary holds.
  - Audit: a scenario that issues a small representative set of mutations (one card mutation, one runtime control, one reconfigure, one queue_notification) and then asks the analyst to surface the corresponding audit entries, asserting each entry has `actor='analyst'` and the originating-surface field.
- Acceptance:
  - `cd saivage-e2e-checkers && npm run test:analyst` reports PASS for S1–S8 (verdict moves from LIMITATION to PASS).
  - All new scenarios above are present and passing.
  - `cd saivage-v3 && npm test` passes; tests for removed features are deleted, not skipped.
  - Test suite contains no references to `mark_note_handled`, `list_notes`, `confirmed`, `preview_hash`, or any deleted concept.
  - **Cumulative ledger is empty.** [saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md) contains its header and zero open entries at the moment S10 closes. Any entry not yet repaired is repaired inside S10, or, if it requires further work, S10 cannot close — a follow-up stage at the next free `NNN` prefix per section 7 is required.
  - The S00 baseline snapshot at [saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json](saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json) is updated to reflect the new green state, so that any future work after S10 has an updated comparison basis. The refresh is itself a reviewable change.
  - Cross-cutting rules from section 3 hold; in particular rule (5) requires the empty-ledger condition above.
- Dependencies: S00, S01–S09.
- Effort: L.
- Risk: e2e flake from a real LLM in CI; residual ledger entries that turn out to require behavior outside S10's scope. Mitigation: design doc S10 specifies whether the analyst suite runs against a fixed analyst model and how transient provider errors are surfaced as test infra failures vs product failures, and pins the protocol for escalating an un-repairable ledger entry into a follow-up stage (the entry is not "transferred" — it stays open, S10 does not close, the follow-up stage takes ownership).
- Rollback: revert the commit; CI returns to prior expectations (still failing 7/8 LIMITATIONS) and ledger entries return to whatever they were before S10 began its repair pass.
- Likely downstream impact: test fixtures, helpers, and mocks that referenced removed surfaces; CI configuration (if any) that depended on suite layout; the baseline-gates snapshot itself which is updated by this stage; the cumulative ledger file which transitions to its empty steady-state; documentation in [saivage-v3/SPEC](saivage-v3/SPEC) and skill files describing the analyst test surface. Holistic fix per concern in S10's `design.md` Downstream impact section.

## 5. Dependency edges (plain text)

```
S00 ──> S01 ──> S02 ──┬─> S03 ─────────────────────────┐
                      ├─> S04 ─────────────────────────┤
                      │                                 │
                      │                                 v
S00 ──> S05 ──────────┴─> S06 (UI removes mutators) ──> S07 (routes pruned)
                                  │
                                  v
                                 S08 (navigation)
                                  │
S04 ──────────────────────────────┴──> S09 (events surface cleanup)

S00..S09 ──> S10 (test suite update + final ledger reconciliation)
```

In words:

- S00 (baseline gates) precedes everything; it produces the comparison snapshot AND the empty cumulative ledger that every later stage's close criterion refers to.
- S01 (real resolver) unlocks every later stage; nothing else can be exercised conversationally until the analyst actually talks. S01 also owns conversation-shape primitives (one-clarification, immediate prior context, no-mutation-when-offline) that later stages rely on.
- S02 (tool surface) sits on top of S01 and is itself a precondition for the data-model and UI stages that need new tool names. It owns the shared audit-wrapped invocation entry point, the non-secret inspection boundary (single classifier module), and the unsupported-action / partial-success / unknown-internal-capability response shapes.
- S03 (card model) and S04 (notifications) are independent of each other and can be developed in parallel after S02. S03 also makes persisted `position` the authoritative render order returned by every backend reader of card children.
- S05 (persistent shell) is a self-contained UI-shell restructure with no backend coupling.
- S06 (UI removes mutating affordances AND their backend callers, preserves read-only affordances, and renders dashboard/files/debug child lists by persisted position) needs S02/S03/S04 (analyst surface covers the capability), and S05 (shell already restructured). Critically, S06 finishes BEFORE S07 so that when routes are deleted there is no UI caller left to 404.
- S07 (operator API pruning) needs S02/S03/S04 (analyst replaces the routes) and S06 (no UI caller remains). After S07 the rendered app is never in a knowingly broken state from a runtime-routing perspective.
- S08 (navigation + contextual awareness, plus ordered-child rendering inside the analyst chat panel) needs the tool from S02, the shell from S05, and the absence of competing mutators from S06. It does not depend on S07.
- S09 (events surface cleanup) needs S04 (semantics) and S06 (no residual mutators).
- S10 (tests + final ledger reconciliation) is last and exercises everything, drains the cumulative ledger to empty, and refreshes the S00 baseline snapshot.

A ledger entry's target fix stage MUST be one of the strictly later stages in this DAG (per section 3 rule 8). Authors cannot name themselves; they cannot name S00 (which has no product surface to repair against); and S10 is always the final safety net.

## 6. Breakage-detection and downstream-impact discipline

This section makes the discipline explicit at the master-plan level. Each per-stage document MUST satisfy the following structural requirements, enforced when the stage is reviewed and again when the stage is closed.

### 6.1 Required sections in each stage's design.md — "Downstream impact" and "Breakage forecast"

Every `stages/NNN-<slug>/design.md` MUST contain a top-level section titled exactly `Downstream impact`. Required content shape:

1. Enumerate the subsystems and concrete code/test paths the stage's mutations are likely to break. Each entry is a one-line markdown link to a file (or directory) under the workspace, plus a short reason ("removes the route this view calls", "changes the on-disk shape this loader reads", and so on). Hand-waving entries ("various tests") are not acceptable. Where the master plan's per-stage block already names paths (S02: [saivage-v3/src/tools/agent-tools.ts](saivage-v3/src/tools/agent-tools.ts), [saivage-v3/src/agents/role-tool-policy.ts](saivage-v3/src/agents/role-tool-policy.ts), [saivage-v3/src/schemas](saivage-v3/src/schemas); S04: [saivage-v3/src/cards/notes.ts](saivage-v3/src/cards/notes.ts), [saivage-v3/src/notifications](saivage-v3/src/notifications), [saivage-v3/src/projections/ledger-projections.ts](saivage-v3/src/projections/ledger-projections.ts), [saivage-v3/src/persistence/file-tree.ts](saivage-v3/src/persistence/file-tree.ts), [saivage-v3/src/workspace/write-territories.ts](saivage-v3/src/workspace/write-territories.ts), [saivage-v3/src/schemas](saivage-v3/src/schemas); S06/S07: [saivage-v3/web/src/api/client.ts](saivage-v3/web/src/api/client.ts), [saivage-v3/web/src/api/types.ts](saivage-v3/web/src/api/types.ts), [saivage-v3/web/src/stores/runtime.ts](saivage-v3/web/src/stores/runtime.ts), [saivage-v3/web/src/__tests__](saivage-v3/web/src/__tests__)) the per-stage `design.md` MUST cover them, plus anything else the stage author discovers.
2. For each entry, describe the holistic fix — the change that restores correctness across the whole subsystem, not a local patch that silences the immediate symptom. Architecture-first applies: dead code is removed, contracts are realigned, callers are rewritten. Migration shims and feature flags are forbidden.
3. List the validation gates that will catch the breakage if the holistic fix is missed. Each entry names the gate (typecheck, the specific vitest suite, the specific playwright suite, the named live probe) so a reader can mechanically check "did we run that gate before closing the stage".

Every stage from S01 onward MUST additionally contain a top-level section titled exactly `Breakage forecast`. Required content shape:

1. For each breakage the stage author anticipates leaving in the cumulative ledger at close-time, one entry with: the failing artifact (test file + test name, or build error location); the failure mode (one sentence); the SPEC-r7 requirement or earlier-stage decision that forces it; the target fix stage (must be a later stage id from the DAG in section 5).
2. An explicit statement of "no forecast entries" is required if the author expects to close green; that statement makes it auditable when reality deviates from the forecast.
3. The forecast is non-binding for content (the close-time ledger is what counts) but binding for shape (any close-time entry that has no analog in the forecast must be justified in `plan.md` Breakage triage as "unforeseen", and the design should be revised in a follow-up if the divergence is large).

The cumulative ledger entries themselves (recorded at close-time in `plan.md` Breakage triage, then written into [saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md)) MUST contain:

- A heading identifying the failing artifact (test file + test name, or build error location). One entry per failure.
- A `Failure mode` line — one sentence.
- A `Reason acceptable now` line — which SPEC-r7 requirement or earlier-stage decision forces the breakage.
- A `Target fix stage` line — the id of a strictly later stage in the DAG (section 5).
- A `Recorded by` line — the stage id and date that authored the entry.

No richer schema is mandated. The file is human-readable Markdown; any extra notes the author finds useful may live under the entry's heading.

### 6.2 Required sub-step in each stage's plan.md — "Breakage triage"

Every `stages/NNN-<slug>/plan.md` MUST contain a sub-step titled exactly `Breakage triage`. This sub-step:

1. Runs the four cheap baseline gates and (where applicable) the e2e analyst suite and the live probe, using the exact commands in [saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md).
2. Compares the result against the baseline snapshot.
3. On any NEW failure (failure not present in baseline), the implementer MUST first attempt the holistic fix described in the stage's `design.md` Downstream impact section. If the fix succeeds, the gates re-run green and no ledger entry is needed. If the holistic fix legitimately belongs in a later stage (per the Breakage forecast or per discovery during implementation), the implementer adds a ledger entry per section 6.1 to [saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md), naming the target fix stage. Localized patches that silence the failure without addressing root cause remain forbidden (section 3 rule 3); skipping or deleting still-valid tests to drop the failure remains forbidden (section 3 rule 4). Closing a stage with a NEW failure and no matching open ledger entry naming a later stage is a protocol violation.
4. Removes from the ledger every entry whose `Target fix stage` is the closing stage and whose underlying failure is now resolved (no longer observed by the relevant gate). If a ledger entry names this stage as target but the failure persists, this stage cannot close.
5. Records, in the `plan.md` Breakage triage sub-step itself, the delta against the design's Breakage forecast: forecast entries that did not materialize, close-time entries that were not foreseen, and any forecast entry deferred to a different target than originally planned. Significant divergence between forecast and reality is a signal to revise the master plan in a future round (r6+).
6. On success, refreshes any volatile entries in [saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json](saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json) that are intentional (e.g. tests for removed features deleted by the stage, per section 3 rule 4). Refresh is itself a reviewable change.

### 6.3 Foundational stage S00 produces the harness and seeds the ledger

S00 produces the artifacts that the rest of the discipline relies on:

- [saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json](saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json): the baseline failure set with the minimum-required fields enumerated in S00's acceptance.
- [saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md): the exact commands each stage runs, including the v2-on-v3 activation preflight and the ledger update procedure.
- [saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md): the empty seed of the cumulative ledger, with a header describing the entry shape from section 6.1 and the close-time bookkeeping rules from section 6.2.

These are the only authoritative references for "what counts as a NEW failure", "what command must I run", and "what failures may a stage close with". Anything else is hearsay.

### 6.4 Mechanical close check

A stage's close is mechanically checkable by the following procedure, runnable by any reviewer:

1. Run the four baseline gates per the cookbook; collect the failing-id set per gate id.
2. Diff each set against the baseline snapshot's failing-id set for the same gate id. Call the per-gate diff `new_failures(gate)`.
3. Parse [saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md). Call the set of open-entry artifact identifiers `open_ledger`.
4. For every `id` in `new_failures(gate)` across all gates, assert `id ∈ open_ledger` AND the matching entry's `Target fix stage` is a later stage in the DAG (section 5). If any id fails this assertion, the close criterion is violated.
5. For every entry in `open_ledger` whose `Target fix stage` equals the closing stage, assert the artifact is no longer in `new_failures(gate)` for any gate. If any such entry remains, the closing stage's repair pass was incomplete and the stage cannot close.
6. For S10 specifically, additionally assert `open_ledger` is empty.

The check uses only the baseline snapshot, the ledger file, and the current gate run; no human judgement is required to decide whether a failure was "expected".

## 7. How stages are published

Stages are published to the autonomous v2-on-v3 instance via the protocol at [saivage-v3/SPEC/analyst-as-control-surface/PLAN/PROTOCOL-r4.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/PROTOCOL-r4.md). That document is the single authority on publication semantics. This master plan only summarizes the relationship.

Key properties relevant to this master plan:

- Each stage lives in its own directory under [saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/](saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/), named `NNN-<slug>` where `NNN` is a zero-padded three-digit sort-order prefix and `<slug>` is a short kebab-case identifier. The prefix is a sort key only, not a dependency declaration.
- A stage is published by building its directory at any path outside `stages/` (typically under a `drafts/` sibling or the workspace `tmp/`, on the same filesystem as `stages/`) and then atomically renaming it into `stages/` via `rename(2)`. There is no `READY` sentinel and no declared documents map; the only files inside a stage directory are `design.md` and `plan.md` plus any stage-local assets.
- **Immutability and follow-up-stage correction.** Once a stage directory is inside `stages/`, neither its name nor any byte under it may change. PROTOCOL-r4 forbids in-place revision, withdrawal, replacement, and rename. If a published stage is wrong — whether the author noticed before or after the consumer picked it up — the correction is published as a new stage at the next free `NNN` prefix. The new stage's `design.md` and `plan.md` describe what they correct relative to the predecessor; this master plan and the affected stages' documents resolve ordering and supersession in human prose. The protocol itself does not model supersession. A future master-plan revision (r6+) may reorder unpublished stages or rename stage ids, but it MUST NOT touch any directory already inside `stages/`.
- **The cumulative ledger is NOT a stage directory.** [saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md) lives outside `stages/`; it is mutable by design (every stage updates it at close-time per section 6.2). The immutability rule applies only to directories under `stages/`, not to the plan-level artifacts in this PLAN folder.
- The on-disk layout sketch matches the protocol verbatim:

  ```
  saivage-v3/SPEC/analyst-as-control-surface/PLAN/
    00-MASTER-PLAN-r7.md
    PROTOCOL-r4.md
    baseline-gates.json
    expected-breakage-ledger.md          (mutable; updated at every stage close)
    VALIDATION-COOKBOOK.md
    drafts/                                    (work-in-progress; consumer ignores)
    stages/                                    (published; consumer watches; immutable)
      000-baseline-gates/
        design.md
        plan.md
      001-llm-resolver-real/
        design.md
        plan.md
      002-tool-surface-alignment/
        design.md
        plan.md
      ...
  ```

- Dependency intent across stages is described in this master plan in human terms (section 5). It is NOT encoded in the protocol, in stage files, or in the directory layout. There are no digests, version fields, or dependency declarations carried by the protocol.
- Stage ids in this master plan (S00..S10) map deterministically to directory prefixes (`000..010`). The master plan's per-stage block names the design and plan paths that MUST exist inside the corresponding `stages/NNN-<slug>/` directory.

## 8. v2-on-v3 delegation notes

This master plan will be executed by the dedicated Saivage v2 harness running in the `saivage-v3` LXC container, targeting `/work/saivage-v3` per [WORKSPACE_HANDOFF.md](WORKSPACE_HANDOFF.md). The harness is the only authorized agent making changes inside [saivage-v3](saivage-v3) during this migration.

Bootstrap moment (explicit):

- The v2-on-v3 autonomous instance is reconfigured and restarted as soon as the [saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/](saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/) directory becomes non-empty — i.e. immediately after the first stage (S00, directory prefix `000`) lands.
- Subsequent stages are picked up incrementally per PROTOCOL-r4: the consumer scans the watched directory when its queue is empty and appends new stage directories in `NNN` ascending order. There is no need to publish all eleven stages before starting work.
- Before that reconfigure-and-restart, the operator runs the activation preflight documented in the cookbook produced by S00 (service health for the `saivage-v3` harness, protocol-consumer presence and watched-path visibility, no stale shutdown handoff state under [saivage-v3/.saivage/tmp/state](saivage-v3/.saivage/tmp/state), expected v2 harness runtime files present under [saivage-v3/.saivage](saivage-v3/.saivage)). The preflight is non-secret and operator-runnable; if any check fails, no stage is published until it is resolved.

Mechanics:

- Each stage S00–S10 becomes one or more cards in the v2-on-v3 project plan. Each card cites both this master plan and its per-stage design document by path.
- Per-stage `design.md` and `plan.md` files live inside their stage directory under [saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/](saivage-v3/SPEC/analyst-as-control-surface/PLAN/stages/). They are written, reviewer-passed, and only then published via PROTOCOL-r4's atomic-rename primitive.
- The autonomous runtime advances through the stages in the dependency order in section 5. The user controls start / pause / resume via the analyst chat. Because the analyst is currently keyword-only, the first product stage (S01) bootstraps its own replacement: until S01 lands, the user steers the v2-on-v3 harness through its keyword parser; from S01 onward the same steering happens conversationally. S00 itself produces no product mutation and is steered through the existing keyword surface.
- Each per-stage card MUST cite the design document and this plan document by path. Card titles should include the stage id (e.g. "S03: Card model — ordered children + bounded move") to keep the mapping legible.
- Cards that span more than one stage are not created. If, during execution, work is found to cross a published stage boundary (for example because a published stage's acceptance turns out to require additional work that was not foreseen, or the cumulative ledger cannot be drained as planned), the correction is published as a new stage at the next free `NNN` prefix per section 7. The published stage stays as-is; the new stage describes the gap it closes; this master plan is revised in a future round only to update unpublished planning.

## 9. Stage-document autonomy

Every file under any `stages/NNN-<slug>/` directory MUST be self-contained in the sense that follows. The rule targets references to non-current rounds of the planning documents (which will no longer exist at consumption time); it does NOT restrict references to other files on disk that v2-on-v3 can reach. The implementer must be able to execute the stage without consulting any document that has been superseded.

### 9.1 Permitted external references

A stage's files MAY freely reference any path inside the workspace [saivage-v3/](saivage-v3/), including but not limited to:

- The currently approved SPEC: [saivage-v3/SPEC/analyst-as-control-surface/SPEC-r7.md](saivage-v3/SPEC/analyst-as-control-surface/SPEC-r7.md).
- The currently approved master plan: this document.
- The currently approved publication protocol: [saivage-v3/SPEC/analyst-as-control-surface/PLAN/PROTOCOL-r4.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/PROTOCOL-r4.md).
- The cumulative breakage ledger: [saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md).
- The S00 artifacts once published: [saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md) and [saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json](saivage-v3/SPEC/analyst-as-control-surface/PLAN/baseline-gates.json).
- Other published stage directories under `stages/NNN-<slug>/`.
- Any workspace source code, configuration, or documentation file.
- Workspace-build path names referenced in the publication protocol (`drafts/`, `tmp/`, `wip/`): mentioning these as part of the publication recipe is allowed.

### 9.2 Forbidden references

A stage's files MUST NOT mention or rely on:

- Earlier rounds of SPEC, master plan, protocol, or any review document — by name or by implication. Concrete forbidden anchor strings (case-insensitive): `SPEC-r1`, `SPEC-r2`, `SPEC-r3`, `SPEC-r4`, `SPEC-r5`, `SPEC-r6`, `PROTOCOL-r1`, `PROTOCOL-r2`, `PROTOCOL-r3`, `MASTER-PLAN-r1`, `MASTER-PLAN-r2`, `MASTER-PLAN-r3`, `MASTER-PLAN-r4`, `MASTER-PLAN-r5`, `MASTER-PLAN-r6`, `REVIEW-r`, `prior round`, `earlier round`, `previous version`, `previous draft`, `before the refactor`, `was superseded`, `older revision`.
- Stages that have not yet been published under `stages/`.
- The per-stage reviewer report (it lives only in the draft directory and is discarded at publish).

The current master plan filename (`MASTER-PLAN-r7.md`), current PROTOCOL filename (`PROTOCOL-r4.md`), and current SPEC filename (`SPEC-r7.md`) are permitted because they are the canonical current artifacts.

### 9.3 Autonomy gate (close criterion for every stage)

The stage's writer/reviewer dance does NOT complete until the reviewer subagent has:

1. Scanned all files inside the stage directory for the forbidden anchor strings in 9.2 (case-insensitive grep) and confirmed zero hits.
2. Confirmed every external link in the stage's files resolves to one of the canonical inputs in 9.1 or to a path inside [saivage-v3/](saivage-v3/).
3. Confirmed each cross-stage reference points to a directory that already exists under `stages/` at the moment of review.

A reviewer finding any violation MUST return VERDICT: CHANGES_REQUESTED. The stage MUST NOT be published until the reviewer returns APPROVED.

### 9.4 Pre-publication operator check

Immediately before the operator atomically renames the built stage directory into `stages/`, the operator runs a grep over the to-be-published tree for the forbidden anchor strings in 9.2. If any appear, the directory is NOT renamed in; the stage returns to the writer/reviewer dance. The exact grep command is recorded in [saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md](saivage-v3/SPEC/analyst-as-control-surface/PLAN/VALIDATION-COOKBOOK.md) (added by S00).

### 9.5 Writer and reviewer prompt requirements (cross-cutting)

When orchestrating the per-stage dual-subagent dance:

- The writer prompt MUST instruct the writer that the produced documents are written AS IF the reader has access only to the canonical inputs in 9.1 and to workspace source code. The writer MUST NOT cite drafts, prior rounds, or unpublished stages.
- The reviewer prompt MUST include the autonomy gate from 9.3 verbatim, including the forbidden anchor list in 9.2. The reviewer prompt MUST instruct CHANGES_REQUESTED on any violation regardless of other findings.

ROUND: 7
