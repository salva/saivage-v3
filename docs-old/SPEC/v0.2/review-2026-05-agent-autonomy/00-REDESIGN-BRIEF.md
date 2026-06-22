# Agent Autonomy Redesign Brief — v0.2 (2026-05)

## Operator complaint that triggered this review

The runtime currently over-structures agent behaviour. Concrete symptom: a
candidate (`nvidia-nim/_/meta/llama-3.3-70b-instruct`) was killed with
`Candidate ... violated tool-call contract (subtype=terminal_tool_missing):
Role 'planner' returned a plain message during tools phase; expected tool_calls.`

The error originates in `src/agents/agent-adapter.ts` (the tool-call loop) and
`src/agents/invocation-recovery-policy.ts` (the recovery policy that converts
the `LlmRequestError(contract_mismatch / terminal_tool_missing)` into an abort).

## Desired model

Agents are autonomous. The runtime must:

1. Hand the agent a clear task, the tools it can use, and the expected return
   contract.
2. Let the agent loop unattended, calling whatever tools it deems appropriate,
   until it declares it is done.
3. Verify the declared return against the contract.
4. If the contract is satisfied, continue the surrounding flow.
5. If the contract is not satisfied, send the agent a structured list of the
   unmet obligations and ask it to bring its result into compliance, then loop.
6. Repeat 2-5 until satisfied or a budget is exhausted.

In other words: the runtime is a **contract verifier with a repair loop**, not
a per-turn protocol cop. Phase swaps, hard-coded "this turn must call a tool"
gates, forced-tool-only last turns, and tool-call-vs-message contract failures
should disappear in favour of (a) prompt-level expectations and (b) post-hoc
contract verification with an explicit repair conversation.

## Scope

In scope (redesign anything inside, including breaking interfaces):

- `src/agents/agent-adapter.ts` — the per-turn loop and recovery glue
- `src/agents/agent-role-runner.ts`
- `src/agents/agent-llm-gateway.ts`
- `src/agents/agent-tool-executor.ts`
- `src/agents/agent-session-coordinator.ts`
- `src/agents/invocation-recovery-policy.ts`
- `src/agents/terminal-protocol.ts`
- `src/agents/role-result-tools.ts`
- `src/agents/role-envelope-schemas.ts`
- `src/agents/llm-options-factory.ts`
- `src/agents/llm-contracts.ts`
- `src/agents/llm-failure.ts`
- `src/agents/llm-failure-classifiers.ts`
- `src/agents/recovery.ts`
- `src/agents/system-prompt.ts`
- `src/agents/persisted-tool-call.ts`
- `src/agents/planner-control-executor.ts`
- `src/agents/skills-engine.ts` (only where it injects per-turn instructions)
- Downstream consumers of the role envelopes:
  - `src/contracts/` (PlannerResult / ExecutorResult / ReviewerResult contracts)
  - planner/supervisor loop (search for `envelopeToPlannerResult`, `markSessionWaiting`, etc.)
  - session-persistence message schemas (`src/schemas/types.ts`, `validators.ts`)

Possibly in scope (one conceptual level up):

- The analyst path — currently bypasses the envelope contract. The redesign
  *may* unify analyst under the same contract-verifier model, but operator
  said "maybe (and just maybe) the analyst must follow this pattern". Treat as
  optional: propose unification if it materially simplifies the design, leave
  it alone otherwise.

Out of scope:

- Provider/credential resolution internals (`provider.ts`,
  `credential-source-resolver.ts`, `candidate-availability.ts`,
  `model-router.ts`) — only touch where they intersect with the per-turn
  contract.
- LLM transport implementations (`llm-openai-chat-gateway.ts`,
  `llm-openai-codex-gateway.ts`, transports, parsers).
- UI / dashboard.

## Hard project constraints

- Architecture-first, NO backward compatibility, NO migration shims, NO
  feature flags. Delete dead code aggressively. (Operator preference, applies
  workspace-wide.)
- No emojis anywhere in generated docs.
- No new docstrings/comments on code that is not being changed.
- Validation commands live in
  `.github/skills/saivage-development-validation/` if that skill is present;
  otherwise: `npm run build`, then deploy to `10.0.3.170:/opt/saivage-v3/dist`
  via rsync and restart `saivage-v3-getrich.service`.

## Tactical state at the start of this review

A quick mitigation was deployed (commit `a2a6f05`): the per-turn phase swap
in `agent-adapter.ts` was removed and a plain message no longer kills the
candidate — it appends a `model_repair` nudge and continues. This is band-aid
on the symptom; the redesign should subsume or replace it cleanly without
leaving the patch as residue.

## Output layout for this review

```
SPEC/v0.2/review-2026-05-agent-autonomy/
  00-REDESIGN-BRIEF.md               # this file
  00-SUBSYSTEM-MAP.md                # Phase C
  00-INDEX.md                        # Phase C (issue index)
  F01-<slug>.md, F02-<slug>.md, ...  # Phase C (one file per issue)
  F01-<slug>/                        # Phase D
    01-analysis-rN.md / -review-rN.md
    02-design-rN.md / -review-rN.md
    03-plan-rN.md / -review-rN.md
    APPROVED.md
  99-METAPLAN.md                     # Phase E
```

## Models

- Writer subagent: Claude Opus 4.7 (copilot)
- Reviewer subagent: GPT-5 (copilot)
- Iteration cap: unlimited, escalate after 2 consecutive identical objections.
- Pause points: none — run end-to-end.
