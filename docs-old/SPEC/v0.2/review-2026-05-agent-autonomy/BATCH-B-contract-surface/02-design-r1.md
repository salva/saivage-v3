# Batch B - Contract Surface Design

This document specifies the contract-surface redesign for issues F05
(hardcoded role taxonomy), F06 (synthesised deferred activations), and
F07 (system prompt misaligned with runtime contract). It defines the
per-invocation contract value, how it propagates into the prompt, the
tool exposure, the verifier, the recorder, and the supervisor
projection, and how the deferred-activation case is dissolved.

The design is compatible with either of the two outcomes the
contract-verifier batch may produce: it works whether the verifier
remains a single function or is generalised into a registry, because
the contract value defined here is the unit a verifier consumes either
way. Any assumption that the verifier batch picks a particular shape is
called out explicitly in
[section 1.4](#14-coordination-with-the-contract-verifier-batch).

## 1. Design goal

The runtime today carries three independent, role-keyed surfaces -
schema, terminal-tool name, allowed-tool list - and binds them only by
the convention that every lookup uses the same `role` string. The
adapter, the LLM-options factory, the verifier, the tool catalogue,
the recorder, and the contracts module all narrow on that string
independently
([role-envelope-schemas.ts#L64](../../../src/agents/role-envelope-schemas.ts#L64),
[role-result-tools.ts#L4](../../../src/agents/role-result-tools.ts#L4),
[terminal-protocol.ts#L6](../../../src/agents/terminal-protocol.ts#L6),
[llm-options-factory.ts#L15](../../../src/agents/llm-options-factory.ts#L15),
[llm-options-factory.ts#L49](../../../src/agents/llm-options-factory.ts#L49),
[agent-adapter.ts#L292](../../../src/agents/agent-adapter.ts#L292),
[agent-tool-catalog.ts#L105](../../../src/agents/agent-tool-catalog.ts#L105),
[llm-exchange.ts#L32](../../../src/contracts/llm-exchange.ts#L32),
[llm-recording.ts#L64](../../../src/agents/llm-recording.ts#L64)).
The system prompt is a fourth, hand-written description of the same
contract that has already drifted
([system-prompt.ts#L64](../../../src/agents/system-prompt.ts#L64),
[system-prompt.ts#L129](../../../src/agents/system-prompt.ts#L129),
[system-prompt.ts#L218](../../../src/agents/system-prompt.ts#L218)).
The deferred-activation envelope is a parallel, undeclared terminal
shape that the adapter forges on the agent's behalf
([agent-adapter.ts#L358](../../../src/agents/agent-adapter.ts#L358)),
with a legacy parser fallback that fabricates identity fields
([validators.ts#L68-L70](../../../src/schemas/validators.ts#L68)).

The redesign goal is to reduce all of this to one value with one
owner:

1. Every call to `invokeAgent` carries a `Contract` value built by
   the caller (planner / executor / reviewer factory). The contract
   owns the wire schema, the names of the terminal tool(s) the
   agent may call to satisfy it, the JSON-schema rendering of those
   tools, a short human-readable description of the wire shape used
   in the prompt, a verifier function from `PersistedToolCall` to
   the typed envelope, and a typed projection from the envelope to
   the supervisor's `PlannerResult` / `ExecutorResult` /
   `ReviewerResult`.
2. The prompt builder consumes the contract's `describe()` and
   `terminalToolNames()` outputs instead of restating the wire
   shape and instead of omitting the terminal-tool name entirely.
   There is one source of truth.
3. The role string survives only as routing metadata for prompt
   selection and tool-catalogue selection; it stops keying anything
   that defines a contract. `EnvelopeBearingRole` and the three
   role-keyed records are deleted.
4. The deferred-activation case is dissolved by making it a
   first-class terminal envelope on the planner contract (Position
   C from the analysis). The adapter's synthesis branch, the
   `__saivage_defer_tool_result` legacy parser fallback, the inline
   `CardStore` construction, the dependency walk, and the
   `system / model_issue` synthesis rows all disappear.
5. The contracts module keeps the typed
   `PlannerResult` / `ExecutorResult` / `ReviewerResult` shapes so
   that the planner driver, `applyPlannerResult`, and the reviewer
   driver continue to receive the same typed values
   ([runtime.ts#L677-L697](../../../src/runtime/runtime.ts#L677),
   [runtime.ts#L822-L842](../../../src/runtime/runtime.ts#L822),
   [runtime.ts#L453-L470](../../../src/runtime/runtime.ts#L453)).
   The construction of those values moves to contract projections
   co-located with the contract definitions.

## 2. Proposal P-B1 - Focused fix

### 2.1 The `Contract` interface

The contract is a value with no global registration. It is constructed
by the caller and passed positionally through `invokeAgent`. The
interface is intentionally minimal: the schema is opaque (`unknown` in,
`Envelope` out), the projection is a pure function from a parsed
envelope to a typed result, and the tool definitions are pre-built so
the LLM-options factory and the recorder do not have to look anything
up by role.

```ts
import type { ZodTypeAny } from 'zod';
import type { PersistedToolCall } from '../agents/persisted-tool-call.js';
import type { LlmRequestError } from '../agents/llm-failure.js';

export interface ContractToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ContractTerminalDescriptor {
  name: string;
  description: string;
  schema: ZodTypeAny;
  toolDefinition: ContractToolDefinition;
}

export interface ContractVerifyOk<Envelope> {
  ok: true;
  terminalName: string;
  envelope: Envelope;
}

export interface ContractVerifyFail {
  ok: false;
  error: LlmRequestError;
}

export type ContractVerifyResult<Envelope> =
  | ContractVerifyOk<Envelope>
  | ContractVerifyFail;

export interface Contract<Envelope, TypedResult> {
  readonly name: string;
  readonly terminals: readonly ContractTerminalDescriptor[];
  describe(): string;
  isTerminalToolName(name: string): boolean;
  verify(call: PersistedToolCall): ContractVerifyResult<Envelope>;
  project(envelope: Envelope, terminalName: string): TypedResult;
}
```

Notes on this signature:

- `terminals` is an array, not a single value. A contract with one
  terminal (executor, reviewer) returns a one-element array; the
  planner contract returns two (`emit_planner_result` and
  `emit_planner_deferred`, see [section 2.6](#26-deferred-activation-as-a-first-class-terminal-on-the-planner-contract)).
  The recorder, the LLM-options factory, and the tool catalogue all
  iterate `contract.terminals` so adding a third terminal is a
  contract-local change, not a runtime change.
- `verify` returns a tagged result rather than throwing because the
  caller is the adapter loop, which today already turns the throw
  into a structured `LlmRequestError`. Returning the error lets the
  verifier-and-repair loop in the parallel batch treat the failure
  as a repair signal without unwinding the stack.
- `project` is parameterised by the terminal name so that a contract
  with multiple terminals can map each one to a different
  `TypedResult` shape (or to a discriminated union of typed results,
  as the planner contract does).

The verifier helper at
[terminal-protocol.ts#L6](../../../src/agents/terminal-protocol.ts#L6)
becomes a thin shared implementation that any concrete contract may
reuse internally:

```ts
import { z } from 'zod';
import type { PersistedToolCall } from './persisted-tool-call.js';
import { LlmRequestError } from './llm-failure.js';
import type {
  Contract,
  ContractTerminalDescriptor,
  ContractVerifyResult,
} from '../contracts/contract.js';

export function verifyAgainstTerminals<Envelope>(
  call: PersistedToolCall,
  terminals: readonly ContractTerminalDescriptor[],
  contractName: string,
): ContractVerifyResult<Envelope> {
  const terminal = terminals.find((t) => t.name === call.name);
  if (!terminal) {
    return {
      ok: false,
      error: new LlmRequestError({
        kind: 'contract_mismatch',
        subtype: 'terminal_tool_unexpected',
        provider: 'gateway-protocol',
        message:
          `contract '${contractName}' got terminal call '${call.name}', ` +
          `expected one of [${terminals.map((t) => t.name).join(', ')}]`,
      }),
    };
  }
  const parsed = terminal.schema.safeParse(call.args);
  if (!parsed.success) {
    return {
      ok: false,
      error: new LlmRequestError({
        kind: 'contract_mismatch',
        subtype: 'terminal_tool_invalid_envelope',
        provider: 'gateway-protocol',
        message:
          `contract '${contractName}' terminal '${call.name}' failed schema: ` +
          parsed.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
            .join('; '),
      }),
    };
  }
  return { ok: true, terminalName: terminal.name, envelope: parsed.data as Envelope };
}
```

This helper is internal to `src/contracts/`. The Contract is the unit
the rest of the runtime sees; `verifyAgainstTerminals` is an
implementation convenience for the bundled planner / executor /
reviewer contracts.

### 2.2 Per-invocation contract construction

The contract value is constructed at the call site of `invokeAgent`.
There is no global map of contracts and no role-keyed dispatch. The
factories live in `src/contracts/` so they are co-located with the
typed result definitions in
[contracts/agent-execution.ts#L30-L79](../../../src/contracts/agent-execution.ts#L30)
that the supervisor consumes; the planner driver, executor driver,
and reviewer driver in
[runtime.ts#L677-L697](../../../src/runtime/runtime.ts#L677),
[runtime.ts#L822-L842](../../../src/runtime/runtime.ts#L822), and
[runtime.ts#L453-L470](../../../src/runtime/runtime.ts#L453) import
the factories instead of role strings.

```ts
import type {
  PlannerResult,
  ExecutorResult,
  ReviewerResult,
} from './agent-execution.js';
import type { Contract } from './contract.js';
import type { DeferredActivationEnvelopeV1 } from '../schemas/types.js';

export type PlannerEnvelope =
  | { kind: 'result'; payload: import('./planner-envelope.js').PlannerResultEnvelope }
  | { kind: 'deferred'; payload: DeferredActivationEnvelopeV1 };

export type PlannerTypedResult =
  | { kind: 'result'; result: PlannerResult }
  | { kind: 'deferred'; result: PlannerResult };

export interface PlannerContractInput {
  goalId: string;
  parentSessionId: string;
}

export interface ExecutorContractInput {
  cardId: string;
  goalId: string;
}

export interface ReviewerContractInput {
  goalId: string;
  assessmentId: string;
}

export function createPlannerContract(
  input: PlannerContractInput,
): Contract<PlannerEnvelope, PlannerTypedResult> {
  // body deferred to src/contracts/planner-contract.ts; see 2.6
  throw new Error('see src/contracts/planner-contract.ts');
}

export function createExecutorContract(
  input: ExecutorContractInput,
): Contract<import('./executor-envelope.js').ExecutorResultEnvelope, ExecutorResult> {
  throw new Error('see src/contracts/executor-contract.ts');
}

export function createReviewerContract(
  input: ReviewerContractInput,
): Contract<import('./reviewer-envelope.js').ReviewerResultEnvelope, ReviewerResult> {
  throw new Error('see src/contracts/reviewer-contract.ts');
}
```

The factories take only the per-invocation data they need
(`goalId`, `cardId`, `assessmentId`, `parentSessionId`). They do not
take a role string, a candidate, or any prompt; those are the
adapter's concern. A future contract that splits executor by card
type or by skill (one of the F05 motivations) is added by exporting
a new factory; no enum is widened.

The analyst path stays outside the contract for now. The analyst
runner exits early on `result.kind === 'message'` at
[agent-adapter.ts#L304-L305](../../../src/agents/agent-adapter.ts#L304),
which means it never reaches `verify`. Wrapping the analyst in a
`Contract<{ content: string }, { content: string }>` whose terminals
array is empty and whose `verify` is unreachable is a one-page
addition that this batch does not require but does not prevent; see
[section 6](#6-rejected-alternatives) for why it is not in P-B1.

`invokeAgent` no longer accepts a role string for the contract
purpose. It accepts the contract value plus the role (still needed
for prompt selection and tool-catalogue selection):

```ts
export interface InvokeAgentRequest<Envelope, TypedResult> {
  role: 'planner' | 'executor' | 'reviewer';
  contract: Contract<Envelope, TypedResult>;
  goalId: string;
  cardId?: string;
  systemPrompt: string;
  candidateRoute: CandidateRoute;
}

export interface InvokeAgentResult<TypedResult> {
  sessionId: string;
  result: TypedResult;
  terminalName: string;
}

export declare function invokeAgent<Envelope, TypedResult>(
  request: InvokeAgentRequest<Envelope, TypedResult>,
): Promise<InvokeAgentResult<TypedResult>>;
```

The supervisor entry points become:

```ts
import { createPlannerContract, createExecutorContract, createReviewerContract } from '../contracts/index.js';

export function invokePlanner(req: PlannerInvocationRequest) {
  return invokeAgent({
    role: 'planner',
    contract: createPlannerContract({
      goalId: req.goalId,
      parentSessionId: req.parentSessionId,
    }),
    goalId: req.goalId,
    systemPrompt: req.systemPrompt,
    candidateRoute: req.candidateRoute,
  });
}
```

The three projection functions at
[agent-adapter.ts#L49-L75](../../../src/agents/agent-adapter.ts#L49)
are deleted; their bodies become the `project` method on each
contract factory.

### 2.3 Migration of the role taxonomy

Under P-B1 the following symbols are removed entirely. No alias, no
re-export, no migration shim.

- `EnvelopeBearingRole` at
  [role-envelope-schemas.ts#L64](../../../src/agents/role-envelope-schemas.ts#L64).
- `ENVELOPE_SCHEMAS` at
  [role-envelope-schemas.ts#L66](../../../src/agents/role-envelope-schemas.ts#L66).
- `ROLE_RESULT_TOOL_NAMES` at
  [role-result-tools.ts#L4](../../../src/agents/role-result-tools.ts#L4),
  along with `ROLE_RESULT_TOOLS`, `EMIT_PLANNER_RESULT`,
  `EMIT_EXECUTOR_RESULT`, `EMIT_REVIEWER_RESULT`, and `buildToolDef`
  at [role-result-tools.ts#L19](../../../src/agents/role-result-tools.ts#L19).
- `validateTerminalToolCall` at
  [terminal-protocol.ts#L6](../../../src/agents/terminal-protocol.ts#L6),
  replaced by `Contract.verify`.
- `isEnvelopeBearing` and the entire `'terminal'` phase branch in
  [llm-options-factory.ts#L15](../../../src/agents/llm-options-factory.ts#L15)
  and [llm-options-factory.ts#L44-L62](../../../src/agents/llm-options-factory.ts#L44),
  along with the `LlmRolePhase` union.
- `TERMINAL_TOOL_NAMES` and the `terminalTool` enum on
  `exchangeAttemptSchema` at
  [llm-exchange.ts#L32-L35](../../../src/contracts/llm-exchange.ts#L32),
  including the re-export at
  [contracts/index.ts#L100](../../../src/contracts/index.ts#L100).
  The schema becomes
  `terminalTool: z.string().nullable()`. The runtime check inside
  `deriveTerminalToolFromOptions` and the `asTerminalToolName` narrowing
  at [llm-recording.ts#L59-L65](../../../src/agents/llm-recording.ts#L59)
  are deleted; the recorder reads the terminal-tool name(s) off the
  contract that produced the request (see
  [section 2.7](#27-recorder-integration)).
- The inline `expectsEnvelope` / `envelopeRole` / `terminalToolName`
  / `terminalToolDef` block at
  [agent-adapter.ts#L292-L295](../../../src/agents/agent-adapter.ts#L292).
- The role-keyed splice of `ROLE_RESULT_TOOL_NAMES.{role}` into
  `ROLE_TOOL_NAMES` at
  [agent-tool-catalog.ts#L105/L120/L130](../../../src/agents/agent-tool-catalog.ts#L105).

What replaces each of them is named in [section 2.4](#24-replacement-map).

### 2.4 Replacement map

| Deleted symbol | Replacement | Owner |
| -------------- | ----------- | ----- |
| `EnvelopeBearingRole` | none; role is no longer a contract key. The string union `'planner' \| 'executor' \| 'reviewer'` survives only on `InvokeAgentRequest.role` for prompt and catalogue routing. | adapter |
| `ENVELOPE_SCHEMAS[role]` | `contract.terminals[i].schema` | contract value |
| `ROLE_RESULT_TOOL_NAMES[role]` | `contract.terminals[i].name`, plus `contract.isTerminalToolName(name)` for membership tests | contract value |
| `ROLE_RESULT_TOOLS[role]` | `contract.terminals.map((t) => t.toolDefinition)` (concatenated into the per-turn tool list at the call site) | contract value |
| `validateTerminalToolCall(call, role)` | `contract.verify(call)` | contract value |
| `isEnvelopeBearing(role)` | always true once `invokeAgent` requires a contract; analyst stays out via a separate adapter entry point (`invokeAnalyst`) | adapter |
| `buildLlmOptions(..., 'terminal', ...)` | deleted; every turn uses `'tools'` with the per-turn tool list (action tools plus `contract.terminals[*].toolDefinition`). The verifier decides when the turn is terminal by reading the tool calls. | adapter |
| `TERMINAL_TOOL_NAMES` (`z.enum`) | `terminalTool: z.string().nullable()` on `exchangeAttemptSchema`; recorder writes whichever terminal name fired | contracts module |
| `asTerminalToolName` / `deriveTerminalToolFromOptions` narrowing | recorder receives `terminalToolNames: string[]` from the contract via the request struct | recorder |
| `ROLE_TOOL_NAMES.planner` splice of `emit_planner_result` | the contract's terminal tool names are concatenated by the adapter at call time; `ROLE_TOOL_NAMES` lists only action tools | tool catalogue |
| `envelopeTo{Planner,Executor,Reviewer}Result` at [agent-adapter.ts#L49-L75](../../../src/agents/agent-adapter.ts#L49) | `contract.project(envelope, terminalName)` | contract value |

### 2.5 System prompt rendered from the contract

`buildPlannerPrompt`, `buildExecutorPrompt`, and `buildReviewerPrompt`
at [system-prompt.ts#L34](../../../src/agents/system-prompt.ts#L34),
[system-prompt.ts#L107](../../../src/agents/system-prompt.ts#L107),
and [system-prompt.ts#L221](../../../src/agents/system-prompt.ts#L221)
lose their hand-written "Expected JSON Output Format" sections at
[system-prompt.ts#L64-L102](../../../src/agents/system-prompt.ts#L64),
[system-prompt.ts#L129-L160](../../../src/agents/system-prompt.ts#L129),
and [system-prompt.ts#L233-L253](../../../src/agents/system-prompt.ts#L233).
They take a contract argument and call `contract.describe()`:

```ts
import type { Contract } from '../contracts/contract.js';

export function buildPlannerPrompt(
  contract: Contract<unknown, unknown>,
  options: { skills?: string; currentDepth?: number; maxDepth?: number },
): string {
  const body = `${SAIVAGE_INTRO}

## Your Role - Planner

You are the **Planner** agent. [...role responsibilities, unchanged from current prose...]

### Terminal Contract

To finish this turn you MUST call exactly one of the following tools:

${contract.describe()}

A plain text reply does not finish the turn. The runtime will respond with a
structured repair request describing what is missing, and you must answer it
with one of the terminal tool calls above.`;

  return options.skills ? `${body}\n\n${options.skills}` : body;
}
```

`Contract.describe()` is a single source of truth for the wire shape.
The recommended implementation renders a numbered list, one entry per
terminal, with: the tool name, its one-line description, and the
schema rendered as prose with embedded type hints. The renderer reads
the same zod schema that
[`zodToJsonSchemaMini`](../../../src/agents/zod-to-jsonschema-mini.ts)
already consumes for the tool definition, so prompt and tool spec
cannot drift:

```ts
import type { ZodTypeAny } from 'zod';
import type { ContractTerminalDescriptor } from './contract.js';
import { zodToJsonSchemaMini } from '../agents/zod-to-jsonschema-mini.js';
import { jsonSchemaToProse } from './json-schema-to-prose.js';

export function describeTerminals(
  terminals: readonly ContractTerminalDescriptor[],
): string {
  return terminals
    .map((t, i) => {
      const schema = zodToJsonSchemaMini(t.schema as ZodTypeAny);
      return `${i + 1}. \`${t.name}\` - ${t.description}\n\n${jsonSchemaToProse(schema)}`;
    })
    .join('\n\n');
}
```

`jsonSchemaToProse` produces the kind of prose currently hand-written
in [system-prompt.ts#L72-L102](../../../src/agents/system-prompt.ts#L72)
but driven by the schema. It is a single new module of bounded size
(a recursive walk over the mini-JSON-schema). The narrative
constraints currently embedded inside the JSON example
("never a project source/config/test file or directory" at
[system-prompt.ts#L143](../../../src/agents/system-prompt.ts#L143))
move to a separate prose block in the executor prompt, since they
are not in the schema; alternatively the schema gains a `description`
on the relevant fields and `jsonSchemaToProse` renders them. P-B1
takes the prose-block path because moving these constraints into
the schema is out of scope.

The `buildSelfCheckPrompt` block at
[system-prompt.ts#L253](../../../src/agents/system-prompt.ts#L253)
is deleted in P-B1 along with its ad-hoc `self_check` JSON examples at
[system-prompt.ts#L268-L272](../../../src/agents/system-prompt.ts#L268).
The block bypasses the contract today and there is no verifier for it;
the cross-cutting "is the agent stuck" question is left to the
verifier-and-repair loop in the parallel batch.

### 2.6 Deferred activation as a first-class terminal on the planner contract

The synthesis branch at
[agent-adapter.ts#L358-L380](../../../src/agents/agent-adapter.ts#L358)
exists because the planner has no contract-recognised way to say
"I am done with this turn, I activated a child, please re-invoke me
when it completes". P-B1 picks Position C from the analysis: the
planner contract exposes a second terminal tool
`emit_planner_deferred` whose body is the
`DeferredActivationEnvelopeV1` already produced by the
planner-control executor at
[planner-control-executor.ts#L120](../../../src/agents/planner-control-executor.ts#L120)
and [planner-control-executor.ts#L131](../../../src/agents/planner-control-executor.ts#L131).
The choice is justified in [section 2.6.2](#262-justification-of-position-c).

#### 2.6.1 Planner contract shape under Position C

```ts
import { z } from 'zod';
import type { PlannerResult } from './agent-execution.js';
import {
  PlannerResultEnvelopeSchema,
  type PlannerResultEnvelope,
} from './planner-envelope.js';
import {
  deferredActivationEnvelopeV1Schema,
  type DeferredActivationEnvelopeV1,
} from '../schemas/index.js';
import {
  type Contract,
  type ContractTerminalDescriptor,
} from './contract.js';
import { zodToJsonSchemaMini } from '../agents/zod-to-jsonschema-mini.js';
import { verifyAgainstTerminals } from '../agents/terminal-protocol.js';
import { describeTerminals } from './describe-terminals.js';

export type PlannerEnvelope =
  | { kind: 'result'; payload: PlannerResultEnvelope }
  | { kind: 'deferred'; payload: DeferredActivationEnvelopeV1 };

export type PlannerTypedResult =
  | { kind: 'result'; result: PlannerResult }
  | { kind: 'deferred'; result: PlannerResult; activations: DeferredActivationEnvelopeV1[] };

export function createPlannerContract(input: {
  goalId: string;
  parentSessionId: string;
}): Contract<PlannerEnvelope, PlannerTypedResult> {
  const resultTerminal: ContractTerminalDescriptor = {
    name: 'emit_planner_result',
    description: 'Emit the planner result envelope as the final action of this turn.',
    schema: PlannerResultEnvelopeSchema,
    toolDefinition: {
      type: 'function',
      function: {
        name: 'emit_planner_result',
        description: 'Emit the planner result envelope as the final action of this turn.',
        parameters: zodToJsonSchemaMini(PlannerResultEnvelopeSchema),
      },
    },
  };
  const deferredTerminal: ContractTerminalDescriptor = {
    name: 'emit_planner_deferred',
    description:
      'End this turn deferring on an in-flight child activation. Echo the deferred_activate_card envelope returned by activate_card.',
    schema: deferredActivationEnvelopeV1Schema,
    toolDefinition: {
      type: 'function',
      function: {
        name: 'emit_planner_deferred',
        description:
          'End this turn deferring on an in-flight child activation. Echo the deferred_activate_card envelope returned by activate_card.',
        parameters: zodToJsonSchemaMini(deferredActivationEnvelopeV1Schema),
      },
    },
  };
  const terminals = [resultTerminal, deferredTerminal] as const;

  return {
    name: 'planner',
    terminals,
    describe() {
      return describeTerminals(terminals);
    },
    isTerminalToolName(name) {
      return terminals.some((t) => t.name === name);
    },
    verify(call) {
      const inner = verifyAgainstTerminals<unknown>(call, terminals, 'planner');
      if (!inner.ok) return inner;
      if (inner.terminalName === 'emit_planner_result') {
        return {
          ok: true,
          terminalName: inner.terminalName,
          envelope: { kind: 'result', payload: inner.envelope as PlannerResultEnvelope },
        };
      }
      return {
        ok: true,
        terminalName: inner.terminalName,
        envelope: { kind: 'deferred', payload: inner.envelope as DeferredActivationEnvelopeV1 },
      };
    },
    project(envelope) {
      if (envelope.kind === 'result') {
        const p = envelope.payload;
        return {
          kind: 'result',
          result: {
            status: p.status,
            blocked_reason: p.blocked_reason ?? undefined,
            created_cards: p.created_cards ?? [],
            updated_cards: p.updated_cards ?? [],
            summary: p.summary,
          },
        };
      }
      const d = envelope.payload;
      return {
        kind: 'deferred',
        result: {
          status: 'continue',
          created_cards: [],
          updated_cards: [],
          summary: `Activated child ${d.child_card_id}; awaiting completion.`,
        },
        activations: [d],
      };
    },
  };
}
```

#### 2.6.2 Justification of Position C

Position A (synthesise behind a contract wrapper) keeps the adapter
forging a result on the agent's behalf and only changes the
narration. Under the workspace's architecture-first rule, that is the
shape of the bug, not the shape of a fix: the runtime is still the
one finishing the turn, and the contract value would lie about who
emitted it. The analysis review flags Position A as "compatibility-
shaped risk" for this reason.

Position B (the planner must always emit `emit_planner_result`) needs
the planner LLM to remember, after every `activate_card`, to do
nothing useful and then emit `status: continue` with no other
content. The model has to learn a redundant ritual that exists purely
to satisfy the contract surface. Worse, B leaves F03 unresolved:
there is no structural difference between "I am done thinking, please
re-invoke me later because a child is running" and "I have nothing
more to say, run me again". The runtime cannot distinguish
"awaiting child completion" from "stuck planner" by inspecting the
typed result.

Position C makes the deferred case a real terminal in the contract.
The planner emits `emit_planner_deferred` with the envelope it
already received from `activate_card`. The verifier accepts it
because it is one of the contract's terminal tools, the projection
returns a `PlannerTypedResult` of kind `'deferred'`, and the
supervisor reads the kind to decide whether to recur or to wait. The
adapter's synthesis branch is deleted; the inline `CardStore`
construction at
[agent-adapter.ts#L360](../../../src/agents/agent-adapter.ts#L360),
the dependency walk, and the `system / model_issue` synthesis rows
go with it. F03 is resolved by the same change.

#### 2.6.3 Mechanics

- The planner-control executor still returns the deferred envelope
  inside the `activate_card` tool result at
  [planner-control-executor.ts#L120/L131](../../../src/agents/planner-control-executor.ts#L120).
  No change required there.
- The system prompt for the planner gains one paragraph (rendered
  from `contract.describe()` since the deferred terminal is now part
  of the contract): "After `activate_card` succeeds, if you have
  nothing else to do this turn, call `emit_planner_deferred` with
  the `deferred_activate_card` envelope the tool returned to you.
  This ends your turn without claiming the parent goal is finished."
- The legacy parser fallback at
  [validators.ts#L68-L70](../../../src/schemas/validators.ts#L68) is
  deleted. `parseDeferredActivationEnvelope` becomes a one-liner that
  only succeeds against the strict
  `DeferredActivationEnvelopeV1` schema. The legacy
  `'legacy'` identity fields cannot survive; the contract requires
  the planner to echo the envelope it actually received, which
  carries real `parent_card_id`, `planner_session_id`, and
  `tool_call_id` values from the planner-control executor.
- The adapter's per-turn loop no longer inspects tool-call names to
  decide whether the turn is terminal. It calls `contract.verify` on
  every tool call whose name `contract.isTerminalToolName(name)` says
  is terminal; the first match ends the loop. The synthesis branch
  at [agent-adapter.ts#L358-L380](../../../src/agents/agent-adapter.ts#L358)
  is removed.

#### 2.6.4 Persistence and recording under Position C

The session-persistence scanners
[`findUniqueUnresolvedActivateCardToolCall`](../../../src/agents/session-persistence.ts#L404),
[`appendActivateCardToolResultOnce`](../../../src/agents/session-persistence.ts#L445),
and [`findUnresolvedActivateCards`](../../../src/runtime/runtime.ts#L235)
key off the persisted `activate_card` tool call and the
`tool_result` carrying the deferred envelope. None of those rows
change shape under Position C: the planner still calls
`activate_card`, the planner-control executor still returns the
deferred envelope as a `tool_result`, and the child activation still
completes through `parseActivationCompletionEnvelope` at
[validators.ts#L75](../../../src/schemas/validators.ts#L75).

What changes is the row that today is a synthesised `assistant / text`
JSON string at [agent-adapter.ts#L388](../../../src/agents/agent-adapter.ts#L388).
Under Position C the planner itself emits an `assistant / tool_call`
row for `emit_planner_deferred`. The "who wrote this" ambiguity that
the current synthesis row introduces disappears: replay sees a real
tool call from the planner, not a runtime-fabricated text row. No new
classification logic is required in the scanners.

### 2.7 Recorder integration

`LlmRecorderRequest` at
[llm-recording.ts#L51](../../../src/agents/llm-recording.ts#L51)
changes its `terminalTool` field from `TerminalToolName | null` to
`string[]` (the set of terminal tool names the contract accepts on
this turn), and a separate completed-side field `terminalToolFired:
string | null` records which one the model actually called:

```ts
import type { LlmExchangeRecorder } from './llm-exchange-recorder.js';
import type { Candidate } from './provider.js';

export interface LlmRecorderRequest {
  transport: 'generic' | 'codex';
  candidate: Candidate;
  endpoint: string;
  headers: Record<string, string>;
  body: unknown;
  terminalToolNames: readonly string[];
}

export interface LlmRecorderCompletion {
  terminalToolFired: string | null;
}
```

`exchangeAttemptSchema` at
[llm-exchange.ts#L24](../../../src/contracts/llm-exchange.ts#L24)
gains `terminalToolFired: z.string().nullable()` and the old
`terminalTool: z.enum(...)` field becomes `terminalToolOffered:
z.array(z.string()).readonly()`. Existing recorded exchanges are not
migrated (architecture-first, no backward compatibility); the
test fixtures regenerate.

The runtime no longer narrows the terminal-tool name through a
closed enum, which means downstream observability consumers that
relied on `terminalTool in TERMINAL_TOOL_NAMES` must read the
contract name (`exchangeAttemptSchema.terminalToolFired` plus
`llmExchangeSchema.contractName`, a new field carrying
`contract.name`) instead. The exhaustiveness check moves from the
schema layer to the dashboard layer.

### 2.8 `role-tool-policy.ts` after the redesign

`RoleToolPolicy` at
[role-tool-policy.ts#L63](../../../src/agents/role-tool-policy.ts#L63)
authorises which tools each role may list and invoke at three
surfaces (planner-control, agent-runtime, workspace, external-mcp,
skill). The terminal-tool name is currently in the role's allowed
list at [agent-tool-catalog.ts#L105/L120/L130](../../../src/agents/agent-tool-catalog.ts#L105)
which means `RoleToolPolicy.decide({ action: 'list', surface:
'agent-runtime', toolName: 'emit_planner_result', role: 'planner' })`
returns `allowed: true` purely because the terminal tool happens to
be in the static role list.

Under P-B1 the terminal tools are removed from `ROLE_TOOL_NAMES`. The
policy gains an explicit code path: the contract's terminal tools
are always allowed for an `invokeAgent` request that carries that
contract, and they are never allowed at any other surface. The
adapter, not the policy, knows which contract is in play, so the
policy gains an extra surface `'contract-terminal'` plus a single
check:

```ts
export type RoleToolPolicySurface =
  | 'planner-control'
  | 'agent-runtime'
  | 'workspace'
  | 'external-mcp'
  | 'skill'
  | 'contract-terminal';

export interface RoleToolPolicyInput {
  role: RoleToolPolicyRole;
  action: RoleToolPolicyAction;
  surface: RoleToolPolicySurface;
  toolName: string;
  contractTerminals?: readonly string[];
}
```

The `contract-terminal` surface is the only one that consults
`contractTerminals`. Every other surface remains exactly as today
(the `ROLE_TOOL_NAMES` lookups, the MCP read-only / destructive
gates, the planner-control gating). The policy survives because it
still answers "may role X invoke tool Y at surface Z", but it stops
treating the terminal as a generic role-allowed tool.

### 2.9 Impact on `contracts/agent-execution.ts`

The typed result interfaces at
[contracts/agent-execution.ts#L30-L79](../../../src/contracts/agent-execution.ts#L30)
- `PlannerResult`, `ExecutorResult`, `ReviewerResult` - stay. The
supervisor consumes them at three sites
([runtime.ts#L677-L697](../../../src/runtime/runtime.ts#L677),
[runtime.ts#L822-L842](../../../src/runtime/runtime.ts#L822),
[runtime.ts#L453-L470](../../../src/runtime/runtime.ts#L453)) and
none of them get a different shape; renaming or merging them would
be a churn unrelated to F05/F06/F07.

What changes:

- `PlannerResult` is now produced by either of two terminal kinds.
  The planner contract's `project` returns a `PlannerTypedResult`
  discriminated union, and the planner driver at
  [runtime.ts#L677-L697](../../../src/runtime/runtime.ts#L677) reads
  the `kind` to decide whether to recur (`kind: 'deferred'`) or to
  apply created/updated cards and finish (`kind: 'result'`). The
  `PlannerResult` value inside both branches has the same shape so
  `applyPlannerResult` at
  [runtime.ts#L822-L842](../../../src/runtime/runtime.ts#L822) does
  not change.
- `ExecutorFallbackReason` and `fallback_with_evidence` at
  [contracts/agent-execution.ts#L57-L68](../../../src/contracts/agent-execution.ts#L57)
  are not used by P-B1; they belong to the recovery batch. The
  executor contract's `project` sets `fallback_with_evidence: null`
  unconditionally, matching the current adapter projection at
  [agent-adapter.ts#L57](../../../src/agents/agent-adapter.ts#L57).
- The `PlannerInvocationRequest` / `ExecutorInvocationRequest` /
  `ReviewerInvocationRequest` interfaces gain no new fields. The
  contract is constructed inside `invokePlanner` etc. from the
  fields already present.

## 3. Proposal P-B2 - One conceptual level up

P-B2 keeps the `Contract` value from P-B1 but generalises it into a
typeclass-like generic with a `VerifierRegistry`, and makes the
invocation Contract-driven rather than role-driven. The role string
becomes pure observability metadata; the prompt and tool catalogue
are also picked from the contract rather than from the role.

### 3.1 Contract as a generic with attached capabilities

```ts
import type { ZodTypeAny } from 'zod';
import type { PersistedToolCall } from '../agents/persisted-tool-call.js';
import type { LlmRequestError } from '../agents/llm-failure.js';

export interface Verifier<Envelope> {
  readonly id: string;
  verify(call: PersistedToolCall): { ok: true; envelope: Envelope } | { ok: false; error: LlmRequestError };
}

export interface PromptRenderer {
  render(context: PromptContext): string;
}

export interface PromptContext {
  contractName: string;
  describeContract(): string;
  skills?: string;
  custom: Record<string, unknown>;
}

export interface ToolCatalogue {
  readonly id: string;
  resolve(): readonly { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[];
}

export interface Contract<Envelope, TypedResult> {
  readonly id: string;
  readonly terminals: readonly { name: string; description: string; schema: ZodTypeAny }[];
  readonly verifier: Verifier<Envelope>;
  readonly promptRenderer: PromptRenderer;
  readonly toolCatalogue: ToolCatalogue;
  readonly observabilityTags: Readonly<Record<string, string>>;
  project(envelope: Envelope, terminalName: string): TypedResult;
}

export interface VerifierRegistry {
  register<Envelope>(verifier: Verifier<Envelope>): void;
  lookup(id: string): Verifier<unknown> | undefined;
}
```

The Contract no longer hard-codes a verifier method; it delegates to
a `Verifier` value. Verifiers can be shared across contracts (a
single `EnvelopeSchemaVerifier<T>` that takes a schema covers every
contract whose verification is "args parse against schema X"), or
specialised (a `MultiTerminalVerifier` for the planner). A
`VerifierRegistry` lets the recorder, replay, and any operator UI
look up the verifier by id and re-run it against historical
exchanges; that is the property a typeclass-like generalisation
unlocks. Without the registry the registry-style indirection has no
purpose, so P-B2 ships them as a pair.

### 3.2 Invocation is Contract-driven, role is metadata

`InvokeAgentRequest` in P-B2 drops the role string:

```ts
export interface InvokeAgentRequest<Envelope, TypedResult> {
  contract: Contract<Envelope, TypedResult>;
  goalId: string;
  cardId?: string;
  candidateRoute: CandidateRoute;
}

export interface InvokeAgentResult<TypedResult> {
  sessionId: string;
  result: TypedResult;
  terminalName: string;
}
```

The system prompt is `contract.promptRenderer.render(...)`. The tool
list is `contract.toolCatalogue.resolve()`. The recorder reads
`contract.id` and `contract.observabilityTags` for tagging instead
of a role string. The adapter's three entry points
(`invokePlanner` / `invokeExecutor` / `invokeReviewer`) become one
entry point `invokeAgent`, with three thin factories upstream:

```ts
export function invokePlanner(req: PlannerInvocationRequest) {
  return invokeAgent({
    contract: createPlannerContract({
      goalId: req.goalId,
      parentSessionId: req.parentSessionId,
      skills: req.skills,
      currentDepth: req.currentDepth,
      maxDepth: req.maxDepth,
    }),
    goalId: req.goalId,
    candidateRoute: req.candidateRoute,
  });
}
```

`createPlannerContract` now also owns prompt selection and tool
catalogue selection, which means there is one place to look when
asking "what does the planner do":

```ts
export function createPlannerContract(input: PlannerContractInput): Contract<PlannerEnvelope, PlannerTypedResult> {
  const terminals = buildPlannerTerminals();
  return {
    id: 'planner',
    terminals,
    verifier: new MultiTerminalVerifier('planner', terminals),
    promptRenderer: new PlannerPromptRenderer(input),
    toolCatalogue: new PlannerToolCatalogue(terminals),
    observabilityTags: { role: 'planner', goal_id: input.goalId },
    project: projectPlannerEnvelope,
  };
}
```

### 3.3 Trade-offs of P-B2 vs P-B1

P-B2 makes adding a "research-mode planner" or an "executor for data
cards only" a single-file change: define a contract, register its
verifier, return it from a new factory. There is no role enum to
widen and no role-keyed catalogue to splice into. The verifier
registry makes replay self-describing: each recorded exchange names
its verifier id and the replay tool re-runs it.

The cost is the new infrastructure: a `Verifier` type, a
`PromptRenderer` type, a `ToolCatalogue` type, a registry, and the
discipline that every contract own all four. P-B1 hides each of these
behind a method on the contract value; P-B2 makes them first-class so
they can be swapped independently. Until there is a second planner
contract or a second executor contract, the cost has no payoff.

The role string still exists in P-B2 as one tag inside
`observabilityTags`. The supervisor scheduler still knows "this is
the planner driver" because it called `createPlannerContract`, not
because the contract is keyed by `'planner'`.

## 4. Comparison table

| Axis | P-B1 (focused) | P-B2 (level up) |
| ---- | -------------- | --------------- |
| Blast radius - files changed | adapter, factory, terminal-protocol, role-result-tools (delete), role-envelope-schemas (delete), agent-tool-catalog (terminal names removed), llm-options-factory (terminal phase removed), system-prompt (3 functions changed), llm-exchange (1 field widened), llm-recording (1 field changed), planner-contract / executor-contract / reviewer-contract (new), planner-envelope / executor-envelope / reviewer-envelope (new), describe-terminals + json-schema-to-prose (new), role-tool-policy (1 surface added), validators (legacy fallback deleted), agent-adapter synthesis block (deleted). | All of P-B1's files plus: verifier-registry (new), verifier base classes (new), prompt-renderer base classes (new), tool-catalogue base classes (new). Every place that currently takes a role string and a contract takes only a contract; `invokePlanner` / `invokeExecutor` / `invokeReviewer` collapse into thin factories. |
| Autonomy gain | High. The synthesis branch and the legacy parser are removed; the planner declares its own terminal envelope including the deferred case. Prompt and verifier are one source of truth. | Same as P-B1 plus: each contract owns its own prompt and tool catalogue, so the runtime stops assuming "role" is the dispatch axis for behaviour. |
| Extensibility - new role / variant | New contract factory + new typed-result type. No changes to global maps because there are none. Prompt builder remains role-keyed (still three top-level functions). | New contract factory only. The prompt builder, the tool catalogue, and the verifier come with the contract; no role-keyed entry point exists. Splitting executor by card type or adding an analyst contract is a single new file. |
| Implementation cost | Moderate. Three contract factories + envelope schemas + `jsonSchemaToProse` (~150 LOC) + adapter rewrite of the terminal-tool block + system-prompt rewrite. No new abstractions beyond `Contract`. | High. Verifier / PromptRenderer / ToolCatalogue base types and registry, plus rewriting every entry point to pass a contract end-to-end. Conceptual cost: every contributor learns four interfaces instead of one. |
| Residual debt | The role string survives on `InvokeAgentRequest.role` for prompt-builder selection and observability tagging. The three role-keyed prompt-builder functions remain. `RoleToolPolicy` still has role-keyed `ROLE_TOOL_NAMES` for action tools. | The role string survives only as a tag inside `observabilityTags`. Prompt-builder selection is contract-internal. `RoleToolPolicy` still needs role-keyed action-tool lists; the contract carries no permission information. |
| Verifier-batch compatibility | Direct: `Contract.verify` is the only place verification happens; the verifier batch can rewrite that method's body (or extract it into a strategy) without touching the contract's consumers. | Direct: `Verifier` is already an interface, so the verifier batch can ship a new implementation (e.g. `RepairLoopVerifier`) and wrap any existing verifier with it. |
| F03 (no awaiting-child signal) | Resolved by the deferred terminal. | Resolved by the deferred terminal (same mechanism). |

## 5. Recommendation

Pick P-B1.

The contract value, the per-invocation factories, the deletion of the
role-keyed maps, the prompt-from-contract rendering, and the
first-class deferred terminal are the changes that actually fix
F05/F06/F07. P-B2 adds a verifier registry, a prompt-renderer
abstraction, and a tool-catalogue abstraction; those are
plausible future moves but they are not needed to dissolve the role
taxonomy or the synthesis branch. Until there is a concrete second
planner contract or a concrete second executor contract on the
roadmap, the registry and the strategy types are infrastructure
without users.

P-B1 leaves room to migrate to P-B2 later: every consumer of
`Contract.verify`, `Contract.describe`, and `Contract.terminals`
already treats the contract as the unit, so extracting `Verifier`
and `PromptRenderer` into named types is a mechanical refactor that
does not change the call sites.

Concrete sequencing inside P-B1:

1. Land the `Contract` interface and the three factories
   (`createPlannerContract`, `createExecutorContract`,
   `createReviewerContract`) returning contracts wired against the
   existing schemas. No call sites change yet.
2. Rewrite `agent-adapter.ts`'s per-turn loop to take a contract and
   call `contract.verify`, removing the inline `expectsEnvelope`
   block at [agent-adapter.ts#L292-L295](../../../src/agents/agent-adapter.ts#L292)
   and the synthesis block at [agent-adapter.ts#L358-L380](../../../src/agents/agent-adapter.ts#L358).
   Delete the three projection helpers at
   [agent-adapter.ts#L49-L75](../../../src/agents/agent-adapter.ts#L49).
3. Rewrite `buildLlmOptions` to take a tool list only; delete the
   `'terminal'` phase branch and `LlmRolePhase`.
4. Rewrite the three prompt builders to take a contract and use
   `describeTerminals`. Delete `buildSelfCheckPrompt`.
5. Delete `ENVELOPE_SCHEMAS`, `ROLE_RESULT_TOOL_NAMES`,
   `ROLE_RESULT_TOOLS`, `EnvelopeBearingRole`,
   `validateTerminalToolCall`, the splice of `ROLE_RESULT_TOOL_NAMES`
   into `ROLE_TOOL_NAMES`, `TERMINAL_TOOL_NAMES`, the closed
   `terminalTool` enum, `asTerminalToolName`, the
   `deriveTerminalToolFromOptions` narrowing, and the legacy parser
   fallback at [validators.ts#L68-L70](../../../src/schemas/validators.ts#L68).
6. Add the `'contract-terminal'` surface to `RoleToolPolicy` and
   route the adapter's terminal-tool authorisation through it.
7. Rewrite `exchangeAttemptSchema` and `LlmRecorderRequest` to carry
   `terminalToolNames` and `terminalToolFired` plus `contractName`,
   and re-generate recorded-exchange test fixtures.

## 6. Rejected alternatives

- **Position A from the analysis (synthesise behind a contract
  wrapper).** Rejected for the reason given in
  [section 2.6.2](#262-justification-of-position-c): it keeps the
  adapter forging the terminal envelope and only renames the
  ownership, which is the shape of F06 rather than a fix.
- **Position B from the analysis (planner must always emit
  `emit_planner_result`).** Rejected because it imposes a redundant
  ritual on the planner LLM and leaves F03 unresolved: the typed
  result cannot distinguish "I am waiting on a child" from "I am
  done".
- **Wrap the analyst in a `Contract<{ content: string }, { content: string }>` whose terminals array is empty.**
  Rejected for P-B1. The analyst exits the adapter loop on the
  first `result.kind === 'message'` at
  [agent-adapter.ts#L304-L305](../../../src/agents/agent-adapter.ts#L304),
  so `verify` is never called. Adding a stub contract whose only job
  is to be passed-and-ignored adds an interface obligation with no
  payoff. If the analyst later gains a structured return shape, a
  real contract is added then.
- **Keep `validateTerminalToolCall` as a free function and have the
  contract call into it from `verify`.** Rejected; that is what
  `verifyAgainstTerminals` in [section 2.1](#21-the-contract-interface)
  already is, but it lives in `src/contracts/` not at the public
  surface. Re-exporting the old `validateTerminalToolCall` name
  preserves a role-keyed signature in a redesign whose point is to
  delete role keys.
- **Render the prompt's terminal description from the JSON schema
  directly, without `jsonSchemaToProse`.** Rejected because the
  current prompts are written in prose with embedded type hints for
  weaker models; pasting raw JSON-Schema into the prompt regresses
  prompt quality for those models. `jsonSchemaToProse` is the
  smallest piece of new code that keeps prompt and verifier on the
  same schema while preserving prose form.
- **Keep `buildSelfCheckPrompt` and add a self-check contract.**
  Rejected for this batch. The self-check channel has no verifier
  on the runtime side today; designing one is the verifier batch's
  job, not the contract-surface batch's. Deleting the block now is
  the cleaner choice and the verifier-and-repair loop subsumes its
  purpose.
- **Widen `EnvelopeBearingRole` to include a fourth string like
  `'planner_deferred'`.** Rejected because it perpetuates the
  role-keyed taxonomy this batch exists to dissolve. The deferred
  case is a second terminal on the planner contract, not a fourth
  role.
- **Per-turn switching of contracts (one tool-call phase contract
  plus a terminal-phase contract).** Rejected because the existing
  `'terminal'` phase branch at
  [llm-options-factory.ts#L44-L62](../../../src/agents/llm-options-factory.ts#L44)
  already encodes that distinction and it has no live consumer: the
  adapter loop never switches into `'terminal'` phase
  ([agent-adapter.ts#L296](../../../src/agents/agent-adapter.ts#L296)
  always passes `'tools'`). The redesign deletes the phase machinery;
  re-introducing per-turn contracts would put it back under a new
  name.
