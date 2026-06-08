# Analyst `changed` propagation — design context

## Goal (operator-agreed)

When the analyst edits a card's objective fields on a running Saivage v3
system, the runtime must propagate a `changed` marker **up the direct
ancestor path** of the edited card, flipping each **resting** ancestor to
`changed` and **stopping at the first live (`running`) ancestor** (the
"active node"). Every live planner above the stop point receives a note
describing the change so it can decide whether to re-schedule the affected
subtree. No special-cased cancellation operation: cancellation becomes
"edit objective -> planner reacts -> planner re-activates or `cancel_card`s",
and the acceptance gate guarantees a goal cannot falsely report `done` while
a non-terminal descendant remains.

## Agreed model (Option A)

1. **Flip set.** Walk parent pointers from the edited card toward the
   project root. For each ancestor whose status is a resting state
   (`done`, `failed`, `cancelled`, `blocked`), transition it to `changed`.
   Stop at the first ancestor whose status is `running` (it is on the live
   call stack). That live node and everything above it keep their status.
2. **Never flip live cards.** `running` ancestors and the active leaf are
   never set to `changed`; that would corrupt the call-stack invariant
   (`active_card_run` + activation ledger assume ancestors hold `running`
   while they have an unresolved `activate_card`).
3. **Direct ancestor path only.** Siblings off the path are not flipped.
4. **Note fan-out.** Every planner on the ancestor chain above the stop
   point receives a synthetic note: "descendant `X` changed (was
   `<previous_status>`); consider re-scheduling." Notes carry the previous
   status (critical for previously `cancelled`/`done` cards).
5. **Completion gate.** A goal cannot `report_goal_done` until every
   descendant is in a terminal status. (Today the gate only rejects
   `blocked`/`changed` descendants.)

## Edge cases to resolve in the design

- Edited card is the active executor leaf.
- Edited card is a goal currently under review (`phase: 'reviewer'`).
- Edited card / an ancestor contains the active leaf.
- Re-legalizing terminal -> `changed` transitions in the state machine.

## Review process

- Writer model: Opus (`github-copilot/claude-opus-4.8`).
- Reviewer model: independent Opus subagent with a fresh, adversarial
  reviewer prompt (Gemini 3.1 Pro was requested but is not drivable from the
  desktop-app runtime; see session notes).
- Output documents: `01-analysis.md`, `02-design.md`, `03-plan.md`, each
  gated by an APPROVED marker.

## Locked decisions (operator-confirmed across iterations)

- **D1 (flip set).** Flip to `changed` only for resting statuses
  `{done, failed, cancelled, blocked}`. Never flip a `running` card (live
  ancestor or active executor leaf) — note only, no state change.
- **D2 (walk).** Walk the direct ancestor path from the edited card upward;
  flip resting ancestors; stop the flip at the first `running` ancestor;
  siblings off-path untouched.
- **D3 (transitions).** Make `done/failed/cancelled -> changed` first-class
  `VALID_TRANSITIONS` entries; route flips through `setStatus`; migrate the
  reviewer retry-exhaustion flip off `repairTerminalLifecycle` onto the
  single reviewer path.
- **D4 (notes).** Queue a note for every planner on the ancestor chain above
  the stop point. `previous_status` is a best-effort secondary hint,
  first-captured-wins on dedup collisions (no dedup-key change).
- **D5 (completion gate).** `report_goal_done` rejects when any descendant is
  non-terminal. Terminal = `{done, failed, cancelled}` (`isTerminalState`).
  `failed` is an acceptable terminal for parent closure.
- **D6' (replaces original D6).** Drop the analyst "discard in-flight review"
  approach. Instead: on reviewer completion the runtime checks for pending
  synthetic notes for the goal's **own** planner; if any exist, it resumes the
  goal's own planner (carrying the notes + the review result) instead of
  unwinding to the parent. The analyst edit during review just persists +
  queues the note; no `active_card_run` mutation from the analyst path, no new
  resume-reason enum.
- **D7 (surface).** Only the analyst surface triggers the ancestor walk+flip.
  Planner-invoked `edit_card` (a separate dispatch path) is unchanged.
- **D8 (remove `active`).** Remove the redundant `active` card status (Finding
  A): it is a transient intermediate the state machine overwrites with
  `running` in the same operation; no consumer distinguishes them.
- **D9 (single reviewer).** Delete the synchronous in-tool reviewer; keep the
  async `RuntimeReviewerDispatcher` as the sole reviewer owner (Findings B/C),
  because it is the only path consistent with "the runtime is the only
  dispatcher", the activation ledger, restart recovery, the planner lifecycle,
  and the `correction_attempts` retry model.
- **D10 (remove `drafting`).** Remove the `drafting` card status. It is a
  pre-backlog shaping state the planner does not meaningfully handle; new cards
  default to `backlog`, cancelled cards reopen through `backlog`, and no direct
  `drafting` lifecycle remains.

## Authority

`docs/agents.md` is the current architecture authority. `AGENTS.md`
architecture principles apply: clean architecture, no backward
compatibility, no migration shims, fail fast on impossible states, remove
dead code, brave refactoring.
