# SPEC Consistency and Completeness Review

Date: 2026-06-12
Scope: SPEC-r7, docs/agents.md, docs/analyst.md, docs/goal-planning-runtime.md, docs/operation.md, docs/specifications/, docs/design/, README.md, 100-CONSOLIDATED-RUNTIME-CORE-PLAN

## Summary

The documentation authority chain is now clean and explicit: SPEC-r7 is the approved product contract, agents.md is the normative runtime behavior authority, goal-planning-runtime.md defers to agents.md, operation.md is a route inventory, and design docs are stale/provenance. The consolidated plan acknowledges it needs rewriting from functional invariants. Within this structure, I found 2 critical inconsistencies, 4 moderate gaps, and 6 minor items.

---

## Critical Inconsistencies

### C1: Card-scoped analyst tool matrix contains retired "note" actions

**Location**: agents.md §18 agent tool matrix (row `card-scoped analyst`)

**Conflict**: SPEC-r7 §"Terminology: from notes to notifications" explicitly retires the v2 user-managed note object and states:

> "There is no notification inbox, no per-notification acknowledge action, no edit, no delete, no bulk-handle operation, and no list/get capability."

The card-scoped analyst row lists these tools:

- `add_note` — contradicts the queue-only/immutable notification model
- `get_note` — contradicts "no get capability"
- `list_notes` — contradicts "no inbox"
- `mark_note_handled` — contradicts "no acknowledge action"

These tool names imply a durable, inspectable, acknowledgeable note object that the SPEC explicitly says must not exist.

**Resolution**: The card-scoped analyst is the "Discuss with analyst" per-card entry point (SPEC §"Persistent panel layout and contextual awareness"). It should stage a contextual chat seed in the Analyst composer, not expose a note CRUD surface. The tool definitions for this role must be updated to remove note-management tools and aligned with the SPEC's notification model: the Analyst queues ephemeral context through `queue_notification`, and per-card discussion enters through the always-visible Analyst panel, not through a separate note inbox.

**Severity**: High. The SPEC is the approved product contract; the current tool definitions implement a model that the SPEC deliberately forbids.

**Owner view**: Yes, that's right, notes/notifications (whatever name we chose), are just a one-way very simple mechanism for delivering messages to the running agents. So, the only functionality required should be to deliver a note to a card which internally would trigger delivery of such card to the main LLM.

### C2: `restart_card` semantics contradict SPEC "re-plans from scratch"

**Location**: agents.md §7.1 `restart_card` vs SPEC-r7 §"Control the runtime"

**Conflict**: SPEC-r7 states:

> "restart a card or a goal subtree, which discards in-progress agent work for that scope and re-plans from scratch"

agents.md §7.1 says:

> "Reset of a planner's internal LLM message log is not part of restart_card... The planner is not woken; the parent must call activate_card(card_id) to give control back."

The SPEC implies immediate re-planning after restart. The implementation specification says the planner is not woken and must be re-activated by the parent. If the parent is Dormant (which it is — it reported goal done/failed/blocked before restart), nothing re-activates the parent unless an explicit runtime command or Analyst action triggers it. The card sits in `backlog` with no automatic re-planning.

**Resolution options**:
1. Update agents.md so `restart_card` on a goal card also queues a `subtree_changed` context note to the parent, which the Analyst must then re-activate — but this still doesn't guarantee "re-plans from scratch."
2. Define `restart_goal_subtree` (separate from `restart_card`) as an Analyst-level operation that restarts the card AND wakes the ancestor chain, so work actually begins again. The Analyst tool table already lists `restart_goal` as a separate tool from `restart_card_or_subtree`.
3. Update the SPEC to say "resets the card to backlog and marks it for re-activation" instead of "re-plans from scratch."

The current Analyst tool list has both `restart_card_or_subtree` and `restart_goal`, suggesting these are intended to be different operations. This distinction needs to be clarified and made consistent with the runtime behavior.

**Severity**: High. The product contract promises a user-visible behavior (immediate re-planning) that the runtime specification does not deliver.

**Owner view**: Planner tools for managing cards (direct descendants only) should be limited to creating, editing the card objectives, canceling, reactivating (conceptually sync op), and queuing notes/notifications. Resetting does not seem a required operation, the planner can just create a new goal for that and cancel the old one.

---

## Moderate Gaps

### M1: Abort vs cancel semantics underspecified

**Location**: SPEC-r7 §"Control the runtime" vs agents.md §7.1 `cancel_card` vs agents.md §17 future stages

The SPEC offers "abort a goal subtree, which halts work on that subtree and any descendants." But agents.md §7.1 `cancel_card` refuses active-leaf and running-ancestor targets. The analyst tool table has `abort_goal_subtree` as a separate tool from `cancel_card`. The exact semantics of abort (force-cancelling through the active chain, sending synthetic failed to the parent) vs cancel (refusing active targets) are not specified in agents.md. Cancel-cascade through running ancestors is explicitly deferred to §17, but the SPEC doesn't acknowledge that "abort" may be limited to non-active subtrees.

**Resolution**: Add an `abort_goal_subtree` specification to agents.md that covers: (a) force-cancelling the active leaf, (b) delivering synthetic `failed` tool results up the ancestor chain, (c) the relationship to the deferred cancel-cascade feature. The SPEC text is fine as a user-facing promise; the runtime behavior needs to match it.

**Owner view**: I can't see the place for two operations, abort and cancel. Only cancel is required.

### M2: Plan document not yet aligned with functional spec

**Location**: 100-CONSOLIDATED-RUNTIME-CORE-PLAN.md

The progress notes already acknowledge: "The current XState plan was written architecture-first and must be rewritten from functional invariants." Specific gaps in the current plan text:

- The plan discusses "active card actors" (plural spawned by a parent) in ways that don't clearly enforce the one-active-leaf invariant from agents.md §15.
- Pause and cancel are discussed in the same P0 section without clearly separating them: pause is a global scheduling gate (agents.md §5, §12), force-cancel is a distinct behavior that produces synthetic `failed` tool results (agents.md §12).
- The plan doesn't map Analyst-initiated runtime commands to XState events on the supervisor machine.
- The plan doesn't address the `changed` card status or `mark_goal_needs_corrections` analyst operation in machine states.

**Resolution**: This is already tracked. The plan must be rewritten starting from the functional specification invariants before P0 implementation begins.

**Owner view**: That's expected, we are still focusing on the spec. That applies to many of the criticism below.

### M3: Planner process handling missing from plan's actor model

**Location**: 100-CONSOLIDATED-RUNTIME-CORE-PLAN.md §P0.3

The plan says goal card actors "invoke one LLM turn actor at a time for planner/reviewer turns and spawn/invoke one active child card actor when handling activate_card." But planners also have process tools (`start_and_wait`, `run_project_command`, `wait_for_process`, `kill_process` per agents.md §7 and §18). The plan doesn't specify where planner process invocation fits in the XState model — the goal card machine states don't include a process-wait state.

agents.md §6 mentions "Durable process terminal results that arrive while paused are buffered" and §5 shows `AwaitingChild` covering "activate_card child or process wait." But the plan's P0.3 goal card machine states only list: `idle`, `marking_running`, `planning`, `activating_child`, `reviewing`, `delivering_child_result`, `applying_review_corrections`, `committing_outcome`, `blocked`, `failed`, `cancelled`, `done`.

**Resolution**: The goal card machine must include a `waiting_process` or equivalent state for planner process waits, mirroring how `AwaitingChild` covers both activation and process waits in the current model.

### M4: Notification routing by "role" not fully specified

**Location**: SPEC-r7 §"Queue notifications to agent sessions" vs agents.md §11 context routing

The SPEC says the user can target notifications "addressed to a given card or role." agents.md §11 defines context routing to "the deepest planner whose goal subtree contains the affected card." But routing by "role" (e.g., "the executor for card X" or "the reviewer for card Y") is not specified in the runtime routing logic. The Analyst might address "the executor for goal-7," but agents.md only routes to the session of the deepest planner, not to executor or reviewer sessions by role.

**Resolution**: Either (a) specify role-based notification routing in agents.md (routing to the next executor/reviewer session for a card, or to a currently-paused session matching the role), or (b) clarify in the SPEC that "role" addressing is resolved by the Analyst to card-based addressing before the notification enters the runtime queue.

**Owner view**: I think the right thing to do here is: notifications are delivered to cards. Inside the card runtime, the notification is delivered to the main agent.

Also, having notes queued may alter the internal flow and transitions.

---

## Minor Items

### m1: `start_project` idempotency not specified

What happens when the Analyst says "Start the project" while the project is already running? agents.md doesn't specify an idempotent behavior. Should return a clear error ("already running"), succeed idempotently, or be a no-op with confirmation?

**Owner view**: That situation should be detected and the runtime should return an error/warning response to the analyst telling the system is already in a running state.

### m2: Open functional questions remain unresolved

SPEC-r7 has 8 open questions (§"Open Functional Questions") that are legitimate design decisions to resolve before implementation. They should be tracked as known open items and resolved before the affected features are implemented.

**Owner view**: where is that document???

### m3: Project completion Analyst handoff deferred

agents.md §6 and §17 explicitly defer "the specific operator-notification or analyst-handoff flow after a project completion." The SPEC says "Stop the project" but doesn't specify what the Analyst sees when the project planner reports done/failed/blocked on its own. This is a known gap, not a surprise — it should be tracked.

### m4: Plan P0-P9 doesn't address Analyst-to-XState event mapping

The plan focuses on runtime internals but doesn't document how Analyst-initiated commands (start_project, stop_project, pause_runtime, resume_runtime, abort_goal_subtree, mark_goal_needs_corrections) map to supervisor machine events. This mapping should be documented before P0 implementation.

### m5: Analyst confirmation behavior absent from runtime spec

SPEC-r7 §"Failure Modes" defines detailed confirmation behavior for destructive actions (ask before executing, handle amended requests, handle stale affirmations). This is Analyst-side behavior and doesn't need to be in agents.md, but it should be tracked as an implementation requirement for the Analyst handler.

### m6: `changed` card status and machine state interaction


The plan doesn't include `changed` card status in any machine state. The `changed` status (agents.md §4.2) is card status, not runner state, so it may not need a machine state. But the goal card machine needs to handle receiving a `subtree_changed` note when it next resumes, which affects the P0 goal card machine's context/event handling.

**Owner view**: that state should be added!

This is an state just for the parent agent planner to see. Besides that another implication is that a goal planner can not return done while it has child cards in state changed.

---

## Cross-Document Consistency Verification

| Aspect | SPEC-r7 | agents.md | goal-planning-runtime | operation.md | analyst.md | Verdict |
|--------|---------|-----------|----------------------|--------------|------------|---------|
| One active leaf | Implied | §3, §6, §15 explicit | "only the leaf does real work" | N/A | N/A | Consistent |
| AwaitingChild is session state, not card status | Not mentioned (internal) | §4.2, §5 explicit | Defers to agents.md | N/A | N/A | Consistent |
| activate_card = synchronous barrier | Not mentioned (internal) | §3, §11.1 explicit | "synchronous logical barrier" | N/A | N/A | Consistent |
| Pause = global gate | "canonical runtime control" | §5, §12 explicit | Consistent | N/A | N/A | Consistent |
| Force-cancel distinct from pause | "Abort" as separate action | §12 distinct | N/A | N/A | N/A | Consistent |
| Analyst = sole mutation surface | Core contract | §2, §15 invariant | "user-visible mutations are routed through the Analyst" | N/A | "sole mutating user control surface" | Consistent |
| UI = projection/read-only | Explicit | §2, §15 invariant | N/A | "does not independently start, stop, activate, or mutate" | Consistent | Consistent |
| Notification = queue-only, ephemeral | Explicit, detailed | §9 GoalContextNote types | N/A | N/A | "immutable delivery items" | Consistent (but see C1) |
| start_project = explicit command | "Start the project" | §11 explicit | "explicit runtime command" | N/A | N/A | Consistent |
| Document authority chain | Approved SPEC | Normative behavior | Summary, defers to agents.md | Route inventory only | Operator guide | Clean, explicit |

---

## Recommendations

1. **Resolve C1 first**: Update the card-scoped analyst tool definitions to remove `add_note`, `get_note`, `list_notes`, `mark_note_handled` and align with the SPEC's notification model. This is a product contract violation in the current code.

2. **Resolve C2**: Define the exact restart semantics. Either implement the SPEC's "re-plans from scratch" promise in the runtime, or update the SPEC to reflect that restart resets status and requires re-activation. Document the Analyst-level `restart_goal` tool distinct from `restart_card_or_subtree`.

3. **Track M1**: Write the `abort_goal_subtree` specification in agents.md, clarifying its relationship to the deferred cancel-cascade feature.

4. **Track M2**: The plan rewrite from functional invariants is already in progress. Add the specific items identified here (one-active-leaf in machine specs, pause vs force-cancel separation, `changed` status handling, process-wait state) to the rewrite scope.

5. **Track M3**: Add process-wait states to the goal card machine specification.

6. **Track M4**: Either specify role-based routing in agents.md or clarify that the Analyst resolves role-based addressing to card-based addressing before entering the runtime queue.

7. **Track m1-m6 as implementation issues** to be resolved before or during P0 implementation.