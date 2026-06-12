# Phase-2 Review Metaplan (review-2026-05)

Companion documents:
[00-INDEX.md](00-INDEX.md), [00-SUBSYSTEM-MAP.md](00-SUBSYSTEM-MAP.md).
Per-issue final docs: F12 r5, F13 r5, F19 r5, F22 r2, F23 r2, F20 r3,
F14 r2, F15 r2, F17 r1, F18 r2, F21 r1, F16 r2 (all carrying an
`APPROVED.md` marker as of 2026-05-23).

## 1. Executive summary

- **Scope**: 12 Phase-2 audit findings (F12–F23) raised by the Checkers
  E2E audit on 2026-05-23 against `saivage-v3` running as
  `saivage-v3-getrich.service` on the LXC container `saivage-v3-getrich-v2`
  (`10.0.3.170`). Phase-1 findings F01–F11 remain out of scope.
- **What was vetted**: each issue went through a writer/reviewer
  dual-LLM loop (analysis → design → plan, multiple rounds until
  `APPROVED.md`). Three issues (F12, F13, F19) required five rounds each;
  the rest closed in 1–3 rounds. F12 is a closure-mode pointer to F13.
- **Cross-cutting subsystems touched**: `src/cards/` (card-store + history),
  `src/runtime/` (runtime + lifecycle + state machine + locks),
  `src/server/` (Fastify routes + operator contracts + availability),
  `src/agents/` + `src/config/` (planner role + model routing),
  `src/permissions/` (state-machine constants), and the matching
  `web/` SPA stores and fixtures. Phase-2 audit tooling under workspace
  `tmp/` is touched only by F16.
- **Architecture-first stance**: no backward-compatibility shims, no
  migration layers, no new docstrings/comments in untouched code.
  Outdated tests and on-disk fixtures are rewritten or deleted, not
  patched.

## 2. Scoring table

`Importance` (1=cosmetic, 5=blocks the deployment loop) and
`Transversality` (1=local, 5=touches multiple subsystems +
contracts + web) are reviewer-orchestrator estimates derived from the
approved analysis/design/plan trio.

| ID | Title | Importance | Transversality | Rationale |
| --- | --- | ---: | ---: | --- |
| F13 | Canonical hierarchy invariant drift (index ↔ by-id) | 5 | 5 | P1 architectural; rewrites `CardStore` (mutex + `withLock` + `applyMutation`), bumps schema (`entry_id`, `kind`), changes `CardStore.open` / `Runtime.open` / `ActiveRuntime.open` to async factories, slims the on-disk `.saivage/cards/` layout, fans into 17+ Jest specs and every web mock. |
| F12 | Card history endpoint returns empty | 5 | 4 | P1 acceptance contract; carries no independent implementation — fully absorbed into F13 r5 as an enumerated test list + live-probe gate. Closure flips when F13's `applyMutation` plus the eight numbered acceptance items go green. |
| F19 | Runtime pinned to a `failed` current card | 5 | 5 | P1 cross-cutting; introduces `RuntimeStateMachine`, deletes `Runtime._status`, routes every runtime-originating `cardStore` status writer through `await transitionCard`, exports `STARTABLE_STATES` / `RESTARTABLE_STATES`, adds the multiline `rg` writer gate (Part A + Part B). Blocks F20 and F23 residual. |
| F22 | Planner role has no default model list at boot | 4 | 3 | P1 boot-cycle bug; surgical (`src/config/`), but the failure mode keeps the service in a restart loop until fixed. Cleanly independent of the runtime/card-store stack — safest first batch. |
| F20 | Executor declares `failed` despite green artefacts | 4 | 4 | P2; composes on F19's executor terminal branch, widens `VALID_TRANSITIONS` with `needs_verification`, fixes the `markActivationComplete` mapper, fans into web fanout for the new lifecycle slot. |
| F23 | Orchestrator attempts illegal `failed → active` | 4 | 3 | P2; resolved primarily by F19 r5's `restart` decomposition. Residual = converting the `dispatchGoal` goal-activation site and deleting `CardStore.activateGoal`. |
| F14 | `/api/state` missing `projectRoot`/`projectId` | 3 | 3 | P3 contract drift; one schema, one handler, three web mocks, plus a redaction-channel regression test. Slot as filler. |
| F17 | No `GET /api/agents/:id` detail endpoint | 3 | 2 | P3 observability gap; one new route + one Jest spec + two doc edits. Filler. |
| F15 | `mcp.state="degraded"` when no MCP servers configured | 2 | 2 | P3 classification; widen enum with `idle`, branch in `buildServerAvailability`, mirror into web types. Filler. |
| F18 | `/api/runtime/status.pid === null` when service is up | 3 | 3 | P3 state-field fix; deletes persisted `pid` from `RuntimeState`, adds `readLiveLockHolder`, overlays `process.pid` at the route layer, ripples through four test fixtures. Filler. |
| F21 | `/api/cards/:id/diff` rejects `to=last` | 2 | 1 | P2 DX; one schema widening + one handler rewrite + six test cases. Smallest non-trivial item. |
| F16 | Seeded-improvement regex non-deterministic | 2 | 1 | P3 test-tooling only; edits `tmp/.../test-matrix.json` and the audit prompt. No Saivage build, no deploy. |

## 3. Sequencing constraints (binding)

These constraints are taken verbatim from the approved per-issue plans
and the orchestrator notes inside F13 r5 / F19 r5 / F20 r3 / F23 r2:

- **F13 BEFORE F19, F23 residual, F20.** F13 r5 rewrites `CardStore.open`
  to an async factory, makes `cardStore.setStatus` / `cardStore.update`
  awaited, and introduces the slim `.saivage/cards/` layout
  (`by-id`, `history`, `.commit`). F19, F23, and F20 all compose on
  awaited card-store calls.
- **F19 BEFORE F23 residual AND F20.** Both compose on the post-F19
  `RuntimeStateMachine` (`transitionCard`, `STARTABLE_STATES`,
  `RESTARTABLE_STATES`, executor terminal branch). F23 r2 §Ordering and
  F20 r3 §P8 hard-pin this.
- **F22 is independent.** Fail-fast hook lives in
  [src/config/environment.ts](../../../src/config/environment.ts), one layer
  above any `ActiveRuntime.open` question. Safe to land first.
- **F20 AFTER F19.** Uses the post-F19 collapsed executor-terminal block
  (the L725–L744 site referenced across F19 r5 Step 5 and F20 r3 Step S3).
- **F23 AFTER F19.** Residual work is the `dispatchGoal` goal-activation
  conversion plus deleting `CardStore.activateGoal`; both rely on
  `await transitionCard(..., 'start' | 'restart', …)`.
- **F12 is closure-mode under F13.** F12 r5 §(a) and the F13 r5
  "Absorbed F12 acceptance shape" section couple them. F12 ships no
  separate diff; closure is the eight enumerated tests + the F12 live
  probe.
- **F14, F15, F17, F18, F21, F16 are orthogonal** to the
  runtime/card-store stack. They slot as fillers between heavy batches.

## 4. Cross-cutting risks

- **Same-file churn on `src/cards/card-store.ts`**: F13 rewrites it
  (constructor → `private`; `applyMutation` + `ProjectMutex` +
  commit-marker; `VALID_TRANSITIONS` at L217–L227 is the source of
  truth for state-machine edges). F20 r3 §S2 appends one edge
  (`running → needs_verification`) and one new row
  (`needs_verification: ['cancelled']`) to the same constant. F23 r2
  deletes `CardStore.activateGoal`. **Mitigation**: F13 lands first;
  F20 and F23 rebase against the merged F13 state; both gates target
  the F13-renumbered line range.
- **Same-file churn on `src/runtime/runtime.ts`**: F18 deletes
  `RuntimeState.pid` reads, F19 deletes `Runtime._status` + every
  inline `updateRuntimeState({...})` blob + adds the
  `await transitionCard` per-site checklist, F20 r3 §S3 rewrites the
  executor-terminal block again. **Mitigation**: F19 r5 Step 7's
  multiline `rg` Part A + Part B gate catches every regression on
  this file; F20 r3 §S3 keeps that gate green by structure.
- **`src/contracts/operator-api.ts` churn**: F13 r5 tightens
  `CardHistoryListResponseSchema` / `CardHistoryEntryResponseSchema`,
  F14 r2 adds `projectRoot` + `projectId` to
  `RuntimeGetStateResponseSchema`, F15 r2 widens
  `AvailabilityStateSchema`, F21 r1 replaces `CardDiffQuerySchema`.
  **Mitigation**: contracts batch (Batch 5) groups F14/F15/F17; F13
  contract edits land inside the F13 train; F21 stands alone.
- **`web/` mocks ripple**: F13 (every history fixture gets
  `entry_id` + `kind`), F14 (`runtime-store.test.ts`,
  `api-client-contracts.test.ts`, `operator-dashboard-smoke.test.ts`),
  F15 (`api/types.ts`), F20 (every consumer of card status).
  **Mitigation**: each batch runs the `web:test:*` scripts named in
  its plan; the SFC corruption guard (`grep -c '<script setup>'`)
  runs before every web build per the user-memory rule.

## 5. Validation strategy

### Per-batch baseline

Every batch except F16 runs the standard host-side gate before
SSH-restarting the service on `10.0.3.170`:

```
cd /home/salva/g/ml/saivage-v3
npm run typecheck
npm run lint
npm run build                                       # tsc + tsup
NODE_OPTIONS=--experimental-vm-modules npx jest <plan-listed targets> --runInBand --forceExit
(cd web && npx vitest run <plan-listed targets>)    # or npm run web:test:<...>
npm run docs:verify
```

Per-batch additions are listed in §6.

### Cumulative regression

After every batch is merged, run the full backend + web sweep before
the SSH restart:

```
cd /home/salva/g/ml/saivage-v3
npm test                                            # full Jest suite
(cd web && npm run build && npx vitest run)
npm run preflight                                    # web:test:sweep + docs:verify
npm run validate:release                             # F13 r5 §Validation baseline
```

### Live probe set

Identical for every batch that ships to the LXC harness:

```
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service && systemctl is-active saivage-v3-getrich.service'
curl -fsS --max-time 5 http://10.0.3.170:8080/health
curl -fsS --max-time 5 http://10.0.3.170:8080/health/ready
```

Batch-specific live probes (e.g., F19 Probe-C tailing
`errors.jsonl`, F22 broken-config fail-fast, F18 PID-equality
against `systemd MainPID`) are listed inside their respective plans.

## 6. Suggested batch order

Batches are intentionally small and topical, respecting all binding
constraints in §3.

### Batch 1 — F22 (config fail-fast, independent safety net)

- **Issues**: F22.
- **Files / subsystems**:
  [src/config/validate-model-roles.ts](../../../src/config/validate-model-roles.ts) (new),
  [src/config/environment.ts](../../../src/config/environment.ts) (around L177–L228),
  [src/config/index.ts](../../../src/config/index.ts),
  [src/agents/config-schema.ts](../../../src/agents/config-schema.ts) (resolver throw at ~L427 stays as defence-in-depth),
  new specs `tests/config/validate-model-roles.test.ts`,
  `tests/runtime/boot-missing-role.test.ts`.
- **Primary risks**: the fail-fast hook must run **before** `deepFreeze`
  and **before** `startServer`, otherwise `saivage-v3-getrich.service`
  still binds an HTTP port on a broken config. Defence-in-depth invariant
  at `config-schema.ts:427` must stay byte-identical (no new comment).
- **Validation**:
  ```
  cd /home/salva/g/ml/saivage-v3
  npm run typecheck && npm run lint
  npm run test:direct -- tests/config/validate-model-roles.test.ts tests/runtime/boot-missing-role.test.ts
  npm run test:direct
  npm run build
  ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service && sleep 2 && systemctl is-active saivage-v3-getrich.service'
  curl -fsS --max-time 3 http://10.0.3.170:8080/health
  # operator-supervised broken-config probe (agent does not touch saivage.json):
  ssh root@10.0.3.170 'journalctl -u saivage-v3-getrich.service -n 30 --no-pager'   # expect missing-role diagnostic on broken boot
  ```
- **Rollback**: `git revert` of the batch commit; `npm run build`
  on host; `ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service'`.
  No on-disk state migration. The bind mount makes the rebuilt
  `dist/` visible inside the container immediately.

### Batch 2 — F13 + F12 (card-store rewrite + history closure)

- **Issues**: F13, F12 (F12 ships zero independent diff; F13 r5
  carries the "Absorbed F12 acceptance shape" eight tests + live
  probe).
- **Files / subsystems**:
  [src/cards/card-store.ts](../../../src/cards/card-store.ts),
  [src/cards/apply-mutation.ts](../../../src/cards/apply-mutation.ts) (new),
  [src/cards/project-mutex.ts](../../../src/cards/project-mutex.ts) (new),
  [src/cards/commit-marker.ts](../../../src/cards/commit-marker.ts) (new),
  [src/cards/state.ts](../../../src/cards/state.ts) (new),
  [src/persistence/file-tree.ts](../../../src/persistence/file-tree.ts),
  [src/persistence/jsonl-ledger.ts](../../../src/persistence/jsonl-ledger.ts),
  [src/schemas/types.ts](../../../src/schemas/types.ts) (L55 — add `CardHistoryKind`),
  [src/schemas/validators.ts](../../../src/schemas/validators.ts) (L23 — `cardHistoryEntryBaseSchema`),
  [src/contracts/operator-api.ts](../../../src/contracts/operator-api.ts) (L156–L158 — tightened response schemas),
  [src/runtime/active-runtime.ts](../../../src/runtime/active-runtime.ts) (async `open` factory),
  [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) (async `open` factory + every `new CardStore` call site converted),
  [src/server/server.ts](../../../src/server/server.ts) (server construction gated on async factories),
  [src/agents/analyst-tools.ts](../../../src/agents/analyst-tools.ts) (drop `TRACKED_EDIT_FIELDS`),
  [web/src/api/types.ts](../../../web/src/api/types.ts) (L240/L251/L789),
  [web/src/stores/cards.ts](../../../web/src/stores/cards.ts),
  every web `__tests__/` history fixture and mock,
  and the 17+ Jest specs enumerated in F13 r5 §Validation baseline.
- **Primary risks**: largest batch by file count; the slim cards
  layout (`cards/by-id`, `cards/history`, `cards/.commit`)
  intentionally drops `cards/views`, `cards/tree`,
  `cards/dependencies`, and `cards/index.json`. Local
  `.saivage/` state from prior runs is incompatible — operators must
  reset (`rm -rf .saivage/`) before the new binary boots in a dev
  env. Async-constructor fanout (`rg -n 'new CardStore\(|new Runtime\(|new ActiveRuntime\('`)
  must return zero matches outside the dedicated test-helper
  factories. Crash-injection matrix is part of the acceptance bar
  (F13 r5 §Crash-injection test matrix).
- **Validation**:
  ```
  cd /home/salva/g/ml/saivage-v3
  npm run typecheck
  npm run lint
  npm run test:direct -- tests/utils/card-store.test.ts tests/utils/card-history.test.ts \
    tests/utils/card-store-startup-refusal.test.ts tests/utils/card-store-state.test.ts \
    tests/utils/apply-mutation.test.ts tests/utils/card-store-crash-injection.test.ts \
    tests/utils/card-store-boot-recovery.test.ts tests/utils/file-tree.test.ts \
    tests/projections/ledger-projections.test.ts tests/persistence/persistence-primitives.test.ts \
    tests/api/cards-history.test.ts tests/agents/card-history-tools.test.ts \
    tests/server/card-routes-authz-audit.test.ts tests/server/runtime-card-contract-routes.test.ts \
    tests/server/operator-api-contracts.test.ts tests/server/operator-api-contract-fixtures.test.ts \
    tests/server/websocket-analyst-safety.test.ts tests/server/server-availability-contract.test.ts \
    tests/runtime/runtime-activation-ledger.test.ts tests/runtime/runtime-command-ledger.test.ts \
    tests/schemas.test.ts tests/utils/project-mutex.test.ts
  npm run docs:verify
  npm run web:typecheck
  npm run web:test:control-room
  npm run web:test:store:cards
  npm run web:test:analyst-ui
  npm run web:test:operator-smoke
  npm run web:test:card-history-panel        # new script added in this batch
  npm run preflight
  npm test
  npm run validate:release
  ```
  Then host build + SSH restart of `saivage-v3-getrich.service` and
  the F12 live probe enumerated at the bottom of
  [F12 r5 §(c)](F12-card-history-empty/03-plan-r5.md): mutate a card,
  assert `history.total >= card.version_seq - 1`,
  `max(history[].version_seq) === card.version_seq - 1`, every row
  carries a UUID-shape `entry_id` and a `kind` in the six-value
  enum, and the per-seq header endpoint matches the row envelope.
- **Rollback**: `git revert` of the batch commit, host
  `npm run build`, SSH restart. Dev environments must `rm -rf .saivage/`
  to re-seed because the on-disk history schema changes — there is no
  bidirectional shim.

### Batch 3 — F19 (RuntimeStateMachine)

- **Issues**: F19.
- **Files / subsystems**:
  [src/runtime/state-machine.ts](../../../src/runtime/state-machine.ts) (new),
  [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) (delete `_status`, delete `safeTick`, delete `mirrorRuntimeState`, route every `cardStore.setStatus` / status-bearing `cardStore.update` through `await transitionCard`),
  [src/runtime/control.ts](../../../src/runtime/control.ts) (replace `mirrorRuntimeState` callers),
  [src/permissions/card-permissions.ts](../../../src/permissions/card-permissions.ts) (L28–L29 — export `STARTABLE_STATES`, `RESTARTABLE_STATES`),
  [src/schemas/types.ts](../../../src/schemas/types.ts) + [src/schemas/validators.ts](../../../src/schemas/validators.ts) (add `last_tick_at: string | null`),
  [src/server/server.ts](../../../src/server/server.ts) (expose `lastTickAt` on both branches of `/api/runtime/status`),
  new specs under `tests/runtime/` (`state-machine.test.ts`,
  `state-machine-wired.test.ts`, `runtime-state-last-tick-at.test.ts`,
  `executor-done.test.ts`, `executor-failed.test.ts`,
  `executor-done-evidence-registration-failure.test.ts`,
  `executor-failure-recovery.test.ts`, `restartable-states.test.ts`).
- **Primary risks**: tick interval interacts with planner
  long-running calls; operator-API restart can race the runtime
  auto-restart; F13 merge order must hold (rebase risk). I1–I3
  corrective bodies land in Step 4, not Step 6 (design/plan parity
  required). Multiline `rg` writer gate Part A + Part B (F19 r5 §Step 7)
  must report zero offenders, and the L644 / L645 / L663 allowlist
  must dispose of the nested `result: { planning: { status: … } }`
  false-positives only.
- **Validation**:
  ```
  cd /home/salva/g/ml/saivage-v3
  npm run typecheck
  NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime --runInBand --forceExit
  npm test
  npm run web:test:operator-smoke
  npm run docs:verify
  # F19 r5 §Step 7 gate (committed to CI / prepush)
  rg -nU --multiline 'cardStore\.update\([^)]{0,400}\bstatus\s*:' src/runtime/runtime.ts | rg -v ':(644|645|663):'
  rg -n 'cardStore\.setStatus\(' src/runtime/runtime.ts                                      # expect zero matches
  rg -n '\bcardStore\.update\(' src/runtime/runtime.ts | rg -v '\bawait\s+(this\.)?cardStore\.update\('  # expect zero matches
  rg -n "enforceInvariants|as Partial<RuntimeState> as never|this\._status\s*=|mirrorRuntimeState|safeTick|_safeTickInFlight|_autoDispatchFirstBacklogGoal" src/runtime/runtime.ts   # expect zero matches
  ```
  Live: host build + SSH restart, then **Probe-A** (pause/resume drift),
  **Probe-B** (`lastTickAt` advances), **Probe-C**
  (`tail -n 200 .saivage/runtime/errors.jsonl | grep "Invalid transition: failed"`
  returns empty). Probe-D is informational only.
- **Rollback**: `git revert` of the batch commit + redeploy. The
  on-disk `RuntimeState.last_tick_at` field is additive; reverting
  leaves a stray `last_tick_at` key in the persisted JSON that a
  pre-F19 build will simply ignore on parse.

### Batch 4 — F20 + F23 (executor terminal branch + needs_verification + dispatchGoal residual)

- **Issues**: F20, F23 residual.
- **Files / subsystems**:
  [src/cards/card-store.ts](../../../src/cards/card-store.ts) (L217–L227 — `VALID_TRANSITIONS` widened with `'running → needs_verification'` and `'needs_verification → cancelled'`; `activateGoal` at L1097–L1105 deleted),
  [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) (executor-terminal block restructured per F20 r3 §S3 — `registrationFailed` / `fallback_with_evidence` / `executor_finish` vs. `executor_partial_finish`; mapper at L172–L173 widened; `dispatchGoal` at L621 routed through `await transitionCard(..., STARTABLE_STATES.includes(...) ? 'start' : 'restart', …)`),
  [src/runtime/state-machine.ts](../../../src/runtime/state-machine.ts) (`RuntimeCardAction` adds `'executor_partial_finish'`),
  ExecutorResult / `ActivationCompletionOutcome` schemas (widen with `'needs_verification'`),
  web fanout for the new status slot,
  new specs `tests/runtime/f23-errors-jsonl-clean.test.ts`,
  `tests/runtime/f23-planner-set-status-failed-active.test.ts`,
  `tests/runtime/f23-goal-activation-failed.test.ts`,
  and the F20 r3 §P1–§P4 test additions.
- **Primary risks**: must rebase cleanly on F13 + F19; the
  executor-terminal block is the most-rewritten function in the
  review, and F20 r3 §S3 explicitly forbids double-completion
  (`markActivationComplete` is called internally by
  `appendChildUnwindToolResult` — only one call survives). The F19
  Step 7 gate must remain green after F20's restructure. `rg -n "activateGoal" src/ tests/`
  must return zero matches after Batch 4.
- **Validation**:
  ```
  cd /home/salva/g/ml/saivage-v3
  npm run typecheck && npm run lint
  NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/state-machine.test.ts tests/runtime/executor-done.test.ts tests/runtime/executor-failed.test.ts tests/runtime/f23-*.test.ts --runInBand --forceExit
  npm test
  (cd web && npx vitest run)            # F20 r3 §P4 web fanout
  npm run docs:verify
  rg -n "activateGoal" src/ tests/      # expect zero matches
  ```
  Live: host build + SSH restart, then F19 r5 Probe-C against
  `errors.jsonl` (same probe covers F23 residual), and the
  informational `api/state` jq filter for the new
  `needs_verification` lifecycle slot per F20 r3 §P6.
- **Rollback**: `git revert` of the batch commit + redeploy. No
  on-disk schema migration; the new `needs_verification` status
  literal disappears from `VALID_TRANSITIONS` and the few persisted
  records (if any) become unreadable by the reverted binary —
  acceptable per architecture-first stance; operators reset
  `.saivage/cards/` in dev envs if hit.

### Batch 5 — API contracts (F14 + F15 + F17)

- **Issues**: F14, F15, F17.
- **Files / subsystems**:
  [src/contracts/operator-api.ts](../../../src/contracts/operator-api.ts) (L105 — widen `AvailabilityStateSchema`; L132 — add `projectRoot` + `projectId`),
  [src/server/availability.ts](../../../src/server/availability.ts) (L85–L95 — emit `idle` from the empty-MCP branch),
  [src/server/routes/operator-contracts.ts](../../../src/server/routes/operator-contracts.ts) (compute `projectId = basename(projectRoot)` once; project both fields in both `runtime.getState` branches),
  [src/server/routes/runtime-config-notes.ts](../../../src/server/routes/runtime-config-notes.ts) (new `GET /api/agents/:id` handler + `lastMessageTimestamp` helper),
  [src/workspace/file-access-security.ts](../../../src/workspace/file-access-security.ts) (regression test only — no source change),
  [web/src/api/types.ts](../../../web/src/api/types.ts) (L550 — add `'idle'` literal),
  [web/src/stores/runtime.ts](../../../web/src/stores/runtime.ts) (add reactive `projectRoot` / `projectId`; reset on 401; keep `unavailable` / `degraded` label branches),
  new specs `tests/server/operator-state-identity.test.ts`,
  `tests/server/agents-detail-route.test.ts`, plus extensions to
  `tests/utils/file-access-security.test.ts`,
  `tests/server/server-availability-contract.test.ts`,
  `tests/server/operator-api-contracts.test.ts`, and the three web
  vitest mocks under `web/src/__tests__/` named in F14 r2 / F15 r2.
- **Primary risks**: three independent route/contract changes
  bundled to amortise the SSH restart cost; each must keep
  `npm run docs:verify` green (the operator-routes table has line
  anchors per route). The F14 `projectRoot` field on success must
  not erode the error-message redaction
  (`redactOperatorErrorMessage(message, projectRoot)` regression test
  is part of the batch).
- **Validation**:
  ```
  cd /home/salva/g/ml/saivage-v3
  npm run build && npm run lint && npm run typecheck
  NODE_OPTIONS=--experimental-vm-modules npx jest \
    tests/server/operator-state-identity.test.ts \
    tests/server/agents-detail-route.test.ts \
    tests/server/server-availability-contract.test.ts \
    tests/server/operator-api-contracts.test.ts \
    tests/utils/file-access-security.test.ts \
    --runInBand --forceExit
  NODE_OPTIONS=--experimental-vm-modules npx jest tests/server --runInBand --forceExit
  (cd web && npm run build && npx vitest run \
     src/__tests__/api-client-contracts.test.ts \
     src/__tests__/runtime-store.test.ts \
     src/__tests__/operator-dashboard-smoke.test.ts)
  npm run docs:verify
  ```
  Live: host build + SSH restart, then
  `curl http://10.0.3.170:8080/api/state | jq '.projectRoot, .projectId'`,
  `curl http://10.0.3.170:8080/api/mcp/status | jq '.serverAvailability.components.mcp'` (expect `state: "idle"`, `diagnostic.code: "mcp-manager-empty"`),
  and `curl http://10.0.3.170:8080/api/agents/<id>` against a real
  session id (expect 200 with `message_count` + `last_activity_at`,
  no payload).
- **Rollback**: `git revert` of the batch commit + redeploy. Web
  callers tolerate missing `projectRoot` / `projectId` because the
  Vue store seeds them to `null`; the `'idle'` enum disappears and
  consumers fall back to the existing `unknown` label branch.

### Batch 6 — Local / tooling (F18 + F21 + F16)

- **Issues**: F18, F21, F16.
- **Files / subsystems**:
  [src/schemas/types.ts](../../../src/schemas/types.ts) (L94 — drop `pid` from `RuntimeState`),
  [src/schemas/validators.ts](../../../src/schemas/validators.ts) (L115 — drop from `runtimeStateSchema`),
  [src/runtime/state.ts](../../../src/runtime/state.ts) (L82 — drop seed `pid`),
  [src/runtime/runtime.ts](../../../src/runtime/runtime.ts) (three `updateRuntimeState` blobs at L609 / L612 / L613 lose `pid`),
  [src/runtime/lock.ts](../../../src/runtime/lock.ts) (add `readLiveLockHolder` reusing the existing `lockPath` helper at L31–L36),
  [src/server/server.ts](../../../src/server/server.ts) (L64 — overlay `pid: process.pid` in both `/api/runtime/status` branches),
  [src/server/routes/chats-files-debug.ts](../../../src/server/routes/chats-files-debug.ts) (L307 — overlay in `/api/debug/state`),
  [src/cli.ts](../../../src/cli.ts) (`handleStatus` reads `readLiveLockHolder`),
  [src/contracts/operator-api.ts](../../../src/contracts/operator-api.ts) (L155 — replace `CardDiffQuerySchema` with `diffPivotSchema` union accepting `'last' | 'current' | <positive int>`),
  [src/server/routes/operator-contracts.ts](../../../src/server/routes/operator-contracts.ts) (L135–L146 — rewrite the `cards.diff` handler),
  [tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json](../../../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json) (T35/T38/T39/T42 structural rewrites),
  [prompts/saivage-v3-checkers-e2e-testing-instance.md](../../../../prompts/saivage-v3-checkers-e2e-testing-instance.md) (matrix-authoring rule),
  fixture cleanups in `tests/agents/planner-control-executor.test.ts`,
  `tests/server/generated-file-inspection.test.ts`,
  `tests/api/cards-history.test.ts`,
  `tests/utils/runtime-state-layout.test.ts`,
  and new specs `tests/server/runtime-status-pid.test.ts`,
  `tests/server/debug-state-pid.test.ts`,
  `tests/schemas/runtime-state-pid.test.ts`.
- **Primary risks**: F18 fixture cleanup must catch every persisted
  `RuntimeState` literal (`grep RuntimeState.*pid|pid: process\.pid`
  in `src/` returns only `FreezeManifest` hits and the lock file
  after the batch). F21 keeps the existing 400-for-non-integer
  contract green (`?from=a&to=2` still rejected). F16 touches no
  Saivage runtime code — no SSH restart, no `/health` probe.
- **Validation**:
  ```
  cd /home/salva/g/ml/saivage-v3
  npm run build
  NODE_OPTIONS=--experimental-vm-modules npx jest \
    tests/server/runtime-status-pid.test.ts \
    tests/server/debug-state-pid.test.ts \
    tests/schemas/runtime-state-pid.test.ts \
    tests/server tests/api/cards-history.test.ts \
    tests/agents/planner-control-executor.test.ts \
    tests/utils/runtime-state-layout.test.ts \
    tests/utils/runtime-integration.test.ts \
    --runInBand --forceExit
  npm run docs:verify
  # F16: matrix JSON validity + structural checks
  python3 -c "import json; json.load(open('../../tmp/saivage-v3-checkers-e2e-artifacts-20260523-phase2/test-matrix.json'))"
  ```
  Live (F18 + F21 only; F16 ships nothing to the harness): host
  build + SSH restart, then PID equality probe per F18 r2 (`/api/runtime/status.pid` and `/api/debug/state.runtime.pid`
  match `systemd MainPID` and change in lockstep across restarts);
  F21 live diff probes per F21 r1 Step 2 (`?from=1&to=last`,
  `?to=last`, no params, `?from=a&to=2 → 400`, `?from=0&to=last → 400`).
- **Rollback**: `git revert` of the batch commit + redeploy. The
  persisted-`pid` removal is forward-only — a reverted build will
  parse the now-pid-less `runtime.json` and seed `process.pid` on
  next mutation; no manual cleanup required. F16's tooling-only
  edits roll back with `git checkout` on the affected `tmp/` /
  prompt files.

## 7. Global rules (apply to every batch)

- **Architecture-first, no backward-compatibility shims.** Outdated
  data structures, on-disk formats, configs, and tests are removed
  rather than wrapped.
- **No new docstrings or comments in untouched code.** Per workspace
  guideline and reproduced in F19 r5, F20 r3, F22 r2, F23 r2 plans.
- **No `rsync`, no in-container build, no token reads.** All deploy
  via host `npm run build` + SSH restart on `10.0.3.170`. The
  container bind-mounts the host `dist/`.
- **VS Code Vue SFC corruption guard** before every web build
  (`grep -c '<script setup>'` on every edited `.vue`; any file with
  count > 1 is corrupted) — see the user-memory note
  `vue-sfc-corruption.md`.
- **Single rollback shape**: `git revert` of the batch commit on
  host + `npm run build` + SSH restart of
  `saivage-v3-getrich.service`. Dev environments that depended on
  the on-disk slim cards layout (Batch 2) require
  `rm -rf .saivage/` to re-seed; production `getrich-v2` is
  managed separately by the operator per workspace handoff.

## 8. Per-batch rollback decision tree

For every batch, the rollback path is the same shape:

1. `cd /home/salva/g/ml/saivage-v3 && git revert <batch commit>`.
2. `npm run build` on host.
3. `ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service && systemctl is-active saivage-v3-getrich.service'`.
4. `curl -fsS --max-time 5 http://10.0.3.170:8080/health`.
5. If the reverted batch shipped a schema/format change (Batch 2
   slim cards layout; Batch 3 `last_tick_at`; Batch 4 `VALID_TRANSITIONS`
   widening; Batch 6 persisted-`pid` removal), dev environments may
   need `rm -rf .saivage/` to re-seed; production state on
   `getrich-v2` is operator-managed.

This is the only rollback mechanism. No bidirectional shims, no
"feature flag off", no on-disk migration runner.
