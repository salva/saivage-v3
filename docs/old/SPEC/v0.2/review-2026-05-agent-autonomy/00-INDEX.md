# Agent Autonomy Review — Issue Index

Sort: severity desc, then transversality desc.

| ID | Title | Severity | Transversality | One-line summary |
|----|-------|----------|----------------|------------------|
| [F02](F02-contract-mismatch-treated-as-fatal.md) | `contract_mismatch` treated as fatal | critical | architectural | Envelope-shape failures abort the whole invocation and skip the candidate chain entirely. |
| [F03](F03-no-explicit-agent-done-signal.md) | No "agent declares done" signal | high | architectural | Done-ness and envelope emission are the same event; the runtime cannot tell "not finished" from "broken". |
| [F05](F05-hardcoded-role-taxonomy.md) | Hardcoded role taxonomy | high | architectural | `planner|executor|reviewer` is baked into five maps; the contract can only be addressed via a global role key. |
| [F04](F04-recovery-conflates-transport-and-semantic-failures.md) | Transport and semantic failures share one channel | high | cross-cutting | `LlmFailure` mixes HTTP/timeout faults with envelope contract violations; one policy switch decides both. |
| [F06](F06-synthesised-deferred-activation-envelopes.md) | Synthesised deferred-activation envelopes | high | cross-cutting | The adapter fabricates planner `continue`/`blocked` envelopes when the agent only called `activate_card`. |
| [F07](F07-system-prompt-misaligned-with-runtime-contract.md) | Prompt disagrees with runtime contract | high | cross-cutting | Prompts ask for JSON in a code block; runtime only accepts an `emit_*_result` tool call. |
| [F01](F01-per-turn-phase-machinery.md) | Per-turn `tools`/`terminal` phase is dead | medium | cross-cutting | `LlmRolePhase`, `LlmCompleteOptionsTerminal`, and `deriveTerminalTool` exist but the hot path never uses `terminal`. |
| [F08](F08-overlapping-turn-and-recovery-budgets.md) | `maxToolTurns` vs `maxRecoveryRetries` overlap | medium | cross-cutting | Two budgets pretending to be one; turn-budget exhaustion routes through the contract-mismatch abort. |
| [F10](F10-adapter-owns-status-projection-and-side-effects.md) | `AgentAdapter.invokeAgent` does too much | medium | cross-cutting | One method owns candidate loop, tool loop, envelope projection, status-to-lifecycle mapping, and event summary. |
| [F09](F09-tactical-nudge-loop-band-aid.md) | Tactical `model_repair` nudge loop | medium | local | Commit `a2a6f05` patched the symptom inline with a hand-written nudge string; should be subsumed by the verifier. |
