# Impossible-State Support Review

Date: 2026-06-07

Scope: Saivage v3 runtime and adjacent agent/session control-flow. This is a review inventory, not an implementation plan. The review was reconciled against the adversarial review in `docs/design/impossible-state-support-review-adversarial.md` and the current code.

Working rule: normal runtime paths should fail loudly when they reach states that should be impossible under the current architecture. Startup repair may handle persisted state left by process death, but it should be narrow, explicit, and should not contradict authoritative card/runtime truth. Backward compatibility has no design value here.

## Summary

The strongest confirmed concerns are live invariant correction during normal ticks, fallback/synthesis in activation and session identity paths, transition results that allow callers to continue after missing/corrupt state, broad defaulting when constructing active-run snapshots, and stale-card fallback during executor completion. Some earlier candidates were removed or reframed: the tick reentrancy guard is legitimate scheduler protection, tool-boundary pruning is legitimate after intentional truncation, and malformed model output is external protocol input rather than internal impossible state, though normalizing it to `{}` is still harmful.

## Confirmed Normal-Path Findings

### C01. Live tick path repairs runtime invariants

- Evidence: `src/runtime/state-machine.ts#L217-L230`, `src/runtime/runtime-core.ts#L372-L397`
- Category: normal-path repair
- Severity: critical
- Finding: invariant observation patches live runtime state: running with no active run becomes idle, idle with an active run becomes running, and terminal active cards clear the active run.
- Why it matters: these are state-machine violations in normal operation. Patching during every tick masks the writer that produced the impossible state. This is the root architectural issue behind several smaller symptoms.
- Fix direction: remove live correction from the tick path after making the transition/event reducers fail fast at their input boundaries. Keep invariant observation as assertion/diagnostic only.

### C02. Active-card status read failure becomes `null`

- Evidence: `src/runtime/state-machine.ts#L221-L225`
- Category: corrupt active-run/card-store relation tolerated
- Severity: high
- Finding: if reading the current active card status throws, the invariant checker receives `null`.
- Why it matters: an active run whose card cannot be read is invalid runtime state. Normalizing it to unknown prevents fail-fast diagnosis.
- Fix direction: let the read error propagate or throw a runtime invariant error that includes the active run id/card id.

### C03. Project-root redispatch failures are swallowed

- Evidence: `src/runtime/state-machine.ts#L233-L239`
- Category: silent normal-path failure
- Severity: high
- Finding: `maybeRedispatchProjectRoot()` catches redispatch errors and discards them.
- Why it matters: redispatch is part of keeping a running intent active. Swallowing failure can leave runtime intent and active work inconsistent without a hard failure.
- Fix direction: propagate the error or transition the runtime into an explicit failed/frozen state with the error recorded.

### C04. `reviewer_started` permits a null active run

- Evidence: `src/runtime/runtime-core.ts#L346-L349`
- Category: impossible transition tolerated
- Severity: high
- Finding: `reviewer_started` sets status to `running` with `payload.activeCardRun ?? null`.
- Why it matters: a reviewer start without an active run should be invalid. This can directly create `running` with no active run, which is later repaired by invariant correction.
- Fix direction: require a non-null active run for `reviewer_started`; throw on missing or malformed payload.

### C05. Card transition failure is left to callers, and several callers do not enforce it

- Evidence: `src/runtime/state-machine.ts#L182-L214`, representative callers in `src/runtime/terminal-commit/commit-planner.ts#L18-L63`, `src/runtime/terminal-commit/commit-reviewer.ts#L21-L59`, `src/runtime/terminal-commit/commit-executor.ts#L46-L124`
- Category: corrupt dispatch/card state tolerated by call sites
- Severity: high
- Finding: `transitionCard()` returns `false` for missing or illegal card transitions. Returning a boolean is not itself the bug; the bug is that normal terminal-commit paths can turn transition failure into a handled receipt/result instead of failing the runtime path.
- Why it matters: runtime card transitions should only target persisted cards in legal states. A missing or illegal transition means the dispatcher, card store, or runtime state is corrupt.
- Fix direction: either make `transitionCard()` throw for impossible runtime transitions or require terminal-commit callers to throw when the returned receipt indicates rejection.

### C06. Activation completion mutation silently ignores missing activation state

- Evidence: `src/runtime/mutations.ts#L89-L99`, reducer in `src/runtime/runtime-core.ts#L666-L728`
- Category: activation ledger violation tolerated
- Severity: high
- Finding: `reduceActivationCompletion(...) ?? current` turns a failed completion reduction into a no-op.
- Why it matters: completing a child without an unresolved activation is a core ledger violation. The reducer may validly return `null` as a failure signal, but the mutation layer must not erase that signal.
- Fix direction: make the mutation throw when the reducer returns `null` for a normal completion request.

### C07. Reviewer pass proceeds when the goal card is missing

- Evidence: `src/runtime/phases/reviewer-assessment-handler.ts#L52-L71`, `src/runtime/phases/reviewer-assessment-handler.ts#L86-L88`
- Category: missing authoritative card tolerated
- Severity: high
- Finding: if `latestGoalCard` is missing, reviewer pass skips `commitReviewerPass()` but still unwinds/emits completion.
- Why it matters: a reviewer cannot validly pass a missing goal card. Emitting completion without committing lifecycle can split runtime truth from card truth.
- Fix direction: throw if the reviewed goal card cannot be read.

### C08. Reviewer child completion conflates activated-child unwind and direct reviewer dispatch

- Evidence: `src/runtime/phases/reviewer-assessment-handler.ts#L72-L84`, unwind helper in `src/runtime/activation-unwind.ts#L54-L68`
- Category: dispatch mode ambiguity
- Severity: high
- Finding: non-project reviewer pass tries to append a child unwind result; if no caller edge exists, it falls back to global `reviewer_finished`. This fallback was recently intentional for direct dispatch without activation edge, so the helper returning `false` is not by itself wrong. The problem is that the handler does not know whether the current reviewer run was activation-owned or direct-dispatched.
- Why it matters: an activation-owned child missing its parent edge should fail; a direct-dispatched reviewer without an activation edge may finish globally. The current boolean fallback treats both cases the same.
- Fix direction: carry explicit dispatch/activation ownership into the reviewer phase. Throw on missing edge for activation-owned reviewer runs; use the direct path only when the run records that it was direct-dispatched.

### C09. Caller-edge reconstruction synthesizes planner session ids

- Evidence: `src/runtime/activation-unwind.ts#L70-L81`
- Category: compatibility/synthesis fallback
- Severity: high
- Finding: missing parent session uses `planner:${parentCardId}` as the caller session id, and missing parent/call becomes `null`.
- Why it matters: activation caller edges should be durable facts. Synthesizing a session id can hide broken session creation or binding.
- Fix direction: require the parent session and unresolved caller tool call to exist for activation-owned unwind. Remove synthesized session ids from this path.

### C10. Malformed planner `activate_card` tool result falls through as ordinary result

- Evidence: `src/agents/invocation-runner.ts#L253-L270`
- Category: internal tool/result corruption tolerated
- Severity: high
- Finding: malformed activation tool result JSON sets `activation = null`; the code then appends the tool result normally.
- Why it matters: `activate_card` is an internal runtime tool. A malformed result is an implementation invariant violation, not external model input.
- Fix direction: parse and validate the activation result with a strict schema; throw on malformed results.

### C11. Agent loop reports unexpected internal state as cancellation

- Evidence: `src/agents/agent-loop-driver.ts#L82-L89`, `src/agents/agent-loop-driver.ts#L180-L193`
- Category: internal state-machine bug reported as normal cancellation
- Severity: high
- Finding: if the loop is non-terminal but not `agent_turn`, it breaks and returns `{ kind: 'cancelled', reason: 'abort' }`.
- Why it matters: unexpected loop state should be impossible. Reporting it as cancellation hides state-machine corruption behind an operator/provider-like outcome.
- Fix direction: throw on unexpected non-terminal states. Reserve `cancelled` only for explicit cancellation transitions.

### C12. Terminal tool args that are non-object JSON become `{}`

- Evidence: `src/agents/contract-verifier.ts#L72-L85`
- Category: contract violation normalized
- Severity: high
- Finding: valid JSON that is not a plain object is accepted as `ok` with empty args.
- Why it matters: arrays, strings, and null terminal args are invalid terminal envelopes. The verifier should reject the actual malformed value rather than checking `{}`.
- Fix direction: return a verifier violation such as `envelope_args_not_object`; preserve the malformed value type in diagnostics.

### C13. Duplicate unresolved `activate_card` calls choose the newest call

- Evidence: `src/runtime/session-persistence.ts#L410-L433`
- Category: duplicate activation tolerated
- Severity: high
- Finding: multiple unresolved `activate_card(childCardId)` calls are handled by choosing the most recent, with comments saying older duplicates are harmless.
- Why it matters: even if duplicates come from model retry behavior, the persisted planner session now contains multiple unresolved activation intents for one child. That is incompatible with a strict activation ledger.
- Fix direction: make duplicate unresolved activation calls a verifier/model-repair condition before they reach runtime unwind, or fail the session if duplicates are already persisted.

### C14. Planner session lookup scans for fallback sessions

- Evidence: `src/runtime/session-persistence.ts#L436-L444`
- Category: compatibility fallback
- Severity: medium
- Finding: `findPlannerSessionForCard()` first tries deterministic `planner:${cardId}`, then scans sessions and chooses the latest matching planner.
- Why it matters: if planner identity is now deterministic, the scan supports historical or duplicate session shapes and makes behavior timestamp-dependent.
- Fix direction: remove the scan fallback and fail if the deterministic session is missing.

### C15. Public agent invocation overloads synthesize incomplete contracts

- Evidence: `src/agents/agent-adapter.ts#L291-L310`, `src/agents/agent-adapter.ts#L329-L352`, `src/agents/agent-adapter.ts#L362-L392`
- Category: backward-compatibility/incomplete context
- Severity: high
- Finding: string-based overloads create contracts with placeholder context such as `parentSessionId: ''`, missing `goalId` defaulting to `''`, and `assessmentId: ''`.
- Why it matters: normal runtime invocation should use structured request objects with complete contract context. These overloads preserve incomplete call shapes.
- Fix direction: delete the string overloads and update callers to use structured invocation requests.

### C16. Reinvocation can use empty card/goal ids

- Evidence: `src/agents/agent-adapter.ts#L414-L441`
- Category: corrupt persisted session tolerated
- Severity: high
- Finding: `reinvokeSession()` substitutes empty strings when executor/reviewer session card or goal metadata is missing.
- Why it matters: executor/reviewer sessions should have required goal/card identity. Reinvocation should fail on missing metadata, not create contracts with empty identifiers.
- Fix direction: throw when required session metadata is missing.

### C17. Session message log invents fallback round stamps

- Evidence: `src/agents/session-message-log.ts#L21-L60`
- Category: missing authoritative session-stamper ownership tolerated
- Severity: medium
- Finding: `SessionMessageLog` owns fallback round ids and block counters, and stamps messages when no runtime stamper is provided.
- Why it matters: if runtime/session ordering is supposed to be owned by a single stamper/lifecycle, this fallback can hide missing round ownership and produce chronology detached from runtime activity semantics.
- Fix direction: refactor `SessionMessageLog` to require an authoritative stamper dependency; do not let it invent ordering by itself.

### C18. Handoff summary swallows persistence errors

- Evidence: `src/agents/agent-session-coordinator.ts#L77-L104`
- Category: operator-facing state disappearance
- Severity: medium
- Finding: handoff summary construction catches all errors and returns `null` or `[]`.
- Why it matters: invalid active sessions or message-read failures become “no handoff” instead of visible corrupted runtime/session state.
- Fix direction: surface the error to the operator/read model or emit a diagnostic; do not make corrupted handoff state disappear silently.

### C19. Planner phase re-blocks from persisted blocked-planning metadata

- Evidence: `src/runtime/phases/planner-phase.ts#L156-L164`
- Category: repair-era metadata leaks into normal path
- Severity: medium
- Finding: normal planner post-dispatch logic blocks if current card state contains blocked-planning metadata.
- Why it matters: stale `planner_blocked` lifecycle metadata can dominate a fresh planner turn, even when the card has been reactivated or is otherwise in a current normal planning path.
- Fix direction: make blocked-planning metadata a current lifecycle state with explicit clearing on resume, or fail if metadata/status disagree.

### C20. Activation reducer defensively defaults active-run fields

- Evidence: `src/runtime/activation-reducer.ts#L18-L66`
- Category: broad defaulting of runtime identity
- Severity: high
- Finding: `activeRunFromActivationState()` defaults `card_type`, `runtime_status`, caller ids, planner session ids, correction attempts, and timestamps.
- Why it matters: in normal operation these fields should come from card state, activation ledger, and session ownership. Broad defaults hide missing metadata and synthesize runtime identity.
- Fix direction: require all identity fields needed for the target phase. Keep defaulting only for values that are truly created by this function, such as fresh timestamps for a newly opened run.

### C21. Executor completion falls back to stale card snapshot

- Evidence: `src/runtime/phases/executor-completion-handler.ts#L31-L35`
- Category: missing authoritative card tolerated
- Severity: high
- Finding: `handleExecutorCompletion()` uses `input.effects.readCard(input.cardId) ?? input.card`.
- Why it matters: after execution, the card should still exist and be readable. Falling back to the originally passed snapshot can commit terminal results against stale state.
- Fix direction: throw if the latest card cannot be read.

### C22. Idle runtime may persist terminal active-run records

- Evidence: `src/runtime/state.ts#L55-L80`
- Category: persistence invariant too permissive
- Severity: medium
- Finding: persistence rejects idle runtime with non-terminal active runs, but permits idle runtime with terminal `active_card_run` statuses such as `stopped` or `cancelled`.
- Why it matters: this is not a code misread: the code intentionally allows terminal active-run records. The design concern is semantic. If `active_card_run` means current work, idle state should have `active_card_run: null`; terminal run history belongs in `runtime_runs`.
- Fix direction: decide and document whether `active_card_run` is current-only. If yes, make idle plus any non-null active run invalid and move terminal information into `runtime_runs` or command history.

## External Protocol Normalization Findings

These findings are not internal impossible states. They concern external model/provider output. The issue is not that the runtime must crash on every malformed model response; the issue is that normalizing malformed payloads to `{}` destroys evidence and may execute unintended tool calls.

### P01. Assistant tool-call argument parse failures become `{}`

- Evidence: `src/agents/invocation-runner.ts#L212-L235`
- Category: external protocol evidence loss
- Severity: medium
- Finding: malformed JSON or non-object tool arguments are persisted as empty args.
- Why it matters: the transcript no longer reflects the model's actual invalid output, and downstream verifier/repair/debug code sees `{}` instead of the malformed value.
- Fix direction: persist the raw malformed output as a protocol error or verifier rejection. Do not execute normal tools with synthesized empty args.

### P02. Analyst tool-call argument parse failures become `{}` and may execute

- Evidence: `src/agents/analyst-handler.ts#L224-L231`
- Category: external protocol evidence loss
- Severity: medium
- Finding: analyst tool-call argument parse failures are logged diagnostically but converted to empty args.
- Why it matters: analyst tools may execute with default/empty parameters, and the persisted tool-call row hides the malformed original arguments.
- Fix direction: return a tool/protocol error to the model or user; do not execute the tool with synthesized empty args.

### P03. Full-history tool-boundary pruning can hide transcript corruption outside intentional truncation

- Evidence: `src/agents/context-compactor.ts#L71-L99`, fallback truncation caller `src/agents/context-compactor.ts#L305-L323`, analyst full-history caller `src/agents/analyst-handler.ts#L283-L288`
- Category: context-boundary normalization
- Severity: medium
- Finding: `pruneToolBoundary()` is legitimate after intentional truncation, where orphan tool rows are expected. It is more suspicious when applied to full analyst history because unmatched rows there indicate persisted transcript corruption or an incomplete previous turn.
- Why it matters: applying the same silent pruning helper to both cases hides the distinction between expected truncation fallout and unexpected persisted history corruption.
- Fix direction: split the API. Use a truncation-only boundary pruner after compaction, and use a strict validator for full untruncated history.

## Startup-Only Or Repair-Path Findings

### R01. Startup executor-interrupted path reports terminal child as failed

- Evidence: `src/runtime/startup-repair.ts#L33-L42`, `src/runtime/startup-repair.ts#L210-L229`
- Category: startup repair contradicts card truth
- Severity: high
- Finding: executor active runs are classified as `executor_interrupted` before the generic terminal-active-card case. If the card is already terminal, `shouldFailCard` is false, but the path still appends a failed child-unwind result.
- Why it matters: a restart after executor terminal commit but before runtime state settled is possible. Reporting that completed terminal child as failed can poison the parent planner transcript.
- Fix direction: if the card is terminal, trust the terminal card lifecycle and synthesize the matching activation outcome instead of always appending failed unwind.

### R02. Startup blocked-planning alignment trusts stale blocker metadata over terminal status

- Evidence: `src/runtime/startup-blocked-planning.ts#L18-L42`
- Category: broad startup repair
- Severity: high
- Finding: startup scans project/goal cards and forces any card with blocked-planning metadata into `blocked`, regardless of current status.
- Why it matters: a card with blocked-planning lifecycle metadata but terminal status is internally contradictory. Startup should fail closed or apply a narrower provenance check rather than blindly trusting stale blocker data.
- Fix direction: only align cards whose status is compatible with blocked-planning repair; otherwise throw a startup invariant error.

### R03. Startup reconciliation broadly closes open runs when runtime is idle

- Evidence: `src/runtime/runtime-core.ts#L542-L597`, `src/runtime/runtime-startup.ts#L86-L94`
- Category: broad startup reconciliation
- Severity: medium
- Finding: startup reconciliation closes all open running runs when runtime state is idle/no active run; non-root runs are failed with an idle-runtime reason.
- Why it matters: open child/non-root runs without active run or parent restoration may indicate ledger corruption. Broad closure masks the underlying violation.
- Fix direction: distinguish expected root-run reconciliation from impossible open child runs. Fail startup for child-run ledger corruption unless a specific repair design exists.

## Rejected Or Deprioritized Candidates

### N01. `_tickInFlight` reentrancy guard

- Evidence: `src/runtime/state-machine.ts#L156-L158`
- Decision: not a finding.
- Rationale: overlapping timer/immediate tick requests are possible in an async runtime. A reentrancy guard is legitimate scheduler protection, not impossible-state repair. If later evidence shows dropped ticks lose work, treat that as scheduler coalescing/observability work, not fail-fast impossible-state cleanup.

### N02. `completeChildActivationForParent()` returning a boolean

- Evidence: `src/runtime/activation-unwind.ts#L54-L68`
- Decision: not independently a finding.
- Rationale: returning success/failure is acceptable at this helper boundary. The confirmed issue is the caller's lack of activation ownership context (C08), not the boolean return itself.

## Suggested Review Order

1. Critical runtime-state foundation: C01, C02, C03, C04.
2. Activation and reviewer ownership: C06, C07, C08, C09, C13, C20.
3. Terminal transition and executor card truth: C05, C21, R01.
4. Backward-compatibility and synthesized identity removal: C14, C15, C16.
5. Agent/session state-machine strictness: C11, C17, C18.
6. Contract/protocol normalization: C10, C12, P01, P02, P03.
7. Planner-blocked and startup repair narrowing: C19, R02, R03.
8. Runtime-state semantic cleanup: C22.
