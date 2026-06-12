# Metaplan — Agent Autonomy Redesign

Sequenced execution of the three approved batch plans. Each stage is a single writer subagent (Claude Opus 4.7) that lands one atomic compile-green commit set, runs the focused validation, deploys to the live target, and probes `/health` + `/api/providers` before returning.

## Selected proposals

- **Batch A** — P-A2: per-invocation `Contract` + `AgentLoopState` machine + `signal_done` tool + verifier+repair driver + `MessageKind` split. ([APPROVED](BATCH-A-contract-verifier-core/APPROVED.md))
- **Batch B** — P-B1: per-invocation `Contract<Envelope, TypedResult>` factories, role-keyed maps deleted, `emit_planner_deferred` as second planner terminal. ([APPROVED](BATCH-B-contract-surface/APPROVED.md))
- **Batch C** — P-C1: seven injected collaborators, three-axis budget, `recovery.ts` deleted, `LlmRolePhase` deleted. ([APPROVED](BATCH-C-scaffolding-cleanup/APPROVED.md))

## Stage sequence (per [00-COORDINATION.md](00-COORDINATION.md))

| Stage | Source plan | Scope | Commit subject |
| --- | --- | --- | --- |
| 1 | Batch B steps 1–4 | Skeleton: add `src/contracts/contract.ts`, the three role-envelope and role-contract factory modules, prose helpers, and focused `tests/contracts/` suite. No deletions, no consumer rewrites. | `F05,F06,F07: contract surface skeleton (factories, verifier, prose helpers)` |
| 2 | Batch A all 6 steps | Verifier core: introduce verifier, state machine, driver, done-signal tool, invocation outcome; split `LlmFailure`, `PersistedRowCorruptError`, `MessageKind context_compaction`, event/exchange schemas; rewrite adapter inner loop, planner-control executor, role runner, system-prompt. | `F02,F03,F04,F09: contract verifier core (state machine, driver, MessageKind split)` |
| 3 | Batch B steps 5–13 | Continuation: rewrite adapter, prompts, recorder, tool catalog, policy, persistence, tests against `Contract`; delete `role-envelope-schemas.ts`, `role-result-tools.ts`, `terminal-protocol.ts`, `TERMINAL_TOOL_NAMES`, `validateTerminalToolCall`, `buildSelfCheckPrompt`, the deferred-activation synthesis branch, the legacy parser fallback. | `F05,F06,F07: contract surface continuation (delete role-keyed maps, planner deferred terminal)` |
| 4 | Batch C steps 1–10 | Scaffolding: flatten `LlmCompleteOptions` (delete `LlmRolePhase`), introduce seven collaborators (`StatusProjector`, `AgentInvocationPlan`, `CandidateResolver`, `AgentSessionLifecycle`, `ConversationRunner`, `InvocationAttemptRecorder`, `OuterAttemptLoop`, `InvocationOutcomeProjector`), reshape runtime-config + recovery-policy, delete `recovery.ts`, rewrite `invokeAgent` orchestrator body, three-axis budget. | `F01,F08,F10: scaffolding decomposition + three-axis budget` |

Cross-batch contract ownership is fixed by [00-COORDINATION.md](00-COORDINATION.md): `Contract<Envelope, TypedResult>` lives in `src/contracts/` (owned by Batch B); `ContractVerifier`, `AgentLoopState`, driver, done-signal tool live in `src/agents/` (Batch A); collaborator decomposition lives in `src/agents/` (Batch C).

## Validation per stage

Run from `/home/salva/g/ml/saivage-v3`:

```bash
npm run typecheck
npm test -- --runInBand <focused suites from the stage's plan §7>
npm run build
rsync -a --delete dist/ root@10.0.3.170:/opt/saivage-v3/dist/
ssh root@10.0.3.170 'systemctl restart saivage-v3-getrich.service'
sleep 4
curl -fsS http://10.0.3.170:8080/health
curl -fsS http://10.0.3.170:8080/api/providers | jq
```

Plus the grep gates listed in each plan's `§7`.

## Binding constraints carried into every stage

- Architecture-first. No backward compatibility. No migration shims, feature flags, or duplicate code paths.
- Aggressively delete code the new design replaces. No silent dead code.
- Each commit lands compile-green and test-green on its focused suites. Multi-file rewrites stay atomic per their plan §3.
- No emojis. No docstrings on untouched code. Comments only when the WHY is non-obvious.
- Target deploy: `saivage-v3-getrich.service` in container `saivage-v3-getrich-v2` at `10.0.3.170:8080` only. Container `10.0.3.112` is the v2 harness and is NOT touched.
- Jest is the root test runner. Vitest is only for `web/`.
- Never print contents of `.saivage/auth-profiles.json` or provider keys.

## Final acceptance (post stage 4)

1. Live `/health` returns 200, `/api/providers` shows the four configured providers (nvidia-nim, opencode, opencode-go, openai-codex) in priority order with NIM first.
2. `journalctl -u saivage-v3-getrich.service -n 200` shows clean startup, no references to deleted symbols (`maxToolTurns`, `recoveryDelayMs`, `maxRecoveryRetries`, `LlmRolePhase`, `TERMINAL_TOOL_NAMES`).
3. Driving one planner invocation against a small goal no longer produces `terminal_tool_missing`; planner deferred path persists a real `assistant / tool_call` row for `emit_planner_deferred`; exchanges carry `terminalToolOffered` / `terminalToolFired` / `contractName`.
4. Quick dashboard probe at `http://10.0.3.170:8080/debug` succeeds.

## Rollback

Per stage: `git revert <stage-commit>` returns to the previous stage's compile-green state. Whole-redesign rollback is reverts of stages 4 → 3 → 2 → 1.
