# Wave 2: Activation And Reviewer Ownership

Findings covered: C06, C07, C08, C09, C13, C20.

## Objective

Make activation ownership explicit and remove synthesized activation/session identity. Child unwind must know whether the reviewer/executor was activation-owned or direct-dispatched.

## Current Problem

Current activation and reviewer paths blur three cases:
- activation-owned child completion
- direct reviewer completion without activation edge
- startup/repair synthesis

The code then compensates with boolean return values, session id synthesis, duplicate activation selection, and active-run field defaults.

## Architecture Decision

Runtime run records and active-run records must carry explicit ownership. A normal child completion path must be able to answer:

- Is this run activation-owned?
- Which activation record owns it?
- Which parent planner session and tool call requested it?
- Is this a direct dispatch path that is allowed to finish without parent unwind?

Do not reconstruct this from card hierarchy or guessed planner ids during normal completion.

## Data Design

Introduce an explicit dispatch ownership shape for active runs and/or runtime runs.

Recommended minimal shape:

```typescript
type RuntimeDispatchOwnership =
  | {
      kind: 'activation';
      activation_id: string;
      parent_card_id: string;
      parent_run_id: string;
      caller_session_id: string;
      caller_tool_call_id: string;
    }
  | {
      kind: 'direct';
      source: 'project_root' | 'operator' | 'startup_repair';
    };
```

Store this as `ownership: RuntimeDispatchOwnership` on `RuntimeRunRecord`. If `active_card_run` remains a current snapshot, also store `ownership` on `ActiveCardRun` and copy it from the open run into the active run; do not compute it independently.

Persisted open runtime runs without `ownership` are invalid after this wave. Startup repair may reconstruct ownership only when it can prove the relation from current runtime activations, runtime runs, card hierarchy, and persisted session metadata. If it cannot prove the relation, startup fails with `RuntimeActivationInvariantError`. There is no migration layer for historical run shapes.

## Implementation Design

### Step 1: Remove Defensive Active-Run Defaults

Current defaults live in `src/runtime/activation-reducer.ts#L18-L66`.

Replace optional identity fields with required fields per phase. For example, executor activation state should require:

- `cardId`
- `goalId`
- `cardType`
- `executorSessionId`
- ownership object
- planner session id if applicable

Only timestamps for newly opened runs may default to `nowIso`.

Startup repair callers that currently rely on `activeRunFromActivationState()` defaults must move to a repair-only reconstruction helper. That helper must accept explicit repair context, must reconstruct identity only from persisted facts, and must throw if those facts are missing. Do not keep normal-path defaults to support repair callers.

### Step 2: Make Activation Completion Mutation Throw On Missing Activation

Current mutation erases reducer failure with `?? current`: `src/runtime/mutations.ts#L89-L99`.

Change apply behavior:

```typescript
const next = reduceActivationCompletion(...);
if (!next) throw new RuntimeActivationInvariantError(...);
return { state: next, result: undefined };
```

This should apply to normal `completeActivation` mutation. If startup repair needs a forgiving path, create a separate repair mutation with explicit name and tests.

### Step 3: Remove Session Id Synthesis From Caller Edge Lookup

Current lookup falls back to `planner:${parentCardId}`: `src/runtime/activation-unwind.ts#L70-L82`.

For activation-owned runs, caller edge must come from ownership metadata, not from `findPlannerSessionForCard()`. Keep `findActivationCallerEdge()` only for startup repair if needed, or delete it if ownership makes it obsolete.

### Step 4: Split Reviewer Completion By Ownership

Current handler falls back from child unwind failure to `reviewer_finished`: `src/runtime/phases/reviewer-assessment-handler.ts#L72-L84`.

New behavior:

- if ownership is `activation`, append parent tool result and complete activation; missing edge throws
- if ownership is `direct`, transition `reviewer_finished`
- if ownership is absent, throw

Do not infer ownership from `goalId === projectCardId`; project root may still be direct, but that should be recorded explicitly.

Reviewer pass must also require the reviewed goal card to be readable before committing lifecycle or emitting completion. Current code skips `commitReviewerPass()` when `readCard(goalId)` returns null and still emits completion; that path must throw.

### Step 5: Fix Parent Planner Run Resumption Identity

Current `findParentPlannerRunForResumption()` in `src/runtime/runtime-core.ts#L736-L767` constructs an `active_card_run` directly and can synthesize planner identity. Replace this with ownership-aware resumption:

- use the completed activation's parent run id, parent session id, and ownership metadata
- require the parent planner run to exist and be open
- copy identity from the authoritative parent run/activation record
- throw if caller/planner identity is absent or contradictory

Do not construct active runs in this path with `caller_session_id: null`, `caller_tool_call_id: null`, or synthesized `planner:${cardId}`.

### Step 6: Reject Duplicate Unresolved Activations

Current code chooses newest duplicate: `src/runtime/session-persistence.ts#L410-L433`.

Replace with strict behavior:

- zero unresolved calls: return null or throw depending on caller context
- one unresolved call: return it
- more than one unresolved call: throw `RuntimeActivationInvariantError`

Because duplicate `activate_card` calls can be produced by model retries, prevent duplicates before they become persisted unresolved calls. The planner tool-call handling should detect multiple unresolved `activate_card(childCardId)` intents in the same assistant turn, append a model-repair/protocol rejection for that turn, and avoid dispatching more than one activation for the same child. Persisted duplicates that already exist are invalid and should fail rather than choosing the newest.

## Tests

Add or update focused tests:

- activation completion without matching activation throws
- activation-owned reviewer without caller edge throws
- direct reviewer without caller edge finishes globally
- reviewer pass with missing goal card throws and emits no completion
- parent planner run resumption copies identity from ownership metadata and never synthesizes planner ids
- duplicate unresolved activation calls throw
- duplicate activate_card intents in one planner turn are rejected before dispatching duplicate activations
- active-run construction requires identity fields and does not synthesize planner ids
- startup repair, if still using old reconstruction, must use a repair-only helper
- persisted open runtime runs without ownership fail startup unless repair can reconstruct ownership from authoritative persisted facts

Recommended focused command:

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/activation-unwind.test.ts tests/runtime/reviewer-assessment-handler.test.ts tests/runtime/runtime-activation-ledger.test.ts tests/runtime/runtime-core.test.ts --runInBand --forceExit
```

## Validation

```bash
npm run typecheck
npm test
npm run validate:docs
```

## Stop Criteria

Wave 2 is complete when normal child completion cannot rely on synthesized planner sessions, duplicate unresolved activations throw, and reviewer completion behavior is selected by explicit ownership.
