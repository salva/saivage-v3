# Batch A — Contract Verifier Core: Analysis Review R2

## 1. Correctness Of Cited File/Line Refs

Finding: approved. I spot-verified the newly corrected source anchors against the current implementation. The stale `agent-adapter.ts` references called out in the prior review are fixed: `invokeAgent` is anchored at `agent-adapter.ts#L225`, `createSession` at `#L250`, the transport recovery directive emission at `#L286`, and the abort/rethrow branch at `#L447-L451`. The central hot-path ranges for the plain-message mitigation, terminal-tool validation, deferred `activate_card` synthesis, post-loop `terminal_tool_missing` throw, invocation summary, and session completion transitions also match the current source.

The supporting references are likewise accurate enough for the analysis: `InvocationRecoveryPolicy` still maps `contract_mismatch` to `fail_invocation` with `abort: true`; `OpenCodeGoClassifier` still promotes opencode-go HTTP 400s into `contract_mismatch`; `validateTerminalToolCall` still throws `contract_mismatch` for terminal protocol failures; `MessageKind` still includes `model_repair`; `TERMINAL_TOOL_NAMES` is still duplicated in the exchange contract; and `AgentRoleRunner.applySelfCheck` still mutates the prompt out of band. I found only a minor non-blocking anchor nit: `recovery.ts#L93-L177` starts inside `invokeWithRecovery` rather than at the function signature, but it still lands on the recovery loop being discussed.

## 2. Completeness Over F02 F03 F04 F09

Finding: approved. The revision covers all four issue files and connects them to one coherent target model.

- F02 is addressed by moving contract violations out of `LlmFailure` / `decideFailure` and into verifier-produced obligation reports with a repair budget.
- F03 is addressed by introducing a done signal distinct from envelope validation and by treating deferred planner activation as an explicit done-signal concern rather than an adapter special case.
- F04 is addressed by splitting transport failures from contract violations at the type and policy boundary.
- F09 is addressed by deleting the inline plain-message nudge and making the verifier the only producer of repair messages.

## 3. Project Guideline Compliance

Finding: approved. The two no-backward-compatibility issues from the prior review were substantively fixed. Repair-budget exhaustion is now described as a contract-layer terminal state with a dedicated `RepairExhausted` outcome that does not enter `decideFailure`, does not cool or fail over through the transport path, and does not preserve existing behavior for its own sake. The earlier invalid "last-resort acceptance" option is now explicitly rejected, as required by the brief's contract-verifier model.

I did not find a remaining compatibility shim smell that should keep this analysis in review. The revision allows downstream semantic invariants such as `PlannerResult.status` to remain stable, but it pairs that with deleting old wire shapes and updating call sites in the same change set, which is architecture preservation rather than backward-compatibility support.

## 4. Self-Containment

Finding: approved. I found no "as in r1", "the reviewer asked", revision-numbered headings, or other non-self-contained language. The document stands on its own and does not require reading the prior review to understand the current analysis.

## 5. Cross-Cutting Impact Credibility

Finding: approved. The cross-cutting section reaches the right surfaces: session persistence and message schema, verified envelope projection, deferred activation synthesis, duplicated terminal-tool constants, event logging, redaction, transport recovery boundaries, repair-budget exhaustion, self-check prompt mutation, and prompt/runtime drift. The impact map is credible for the scope of an analysis phase and does not over-claim implementation detail that belongs in design.

## 6. Open Questions Are Genuinely Open

Finding: approved. The open questions now read as design choices rather than hidden contradictions. The repair-exhaustion question is especially improved: it limits valid choices to explicit `RepairExhausted` failure or contract-owned cross-candidate repair, rejects verifier demotion, and rejects falling back into transport failover. The remaining questions about done-signal wire form, repair budget shape, analyst unification, classifier replacement, obligation persistence, provider attribution, and termination ownership are appropriately open for the design phase.

## Required Changes

None.

VERDICT: APPROVED