# Analyst As Sole Control Surface

The approved functional specification lives in `SPEC/analyst-as-control-surface/SPEC-r7.md`, with approval metadata in `SPEC/analyst-as-control-surface/APPROVED.md`.

This docs page makes that contract discoverable from the active documentation set. The key contract is:

- Saivage has two coupled parts: an autonomous runtime and the Analyst chat.
- The runtime owns project progress: planner, executor, reviewer, process, card, runtime state, and events.
- The Analyst is the user's mutating control surface for inspection, steering, reconfiguration, repair, and lifecycle control.
- The operator UI displays read-only projections and navigation affordances, except bounded authentication/bootstrap controls.
- Delivery work remains owned by planners, executors, reviewers, and runtime services; the Analyst delegates through cards, queued context/notifications, and canonical runtime controls.

Approved source specification path: `SPEC/analyst-as-control-surface/SPEC-r7.md`.

Approval manifest path: `SPEC/analyst-as-control-surface/APPROVED.md`.
