# Impossible-State Support Review

Date: 2026-06-07

Scope: Saivage v3 runtime and adjacent agent/session control-flow. This is a review inventory, not an implementation plan. The working rule for this review is that normal runtime paths should fail loudly when they reach states that should be impossible under the current architecture. Startup-only repair paths are listed separately when they look too broad or contradictory.

## Summary

The strongest normal-path concerns are live invariant correction during ticks, activation unwind fallbacks, transition helpers returning benign values for missing/corrupt state, and model/tool argument parsing that normalizes malformed protocol data to `{}`. Several compatibility overloads and session lookup fallbacks also preserve old or incomplete invocation shapes that weaken current invariants.

## Normal-Path Findings

### F01. Runtime tick silently drops overlapping ticks

- Evidence: [`src/runtime/state-machine.ts#L156-L158`](../../src/runtime/state-machine.ts#L156-L158)
- Category: impossible scheduler state tolerated
- Severity: medium
- Finding: `tick()` returns when `_tickInFlight` is true.
- Why it matters: overlapping ticks in a sequential runtime should expose scheduler/reentrancy bugs instead of being dropped silently. If this guard is intentionally a concurrency lock, it should be treated as a scheduling boundary with explicit accounting rather than an invisible no-op.

### F02. Card transition helper logs missing cards and returns `false`

- Evidence: [`src/runtime/state-machine.ts#L182-L192`](../../src/runtime/state-machine.ts#L182-L192)
- Category: corrupt dispatch/card state tolerated
- Severity: high
- Finding: `transitionCard()` logs `state_machine_card_not_found` and returns `false` when the target card does not exist.
- Why it matters: runtime card transitions should only target persisted cards. A missing card means the dispatcher, card store, or runtime state is corrupt; returning `false` lets callers decide whether to continue.

### F03. Live tick path repairs runtime invariants

- Evidence: [`src/runtime/state-machine.ts#L217-L230`](../../src/runtime/state-machine.ts#L217-L230), [`src/runtime/runtime-core.ts#L372-L397`](../../src/runtime/runtime-core.ts#L372-L397)
- Category: normal-path repair
- Severity: high
- Finding: invariant observation patches live runtime state: running with no active run becomes idle, idle with an active run becomes running, and terminal active cards clear the active run.
- Why it matters: these are state-machine violations in normal operation. Patching during every tick masks the writer that produced the impossible state.

### F04. Active-card status read failure becomes `null`

- Evidence: [`src/runtime/state-machine.ts#L221-L225`](../../src/runtime/state-machine.ts#L221-L225)
- Category: corrupt active-run/card-store relation tolerated
- Severity: high
- Finding: if reading the current active card status throws, the invariant checker receives `null`.
- Why it matters: an active run whose card cannot be read is invalid runtime state. Normalizing it to unknown prevents fail-fast diagnosis.

### F05. Project-root redispatch failures are swallowed

- Evidence: [`src/runtime/state-machine.ts#L233-L239`](../../src/runtime/state-machine.ts#L233-L239)
- Category: silent normal-path failure
- Severity: high
- Finding: `maybeRedispatchProjectRoot()` catches redispatch errors and discards them.
- Why it matters: redispatch is part of keeping a running intent active. Swallowing failure can leave runtime intent and active work inconsistent without a hard failure.

### F06. `reviewer_started` permits a null active run

- Evidence: [`src/runtime/runtime-core.ts#L346-L349`](../../src/runtime/runtime-core.ts#L346-L349)
- Category: impossible transition tolerated
- Severity: high
- Finding: `reviewer_started` sets status to `running` with `payload.activeCardRun ?? null`.
- Why it matters: a reviewer start without an active run should be invalid. This can directly create `running` with no active run, which is later repaired by invariant correction.

### F07. `completeActivation` silently ignores missing activation state

- Evidence: [`src/runtime/mutations.ts#L89-L99`](../../src/runtime/mutations.ts#L89-L99)
- Category: activation ledger violation tolerated
- Severity: high
- Finding: `reduceActivationCompletion(...) ?? current` turns failed activation completion reduction into a no-op.
- Why it matters: completing a child without an unresolved activation is a core ledger violation. Ignoring it can lose child completion and leave parent/child state inconsistent.

### F08. Reviewer pass proceeds when the goal card is missing

- Evidence: [`src/runtime/phases/reviewer-assessment-handler.ts#L52-L71`](../../src/runtime/phases/reviewer-assessment-handler.ts#L52-L71), [`src/runtime/phases/reviewer-assessment-handler.ts#L86-L88`](../../src/runtime/phases/reviewer-assessment-handler.ts#L86-L88)
- Category: missing authoritative card tolerated
- Severity: high
- Finding: if `latestGoalCard` is missing, reviewer pass skips `commitReviewerPass()` but still unwinds/emits completion.
- Why it matters: a reviewer cannot validly pass a missing goal card. Emitting completion without committing lifecycle can split runtime truth from card truth.

### F09. Child-goal reviewer completion falls back to global reviewer finish when unwind fails

- Evidence: [`src/runtime/phases/reviewer-assessment-handler.ts#L72-L84`](../../src/runtime/phases/reviewer-assessment-handler.ts#L72-L84)
- Category: activation/session linkage tolerated
- Severity: high
- Finding: non-project reviewer pass calls `appendChildUnwindToolResult()`, but if it returns false, the code transitions `reviewer_finished` globally.
- Why it matters: a reviewed child goal should have a parent activation edge in normal runtime. Falling back hides orphaned activation or parent-session bugs.

### F10. Activation unwind returns `false` instead of failing on missing caller edge

- Evidence: [`src/runtime/activation-unwind.ts#L54-L68`](../../src/runtime/activation-unwind.ts#L54-L68)
- Category: parent activation edge absence tolerated
- Severity: high
- Finding: `completeChildActivationForParent()` returns `false` when no caller edge exists.
- Why it matters: child activation completion normally requires a parent `activate_card` caller edge. A boolean false branch makes orphan completion a supported outcome.

### F11. Caller-edge reconstruction falls back to synthesized session ids

- Evidence: [`src/runtime/activation-unwind.ts#L70-L81`](../../src/runtime/activation-unwind.ts#L70-L81)
- Category: compatibility/synthesis fallback
- Severity: medium
- Finding: missing parent session uses `planner:${parentCardId}` as the caller session id, and missing parent/call becomes `null`.
- Why it matters: activation caller edges should be durable facts. Synthesizing a session id can hide broken session creation or binding.

### F12. Assistant tool-call argument parse failures become `{}`

- Evidence: [`src/agents/invocation-runner.ts#L212-L235`](../../src/agents/invocation-runner.ts#L212-L235)
- Category: provider/model protocol failure normalized
- Severity: high
- Finding: malformed JSON or non-object tool arguments are persisted as empty args.
- Why it matters: the transcript no longer reflects the model's actual invalid output, and downstream verifier/repair/debug code sees `{}` instead of the malformed value.

### F13. Malformed planner `activate_card` tool result falls through as ordinary result

- Evidence: [`src/agents/invocation-runner.ts#L253-L270`](../../src/agents/invocation-runner.ts#L253-L270)
- Category: internal tool/result corruption tolerated
- Severity: high
- Finding: malformed activation tool result JSON sets `activation = null`; the code then appends the tool result normally.
- Why it matters: `activate_card` producing a malformed result is an internal invariant violation. Falling through can let the planner continue without dispatching the activation barrier.

### F14. Agent loop reports unexpected internal state as cancellation

- Evidence: [`src/agents/agent-loop-driver.ts#L82-L89`](../../src/agents/agent-loop-driver.ts#L82-L89), [`src/agents/agent-loop-driver.ts#L180-L193`](../../src/agents/agent-loop-driver.ts#L180-L193)
- Category: internal state-machine bug reported as normal cancellation
- Severity: medium
- Finding: if the loop is non-terminal but not `agent_turn`, it breaks and returns `{ kind: 'cancelled', reason: 'abort' }`.
- Why it matters: unexpected loop state should be impossible. Reporting it as cancellation hides state-machine corruption behind an operator/provider-like outcome.

### F15. Terminal tool args that are non-object JSON become `{}`

- Evidence: [`src/agents/contract-verifier.ts#L72-L85`](../../src/agents/contract-verifier.ts#L72-L85)
- Category: contract violation normalized
- Severity: high
- Finding: valid JSON that is not a plain object is accepted as `ok` with empty args.
- Why it matters: arrays, strings, and null terminal args are invalid terminal envelopes. The verifier should preserve and reject the actual malformed value rather than checking `{}`.

### F16. Analyst tool-call argument parse failures become `{}` and may execute

- Evidence: [`src/agents/analyst-handler.ts#L224-L231`](../../src/agents/analyst-handler.ts#L224-L231)
- Category: provider/model protocol failure normalized
- Severity: high
- Finding: analyst tool-call argument parse failures are logged diagnostically but converted to empty args.
- Why it matters: analyst tools may execute with default/empty parameters, and the persisted tool-call row hides the malformed original arguments.

### F17. Tool boundary pruning hides corrupt session transcripts

- Evidence: [`src/agents/context-compactor.ts#L71-L99`](../../src/agents/context-compactor.ts#L71-L99)
- Category: transcript corruption normalized
- Severity: medium
- Finding: `pruneToolBoundary()` drops orphan `tool_call`, `tool_result`, and `tool_error` rows.
- Why it matters: a valid persisted transcript should not contain unmatched tool boundaries in normal operation. Pruning lets the model continue with missing evidence instead of surfacing session-log corruption.

### F18. Duplicate unresolved `activate_card` calls choose the newest call

- Evidence: [`src/runtime/session-persistence.ts#L410-L433`](../../src/runtime/session-persistence.ts#L410-L433)
- Category: duplicate activation tolerated
- Severity: high
- Finding: multiple unresolved `activate_card(childCardId)` calls are handled by choosing the most recent, with comments saying older duplicates are harmless.
- Why it matters: duplicate unresolved activation calls should be an invariant violation. Leaving older calls unresolved weakens activation/session guarantees.

### F19. Planner session lookup scans for fallback sessions

- Evidence: [`src/runtime/session-persistence.ts#L436-L444`](../../src/runtime/session-persistence.ts#L436-L444)
- Category: compatibility fallback
- Severity: medium
- Finding: `findPlannerSessionForCard()` first tries deterministic `planner:${cardId}`, then scans sessions and chooses the latest matching planner.
- Why it matters: if planner identity is now deterministic, the scan supports historical or duplicate session shapes and makes behavior timestamp-dependent.

### F20. Public agent invocation overloads synthesize incomplete contracts

- Evidence: [`src/agents/agent-adapter.ts#L291-L310`](../../src/agents/agent-adapter.ts#L291-L310), [`src/agents/agent-adapter.ts#L329-L352`](../../src/agents/agent-adapter.ts#L329-L352), [`src/agents/agent-adapter.ts#L362-L392`](../../src/agents/agent-adapter.ts#L362-L392)
- Category: backward-compatibility/incomplete context
- Severity: medium
- Finding: string-based overloads create contracts with placeholder context such as `parentSessionId: ''`, missing `goalId` defaulting to `''`, and `assessmentId: ''`.
- Why it matters: normal runtime invocation should use structured request objects with complete contract context. These overloads preserve incomplete call shapes.

### F21. Reinvocation can use empty card/goal ids

- Evidence: [`src/agents/agent-adapter.ts#L414-L441`](../../src/agents/agent-adapter.ts#L414-L441)
- Category: corrupt persisted session tolerated
- Severity: high
- Finding: the review identified `reinvokeSession()` fallback behavior that substitutes empty strings when session card/goal metadata is missing.
- Why it matters: executor/reviewer sessions should have required goal/card identity. Reinvocation should fail on missing metadata, not create contracts with empty identifiers.
- Follow-up: none; the empty-string fallbacks are in the cited range.

### F22. Session message log invents fallback round stamps

- Evidence: [`src/agents/session-message-log.ts#L21-L60`](../../src/agents/session-message-log.ts#L21-L60)
- Category: missing authoritative session-stamper ownership tolerated
- Severity: medium
- Finding: `SessionMessageLog` owns fallback round ids and block counters, and stamps messages when no runtime stamper is provided.
- Why it matters: if runtime/session ordering is supposed to be owned by a single stamper/lifecycle, this fallback can hide missing round ownership and produce chronology detached from runtime activity semantics.

### F23. Handoff summary swallows persistence errors

- Evidence: [`src/agents/agent-session-coordinator.ts#L77-L104`](../../src/agents/agent-session-coordinator.ts#L77-L104)
- Category: operator-facing state disappearance
- Severity: medium
- Finding: handoff summary construction catches all errors and returns `null` or `[]`.
- Why it matters: invalid active sessions or message-read failures become “no handoff” instead of visible corrupted runtime/session state.

### F24. Planner phase re-blocks from persisted blocked-planning metadata

- Evidence: [`src/runtime/phases/planner-phase.ts#L156-L164`](../../src/runtime/phases/planner-phase.ts#L156-L164)
- Category: repair-era metadata leaks into normal path
- Severity: medium
- Finding: normal planner post-dispatch logic blocks if current card state contains blocked-planning metadata.
- Why it matters: stale `planner_blocked` lifecycle metadata can dominate a fresh planner turn, even when the card has been reactivated or is otherwise in a current normal planning path.

### F25. Runtime state invariant allows idle with terminal active run records

- Evidence: [`src/runtime/state.ts#L55-L80`](../../src/runtime/state.ts#L55-L80)
- Category: persistence invariant too permissive
- Severity: medium
- Finding: the review identified that state persistence permits `status: 'idle'` with a non-null `active_card_run` when the run status is terminal.
- Why it matters: most runtime logic treats idle as no active run. Keeping terminal run identity in `active_card_run` weakens the core invariant and supports stale current-run identity.

## Startup-Only Or Repair-Path Findings

### R01. Startup executor-interrupted path reports terminal child as failed

- Evidence: [`src/runtime/startup-repair.ts#L33-L42`](../../src/runtime/startup-repair.ts#L33-L42), [`src/runtime/startup-repair.ts#L210-L229`](../../src/runtime/startup-repair.ts#L210-L229)
- Category: startup repair contradicts card truth
- Severity: high
- Finding: executor active runs are classified as `executor_interrupted` before the generic terminal-active-card case. If the card is already terminal, `shouldFailCard` is false, but the path still appends a failed child-unwind result.
- Why it matters: a restart after executor terminal commit but before runtime state settled is possible. Reporting that completed terminal child as failed can poison the parent planner transcript.

### R02. Startup blocked-planning alignment trusts stale blocker metadata over terminal status

- Evidence: [`src/runtime/startup-blocked-planning.ts#L18-L42`](../../src/runtime/startup-blocked-planning.ts#L18-L42)
- Category: broad startup repair
- Severity: high
- Finding: startup scans project/goal cards and forces any card with blocked-planning metadata into `blocked`, regardless of current status.
- Why it matters: a card with blocked-planning lifecycle metadata but terminal status is internally contradictory. Startup should fail closed or apply a narrower provenance check rather than blindly trusting stale blocker data.

### R03. Startup reconciliation broadly closes open runs when runtime is idle

- Evidence: [`src/runtime/runtime-core.ts#L542-L597`](../../src/runtime/runtime-core.ts#L542-L597), [`src/runtime/runtime-startup.ts#L86-L94`](../../src/runtime/runtime-startup.ts#L86-L94)
- Category: broad startup reconciliation
- Severity: medium
- Finding: startup reconciliation closes all open running runs when runtime state is idle/no active run; non-root runs are failed with an idle-runtime reason.
- Why it matters: open child/non-root runs without active run or parent restoration may indicate ledger corruption. Broad closure masks the underlying violation.

## Non-Findings Or Likely Legitimate Recovery

- Provider/model retry and candidate cooldown in `src/agents/invocation-runner.ts` are recovery for external failures, not impossible internal state support.
- Analyst LLM unavailability returning a user-facing offline message is service degradation handling.
- Context summarizer failure falling back to truncation may be acceptable if liveness during context pressure is a product requirement, but `pruneToolBoundary()` inside compaction remains suspicious because it normalizes transcript corruption.
- Explicit startup repair modules are expected to handle some inconsistent persisted state after process death; the issue is when their behavior is broad, contradictory, or leaks into normal runtime paths.

## Suggested Review Order

1. Activation ledger and reviewer unwind issues: F07-F11.
2. Live invariant correction and state-machine no-op/error swallowing: F01-F06.
3. Tool/contract parse normalization: F12-F16.
4. Session/compatibility fallbacks: F18-F23.
5. Startup-only repair contradictions: R01-R03.
6. Transcript pruning and planner-blocked metadata behavior: F17, F24-F25.
