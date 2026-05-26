# Stage 010e inventory and deterministic Analyst e2e implementation guidance

Accessed: 2026-05-26

## Executive summary

The live Stage 010e starting point is intentionally not a passing S1-S68 suite yet. The checker repository currently contains only a quarantine guard in `e2e/analyst/scenarios.spec.js` and a short findings reset file. The current fixture still copies ambient checker `.saivage/auth-profiles.json` and `.saivage/saivage.json` into each temp project, which directly violates the accepted 010d strategy and must be removed before any real scenario work is accepted.

The v3 product already exposes the real Analyst route/stack and source-truth tool registry needed by the implementation:

`POST /api/chats/:sessionId -> AnalystHandler -> LlmIntentResolver -> LlmClient -> registered analyst tools -> persisted messages/toolInvocations`

Stage 010d proved a non-secret localhost OpenAI-compatible deterministic provider can drive the real handler/resolver/tool-runner loop with live advertised tools. The implementation should port that pattern into the checker fixture and then replace the quarantine-only scenario file with substantive S1-S68 Playwright specs.

## Authoritative requirements consulted

- `SPEC/analyst-as-control-surface/PLAN/stages/010-test-suite-and-ledger-reconciliation/plan.md`
- `SPEC/analyst-as-control-surface/PLAN/stages/010-test-suite-and-ledger-reconciliation/design.md`
- `.saivage/stages/010d-design-valid-deterministic-analyst-e2e-strategy/artifacts/deterministic-analyst-e2e-strategy.md`
- `.saivage/stages/010d-design-valid-deterministic-analyst-e2e-strategy/artifacts/feasibility-evidence.md`
- `.saivage/stages/010d-design-valid-deterministic-analyst-e2e-strategy/artifacts/deterministic-analyst-poc-output.json`

## Current checker state

### Fixture: `../saivage-e2e-checkers/e2e/analyst/fixtures/saivage-server.js`

Observed exports:

- `bootSaivageServer(opts = {})`
- `sendAnalystMessage(baseURL, sessionId, content)`
- `listCards(baseURL)`
- `runtimeStatus(baseURL)`
- `controlActionsLog(baseURL, { cardId, since } = {})`
- `plannerSessionInspect(baseURL, sessionId)`
- `analystToolRegistry()`
- `workspaceRouteSnapshot(page)`

Problematic current behavior:

- Lines found by inventory show the fixture imports `copyFileSync`, `readFileSync`, and `writeFileSync` and contains comments saying credentials/provider config are inherited from the checker project.
- It constructs checker paths to `.saivage/auth-profiles.json` and `.saivage/saivage.json` and copies them into the temp project when present.
- It then edits the temp `.saivage/saivage.json` to override only the server port.

Required implementation direction:

1. Delete all ambient auth/provider copying from the fixture.
2. Make `bootSaivageServer` write a fresh non-secret temp-project config that routes the `analyst` role to a local deterministic provider/model.
3. Start a fixture-local OpenAI-compatible deterministic provider before the v3 server and stop it afterward.
4. Keep/add observation helpers from the Stage 010 plan (`controlActionsLog`, `plannerSessionInspect`, `analystToolRegistry`, `workspaceRouteSnapshot`) and add evidence helpers for persisted Analyst messages if useful.
5. Do not read checker/v3 provider config or auth files.

### Scenario file: `../saivage-e2e-checkers/e2e/analyst/scenarios.spec.js`

Current inventory:

- 26 lines total.
- Header says `Analyst e2e placeholder quarantine guard`.
- It references quarantine directory `e2e/analyst/quarantine/2026-05-26-stage010-placeholder-quarantine`.
- Only executable test is `failed Stage 010 placeholder scenarios are quarantined outside executable suite`.
- No S1-S68 scenarios currently execute.
- No real `sendAnalystMessage`/tool/state assertions are present in the active suite.

Required implementation direction:

- Replace the quarantine guard with real S1-S68 specs in Stage 010 Phase C order.
- Preserve S1-S8 prompt wording and turn counts mechanically (store original prompt constants and assert before sending).
- S9-S68 must each send turns through the real chat route unless the scenario is explicitly a UI-only affordance subcase in S65.
- Assertions must inspect `toolInvocations`, persisted messages, product state/API/DOM, and/or audit evidence. Title-only, registry-only, URL-only, and static PASS checks are not acceptable.
- Add the repeatability subset for S1, S8, S23, S36, and S57 in fresh temp projects with normalized stable outcomes.

### Findings file: `../saivage-e2e-checkers/e2e/analyst/findings/findings.md`

Current inventory:

- 11 lines total.
- States prior S9-S68 checks were placeholder/static and quarantined.
- Contains no actual PASS records for S1-S68.

Required implementation direction:

- Regenerate only from actual Playwright execution evidence.
- PASS for S1-S68 is valid only if produced by a run of the real suite, not hand-authored from the matrix.

## v3 routes, stack, and source truth available

### Analyst chat route

Inventory found the live chat routes in `src/server/routes/chats-files-debug.ts`:

- `GET /api/chats`
- `GET /api/chats/:sessionId`
- `POST /api/chats/:sessionId`

The web client wrappers are in `web/src/api/client.ts`:

- `listChatSessions()` -> `GET /api/chats`
- `getChatMessages(sessionId)` -> `GET /api/chats/:sessionId`
- `sendChatMessage(sessionId, content, workspaceContext?)` -> `POST /api/chats/:sessionId`

The checker fixture's `sendAnalystMessage` should continue posting to this real route.

### Real Analyst stack files

Relevant files identified:

- `src/agents/analyst-handler.ts` exports `AnalystHandler`.
- `src/agents/analyst-llm-resolver.ts` exports `LlmIntentResolver` and `TOOL_REGISTRY`.
- `src/agents/llm-client.ts` exports `LlmClient` with `complete(...)`.
- `src/agents/analyst-tool-schemas.ts` exports `ANALYST_TOOL_DEFINITIONS` and `ANALYST_TOOL_NAMES`.
- `src/agents/analyst-tools.ts` implements registered tool behavior.

Stage 010d PoC evidence showed this path can be driven by a localhost provider with no ambient auth copying.

### Observation routes already available

`src/server/routes/runtime-config-notes.ts` provides routes needed by Phase C helpers:

- `GET /api/control-actions` returns `{ control_actions, total }` and supports `card_id` and `since` query filters.
- `GET /api/agents/:id/conversation` returns `{ session, messages }` for an agent session.
- `GET /api/agents`, `GET /api/agents/:id`, and `GET /api/agents/:id/llm-exchange` are also present.

## Analyst tool registry inventory

`src/agents/analyst-tool-schemas.ts` currently advertises 38 tool names:

```text
mark_goal_needs_corrections
create_card
edit_card
move_card
delete_card
list_cards
get_card
get_tree
get_plan_diary
get_card_output
get_status
list_card_history
get_card_history_entry
diff_card
start_project
stop_project
terminate_process
pause_runtime
resume_runtime
abort_goal_subtree
restart_card_or_subtree
restart_goal
queue_notification
reorder_child
navigate_workspace
navigate_back
show_config
restart_server
reconfigure
read_file
list_directory
run_shell_command
read_runtime_events
read_runtime_errors
read_control_actions
list_processes_tool
list_agent_sessions
read_agent_session
```

Absence check result: no tool name matched `/^(list_notifications|get_notification|acknowledge_notification|.*_ack)$/`.

Implementation gotchas:

- The published Stage 010 plan text sometimes names `reorder_children`, but the live registry exposes singular `reorder_child` with params `{ parentId, orderedChildIds }`.
- The published S7 text mentions `delete_card(target_id: <id>)`, but the live registry exposes `delete_card` with required `ids` array.
- The file/directory tools are named `read_file` and `list_directory`, not `list_files`.
- The process listing tool is `list_processes_tool`.
- The audit read tool is `read_control_actions`.

The deterministic provider and assertions should use the live registry names/parameter shapes, not stale names from earlier drafts.

## Ledger and baseline state

### Expected-breakage ledger

`SPEC/analyst-as-control-surface/PLAN/expected-breakage-ledger.md` is currently header-only under `## Open entries` with zero `### ` H3 entries.

### Baseline gates

`SPEC/analyst-as-control-surface/PLAN/baseline-gates.json` currently has four gates:

- `tsc-build`: `observed_exit_code: 0`, `failing_ids: []`
- `web-vite-build`: `observed_exit_code: 0`, `failing_ids: []`
- `web-vitest`: `observed_exit_code: 1`, 8 pre-recorded failing ids
- `analyst-e2e`: `observed_exit_code: 0`, `failing_ids: []`

Do not refresh `baseline-gates.json` until real S1-S68 validation and all final Stage 010 gates are green.

## Repository state observed

Checker repo `/work/saivage-e2e-checkers`:

- Branch: `main`
- Clean status at inventory time.
- HEAD: `a463bf7 [t5-revert-misleading-baseline-and-quarantine-synthetic-e2e] quarantine synthetic analyst e2e evidence`

v3 repo `/work/saivage-v3`:

- Branch: `master`
- HEAD: `37706f0 [t1-design-deterministic-analyst-e2e-strategy] update design report commit metadata`
- Many SPEC/PLAN and prior research paths are untracked in the working tree. This appears pre-existing and not created by this task. Coder should avoid confusing those untracked files with Stage 010e implementation changes.

## Deterministic provider implementation guidance

Use the Stage 010d validated pattern:

1. Fixture writes temp `.saivage/saivage.json` with local non-secret provider config only.
2. Provider id/model can follow the PoC shape, e.g. `deterministic_local` and `deterministic-analyst-test` (or equivalent agreed names).
3. Provider endpoint should be localhost loopback and OpenAI-chat-completions compatible if current v3 provider plumbing can use it.
4. Dummy token may be a clearly non-secret local test token only if schema requires an apiKey; do not read env vars or auth profile files.
5. Provider receives live `tools` array from `LlmIntentResolver` and conversation history.
6. Provider emits generic capability-level tool calls, then final text after tool results appear.
7. Provider must not branch on `S1`...`S68`, `scenarioId`, scenario titles, page URL, Playwright assertion names, or per-scenario expected tool-call arrays.
8. Add static/automated guard that scans provider source for prohibited S-number/scenario dispatch patterns.

Recommended checker support files:

- `e2e/analyst/fixtures/deterministic-analyst-provider.js`
- `e2e/analyst/fixtures/seeds.js`
- `e2e/analyst/fixtures/assertions.js`

## Validation commands to preserve

Use the Stage 010 plan/cookbook commands exactly for close-out. Key commands include:

```sh
npx tsc -p .
( cd web && npm run build )
npm test
( cd web && npx vitest run --reporter=json --outputFile=../../tmp/s10-H8-vitest.json )
( cd ../saivage-e2e-checkers && npm run test:analyst -- --reporter=json --output=../tmp/playwright-analyst-report.json )
```

Strict forbidden-token grep at close must cover only `mark_note_handled|list_notes|preview_hash`; `confirmed` is a manual audit, not a zero-hit gate.

## Issues and risks for implementation

1. Current executable analyst e2e is a quarantine guard only; there is no existing active S1-S68 implementation to repair incrementally.
2. Current fixture secret/config inheritance must be removed before meaningful deterministic testing can begin.
3. The published plan contains a few stale/analogous tool names; use live `ANALYST_TOOL_NAMES` and schemas for exact implementation.
4. Baseline currently still records eight `web-vitest` failures from S00; baseline refresh must wait until all real gates are green.
