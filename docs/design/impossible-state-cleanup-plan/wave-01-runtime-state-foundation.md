# Wave 1: Runtime State Foundation

Findings covered: C01, C02, C03, C04.

## Objective

Make the runtime state machine fail fast instead of self-healing during normal ticks. This wave removes the root architectural problem: live invariant correction in `RuntimeStateMachine.tick()`.

## Current Problem

The normal tick path currently observes invariants and applies corrections. Source references: `src/runtime/state-machine.ts#L217-L230`, `src/runtime/runtime-core.ts#L372-L397`.

The specific repairs are:
- running without active run becomes idle
- idle with active run becomes running
- terminal active card clears active run

This makes runtime corruption survivable and therefore hard to locate. It also encourages later code to rely on tick repair rather than maintaining the state invariant at write time.

## Architecture Decision

Runtime state invariants are write-time obligations. A component that mutates runtime state must produce valid state or throw. The tick loop may observe and report invariants, but it must not correct them.

Use this separation:

- `observeRuntimeStateInvariants()` returns observations only.
- `assertRuntimeStateInvariantsForNormalRuntime()` throws for impossible normal state.
- Startup repair modules may call explicitly named repair planners.

Do not keep a `correction` field in normal invariant observations. If repair planners still need correction plans, move them to repair-specific modules.

## Implementation Design

### Step 1: Split Observation From Repair

Refactor `RuntimeInvariantObservation` in `src/runtime/runtime-core.ts`.

Current shape includes optional `correction`. Replace normal observation shape with:

```typescript
export interface RuntimeInvariantObservation {
  invariant: InvariantId;
  key: string;
  details: Record<string, unknown>;
}
```

Move correction-producing logic to explicitly named repair functions if any startup caller still needs it.

### Step 2: Make `observeInvariants()` Throw Or Record Without Patching

Update `src/runtime/state-machine.ts#L217-L230` so it never calls `this.state.patch(observation.correction)`.

Preferred design:

```typescript
const observations = observeRuntimeStateInvariants(...);
for (const observation of observations) this.logInvariantOnce(...);
if (observations.some(isNormalRuntimeFatalInvariant)) {
  throw new RuntimeStateInvariantError(...);
}
```

Avoid a broad “fatal vs nonfatal” compatibility matrix. In normal runtime, all I1/I2-style state coherence violations should be fatal. If any observation is purely diagnostic, name it separately and keep it out of the fatal invariant set.

### Step 3: Remove Active-Card Read Normalization

Current code catches card status read errors and maps them to `null`: `src/runtime/state-machine.ts#L221-L225`.

Replace with direct read. If card read fails, propagate. If `readStatus()` returns null for an active card, throw `RuntimeStateInvariantError` with active run details.

### Step 4: Stop Swallowing Project Root Redispatch Errors

Current code catches redispatch errors and discards them: `src/runtime/state-machine.ts#L233-L239`.

Preferred implementation:
- call redispatch directly
- if redispatch throws, let the tick fail
- ensure the runtime application logs the error through existing error logger boundaries

If throwing from tick creates unhandled scheduler promises, fix the scheduler boundary to record and surface errors. Do not swallow inside `maybeRedispatchProjectRoot()`.

### Step 5: Require Non-Null Active Run For `reviewer_started`

Current reducer accepts `payload.activeCardRun ?? null`: `src/runtime/runtime-core.ts#L346-L349`.

Change reducer behavior:

```typescript
case 'reviewer_started': {
  const activeCardRun = parseReviewerStartedActiveRun(payload);
  return { status: 'running', active_card_run: activeCardRun };
}
```

The parser must throw if `activeCardRun` is missing or malformed.

## Tests

Add or update focused tests:

- `tests/runtime/state-machine.test.ts`: tick with running/no active run throws and does not patch to idle.
- `tests/runtime/state-machine.test.ts`: tick with idle/non-null active run throws and does not patch to running.
- `tests/runtime/state-machine.test.ts`: active card read failure propagates.
- `tests/runtime/state-machine.test.ts`: redispatch failure propagates.
- `tests/runtime/runtime-core.test.ts`: `reviewer_started` without `activeCardRun` throws.

## Validation

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/state-machine.test.ts tests/runtime/runtime-core.test.ts --runInBand --forceExit
npm run typecheck
npm test
npm run validate:docs
```

## Stop Criteria

Wave 1 is complete when no normal tick path patches runtime state and the focused tests prove impossible runtime state throws.
