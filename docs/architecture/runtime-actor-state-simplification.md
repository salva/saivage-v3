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
  | 'stopping'
  | 'error';
```

The field should remain named `status` rather than being renamed to `state`. The name is already used in API contracts and avoids awkward objects such as `runtime.state.state`. The improvement is the vocabulary and semantics, not a cosmetic rename.

### 3.1 Status Meanings

| Status | Meaning | Can Analyst Mutate Cards? | Active Card Run? |
| --- | --- | --- | --- |
| `stopped` | Runtime is not executing autonomous project work and will not schedule work until explicitly started. This includes initial project state and natural completion. | Yes | No |
| `running` | Runtime is executing or admitting autonomous work. | No | Usually yes; if no active card exists transiently, scheduling may still proceed. |
| `paused` | Runtime admission is closed at a safe point. Existing long-running processes may still exist, but no new model/provider turns are admitted. | Yes, subject to card/subtree rules | No active LLM turn should be in flight after safe point. |
| `stopping` | Stop was requested while active work is winding down or being terminated. | No | Yes or termination in progress |
| `error` | Runtime infrastructure is in an unrecoverable or operator-actionable error state. Card-level failures are not runtime `error`. | No | Maybe, depending on failure point |

`idle` is removed. The former useful distinction behind `idle` was whether a live server/runtime process had no active card. That is not a lifecycle status. If the runtime will not schedule work, it is `stopped`. If it may schedule work, it is `running` even when temporarily between active cards.

## 4. Fields To Remove Or Demote

### 4.1 Remove `paused` As Lifecycle Authority

Remove `runtime.paused` from the canonical runtime state. Pause is represented by:

```json
{ "status": "paused" }
```

If a compatibility projection temporarily needs `paused`, it must be derived:

```ts
const paused = runtime.status === 'paused';
```

No internal permission or scheduling logic should read a persisted boolean `paused` after the refactor.

### 4.2 Demote `runtime_intent`

`runtime_intent.status` must not represent current lifecycle. The current lifecycle is `runtime.status`.

There are two acceptable end states:

- Remove `runtime_intent` entirely if runtime commands and runs provide enough history.
- Keep a renamed pending-command field only for in-progress transitions, not as current state authority.

If a pending-command field remains, it should be explicit, for example:

```ts
interface PendingRuntimeCommand {
  command: 'start_project' | 'stop_project' | 'pause_runtime' | 'resume_runtime';
  requested_at: string;
  requested_by: string;
}
```

This field must never be used to answer "what state is the runtime in?" It answers only "what command is currently being applied?"

### 4.3 Keep Execution Detail Separate

Keep `active_card_run`, runtime run ledger, activation ledger, command ledger, and process records. They are execution detail and history, not separate lifecycle authorities.

## 5. Invariants

The implementation must enforce these invariants at runtime-state write boundaries and in tests.

### 5.1 Lifecycle Authority

`runtime.status` is the only current lifecycle authority.

No permission guard, scheduler gate, UI badge, or runtime read model should infer lifecycle from a combination of fields when `runtime.status` is available.

### 5.2 Active Run Consistency

`active_card_run` is allowed only when the runtime is doing or winding down active work:

```ts
if (runtime.active_card_run !== null) {
  assert(runtime.status === 'running' || runtime.status === 'stopping' || runtime.status === 'error');
}
```

For the steady state, prefer the stronger invariant:

```ts
runtime.status === 'running' || runtime.status === 'stopping'
  ? runtime.active_card_run !== null || schedulerIsBetweenDispatches
  : runtime.active_card_run === null;
```

Because there may be brief scheduler gaps between cards, the implementation should not overfit to `running` always requiring a non-null active run. It should, however, reject `stopped` or `paused` with a non-null active run.

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
running  --stop_project-->   stopping
stopping --settled-->        stopped
paused   --stop_project-->   stopped
error    --stop_project-->   stopped
running  --fatal_error-->    error
paused   --fatal_error-->    error
stopping --fatal_error-->    error
```

Invalid examples:

```text
stopped --pause_runtime--> invalid
stopped --resume_runtime--> invalid
paused  --start_project--> invalid; use resume_runtime
running --start_project--> invalid; already running
stopping --pause_runtime--> invalid
```

The operator UI may offer friendly labels, but the runtime API should return explicit conflict errors for invalid transitions.

## 7. Stop, Pause, And Shutdown Semantics

The existing language mixes stop, pause, and shutdown. The simplified model should make them distinct.

### 7.1 Pause

Pause is a reversible admission gate.

- It stops new LLM/provider calls at the next safe point.
- It does not imply project cancellation.
- It does not imply process termination.
- Analyst card mutation is allowed while paused after the safe point.

### 7.2 Stop

Stop is a request to leave autonomous project execution.

- From `paused`, stop is immediate and transitions to `stopped`.
- From `running`, stop transitions to `stopping` until active work is settled or terminated according to runtime policy.
- From `error`, stop resets runtime lifecycle to `stopped` after clearing or recording the runtime-level error.

The implementation must choose and document the active-work policy for stop. The recommended policy is graceful-first:

1. Close admission immediately.
2. Signal active agent/session/process owners to finish or cancel at the next safe point.
3. Transition from `stopping` to `stopped` when no active card run remains.
4. Surface any stuck termination as a runtime error or operator-actionable diagnostic.

### 7.3 Shutdown

Shutdown remains the hard operation for service/process termination. It may terminate runtime-owned processes and possibly restart or stop the server service. It is not the same as `stop_project`.

## 8. Initialization And Root Project Card

Project initialization should create both:

- A root project card.
- Runtime state with `status: 'stopped'`.

This removes the special Analyst bootstrap exception for a missing root project card.

The current Analyst path allows creating the first root project card without paused runtime. That is a wart caused by incomplete initialization. The target behavior is:

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

Temporary compatibility fields may be exposed during migration, but must be explicitly documented as derived and deprecated:

```json
{
  "paused": false,
  "deprecated": true
}
```

The operator UI should display exactly one runtime lifecycle badge using the new vocabulary:

- Stopped
- Running
- Paused
- Stopping
- Error

The UI may additionally display a derived reason, such as `initial`, `operator`, `natural`, or `error`, but reason must not be treated as lifecycle state.

## 10. Derived Stop Reason

The runtime may expose a non-authoritative `stop_reason` projection:

```ts
type StopReason = 'initial' | 'operator' | 'natural' | 'error';
```

This is useful for UI and diagnostics:

- `initial`: project has not yet been started.
- `operator`: operator explicitly stopped the project.
- `natural`: runtime reached a normal no-work/completed condition.
- `error`: runtime was stopped after a runtime-level error.

`stop_reason` should be derived from runtime command/run history or written as metadata when entering `stopped`. It must not be used as a lifecycle guard.

## 11. Revised Analyst Mutation Gate

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

## 12. Implementation Plan

### Phase 1: Specification And Tests First

1. Update `docs/spec/system-specification.md` to replace paused-only Analyst mutation language with stopped-or-paused language.
2. Update `docs/spec/operator-ui.md` to use the new runtime status vocabulary.
3. Update architecture references that mention `idle`, `paused` boolean semantics, or `runtime_intent.status` as lifecycle authority.
4. Add failing tests for:
   - Analyst can create child cards when runtime status is `stopped`.
   - Analyst can mutate supported card records when runtime status is `paused`.
   - Analyst cannot mutate cards when runtime status is `running`, `stopping`, or `error`.
   - Stopped runtime does not require `pause_runtime` before card mutation.
   - Invalid transitions fail loudly.

### Phase 2: Runtime Schema Refactor

1. Change `RuntimeStatus` schema from `idle | running | paused | error` to `stopped | running | paused | stopping | error`.
2. Remove `paused` from canonical `RuntimeState`.
3. Remove `runtime_intent.status` as a lifecycle authority.
4. Add or retain command/run ledgers for history only.
5. Add runtime-state invariant validation near persistence boundaries.
6. Ensure project initialization writes `status: 'stopped'`.

### Phase 3: Runtime Supervisor And Control Tools

1. Update `start_project`:
   - Accept only `stopped`.
   - Transition to `running`.
   - Reject `paused` with guidance to use `resume_runtime`.
   - Reject `running` and `stopping` as conflicts.
2. Update `pause_runtime`:
   - Accept only `running`.
   - Transition to `paused` at a safe point.
   - Reject `stopped`, `stopping`, and `error` as conflicts.
3. Update `resume_runtime`:
   - Accept only `paused`.
   - Transition to `running`.
4. Update `stop_project`:
   - From `running`, transition to `stopping`, then to `stopped` when active work settles.
   - From `paused`, transition directly to `stopped`.
   - From `error`, transition to `stopped` after preserving diagnostics.
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
2. Remove any projection that displays `idle` as runtime lifecycle.
3. Update UI controls:
   - `stopped`: show Start and allow Analyst management.
   - `running`: show Pause and Stop; deny direct card mutation.
   - `paused`: show Resume and Stop; allow Analyst management.
   - `stopping`: show progress/diagnostics; deny direct card mutation.
   - `error`: show diagnostics and Stop/Reset path; deny direct card mutation.
4. Add UI tests for runtime status badges and enabled controls.

### Phase 6: Cleanup And Compatibility Removal

1. Remove compatibility projections for `paused` if any were temporarily exposed.
2. Remove code that reads `runtime_intent.status` as current lifecycle.
3. Remove tests expecting `idle` runtime status.
4. Update generated schemas and API contract tests.
5. Run the full Saivage routine and UI validation profiles.

## 13. Migration Policy

The Saivage v3 project is still in active local development. Do not add broad backward-compatibility layers unless a deployed runtime state file must be preserved.

Recommended migration stance:

- For local runtime state, fail fast on contradictory states during development.
- For known live project state, provide a one-time local repair command or reset recipe if needed.
- Do not keep long-term support for `idle + paused + runtime_intent.status` combinations.

If an existing runtime state must be read during a transition window, normalize only at the boundary and immediately persist the new canonical shape. Avoid carrying legacy shape through internal code.

## 14. Acceptance Criteria

The refactor is complete when:

- Runtime lifecycle has one authoritative status field.
- `idle` is removed from public runtime lifecycle vocabulary.
- `paused` boolean is removed from canonical runtime state.
- `runtime_intent.status` is removed or no longer used as current lifecycle authority.
- Analyst card mutation is allowed while runtime status is `stopped` or `paused`.
- Analyst card mutation is denied while runtime status is `running`, `stopping`, or `error`.
- New projects initialize with a root project card and runtime status `stopped`.
- There is no special Analyst root-card bootstrap exception.
- Operator UI displays stopped/running/paused/stopping/error without contradictory badges.
- Runtime transition tests cover valid and invalid transitions.
- Existing validation profiles pass.

## 15. Non-Goals

- Introducing a synthetic workspace root above the project card.
- Moving runtime lifecycle state onto the project card.
- Event-sourcing runtime lifecycle as the primary state representation.
- Redesigning card lifecycle states.
- Allowing Analyst structural mutations of actively running subtrees.

These alternatives may be revisited if future requirements demand multi-project workspaces, fully replayable runtime control state, or subtree-level runtime actors. They are not necessary to fix the current architectural problem.
