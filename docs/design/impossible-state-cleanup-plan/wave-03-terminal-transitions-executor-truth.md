# Wave 3: Terminal Transitions And Executor Truth

Findings covered: C05, C21, R01.

## Objective

Make terminal commit paths fail fast on missing/illegal card transitions and ensure executor completion always uses authoritative current card state.

## Current Problem

Terminal commit helpers call `transitionCard()` and can treat rejected transitions as handled receipts. Executor completion also falls back to a stale card snapshot when current card read returns null. Startup executor repair can report a terminal child as failed even when the card is already terminal.

## Architecture Decision

Terminal commit is an authoritative write. If the target card is missing or cannot transition, the runtime path is invalid. It must throw before writing terminal lifecycle or appending activation unwind evidence.

Startup repair must trust terminal card lifecycle over stale active-run phase.

## Implementation Design

### Step 1: Create Strict Transition Helper

Make `RuntimeStateMachine.transitionCard()` throw `RuntimeDispatchInvariantError` for missing cards or illegal runtime transitions. Normal runtime commit paths should have one strict transition API.

If a future operator preview needs non-throwing transition planning, expose it through the existing planning policy (`planCardTransition`) or a separately named preview helper. Do not keep a lenient runtime transition method for normal commits.

The strict method has this shape:

```typescript
async function transitionCardStrict(input: {
  cardId: string;
  event: RuntimeCardAction;
  details: Record<string, unknown>;
  transitionCard(...): Promise<void>;
}): Promise<void>
```

Callers that still need to know whether a transition occurred should infer success from the absence of an exception.

### Step 2: Update Terminal Commit Helpers

Touch:
- `src/runtime/terminal-commit/commit-planner.ts#L18-L63`
- `src/runtime/terminal-commit/commit-reviewer.ts#L21-L59`
- `src/runtime/terminal-commit/commit-executor.ts#L46-L124`

Terminal commit helpers should not return receipts that encode rejected transitions as a normal outcome. They should either commit or throw.

### Step 3: Remove Executor Stale-Card Fallback

Current fallback: `src/runtime/phases/executor-completion-handler.ts#L31-L35`.

Change:

```typescript
const latestCard = input.effects.readCard(input.cardId);
if (!latestCard) throw new RuntimeDispatchInvariantError(...);
```

Do not keep `input.card` as fallback. It may remain useful only as caller context for error messages.

### Step 4: Fix Startup Executor Repair For Terminal Cards

Current startup repair classifies executor active run before terminal-active-card handling: `src/runtime/startup-repair.ts#L33-L42`, `src/runtime/startup-repair.ts#L210-L229`.

Preferred behavior:
- if the card is terminal, record child activation lifecycle from the card lifecycle and synthesize the parent unwind outcome from card lifecycle/status
- if the card is non-terminal and executor was interrupted, fail the card and append failed unwind
- if lifecycle/status contradict, fail startup with an invariant error

For terminal executor cards during startup, do not append the hard-coded failed unwind. Use `recordChildActivationLifecycle(cardId, card.lifecycle)` or the terminal activation synthesis helper so the parent receives `done`, `failed`, `cancelled`, or `needs_verification` according to authoritative card truth.

## Tests

Add or update:

- terminal commit throws when `transitionCard` rejects
- `transitionCard()` itself throws for missing cards and illegal runtime transitions in runtime commit contexts
- executor completion throws if latest card is missing
- executor completion does not use stale snapshot
- startup repair with terminal done card appends done unwind, not failed unwind
- startup repair with contradictory lifecycle/status fails startup

Focused command:

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/runtime/executor-completion-handler.test.ts tests/runtime/startup-repair.test.ts tests/runtime/terminal-commit.test.ts --runInBand --forceExit
```

## Validation

```bash
npm run typecheck
npm test
npm run validate:docs
```

## Stop Criteria

Wave 3 is complete when terminal commit paths cannot encode missing/illegal transitions as successful handled results, and executor completion always uses current card truth.
