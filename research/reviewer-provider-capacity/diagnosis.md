# Reviewer/provider capacity code diagnosis

Access date: 2026-06-01. Scope: source-only diagnosis for stage `repair-reviewer-provider-capacity-001`, task `t1-diagnose-reviewer-routing-capacity-code`. No live secret-bearing config, auth values, raw logs, raw cards, or HTTP bodies are included here.

## Executive summary

The terminal acceptance reviewer path is routed through the real `AgentAdapter` in active runtime, not the fake adapter. Both terminal gates ultimately invoke role `reviewer`, which uses the same model routing and provider capacity mechanism as planner/executor:

1. **Planner-control `report_goal_done` path**: `AgentAdapter` injects a reviewer invoker into `PlannerControlExecutor`; `PlannerToolsService.reportGoalSync()` calls it for `report_goal_done` and now persists a durable `reviewer_unavailable` / `reviewer_invocation_failed` blocker if invocation fails before an assessment is produced.
2. **Direct runtime planner-done path**: `Runtime.dispatchGoal()` calls `Runtime.invokeReviewer()` when a planner result is terminal `done`; failure also blocks the goal/project with `reviewer_unavailable` / `reviewer_invocation_failed`.
3. **Capacity selection**: `AgentAdapter.invokeAgent('reviewer', ...)` builds a capability request requiring tool support and exclusive tool-choice support, asks `ModelRouter.resolve('reviewer', request)`, then iterates provider/account/model candidates while respecting persistent candidate availability cooldown/block state.
4. **Config/auth consumption**: model lists come from `models.reviewer`, `models.routing[reviewer]`, or `models.default`; providers/accounts/capabilities come from `.saivage/saivage.json` schema; credentials are intentionally resolved only after a concrete candidate is selected, using account/provider API keys, explicit auth profiles, or unambiguous provider-alias auth profiles.
5. **Invocation error handling**: LLM failures are classified into `auth_permanent`, `rate_limit`, `server_transient`, `timeout`, `provider_protocol_error`, `token_budget_exceeded`, `parse_error`, `cancelled`, or `unknown`; the recovery policy cools/blocks candidates and records redacted `llm_attempt` / `llm_invocation_summary` metadata. After all candidates/retries fail, terminal acceptance paths persist the reviewer-capacity blocker.

Source inspection did **not** reveal a remaining reviewer-specific routing bug in the code paths examined. The most likely live causes for `reviewer_unavailable/reviewer_invocation_failed` after the prior fixes are: no configured reviewer/default model list, no capability-compatible candidates, all reviewer candidates in availability cooldown/block state, auth/profile absence or ambiguity, permanent auth failure, rate limit/provider quota, provider protocol mismatch, or transient provider/server failures.

## Prior-stage context

- `repair-reviewer-availability-terminal-acceptance-001` repaired the planner-control `report_goal_done` path so reviewer invoker failures become durable project/card blockers instead of transient tool errors.
- `repair-runtime-intent-active-run-reconciliation-001` later repaired stale runtime intent and preserved precise reviewer-capacity blocker classification when fresh planner output text identifies `report_goal_done` reviewer/provider capacity failure.
- Current stage should therefore focus live evidence gathering on provider routing/candidate availability/config-auth shape rather than re-fixing blocker persistence unless tests/data show a regression.

## Routing and terminal acceptance paths

### Active runtime uses the real AgentAdapter

`ActiveRuntime` constructs an `AgentAdapter` with shared event/error loggers and durable `FsCandidateAvailability`, then wires the real LLM call function via `setLlmCallFn(createLlmCallFn())` (`src/runtime/active-runtime.ts:216-240`). This is the runtime path that matters for live reviewer capacity.

### Planner-control `report_goal_done` path

`AgentAdapter` passes a `reviewer` callback into `PlannerControlExecutor` (`src/agents/agent-adapter.ts:149-190`). That callback:

- marks the parent planner session waiting while reviewer runs,
- creates a reviewer contract,
- calls `this.invokeReviewer({ role reviewer request... })`, and
- returns the produced assessment.

`PlannerToolsService.reportGoalSync()` gates `report_goal_done` on subtree readiness and evidence readiness, then calls the injected reviewer with a generated assessment/session id (`src/tools/planner-tools.ts:450-523`). If the reviewer call throws synchronously or asynchronously before an assessment exists, `persistReviewerInvocationBlock()` updates the goal/project to blocked with:

- `result.planning.status = blocked`,
- `resume_reason = reviewer_unavailable`,
- `failure_kind = reviewer_invocation_failed`, and
- a redacted capacity-oriented message, not raw provider error text (`src/tools/planner-tools.ts:537-558`).

### Direct runtime planner-done path

When `Runtime.dispatchGoal()` reaches a planner-done terminal acceptance gate, it calls `Runtime.invokeReviewer()` (`src/runtime/runtime.ts:2362-2372`). If reviewer invocation fails, it emits diagnostics, appends an error record, transitions the card to blocked, and persists `resume_reason = reviewer_unavailable` and `failure_kind = reviewer_invocation_failed` (`src/runtime/runtime.ts:2373-2408`).

`Runtime.invokeReviewer()` builds the reviewer prompt/contract, loads reviewer instructions and skills when available, transitions runtime phase to `reviewer_started`, then delegates to `agentRuntime.invokeReviewer()` with the requested reviewer session id (`src/runtime/runtime.ts:2861-2919`).

### Fresh planner text classifier

A prior repair added `Runtime.isReviewerCapacityPlannerBlocker()` to classify planner-blocked text mentioning `report_goal_done` + reviewer/provider capacity as the precise reviewer-capacity blocker (`src/runtime/runtime.ts:1582-1594`). The blocked-result handling uses that classifier to persist `resume_reason = reviewer_unavailable` and `failure_kind = reviewer_invocation_failed` instead of generic `planner_blocked` (`src/runtime/runtime.ts:2247-2297`).

## Capacity and candidate selection

`AgentAdapter.invokeAgent()` handles all roles, including reviewer. For reviewer:

1. It loads role model params with `getModelParamsForRole(config, 'reviewer')`.
2. It builds role tools and a capability request with `requiresTools = true`, `requiresExclusiveToolChoice = true`, and `streaming = false` (`src/agents/agent-adapter.ts:505-523`; `src/agents/provider-capabilities.ts:115-120`).
3. It calls `router.resolve('reviewer', capabilityRequest)` before creating the session; if no candidates are returned, it throws a no-candidate recovery-policy message (`src/agents/agent-adapter.ts:523-537`).
4. During each recovery attempt, it resolves the candidate chain again, iterates provider/account/model candidates, skips unavailable candidates, and invokes the LLM loop (`src/agents/agent-adapter.ts:603-674`).
5. On per-candidate failure, it classifies the error, may mark the candidate failed/cooling/blocked, appends redacted model issue text, records `llm_attempt` metadata, and either retries, fails over, or aborts (`src/agents/agent-adapter.ts:900-959`).
6. It records an `llm_invocation_summary` with role, attempt count, final provider/model/account on success or last failure class on failure (`src/agents/agent-adapter.ts:975-997`).

`ModelRouter.resolve()` is network-free and auth-free by design (`src/agents/model-router.ts:54-56`). It:

- reads the role's model list,
- resolves providers that advertise each model,
- sorts by provider priority and account priority,
- skips capability-incompatible candidates,
- skips unavailable candidates,
- tries equivalents/failover only when the current model has no viable candidates (`src/agents/model-router.ts:58-129`).

Potential no-candidate code categories:

| Category | Source mechanism | Durable symptom to look for |
|---|---|---|
| Missing reviewer/default model list | `getModelListForRole()` throws if neither role nor default exists | planner/reviewer invocation error before candidates |
| Model not advertised by any provider | provider registry returns no providers for model | no healthy candidates or no candidate chain |
| Capability mismatch | provider effective capabilities do not satisfy tools/exclusive tool choice | no capability-compatible candidates; capability skip reasons |
| Availability cooldown/block | `CandidateAvailability.isAvailable()` false | no healthy candidates if all candidates unavailable |
| Auth/profile transport failure | credential resolution or provider HTTP auth failure after candidate selected | failed `llm_attempt` with `auth_permanent` or `unknown`; candidate may block |
| Rate/usage/provider capacity | HTTP 429 or usage-limit classified as rate limit | failed `llm_attempt` with `rate_limit`; candidate `BLOCKED_UNTIL` |
| Provider protocol mismatch | provider rejects tool/response format protocol | failed `llm_attempt` with `provider_protocol_error`; failover if possible |

## Config and auth shape consumed by code

The persisted config schema accepts open role keys in `models`, plus `models.profiles`, `models.routing`, `models.equivalents`, `models.failover`, and `models.default` (`src/agents/config-schema.ts:120-164`). Provider/account entries accept non-secret routing/capability fields and secret-bearing `apiKey` or `authProfile` references (`src/agents/config-schema.ts:166-190`).

`getModelListForRole()` resolution order is:

1. direct `models[role]` list,
2. `models.routing[role]` profile with preferred + allowed models,
3. `models.default`,
4. throw if none exists (`src/agents/config-schema.ts:398-424`, read during source inspection).

Credentials are consumed only after candidate selection by `resolveLlmTransportConfig()` and `CredentialSourceResolver`. Resolution order is documented in code and implemented as:

- base URL: account base URL → provider base URL → provider default → OpenAI default,
- credential: account API key → provider API key → explicit account auth profile → explicit provider auth profile → unambiguous provider/alias auth profile → none,
- token endpoint: account → provider → inferred provider base (`src/agents/credential-source-resolver.ts:75-87`, `src/agents/credential-source-resolver.ts:107-207`).

Important operational implication: a candidate can be routeable even when credentials are missing or ambiguous, because `ModelRouter` intentionally does not load/refresh auth profiles. Such failures appear at invocation time, not route resolution time.

## Invocation error categories and recovery

HTTP/transport classification maps common provider-capacity/auth cases as follows (`src/agents/llm-failure-classifiers.ts`):

- HTTP 401/403 → `auth_permanent`.
- HTTP 429, or HTTP 400 body with `usage_limit_reached` → `rate_limit`.
- HTTP 400 body with `context_length_exceeded` → `token_budget_exceeded`.
- HTTP 5xx → `server_transient`.
- provider-specific bad protocol, especially `opencode-go` HTTP 400 → `provider_protocol_error`.
- aborts/cancellations → `cancelled`.
- network timeout/error patterns → `timeout` or `unknown`.

`InvocationRecoveryPolicy` converts those classes into actions:

- permanent auth: failover without retry and block candidate for about one hour,
- rate limit: cooldown/block until provider reset/retry horizon,
- server transient/timeout/unknown: cooldown and failover,
- provider protocol/token budget: failover without cooldown,
- parse errors: retry same candidate up to recovery limit then failover,
- no candidates: abort without retry with either capability-compatible or healthy-candidate wording (`src/agents/invocation-recovery-policy.ts`, inspected in full).

All session model issues and `llm_attempt` error fields are redacted before persistence (`src/agents/agent-adapter.ts:578-584`, `src/agents/agent-adapter.ts:900-935`).

## What the data-agent/coder should verify next

Without exposing values, live evidence should answer these precise questions:

1. **Reviewer model routing shape**: Does `.saivage/saivage.json` contain `models.reviewer`, a `models.routing.reviewer` profile, or `models.default`? Do referenced model names appear under any configured provider's `models` list?
2. **Capability compatibility**: Do reviewer candidates have effective `toolsMode != unsupported` and `exclusiveToolChoiceSupport != unsupported`? Check `llm_attempt.capability_skip_reasons` or compute non-secret candidate diagnostics.
3. **Candidate availability state**: Are all reviewer candidates currently `COOLING`/`BLOCKED_UNTIL` in the candidate availability store? Record provider/account/model labels and reason/time category only.
4. **Credential shape**: For selected reviewer candidates, is credential source `account-api-key`, `provider-api-key`, explicit profile, alias profile, or `none`? If a profile is used, report only profile name/provider/key presence/expiry category, not token values.
5. **Failure class**: Recent reviewer `llm_attempt` / `llm_invocation_summary` events should identify last failure class. Prefer these structured event fields over raw provider bodies.
6. **Ambiguous profiles**: If credential resolution throws an ambiguous profile error, the safe fix is to set explicit `authProfile` on provider/account (without exposing or modifying token values unless directed).

## Code-fix likelihood

Based on source inspection alone, a new v3 source fix is only indicated if live evidence shows one of these specific defects:

- `ModelRouter` returns no candidates despite valid reviewer/default models and compatible providers/accounts.
- Capability defaults incorrectly exclude a provider that is known/configured to support tool calls and exclusive terminal tool choice.
- Credential resolution selects the wrong profile when explicit `authProfile` is present.
- Recovery policy leaves all candidates blocked long past their `untilMs` or fails to mark a successful candidate healthy.
- Terminal acceptance path fails to persist `reviewer_unavailable/reviewer_invocation_failed` when reviewer invocation throws.

Otherwise, the remaining blocker should be surfaced as provider/auth/capacity state: missing/ambiguous credential shape, permanent auth failure, rate/usage limit, provider protocol incompatibility, or no healthy/capability-compatible candidate.

## Sources

Source files inspected locally on 2026-06-01:

- `src/runtime/active-runtime.ts`
- `src/agents/agent-adapter.ts`
- `src/agents/model-router.ts`
- `src/agents/provider.ts`
- `src/agents/provider-capabilities.ts`
- `src/agents/config-schema.ts`
- `src/agents/credential-source-resolver.ts`
- `src/agents/llm-transport.ts`
- `src/agents/llm-provider-gateway.ts`
- `src/agents/llm-openai-chat-gateway.ts`
- `src/agents/llm-failure-classifiers.ts`
- `src/agents/invocation-recovery-policy.ts`
- `src/agents/candidate-availability.ts`
- `src/tools/planner-tools.ts`
- `src/runtime/runtime.ts`
- Prior summaries: `.saivage/stages/repair-reviewer-availability-terminal-acceptance-001/summary.json` and `.saivage/stages/repair-runtime-intent-active-run-reconciliation-001/summary.json`
