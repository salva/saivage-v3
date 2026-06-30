# Runtime Actor State Simplification

Status: proposed architecture and implementation plan.

Last updated: 2026-06-30.

## 1. Problem

Saivage v3 currently represents runtime lifecycle through overlapping fields:

- `runtime.status`, currently using values such as `idle`, `running`, `paused`, and `error`.
- `runtime.paused`, a boolean scheduling gate.
- `runtime.runtime_intent.status`, which can represent requested or projected intent such as `stopped`.
- `runtime.active_card_run`, which represents active execution detail.

This creates contradictory states. A stopped project can currently project as:

```json
{
  "status": "idle",
  "paused": false,
  "runtime_intent": { "status": "stopped" },
  "active_card_run": null
}
```

That state is safe for Analyst card mutation, but the current Analyst mutation guard only accepts `paused === true`. The result is a false denial: a stopped project is treated as unsafe because it is not also marked paused.

The deeper issue is not the guard. The deeper issue is that runtime lifecycle is not represented by one authoritative actor state.

## 2. Design Goal

Represent the Saivage runtime as one actor with one authoritative lifecycle status.

The runtime is the actor. Cards are the work targets. Agent sessions and processes are execution details owned by the runtime. Runtime lifecycle should not be inferred from a combination of `status`, `paused`, `runtime_intent`, and active-run fields.

The target model should make these questions trivial:

- Is the runtime allowed to start autonomous work?
- Is the runtime actively executing work?
- Can the Analyst mutate card records safely?
- What should the operator UI display?
- Which transitions are valid?

## 3. Target Runtime Status Vocabulary

Use one authoritative status field:

```ts
type RuntimeStatus =
  | 'stopped'
  | 'running'
  | 'paused'
  | 'error';
```

The field should remain named `status` rather than being renamed to `state`. The name is already used in API contracts and avoids awkward objects such as `runtime.state.state`. The improvement is the vocabulary and semantics, not a cosmetic rename.

### 3.1 Status Meanings

| Status | Meaning | Can Analyst Mutate Cards? | Active Card Run? |
| --- | --- | --- | --- |
| `stopped` | Runtime is not executing autonomous project work and will not schedule work until explicitly started. This includes initial project state and natural completion. | Yes | No |
| `running` | Runtime is executing or dispatching autonomous work. | No | Yes while a card is dispatched |
| `paused` | Runtime admission is closed at a safe point. Existing long-running processes may still exist, but no new model/provider turns are admitted. | Yes, subject to card/subtree rules | No (in-flight turns drain at the safe point) |
| `error` | Runtime infrastructure is in an unrecoverable or operator-actionable error state. Card-level failures are not runtime `error`. | No | Maybe, depending on failure point |

`idle` is removed. Whether a live runtime process currently has a card dispatched is execution detail, not a lifecycle status. If the runtime will not schedule work, it is `stopped`. If it may schedule work, it is `running`.

## 4. Fields To Remove Or Demote

### 4.1 Remove `paused` As Lifecycle Authority

Remove `runtime.paused` from the canonical runtime state. Pause is represented by status `'paused'` and nothing else. No projection, derived field, or compatibility shim for `paused` is added. Internal permission and scheduling logic read `runtime.status` only.

### 4.2 Remove `runtime_intent`

Remove `runtime_intent` entirely. It must not represent current lifecycle or pending transitions. The current lifecycle is `runtime.status`. Control commands are recorded in the `runtime_commands` ledger as history, not as state authority. There is no pending-command field.

### 4.3 Keep Execution Detail Separate

Keep `active_card_run`, runtime run ledger, activation ledger, command ledger, and process records. They are execution detail and history, not separate lifecycle authorities.

## 5. Invariants

The implementation must enforce these invariants at runtime-state write boundaries and in tests.

### 5.1 Lifecycle Authority

`runtime.status` is the only current lifecycle authority.

No permission guard, scheduler gate, UI badge, or runtime read model should infer lifecycle from a combination of fields when `runtime.status` is available.

### 5.2 Active Run Consistency

The enforced invariant is:

```ts
if (runtime.status === 'stopped' || runtime.status === 'paused') {
  assert(runtime.active_card_run === null);
}
```

The persisted runtime state never combines `stopped`/`paused` with a non-null active card run. A `running` runtime may transiently have no dispatched card between scheduling steps; that transient is not persisted. Contradictory persisted combinations fail fast at the write boundary.

### 5.3 Runtime Error Scope

`runtime.status === 'error'` means the runtime infrastructure is unhealthy or cannot safely continue. It does not mean a card failed.

Card failure remains card lifecycle state. Runtime error is reserved for runtime-level failures such as unrecoverable persistence errors, corrupted runtime state, or fatal dispatcher invariants.

### 5.4 Mutation Safety

Analyst card mutation is allowed only when the runtime actor is not admitting autonomous work:

```ts
function canAnalystMutateCards(runtime: RuntimeState): boolean {
  return runtime.status === 'stopped' || runtime.status === 'paused';
}
```

This is only the global runtime gate. Existing card/subtree permission rules still apply. For example, structural deletion of running subtrees remains denied unless a later design explicitly allows it.

## 6. Transition Model

Transitions should be explicit and invalid transitions should fail loudly. Silent no-ops hide bugs and recreate contradictory state.

```text
stopped  --start_project-->  running
running  --pause_runtime-->  paused
paused   --resume_runtime--> running
running  --stop_project-->   stopped
paused   --stop_project-->   stopped
error    --stop_project-->   stopped
running  --fatal_error-->     error
paused   --fatal_error-->     error
```

Invalid examples:

```text
stopped --pause_runtime--> invalid
stopped --resume_runtime--> invalid
paused  --start_project--> invalid; use resume_runtime
running --start_project--> invalid; already running
```

The operator UI may offer friendly labels, but the runtime API should return explicit conflict errors for invalid transitions.

## 7. Stop, Pause, And Shutdown Semantics

The existing language mixes stop, pause, and shutdown. The simplified model should make them distinct.

### 7.1 Pause

Pause is a reversible admission gate.

- It stops new LLM/provider calls at the next safe point.
- It does not imply project cancellation.
- It does not imply process termination.
- Analyst card mutation is allowed while `stopped`, and while `paused` after the safe point.

### 7.2 Stop

Stop leaves autonomous project execution. It is synchronous: on `stop_project` the runtime closes admission, cancels the active card run, and terminates runtime-owned processes, then transitions directly to `stopped`. From `paused` and `error` the transition to `stopped` is immediate since no active work is admitted.

Stop does not distinguish "graceful" and "forced". If an active LLM turn is in flight, it is aborted; if a managed process is running, it is terminated. The runtime records what was cancelled/terminated so the operator can see the outcome, but no intermediate lifecycle state exists.

### 7.3 Shutdown

Shutdown remains the hard operation for service/process termination. It may terminate runtime-owned processes and possibly restart or stop the server service. It is not the same as `stop_project`.

## 8. Initialization And Root Project Card

Project initialization should create both:

- A root project card.
- Runtime state with `status: 'stopped'`.

This removes the special Analyst bootstrap exception for a missing root project card.

The previous Analyst path allowed creating the first root project card without a safe stopped/paused runtime. That was a wart caused by incomplete initialization. The target behavior is:

- `saivage init` or runtime first-run setup creates the root `project` card.
- The Analyst updates the existing root card brief/objective while runtime status is `stopped` or `paused`.
- `create_card` with `type: 'project'` and `parent: null` becomes a conflict because the root already exists.

The root project card remains special as the root of the card tree, but not as a missing bootstrap object.

## 9. Public API And UI Semantics

Runtime read models should expose one lifecycle field:

```json
{
  "runtime": {
    "status": "stopped",
    "active_card_run": null
  }
}
```

No compatibility fields for `paused` or `runtime_intent` are projected. The operator UI displays exactly one runtime lifecycle badge using the new vocabulary:

- Stopped
- Running
- Paused
- Error

## 10. Revised Analyst Mutation Gate

The current paused-only gate should be replaced with a runtime-status gate.

Old rule:

```ts
runtime.paused === true
```

New rule:

```ts
runtime.status === 'stopped' || runtime.status === 'paused'
```

Error messages should say exactly what state is required and what state was observed:

```text
create_card requires runtime status stopped or paused before the Analyst mutates card state. Current runtime status is running.
```

This avoids misleading messages that tell the user to pause a stopped project.

## 11. Implementation Plan

### Phase 1: Specification And Tests First

1. Update `docs/spec/system-specification.md` to replace paused-only Analyst mutation language with stopped-or-paused language.
2. Update `docs/spec/operator-ui.md` to use the new runtime status vocabulary.
3. Update architecture references that mention `idle`, `paused` boolean semantics, or `runtime_intent.status` as lifecycle authority.
4. Add failing tests for:
   - Analyst can create child cards when runtime status is `stopped`.
   - Analyst can mutate supported card records when runtime status is `paused`.
   - Analyst cannot mutate cards when runtime status is `running` or `error`.
   - Stopped runtime does not require `pause_runtime` before card mutation.
   - Invalid transitions fail loudly.

### Phase 2: Runtime Schema Refactor

1. Change `RuntimeStatus` schema from `idle | running | paused | error` to `stopped | running | paused | error`.
2. Remove `paused` from canonical `RuntimeState`.
3. Remove `runtime_intent` entirely.
4. Keep command/run ledgers as history only.
5. Enforce the active-run invariant at runtime-state write boundaries (fail fast on contradictory persisted state).
6. Ensure project initialization writes `status: 'stopped'`.

### Phase 3: Runtime Supervisor And Control Tools

1. Update `start_project`:
   - Accept only `stopped`.
   - Transition to `running`.
   - Reject `paused` with guidance to use `resume_runtime`.
   - Reject `running` as a conflict.
2. Update `pause_runtime`:
   - Accept only `running`.
   - Transition to `paused` at a safe point.
   - Reject `stopped` and `error` as conflicts.
3. Update `resume_runtime`:
   - Accept only `paused`.
   - Transition to `running`.
4. Update `stop_project`:
   - Close admission, cancel the active card run, terminate runtime-owned processes, and transition directly to `stopped`.
   - Treat `paused` and `error` as immediate transitions to `stopped`.
5. Ensure shutdown remains distinct from project stop.

### Phase 4: Analyst Tool Gate Refactor

1. Replace `requirePausedRuntime` with `requireMutableRuntime`.
2. Base the guard on `runtime.status` only.
3. Update all Analyst card and record mutation tools:
   - `create_card`
   - `reorder_child`
   - `cancel_card`
   - `delete_card`
   - `write_file(record://brief.md...)`
4. Update tool descriptions and Analyst prompt text to say stopped or paused.
5. Remove the missing-root-project bootstrap path from `create_card` after initialization guarantees root creation.

### Phase 5: Read Models, API, And UI

1. Update `/api/state`, `/api/debug/state`, `/api/runtime/status`, and WebSocket projections to expose the new status vocabulary.
2. Remove any projection that displays `idle` as runtime lifecycle, and add no compatibility projections for `paused` or `runtime_intent`.
3. Update UI controls:
   - `stopped`: show Start and allow Analyst management.
   - `running`: show Pause and Stop; deny direct card mutation.
   - `paused`: show Resume and Stop; allow Analyst management.
   - `error`: show diagnostics and Stop; deny direct card mutation.
4. Add UI tests for runtime status badges and enabled controls.

### Phase 6: Cleanup And Validation

1. Remove tests expecting `idle` runtime status.
2. Update generated schemas and API contract tests.
3. Run the full Saivage routine and UI validation profiles.

## 12. Migration Policy

This is a breaking change to persisted runtime state. No backward-compatibility, normalization, or boundary-repair code is added. Existing runtime state files that do not conform to the new schema fail fast and must be reset/reinitialized. The project's live runtime state is reset-friendly, so neither a repair command nor a legacy-shape reader is warranted.

## 13. Acceptance Criteria

The refactor is complete when:

- Runtime lifecycle has one authoritative status field.
- `idle` is removed from public runtime lifecycle vocabulary.
- `paused` boolean is removed from canonical runtime state.
- `runtime_intent` is removed entirely.
- Analyst card mutation is allowed while runtime status is `stopped` or `paused`.
- Analyst card mutation is denied while runtime status is `running` or `error`.
- New projects initialize with a root project card and runtime status `stopped`.
- There is no special Analyst root-card bootstrap exception.
- Operator UI displays stopped/running/paused/error without contradictory badges.
- Runtime transition tests cover valid and invalid transitions.
- Existing validation profiles pass.

## 14. Non-Goals

- Introducing a synthetic workspace root above the project card.
- Moving runtime lifecycle state onto the project card.
- Event-sourcing runtime lifecycle as the primary state representation.
- A transitional `stopping` status or graceful wind-down machinery; stop is synchronous.
- Speculative non-authoritative projections such as `stop_reason`.
- Redesigning card lifecycle states.
- Allowing Analyst structural mutations of actively running subtrees.

These alternatives may be revisited if future requirements demand multi-project workspaces, fully replayable runtime control state, or subtree-level runtime actors. They are not necessary to fix the current architectural problem.
