# Final Verification Pass (Round 4): `01-analysis.md` (Analyst `changed` Propagation)

Reviewer role: adversarial final-verification checker. Round 3 confirmed the
**B5 constraint** was adequately stated and **all B5 mechanism claims were
TRUE**, but raised **B6**: the prior illustrative trace falsely asserted a
queued `pending_subtree_correction` note survives an intervening
*re-activation of the goal* (it does not — re-activating the goal runs its
planner, which drains the note via `planner-phase-runner.ts:65`). The trace
has been rewritten. This pass verifies **only** that the rewritten trace is
technically correct and introduces no new error. B5 constraint language, NB1,
and all previously-approved items were not re-litigated; I confirmed only that
the rewrite did not regress them.

Every claim below was re-verified against source on disk:
`src/runtime/phases/planner-phase-runner.ts`,
`src/runtime/phases/planner-iteration-runner.ts`,
`src/runtime/synthetic-planner-notes.ts`, `src/agents/analyst-stage6.ts`,
`src/tools/analyst-card-tools.ts`, `src/cards/lifecycle-commands.ts`,
`src/cards/card-patch-service.ts`, `src/cards/lifecycle.ts`,
`src/runtime/runtime-goal-context.ts`, `src/agents/agent-adapter.ts`,
`src/runtime/phases/planner-activation-runner.ts`,
`src/agents/planner-control-executor.ts`.

The rewritten trace (§4.3 lines 317-337) now claims the reachable collision
window is: two producer calls targeting the **same planner session** with the
same `(kind, affected_card_id, summary)` and **no intervening turn of that
target session**, instantiated as a `subtree_changed` note for descendant D
routed to an **ancestor** planner `planner:P` that is **not** re-run in the
window, with two `edit_card(D)` calls touching the **same field names**.

Up-front verdict: the rewritten trace is **technically sound** and introduces
**no new factual error**. The B6 defect (survival across re-activation) is
**removed**: the trace now explicitly constructs a window in which the target
planner does not take a turn, which is exactly the real drain semantics.

---

## Source verification of the rewritten trace (all TRUE)

1. **Drain is real and happens only on a planner turn.**
   `planner-phase-runner.ts:65` calls `this.deps.injectSyntheticPlannerNotes(input.goalId)`
   **unconditionally**, immediately before `invokePlanner` (`:66`). The wiring
   (`planner-iteration-runner.ts:54-55`) routes it to
   `goalContext.injectQueuedPlannerNotes(\`planner:${cardId}\`)`. The trace
   correctly **avoids** re-running the target session, so this drain never
   fires for `planner:P` in the window. **TRUE.**

2. **`injectQueuedSyntheticPlannerNotes` drains by `target_planner_session_id`.**
   `synthetic-planner-notes.ts:79-90`: filters `note.target_planner_session_id
   === plannerSessionId` (`:81`), appends one synthetic user message, then
   removes the injected ids (`:85-88`). Dedup key (`:54`) is
   `(target_planner_session_id, kind, affected_card_id, summary)` and excludes
   `previous_status` (which is not even a field in the shape, `:10-19`); on a
   hit it `return existing` (`:55`). A `subtree_changed` note for a descendant
   routes to the deepest containing planner via `findDeepestContainingPlanner`
   (`:33-50`), keyed on hierarchy containment + `role === 'planner'` + greatest
   `card.depth`, **independent of card status**. **TRUE.**

3. **`subtree_changed` kind + summary.** `analyst-stage6.ts:80` picks
   `'subtree_changed'` when `affectedCardId !== routed.goalId`; for descendant
   D routed to ancestor P, D ≠ P, so kind is `subtree_changed` on both edits.
   `edit_card` summary is `analyst edited card fields:
   ${Object.keys(changes).join(', ')}` (`analyst-card-tools.ts:123`). **TRUE.**

4. **Collision key identity.** Both edits produce
   `(planner:P, subtree_changed, D, "analyst edited card fields: <same names>")`.
   target is stable (D's position under P does not change, and routing ignores
   D's status), kind is stable, affected_card_id = D, summary identical for the
   same field set. `queueSyntheticPlannerNote` returns the first note,
   retaining its stale `previous_status`. **TRUE.**

5. **Editing D does NOT run planner:P (key logical claim).** `edit_card` ->
   `store.mutateCard` -> `CardLifecycleCommands.mutateCard`
   (`lifecycle-commands.ts:126`) -> `applyPatch` (`card-patch-service.ts:35-78`).
   That path only prunes/validates/persists the patch and enqueues a
   best-effort `card_changed` operator notification (`:65-76`); it performs
   **no** planner invocation, **no** activation, and calls **none** of
   `injectQueuedSyntheticPlannerNotes` / `drainSyntheticPlannerNotes` /
   `consumeChangedCardActivation`. So `planner:P`'s queue is not drained by an
   edit of D. **TRUE.**

6. **Nothing in the edit_card path drains planner:P's notes (explicit check).**
   Exhaustive call-site audit of the drain/inject/consume functions:
   `injectSyntheticPlannerNotes` -> `planner-phase-runner.ts:65` (planner turn);
   `injectQueuedSyntheticPlannerNotes` -> `agent-adapter.ts:296` (inside
   `invokePlanner`), `runtime-goal-context.ts:71`, `runtime-pause-resume.ts:42`;
   `consumeChangedCardActivation` -> `planner-activation-runner.ts:31`,
   `planner-control-executor.ts:154` (both are *activation* paths and clear only
   `subtree_changed` for the activated card). **None** are reachable from
   `edit_card`/`mutateCard`/`applyPatch`. Only a planner turn of P drains P's
   queue. **TRUE.**

7. **No NEW factual error in the rewrite.** Cross-checks:
   - The "general form" parenthetical (`:334-337`) — same-session repeated
     `edit_card` with no intervening planner turn, and `subtree_changed` routed
     to an ancestor the edits do not re-run — is consistent with the verified
     drain semantics. **No overreach.**
   - The flip "D (`cancelled`) -> `changed`" is attributed to "the producer",
     i.e. the proposed flip-and-notify design (the same design that adds
     `previous_status`). This is the document's *required* behavior, whose gap
     table (`:483`) and §2.3 (`:110-112`) explicitly note `cancelled -> changed`
     must be legalized; it is **not** a claim about current `edit_card`, which
     §4.1 correctly says does not flip. Internally consistent with §4.3's
     hypothetical-design framing. **Not an error.**
   - Routing stability across both edits holds because
     `findDeepestContainingPlanner` ignores D's status (`:33-41`); the flip to
     `changed` does not re-route. **No error.**
   - `consumeChangedCardActivation(D)` (which would discard the `subtree_changed`
     note) is **not** triggered, because the trace edits D rather than
     activating it. **No error.**
   - Residual wording scan: the only `re-run`/`re-activat` tokens in the trace
     region (`:325`, `:337`) now correctly assert planner:P is **not** re-run.
     The old "survives an intervening re-activation" claim is **gone**.

---

## BLOCKING

None. The rewritten trace is technically correct against the cited code and
introduces no new factual error. B6 is resolved: the collision window no
longer spans a planner re-activation of the target session.

---

## NON-BLOCKING

### NB1. `previous_status`/flip are proposed-design behavior (clarity, optional)

The trace narrates a producer that both captures `previous_status` and flips
`cancelled -> changed`; neither exists in current `edit_card` (§4.1). The
surrounding §4.3 framing makes the hypothetical-design context clear, and the
hazard reasoning is valid within it, so this is not an error. A half-sentence
tying the trace's "producer" explicitly to "the proposed flip-and-notify +
`previous_status` design" would remove any chance of a reader mistaking it for
current behavior. Purely editorial.

### NB2. `unconditionally` qualifier (carryover precision, unchanged)

§4.3 line 320 still describes the target-session drain trigger as the next
planner turn that "unconditionally injects/drains". Accurate for
`planner-phase-runner.ts:65` (the inject call is unconditional). No change
needed.

### NB3. No regression in previously-approved items

Spot-checked that the trace rewrite did not disturb the B5 constraint
sentences (§4.3 `:339-343`, §8 `:519-528`, §7 `:485`), the two-projection-site
NB1 point (§4.3 `:346-356`), §2.4 ordering, §3 authority contradiction, §2.5
ledger rationale, §4.4 consumption constraint, and §4.6 reviewer second
producer. All read unchanged and remain correctly grounded. No regression.

---

## Net assessment

- The rewritten trace's collision window — two `edit_card(D)` calls with the
  same field names, `subtree_changed` routed to ancestor `planner:P`, and no
  intervening turn of `planner:P` — is **technically sound** against source.
- The key logical claim verifies: editing D goes through
  `edit_card -> mutateCard -> applyPatch` and never runs or drains `planner:P`;
  only a planner turn of P drains P's queue
  (`planner-phase-runner.ts:65` / `agent-adapter.ts:296`).
- B6 is **resolved** with **no new factual error**; the underlying B5 hazard
  remains genuinely reachable. No regression in previously-approved content.

---

VERDICT: APPROVED
