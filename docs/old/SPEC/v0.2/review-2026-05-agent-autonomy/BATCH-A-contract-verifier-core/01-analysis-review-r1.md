# Batch A — Contract Verifier Core: Analysis Review R1

## 1. Correctness Of Cited File/Line Refs

Finding: changes required. The substantive code reading is mostly correct, but several `agent-adapter.ts` anchors in [01-analysis-r1.md](01-analysis-r1.md#L22-L28) and [01-analysis-r1.md](01-analysis-r1.md#L109-L140) are stale enough to send the next writer/reviewer to the wrong code.

Verified correct source claims:

- The contract-mismatch recovery arm exists and returns `fail_invocation` with `abort: true` in [invocation-recovery-policy.ts](../../../../src/agents/invocation-recovery-policy.ts#L127-L129), matching [01-analysis-r1.md](01-analysis-r1.md#L99-L107).
- The inline plain-message `model_repair` mitigation exists in [agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L304-L319), matching [01-analysis-r1.md](01-analysis-r1.md#L45-L58).
- `OpenCodeGoClassifier` still turns HTTP 400s into `contract_mismatch` in [llm-failure-classifiers.ts](../../../../src/agents/llm-failure-classifiers.ts#L99-L119), matching [01-analysis-r1.md](01-analysis-r1.md#L207-L213).
- `validateTerminalToolCall` raises `contract_mismatch` for missing or unexpected terminal calls in [terminal-protocol.ts](../../../../src/agents/terminal-protocol.ts#L6-L24), matching [01-analysis-r1.md](01-analysis-r1.md#L67-L72).

Incorrect or misleading anchors that must be fixed:

- [01-analysis-r1.md](01-analysis-r1.md#L22-L28) links `invokeAgent` at `agent-adapter.ts#L211` and `createSession` at `#L225-L237`; the current signature is [agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L225) and `createSession` is [agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L250).
- [01-analysis-r1.md](01-analysis-r1.md#L109-L140) says `abort: true` is honored at `agent-adapter.ts#L435-L440`; the current abort/rethrow branch is [agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L447-L451).
- [01-analysis-r1.md](01-analysis-r1.md#L427-L430) links `model_recovered` emission at `agent-adapter.ts#L249-L254`; the current emission is [agent-adapter.ts](../../../../src/agents/agent-adapter.ts#L286).

## 2. Completeness Over F02 F03 F04 F09

Finding: no required change. The analysis covers all four issue files and connects each one back to the brief's contract-verifier model.

- F02's fatal `contract_mismatch` path from [F02-contract-mismatch-treated-as-fatal.md](../F02-contract-mismatch-treated-as-fatal.md#L5-L10) is analyzed in [01-analysis-r1.md](01-analysis-r1.md#L129-L150) and resolved in [01-analysis-r1.md](01-analysis-r1.md#L397-L402).
- F03's missing done signal from [F03-no-explicit-agent-done-signal.md](../F03-no-explicit-agent-done-signal.md#L1-L18) is analyzed in [01-analysis-r1.md](01-analysis-r1.md#L164-L193) and resolved in [01-analysis-r1.md](01-analysis-r1.md#L403-L406).
- F04's transport/semantic conflation from [F04-recovery-conflates-transport-and-semantic-failures.md](../F04-recovery-conflates-transport-and-semantic-failures.md#L1-L12) is analyzed in [01-analysis-r1.md](01-analysis-r1.md#L194-L221) and resolved in [01-analysis-r1.md](01-analysis-r1.md#L407-L410).
- F09's tactical nudge loop from [F09-tactical-nudge-loop-band-aid.md](../F09-tactical-nudge-loop-band-aid.md#L1-L8) is analyzed in [01-analysis-r1.md](01-analysis-r1.md#L225-L247) and resolved in [01-analysis-r1.md](01-analysis-r1.md#L411-L412).

## 3. Project Guideline Compliance

Finding: changes required. The analysis generally follows the architecture-first/no-shim rule from [00-REDESIGN-BRIEF.md](../00-REDESIGN-BRIEF.md#L81-L82), and [01-analysis-r1.md](01-analysis-r1.md#L421-L422) explicitly says old shapes should be deleted and call sites updated in the same change set. However, [01-analysis-r1.md](01-analysis-r1.md#L494-L496) says repair-budget exhaustion should convert to a transport-layer failure "so the existing failover behaviour stays intact." That is a backward-compat smell: the analysis should justify the escalation path architecturally, not by preserving existing recovery behavior.

Finding: changes required. [01-analysis-r1.md](01-analysis-r1.md#L537-L541) lists "demote the verifier check (last-resort acceptance)" as an open design option. That option contradicts the desired model in [00-REDESIGN-BRIEF.md](../00-REDESIGN-BRIEF.md#L23-L26): unsatisfied contracts get repaired until satisfied or budget-exhausted, not accepted despite failing verification. Remove it as a valid option, or explicitly mark it rejected.

## 4. Self-Containment

Finding: no required change. I found no references to review iterations, prior reviewer requests, or non-self-contained language such as "as in r1" or "the reviewer asked". The document stands alone.

## 5. Credibility Of Cross-Cutting Impact

Finding: no required change beyond the repair-exhaustion issue already called out. The cross-cutting section credibly reaches session persistence/message schema in [01-analysis-r1.md](01-analysis-r1.md#L424-L442), supervisor/downstream consumers in [01-analysis-r1.md](01-analysis-r1.md#L444-L462), observability in [01-analysis-r1.md](01-analysis-r1.md#L465-L485), recovery harness boundaries in [01-analysis-r1.md](01-analysis-r1.md#L487-L496), and prompts/self-checks in [01-analysis-r1.md](01-analysis-r1.md#L498-L511). Those are the right surfaces for persistence, supervisor behavior, observability, recovery, and prompt drift.

## 6. Open Questions Are Genuinely Open

Finding: changes required. The repair-exhaustion question is not genuinely open as written because [01-analysis-r1.md](01-analysis-r1.md#L494-L496) already chooses conversion into a transport-layer failure, while [01-analysis-r1.md](01-analysis-r1.md#L537-L541) later presents failover, abort, acceptance, and candidate rotation as open options. Pick one stance for the analysis phase: either keep the policy genuinely open, or state the chosen invariant and remove the conflicting open question.

## Required Changes

1. Refresh the stale `agent-adapter.ts` line anchors identified above, at minimum the `invokeAgent`/`createSession`, abort/rethrow, and `model_recovered` references.
2. Rewrite the repair-budget exhaustion discussion so it does not preserve existing failover behavior for its own sake and does not contradict the open question section.
3. Remove "demote the verifier check (last-resort acceptance)" as a valid open option, or explicitly mark it rejected because it violates the brief's contract-verifier semantics.

VERDICT: CHANGES_REQUESTED