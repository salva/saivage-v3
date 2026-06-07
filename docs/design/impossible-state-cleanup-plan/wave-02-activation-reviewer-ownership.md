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

Store this on the authoritative run record. If `active_card_run` remains a current snapshot, copy the ownership from the open run into the active run; do not compute it independently.

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

Current lookup falls back to `planner:${parentCardId}`: `src/runtime/activation-unwind.ts#L70-L81`.

For activation-owned runs, caller edge must come from ownership metadata, not from `findPlannerSessionForCard()`. Keep `findActivationCallerEdge()` only for startup repair if needed, or delete it if ownership makes it obsolete.

### Step 4: Split Reviewer Completion By Ownership

Current handler falls back from child unwind failure to `reviewer_finished`: `src/runtime/phases/reviewer-assessment-handler.ts#L72-L84`.

New behavior:

- if ownership is `activation`, append parent tool result and complete activation; missing edge throws
- if ownership is `direct`, transition `reviewer_finished`
- if ownership is absent, throw

Do not infer ownership from `goalId === projectCardId`; project root may still be direct, but that should be recorded explicitly.

### Step 5: Reject Duplicate Unresolved Activations

Current code chooses newest duplicate: `src/runtime/session-persistence.ts#L410-L433`.

Replace with strict behavior:

- zero unresolved calls: return null or throw depending on caller context
- one unresolved call: return it
- more than one unresolved call: throw `RuntimeActivationInvariantError`

If model retries can produce duplicate activation calls, prevent that earlier in the agent loop by making duplicate activation intent a verifier/model-repair condition.

## Tests

Add or update focused tests:

- activation completion without matching activation throws
- activation-owned reviewer without caller edge throws
- direct reviewer without caller edge finishes globally
- duplicate unresolved activation calls throw
- active-run construction requires identity fields and does not synthesize planner ids
- startup repair, if still using old reconstruction, must use a repair-only helper

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
