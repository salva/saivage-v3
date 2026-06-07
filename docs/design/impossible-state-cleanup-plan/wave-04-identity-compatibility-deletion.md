# Wave 4: Identity And Compatibility Deletion

Findings covered: C14, C15, C16.

## Objective

Delete backward-compatible invocation shapes and fallback session lookup. Normal runtime calls should use structured requests with complete identities.

## Current Problem

The agent adapter still accepts string overloads and constructs incomplete contracts with placeholder values. Session lookup scans all planner sessions if deterministic lookup fails. Reinvocation substitutes empty ids when persisted session metadata is missing.

## Architecture Decision

There is one invocation shape per role: a structured request object. The request must contain every identity field needed to build the role contract. No string overloads, empty string placeholders, or fallback session scans.

## Implementation Design

### Step 1: Delete Public String Overloads

Targets:
- `src/agents/agent-adapter.ts#L291-L310`
- `src/agents/agent-adapter.ts#L329-L352`
- `src/agents/agent-adapter.ts#L362-L392`

Keep only:

```typescript
invokePlanner(request: PlannerInvocationRequest): Promise<PlannerResult>
invokeExecutor(request: ExecutorInvocationRequest): Promise<ExecutorResult>
invokeReviewer(request: ReviewerInvocationRequest): Promise<ReviewerResult>
```

Update all callers and tests. Do not keep compatibility wrappers.

### Step 2: Delete Placeholder Contract Inputs

Remove contract construction with:
- `parentSessionId: ''`
- `goalId: ''`
- `assessmentId: ''`

If a caller cannot provide the value, that caller is invalid and should throw before invoking an agent.

### Step 3: Make Reinvocation Strict

Current empty fallback: `src/agents/agent-adapter.ts#L414-L441`.

Required behavior:
- executor reinvocation requires `session.card_id` and `session.goal_card_id`
- reviewer reinvocation requires `session.goal_card_id` and a valid assessment id source
- missing metadata throws `SessionInvariantError`

If reviewer assessment id is not persisted today, add it to session metadata at reviewer session creation. Do not keep `assessmentId: ''`.

Use an explicit `assessment_id` field on `AgentSession` for reviewer sessions. It is required for reviewer reinvocation and null/absent for roles that do not use assessments. Update the session schema and reviewer session creation in the same commit.

### Step 4: Remove Planner Session Scan Fallback

Current fallback: `src/runtime/session-persistence.ts#L436-L444`.

Keep deterministic session lookup only:

```typescript
return getSession(saivageDir, `planner:${cardId}`);
```

If deterministic lookup fails in a normal path, the caller should throw.

## Tests

Update tests that call old string overloads to structured requests.

Add tests:
- string overloads no longer exist at type level
- missing executor `card_id` or `goal_card_id` in reinvocation throws
- missing reviewer goal/assessment metadata throws
- planner session lookup does not scan fallback sessions

Focused command:

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/agents/agent-adapter-recovery.test.ts tests/agents/agent-adapter-planner-tools.test.ts tests/agents/agent-adapter-non-planner-tools.test.ts tests/agents/session-persistence.test.ts --runInBand --forceExit
```

## Validation

```bash
npm run typecheck
npm test
npm run validate:docs
```

## Stop Criteria

Wave 4 is complete when no old invocation overload, empty contract id, or planner-session scan fallback remains.
