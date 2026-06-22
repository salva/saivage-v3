# Wave 002 research findings — runtime/agent contract boundary

Access date: 2026-05-27. This note is read-only research for `cycle-002-runtime-agent-contract-boundary`; source code was inspected but not modified.

## Executive summary

Wave 002 remains valid and should proceed after bounded review. Wave 001 introduced runtime state-machine ports, but the runtime/agent seam is still bidirectional:

- `src/runtime/runtime.ts` imports many agent package exports, including `AgentRuntime`, `FakeAgentAdapter`, prompt builders, `SkillsEngine`, session helpers, and analyst activation helpers (`src/runtime/runtime.ts:23-49`, `src/runtime/runtime.ts:67-75`).
- `src/agents/agent-adapter.ts` imports runtime state via `readRuntimeState` and passes that into `PlannerControlExecutor` (`src/agents/agent-adapter.ts:33`, `src/agents/agent-adapter.ts:193-198`).
- Agent-side planner control helpers and fake fixtures also import runtime persistence functions (`src/agents/planner-control-executor.ts:5`, `src/agents/planner-control-executor.ts:80-116`; `src/agents/fake-agent.ts:7`, `src/agents/fake-agent.ts:85-124`).
- Role vocabulary still drifts: schema roles include `content_supervisor` (`src/schemas/types.ts:74`; `src/schemas/validators.ts:38`) while `AgentAdapter` and `RoleToolPolicy` define narrower local role unions (`src/agents/agent-adapter.ts:41`; `src/agents/role-tool-policy.ts:4`).
- Import boundary tooling currently allows agents to import the runtime package root and only rejects deep runtime imports (`scripts/check-import-boundaries.cjs:57-59`, `scripts/check-import-boundaries.cjs:114-116`). It does not forbid runtime importing agents.

Recommended direct implementation: create a shared backend agent execution contract (request/result/session-control types) outside `src/agents/`, make runtime consume that port, move runtime-ledger/planner-control state dependencies out of agent internals into explicit ports supplied by runtime/composition, and centralize role value/type definitions in schemas/contracts. The more aggressive restructure proposal would extract a full dispatch application service first, but that likely exceeds one cycle.

## Current evidence

### Mailbox and working tree

- Mailbox root contained only `README.md`, `done/`, and `rejected/`; no live `.md` proposal preempted Wave 002.
- The working tree was already dirty before this task, including unrelated mailbox artifacts, agent/card/server/web tests, deleted historical stage artifacts, and many untracked audit/SPEC files. Wave 002 should not revert or rely on those unrelated changes. See `architecture-audit/cycle-002-runtime-agent-contract-boundary/logs/t1-initial-inspection.stdout.log` and the task transcript `git_status` result.

### Runtime still consumes agent internals broadly

- Runtime imports agent activation helpers directly from the agent package root: `consumeChangedCardActivation`, `injectQueuedSyntheticPlannerNotes`, `queueSyntheticPlannerNote`, and `drainSyntheticPlannerNotes` (`src/runtime/runtime.ts:23`).
- Runtime imports `FakeAgentAdapter`, `AgentRuntime`, planner/reviewer result types, prompt builders, and `SkillsEngine` from `../agents/index.js` (`src/runtime/runtime.ts:41-49`).
- Runtime imports session persistence helpers from the agent package root: `appendActivateCardToolResultOnce`, `appendMessage`, `findPlannerSessionForCard`, `findUniqueUnresolvedActivateCardToolCall`, `listSessions`, `getSession`, and `getSessionMessages` (`src/runtime/runtime.ts:67-75`).
- Runtime directly calls the agent runtime for handoffs/cancel/force-cancel and planner/executor/reviewer invocation (`src/runtime/runtime.ts:114`, `src/runtime/runtime.ts:579`, `src/runtime/runtime.ts:622`, `src/runtime/runtime.ts:677`, `src/runtime/runtime.ts:755`, `src/runtime/runtime.ts:809`).

### Agents still read runtime state/persistence

- `AgentAdapter` imports `readRuntimeState` from runtime (`src/agents/agent-adapter.ts:33`) and injects a runtime-state provider into `PlannerControlExecutor` (`src/agents/agent-adapter.ts:193-198`).
- `PlannerControlExecutor` imports `appendRuntimeRun`, `readRuntimeState`, and `upsertRuntimeActivation` from runtime (`src/agents/planner-control-executor.ts:5`) and uses them to validate/record `activate_card` tool calls (`src/agents/planner-control-executor.ts:80-116`).
- `FakeAgentAdapter` imports the same runtime helpers (`src/agents/fake-agent.ts:7`) and creates fixture runtime runs/activations by reading runtime state and appending runtime records (`src/agents/fake-agent.ts:85-124`).
- Analyst control modules under `src/agents/` also read runtime state and control runtime (`src/agents/analyst-stage6.ts`, `src/agents/analyst-tools.ts`); because Wave 002 is scoped to runtime/agent execution boundary, these should be documented as residual/future work unless the selected proposal explicitly includes them.

### Role vocabulary is duplicated

- Backend schema role type is `AgentRole = 'analyst' | 'planner' | 'executor' | 'reviewer' | 'content_supervisor'` (`src/schemas/types.ts:74`), and the validator repeats the literal list (`src/schemas/validators.ts:38`).
- `AgentAdapter` defines `AgentRole = 'planner' | 'executor' | 'reviewer' | 'analyst'` locally (`src/agents/agent-adapter.ts:41`) and repeatedly casts to `import('../schemas/types.js').AgentRole` when emitting/session-persisting events (`src/agents/agent-adapter.ts:261`, `src/agents/agent-adapter.ts:447-455`).
- `RoleToolPolicy` defines `RoleToolPolicyRole = 'planner' | 'executor' | 'reviewer' | 'analyst'` separately (`src/agents/role-tool-policy.ts:4`).
- `FakeAgentAdapter` defines its active-session roles as `'planner' | 'executor' | 'reviewer'` (`src/agents/fake-agent.ts:45`).
- `src/config/validate-model-roles.ts` imports `AgentRole` from agents rather than schemas/contracts (`src/config/validate-model-roles.ts:1-3`), preserving the narrower local agent role vocabulary outside the agent package.

### Boundary tooling needs to change with the implementation

- Current import-boundary self-test explicitly permits agents importing the runtime package root (`scripts/check-import-boundaries.cjs:69-70`).
- The runtime restriction only rejects deep imports from agents to runtime (`scripts/check-import-boundaries.cjs:57-59`, `scripts/check-import-boundaries.cjs:114-116`).
- No reciprocal rule prevents runtime from importing agents. The direct implementation should add rules that force runtime to depend on contracts/schemas and prohibit agents from importing runtime after the explicit runtime-ledger/planner-control port is introduced.

## Practical implementation notes for the Coder

- Do not treat all agent-to-runtime imports as one concern. `AgentAdapter`/`PlannerControlExecutor`/`FakeAgentAdapter` runtime state access is directly in Wave 002; analyst tools are user-control surface concerns and may be a residual if not selected for this cycle.
- Prefer moving the port/interface to `src/contracts/agent-execution.ts` (or a similarly bottom-layer location) rather than leaving `AgentRuntime` in `src/agents/agent-runtime.ts`; otherwise runtime still imports the agent package for its primary execution contract.
- Keep result payload types from the existing parser modules unless the selected proposal explicitly authorizes moving result-parser types. Moving result parsing may balloon into Wave 005/007 territory.
- Centralize role values in schemas/contracts with exported value arrays plus derived types. Then use subset types such as `OperationalAgentRole = Extract<AgentRole, 'planner' | 'executor' | 'reviewer' | 'analyst'>` rather than redefining literal unions in agent modules.
- Update tests that instantiate `AgentRuntime` stubs (`tests/runtime/f23-dispatch-goal-acceptance.test.ts`, `tests/runtime/runtime-command-ledger.test.ts`, `tests/runtime/startup-session-sweep.test.ts`) to use the new port type/request shape.

## Sources

- Current source files under `/work/saivage-v3/src/`, accessed 2026-05-27.
- Inspection logs: `architecture-audit/cycle-002-runtime-agent-contract-boundary/logs/t1-initial-inspection.stdout.log`, `t1-boundary-grep.stdout.log`, `t1-supporting-line-refs.stdout.log`.
