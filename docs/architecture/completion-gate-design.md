# Terminal Completion Gate Decision

Status: implemented.

Date: 2026-07-05

F03 originally described recovery as duplicating terminal outcome projection. A second review found that was overstated: planner, executor, and reviewer terminal projections are already shared through the live projection functions imported by recovery.

The only real duplication was the descendant completion gate:

- Live planner execution used `firstIncompleteDescendant(...)`.
- Startup recovery used a separate `descendantsAreComplete(...)` traversal with the same status predicate.

The clean fix is to keep one traversal. `firstIncompleteDescendant(...)` is now exported from `src/runtime/actors/planning-card-processor-actor.ts` and reused by `src/runtime/actors/actor-recovery.ts`. Recovery checks for `null`; live execution keeps using the blocker for its repair message.

The helper is deliberately strict. If `listChildren` is unavailable, or if a listed child id cannot be read, the completion gate throws. A card tree containing a missing listed child is corrupt state, not a recoverable completion condition.

No new projection module was introduced. Moving already-shared projection functions would only relocate code without reducing architectural drift.
