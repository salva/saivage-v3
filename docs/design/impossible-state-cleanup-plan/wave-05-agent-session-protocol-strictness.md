# Wave 5: Agent Session And Protocol Strictness

Findings covered: C10, C11, C12, C17, C18, P01, P02, P03.

## Objective

Make agent/session code strict about internal state while treating malformed model/provider output as explicit protocol failure rather than normalizing it to `{}`.

## Architecture Decision

Internal agent loop state is authoritative and must fail fast. External model output is untrusted and should be converted into protocol/verifier errors with preserved evidence. Session message ordering is owned by one authoritative stamper.

## Implementation Design

### Step 1: Introduce Protocol Error Representation

Define a typed representation for malformed model/tool-call arguments, for example:

```typescript
interface AgentProtocolViolation {
  kind: 'agent_protocol_violation';
  session_id: string;
  role: AgentRole;
  provider?: string;
  model?: string;
  tool_call_id?: string;
  tool_name?: string;
  violation: 'tool_args_invalid_json' | 'tool_args_not_object' | 'terminal_args_not_object' | 'internal_tool_result_malformed';
  raw_preview: string;
}
```

Use this for diagnostics/events and for model-visible repair messages when appropriate.

### Step 2: Stop Persisting Malformed Assistant Tool Args As `{}`

Current path: `src/agents/invocation-runner.ts#L212-L235`.

New behavior:
- parse tool args
- if invalid, persist/provide a protocol violation message or verifier rejection
- do not call normal tools with empty args
- preserve a redacted/truncated raw preview

### Step 3: Validate Internal `activate_card` Tool Results Strictly

Current path: `src/agents/invocation-runner.ts#L253-L270`.

Since `activate_card` is an internal tool result, malformed JSON should throw, not become a model repair attempt.

### Step 4: Make Agent Loop Unexpected State Throw

Current path: `src/agents/agent-loop-driver.ts#L82-L89`, `src/agents/agent-loop-driver.ts#L180-L193`.

Replace the default cancelled result with an invariant throw. The state union should make this unreachable; if TypeScript still allows it, add an exhaustive `assertNever` helper.

### Step 5: Reject Non-Object Terminal Args

Current path: `src/agents/contract-verifier.ts#L72-L85`.

Change `parseDoneArgs()` so arrays, strings, numbers, booleans, and null produce a verifier violation. Do not map to `{}`.

### Step 6: Make Analyst Tool Args Protocol Errors

Current path: `src/agents/analyst-handler.ts#L224-L231`.

New behavior:
- malformed args become a tool/protocol error response
- analyst tool is not executed
- persisted transcript preserves evidence without exposing secrets

### Step 7: Split Tool Boundary Pruning APIs

Current shared helper: `src/agents/context-compactor.ts#L71-L99`.

Create two APIs:
- `pruneToolBoundaryAfterTruncation(messages)` for known truncation fallout
- `assertToolBoundaryIntegrity(messages)` for full untruncated history

Use pruning only after compaction fallback truncation. Use assertion/diagnostic for analyst full history before model input.

### Step 8: Refactor SessionMessageLog To Require A Stamper

Current fallback stamps: `src/agents/session-message-log.ts#L21-L60`.

Make `SessionMessageLog` depend on `SessionStamper`. Remove internal fallback round maps. If a caller cannot provide a stamper, that caller is architecturally incomplete and should be fixed.

### Step 9: Surface Handoff Read Errors

Current path: `src/agents/agent-session-coordinator.ts#L77-L104`.

Instead of returning `null` or `[]` for read failures, return an explicit operator-visible error state or emit a diagnostic event. Do not hide corrupted persistence as absence of handoff.

## Tests

Add/update tests:

- malformed assistant tool args do not execute tools and preserve protocol evidence
- malformed analyst tool args do not execute tools
- terminal args that are arrays/null/strings produce verifier violation
- internal `activate_card` malformed result throws
- agent loop unexpected non-terminal state throws
- full-history orphan tool rows fail strict boundary validation
- truncation path still prunes boundary fallout
- `SessionMessageLog` uses injected stamper and no fallback maps remain
- handoff read failure surfaces error/diagnostic

Focused command:

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest tests/agents/agent-loop-driver.test.ts tests/agents/contract-verifier.test.ts tests/agents/analyst-handler.test.ts tests/agents/compaction.test.ts tests/agents/session-persistence.test.ts tests/agents/agent-session-coordinator.test.ts --runInBand --forceExit
```

## Validation

```bash
npm run typecheck
npm test
npm run validate:docs
```

## Stop Criteria

Wave 5 is complete when no malformed model/tool arguments are normalized to `{}`, unexpected agent loop states throw, and session message ordering has one authoritative stamper.
