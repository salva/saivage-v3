# Terminal Completion Gate Design

Status: design proposal.

Date: 2026-07-05

## 1. The F03 finding, corrected

F03 (in `tmp/actor-review-2026-07/F03-recovery-projection-duplication.md`) originally claimed recovery "re-derives the same projection" as live execution and rated the drift risk **high**. Re-reading both paths line by line, that overstates the duplication.

### What is already shared

The terminal-outcome projection math is **already shared** via three free functions, which recovery imports and calls directly:

- `projectPlannerTerminalOutcome` — `src/runtime/actors/planning-card-processor-actor.ts`, imported at `src/runtime/actors/actor-recovery.ts#L23`, called at `src/runtime/actors/actor-recovery.ts#L378`.
- `projectTerminalExecutorOutcome` — `src/runtime/actors/terminal-card-processor-actor.ts`, imported at `src/runtime/actors/actor-recovery.ts#L24`, called at `src/runtime/actors/actor-recovery.ts#L384`.
- `evaluateReviewerTerminalOutcome` — `src/runtime/actors/reviewer-terminal-evaluation.ts`, imported at `src/runtime/actors/actor-recovery.ts#L19`, called at `src/runtime/actors/actor-recovery.ts#L354`.

All three route through the same `verifyTerminalToolOutcome` and the same contracts. For a given persisted terminal tool call, live and recovery compute the **identical** `CardActivationOutcome`. The headline drift risk I warned about — "recovery writes a different card status than live would have" — is already eliminated for the projection itself. This is why F03's severity is downgraded from **high to medium-low**.

### What is actually duplicated

Exactly one thing: the **completion-gate traversal** that decides whether a planner `done` may complete given its descendants.

- Live: `firstIncompleteDescendant(cardId, store): { id, status } | null` — `src/runtime/actors/planning-card-processor-actor.ts#L477`. Returns the first non-complete descendant so the planner can be told to repair.
- Recovery: `descendantsAreComplete(cardId, store): boolean` — `src/runtime/actors/actor-recovery.ts#L400`. Returns whether all descendants are complete.

Same recursive tree walk, same completeness predicate (`status !== 'done' && status !== 'cancelled'`), inverse shapes. They are in sync today. They could drift if the "which statuses count as complete" rule changes in one place but not the other — for example if `needs_verification` ever becomes completion-eligible, or a new terminal status is introduced.

### What is correctly separate (not duplication)

- **The paired planner-done + reviewer-terminal matching** (`projectReviewerRecoveryOutcome`, `src/runtime/actors/actor-recovery.ts#L326`). Live runs the reviewer synchronously after planner-done; recovery matches two *persisted* waits. There is no live counterpart, so there is nothing to diverge from. This stays in `actor-recovery.ts`.
- **Record-slot closing policy.** Live (`closeRequiredRecord` / `closeRequiredStatusRecord`) catches *any* error and turns it into a model-repair message. Recovery (`closeRecoveredRecordSlot`) swallows *only* `ExpectedRecordSlotCloseError` (→ skip projection) and rethrows everything else (fail-fast). These are intentionally different policies around the shared `closeOpenRecordSlot` primitive; unifying them would erase a correct distinction. They stay as-is.
- **The projection free functions' file locations.** Relocating them into a single `terminal-projection.ts` module would be cosmetic — they are already single definitions with single call sites on each side. Relocation does not reduce drift (there is none) and is rejected as over-engineering.

## 2. The fix

Make `firstIncompleteDescendant` the single source of truth for "which descendant statuses block a planner-done completion." Delete `descendantsAreComplete`. Recovery calls `firstIncompleteDescendant(cardId, store) === null`.

### Current function

```ts
// planning-card-processor-actor.ts:477
function firstIncompleteDescendant(cardId: string, store: CardActorStorePort): { id: string; status: CardStatus } | null {
  for (const childId of store.listChildren?.(cardId) ?? []) {
    const child = store.read(childId);
    if (!child) continue;
    if (child.status !== 'done' && child.status !== 'cancelled') return { id: child.id, status: child.status };
    const descendant = firstIncompleteDescendant(childId, store);
    if (descendant) return descendant;
  }
  return null;
}
```

Two changes:

1. **Export it** so recovery can import it (recovery already imports from this file).
2. **Require `listChildren`** in the store parameter, replacing the silent `?? []`. Recovery's reviewer path already fails fast when `listChildren` is absent (`descendantsAreComplete` throws); live always passes a full store. The function signature should enforce the requirement instead of papering over it with an optional.

### Tightened signature

```ts
export function firstIncompleteDescendant(
  cardId: string,
  store: { read(cardId: string): CardRecord | null; listChildren(cardId: string): string[] },
): { id: string; status: CardStatus } | null {
  for (const childId of store.listChildren(cardId)) {
    const child = store.read(childId);
    if (!child) continue;
    if (child.status !== 'done' && child.status !== 'cancelled') return { id: child.id, status: child.status };
    const descendant = firstIncompleteDescendant(childId, store);
    if (descendant) return descendant;
  }
  return null;
}
```

The structural store type is narrower than `CardActorStorePort`, but every existing caller already passes a store that satisfies it (live: the full `CardStore`; recovery: the projection deps store once `listChildren` is confirmed present).

### Recovery call site

`projectReviewerRecoveryOutcome` (`src/runtime/actors/actor-recovery.ts#L336`) replaces:

```ts
if (!descendantsAreComplete(card.id, deps.store)) return null;
```

with:

```ts
if (!deps.store.listChildren) throw new Error(`Cannot project reviewer recovery for card '${card.id}': recovery outcome store must provide listChildren for descendant traversal.`);
if (firstIncompleteDescendant(card.id, deps.store)) return null;
```

The explicit `listChildren` check preserves recovery's current fail-fast behavior; the structural type of `firstIncompleteDescendant` then accepts `deps.store`. `descendantsAreComplete` (`src/runtime/actors/actor-recovery.ts#L400`) is deleted.

Live's `validatePlannerCompletionGate` (`src/runtime/actors/planning-card-processor-actor.ts#L318`) and the `firstIncompleteDescendant` call inside it are unchanged — they already use this function.

## 3. What this design deliberately does not do

- **No new `terminal-projection.ts` module.** The projection functions are already shared and already live next to their contracts. A module would be cosmetic relocation.
- **No unification of the record-close policy.** Live-repairs-on-failure and recovery-skips-on-failure are two correct, different policies around a shared primitive.
- **No touching the paired reviewer matching.** It is recovery-only by nature.
- **No change to `recoverTerminalToolOutcome` (F02).** That is a separate dead-code cleanup in the same batch, unrelated to this gate.

## 4. Explicit decisions

1. The projection math was already shared. This design does not relocate or re-expose it.
2. There is one completion-gate traversal. Live reads the blocker from it; recovery reads `=== null`.
3. `firstIncompleteDescendant` requires `listChildren`. Recovery keeps its explicit fail-fast check at the call site.
4. Record-close policy stays split. Paired-reviewer matching stays in recovery. Neither is duplication.
5. F03 severity is downgraded from high to medium-low. The residual drift risk is one completeness predicate, and this design puts it in one function.

## 5. Validation

- Recovery reviewer projection skips when any descendant is incomplete (the `firstIncompleteDescendant(...) !== null` branch).
- Recovery still throws when `deps.store.listChildren` is missing in the reviewer path.
- Live completion gate (`validatePlannerCompletionGate`) behaves identically — same function, same call.
- The completeness predicate (`status !== 'done' && status !== 'cancelled'`) now lives in exactly one place; changing it changes both paths simultaneously.
- `tests/runtime/actors/actor-recovery.test.ts` cases for the paired reviewer projection and the `listChildren`-missing failure must still pass.
- `npm run typecheck`; focused recovery + planning-processor tests; `npm test`.
