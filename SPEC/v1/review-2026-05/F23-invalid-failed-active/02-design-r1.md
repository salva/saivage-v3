# F23 — Design (r1)

## Closure-mode

Implementation is **owned by [F19 r5](../F19-runtime-pinned-failed-card/02-design-r5.md)**. F23 contributes the acceptance contract:

1. After F19 r5 Step 5 merges, `errors.jsonl` on the LXC harness contains **zero** `Invalid transition: failed → ...` lines for any subsequent runtime turn — verified by Probe-C and by an integration test (see [03-plan-r1.md](03-plan-r1.md)).
2. The orchestrator's retry path for a `failed` card goes through `RuntimeStateMachine.transitionCard(card.id, 'restart', { goalId })`, which decomposes `failed → backlog → active → running` via three legal one-step writes (per F19 r5 design action table). No direct `failed → active` write is emitted by the runtime.
3. The planner-supplied `failed → active` case at [src/runtime/runtime.ts L766-L782](../../../../src/runtime/runtime.ts#L766) is rejected by `transitionCard(id, 'planner_set_status', { requestedStatus: 'active' })` with one `state_machine_planner_status_rejected` log line and zero card writes (F19 r5 design action table; r5 test contract `planner_set_status active → failed is rejected`-style cases).

No new module, no new action, no new permission rule. The F19 r5 binding rules (every machine call awaited; every follow-up `cardStore.update` awaited; Step 7 multiline `rg` gate) cover the F23 surface verbatim.
