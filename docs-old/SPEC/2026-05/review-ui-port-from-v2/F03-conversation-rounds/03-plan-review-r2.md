# F03 - Conversation rounds / diagnostics / pairing - Plan review (r2)

Reviewer r2 for [03-plan-r2.md](03-plan-r2.md), checked against
the prior critique [03-plan-review-r1.md](03-plan-review-r1.md),
the previous draft [03-plan-r1.md](03-plan-r1.md), and the approved
design [02-design-r3.md](02-design-r3.md).

## Findings

No blocking findings.

The r2 plan addresses the r1 blocker. The missing backend producer
coverage is now made explicit in a binding inventory, the analyst
duplicate writer is removed from the architecture, every previously
called-out producer path receives a concrete `ActiveRuntime` stamp
source, compaction gets a clear kept-entry policy, and the plan adds
targeted backend tests for the formerly uncovered producers.

## Required item verification

1. **Explicit producer audit:** addressed. The plan adds the binding
   producer inventory in §2.5, requires the audit at commit 2b step
   10, and repeats the audit requirement in §5.1 for later commits.
   The inventory covers shared persistence writers, manual
   `AgentMessage` literals, schema parse points, compaction rewrites,
   and the `appendActivateCardToolResultOnce(...)` helper.

2. **Runtime resume context:** addressed. `runtime.ts` planner-resume
   context is listed as R-RT-1, stamped with
   `activeRuntime.stampUserMessage(plannerSessionId)`, implemented in
   commit 2b step 2, and covered by
   `src/__tests__/runtime/runtime.resume-context.test.ts`.

3. **Analyst path:** addressed. r2 chooses the reviewer-accepted
   option A: delete the local `readMessages(...)` / `appendMessage(...)`
   helpers in `analyst-handler.ts`, route writes through
   `session-persistence.appendMessage(...)`, require `ActiveRuntime`
   constructor injection, and cover all twelve analyst writers under
   R-AN-1..R-AN-12 plus `analyst-handler.stamping.test.ts`.

4. **Synthetic planner notes:** addressed. `analyst-stage6.ts` is
   listed as R-S6-1, receives a required `ActiveRuntime` argument,
   stamps via `stampUserMessage(plannerSessionId)`, and has a named
   test file.

5. **Fake-agent fixture appends:** addressed. `fake-agent.ts` is
   listed as R-FK-1, opens and closes a simulated assistant round,
   stamps fixture `tool_call` records with `stampInRound`, persists
   scalar `tool_call_id`, and has `fake-agent.stamping.test.ts`.

6. **Stale-session failure diagnostic:** addressed. `failActiveWorkerSessions(...)`
   is listed as R-SP-1, widened to accept `ActiveRuntime`, stamped
   with `stampPre(session.id)`, and covered by
   `session-persistence.stale-failure.test.ts`.

7. **`appendActivateCardToolResultOnce(...)`:** addressed. The helper
   is listed as R-SP-2, its two runtime callers are listed as R-RT-2
   and R-RT-3, the stamp is caller-supplied via `stampInRound`, and
   `session-persistence.activate-card.test.ts` covers the helper path.

8. **Compaction records and rewrite policy:** addressed. R-CP-1 and
   §2.6 specify that the new summary head uses
   `stampCompacted(sessionId)` / `r-compacted-N`, while kept entries
   preserve their original stamps. `replaceSessionMessages(...)` gets
   a schema-parse canary for every line, and
   `compaction.stamping.test.ts` covers the behavior.

9. **Remaining `agent-adapter.ts` callsites:** addressed. R-AD-1
   through R-AD-18 enumerate the recovery, force-final-answer,
   synthesised-envelope, model-recovered, final-text, diagnostic,
   and in-flight tool-message loop paths called out in r1. Commit 2b
   step 8 binds each to a concrete stamp source and closes assistant
   rounds on terminal paths.

10. **Backend tests for formerly missed producers:** addressed. §2.1
    adds one named test file per uncovered path, and commit 2b step 9
    requires each to assert the selected stamp source, schema parse,
    and JSONL readback.

11. **Accepted axes from r1:** addressed. Wire migration, frontend
    commit order, legacy store-machinery deletion, `AnalystChatPanel`
    chip swap, test coverage, and rollback remain aligned with r1's
    accepted direction. The `grep | wc -l` test-count check is now
    explicitly a reviewer aid rather than a CI gate.

## Non-blocking note

Commit 2a's prose has a small internal wording conflict around root
typecheck status: the table initially marks 2a as compiling, while
the architecture-first note and §5.1 correctly describe 2a as the
single intentional root-typecheck gap, closed by commit 2b in the
same PR. This does not block approval because the binding validation
rule is clear by the end of §4 and §5.1: root CI must be green from
2b onward and at branch tip.

## Recommendation

Approve r2. The single r1 blocker is resolved, the plan now has an
auditable producer-by-producer backend stamping contract, and the
remaining implementation sequence stays consistent with the approved
F03 design and the workspace's architecture-first/no-compatibility
rule.

VERDICT: APPROVED