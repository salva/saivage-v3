# Card Runner XState Rearchitecture Draft

Status: exploratory draft design. This document describes the target XState
architecture for replacing the current runtime. It does not describe current
runtime behavior. Current behavior remains documented in
[Agents and runtime architecture](../agents.md).

## 1. Goal

Use XState as the state-machine and actor substrate for Saivage card execution
while preserving the layered runtime model:

- Public card status is domain state visible to operators, planners, and APIs.
- CardRunner state is private orchestration state for one card.
- LLMRunner state is private implementation state for one attached agent.

This design replaces the current dispatcher/session/unwind runtime with XState
actors, events, transitions, entry actions, invoked async services, and
snapshots.

It does not make XState the product model. Cards remain Saivage domain objects.

## 2. Non-Goals

- Do not move card records, hierarchy, notes, evidence, or results exclusively
  into XState context.
- Do not expose XState concepts in the operator API or web UI.
- Do not introduce LangGraph or a generic workflow engine.
- Do not add migration for old `.saivage` runtime state.
- Do not make the analyst card-attached.
- Do not implement definitive compaction changes as part of this work.

## 3. XState Role

XState is used for object-local state machines and actor messaging. This draft
assumes XState v5-style actors and machine setup. Code snippets are
illustrative, not drop-in implementation code.

XState owns:

- CardRunner actor state.
- LLMRunner actor state.
- State transition validation.
- Entry actions and invoked async services.
- Parent/child actor communication.
- Snapshots used for recovery.

Saivage still owns:

- Canonical card records.
- Card hierarchy.
- Agent message logs.
- Tool-call protocol validation.
- Process records.
- NoteBox records.
- Operator API and UI read models.
- Runtime pause/resume/cancel policy.
- Evidence and reviewer semantics.

Operator-facing APIs and UI must expose Saivage read-model fields, not raw XState
snapshots. Examples: expose `runnerPhase`, `agentPhase`, `pauseMode`, card status,
and recovery diagnostics. Do not expose framework node ids, actor references,
internal snapshot objects, or XState event names as product contracts. Debug/file
inspection may show internal files when explicitly requested, but those files are
not API/UI contract shapes.

## 4. Layer Mapping

| Saivage concept | XState representation | Source of truth |
|---|---|---|
| Public card status | Context field mirrored from CardStore | CardStore |
| CardRunner phase | Card actor state value | CardRunner actor snapshot |
| LLMRunner phase | Child agent actor state value | LLMRunner actor snapshot |
| Attached agent identity | Actor id and persisted AgentSession id | Saivage id rules |
| Parent/child activation wait | Parent actor context + child actor event | CardRunner actor snapshot + CardStore |
| ProcessRunner phase | Process actor state value | ProcessRunner actor snapshot + process registry |
| Process wait | LLMRunner wait state + process actor id | LLMRunner actor snapshot + process registry |
| NoteBox | CardRunner-owned note container | Saivage NoteBox store |
| Pause | Runtime supervisor actor state | Runtime state |
| Recovery | Rehydrate actors from snapshots + Saivage persisted state | Runtime bootstrap |

The same word may appear in more than one layer. For example, a card may have
public status `running` while its CardRunner actor state is `planning` and its
planner LLMRunner actor state is `waiting_for_tool`.

## 5. Actor Topology

The design has four state-machine levels:

1. Card lifecycle state.
2. CardRunner execution state.
3. LLMRunner LLM-interaction state.
4. ProcessRunner process-interaction state.

These levels are related but not interchangeable.

### 5.1 Card State

The Card state is the public lifecycle state stored in CardStore:

```text
backlog | changed | running | done | cancelled | failed | blocked | deleted
```

It answers: what is the card's externally visible status from the point of view
of the runtime, operator, planner, API, and UI?

### 5.2 CardRunner State

The CardRunner state is private execution state for the process used to run a
card while the card is public `running`. It is fully dependent on the card type.

For a goal/project card, the CardRunner machine is about planner/reviewer
execution. Conceptually:

```text
planning | reviewing | done
```

For a terminal card, the CardRunner machine is about executor execution.
Conceptually:

```text
executing | done
```

The CardRunner `done` state means "this runner has no more active card-level work
for the current activation." It is not the same as public card status `done`.
The public card may end as `done`, `failed`, `blocked`, or `cancelled`; in all of
those cases, the CardRunner becomes `done`/settled.

Use `done` for this settled CardRunner state in this design. This is a different
semantic layer from public card lifecycle `done`: CardRunner `done` means the
runner is settled for the current activation, while public card `done` means the
card outcome was accepted as complete.

### 5.3 LLMRunner State

The LLMRunner state is private implementation state for handling one attached
LLM agent. It is generic across planner, reviewer, and executor agents.

Conceptually:

```text
running | waiting_for_tool | done
```

`done` means the current LLM turn or episode is no longer active. It does not
mean the attached agent session is complete or archived. The attached agent may
run again later for the same card.

For LLMRunner, `done` is also the settled/restartable state. There is no separate
`idle` state because an attached agent can always run again while its owning card
remains valid.

### 5.4 ProcessRunner State

ProcessRunner state is private implementation state for one background external
process. A process is a subprocess that can outlive a single LLMRunner turn. When a
process times out, ProcessRunner does not kill it. Instead, ProcessRunner reports the
timeout to the owning LLMRunner, which decides whether to keep waiting, inspect
partial output, kill the process, or abandon it.

Conceptually:

```text
running | done
```

`running` means the process is still active or being reconciled. `done` means the
process has a terminal result or failure and no active work remains. For
ProcessRunner, `done` is the settled state. A new process execution uses a new
ProcessRunner and process record.

ProcessRunner provides exactly-one terminal delivery to the waiting LLMRunner. If
the process is still running after a dirty shutdown, ProcessRunner reattaches to it
instead of starting a duplicate.

### 5.5 NoteBox

Each CardRunner owns a NoteBox. The NoteBox stores planner-visible notes and
runtime context that should be delivered to the card's primary LLMRunner when the
CardRunner state allows it.

The primary LLMRunner depends on CardRunner state:

- `planning`: deliver NoteBox entries to `planner:<card>` before the next
  planner turn.
- `reviewing`: usually keep NoteBox entries pending; reviewer context is
  produced from the review episode, not arbitrary planner notes.
- `executing`: deliver NoteBox entries to `executor:<card>` before the
  next executor turn. If a terminal/executor card gets a note, that note is
  executor-relevant by definition.
- `done`: keep entries pending until the card is reactivated, archived, or the
  notes are otherwise resolved by Saivage domain rules.

The NoteBox is not an LLM conversation and not XState framework state. It is a
Saivage-owned delivery buffer used by CardRunner to decide what context to append
to the next primary LLMRunner turn.

NoteBox delivery is idempotent by note id. When CardRunner delivers a note, it
records enough durable metadata to tell whether that note was already appended to
the target LLMRunner input. State entry actions deliver only still-pending notes.
After a dirty shutdown, recovery makes a best-effort reconciliation from the note
record and message log; if it cannot prove delivery, it may redeliver the note as
context rather than silently drop operator input.

Planner and executor are the primary LLMRunners for their card types. Notes are
delivered immediately when the primary LLMRunner is running:

- Goal/project card in `planning`: deliver to planner.
- Terminal card in `executing`: deliver to executor.

Immediate delivery means "before the next provider call," not interrupting an
in-flight model request or inserting context while an LLMRunner is waiting for a
tool result. If the primary LLMRunner is `waiting_for_tool`, the CardRunner keeps
the note in the NoteBox and appends it after the tool result is resolved and
before the next `RUN_TURN`.

Reviewer is a secondary LLMRunner. If notes arrive while a goal/project card is
in `reviewing`, the NoteBox stores them until the reviewer finishes. When
the reviewer result arrives, the CardRunner first checks the NoteBox. If pending
planner notes exist, the CardRunner diverts back to `planning`, appends the
pending notes and reviewer context to the planner conversation, and lets the
planner decide how to proceed. Otherwise, it handles the reviewer result normally.

In XState terms, NoteBox contents are guards on CardRunner transitions. A
reviewer result of `pass` normally targets `done`, but with pending planner notes
it targets `planning` instead.

### 5.6 Actor Topology

Use one CardRunner actor per active or recoverable card.

```text
RuntimeSupervisor actor
  CardRunner actor: card:project
  CardRunner actor: card:G-12
  CardRunner actor: card:T-7
  ProcessRunner actor: process:P-44

CardRunner actor: card:G-12
  LLMRunner actor: planner:G-12
  LLMRunner actor: reviewer:G-12

CardRunner actor: card:T-7
  LLMRunner actor: executor:T-7
```

CardRunner actors are created by the runtime actor registry. LLMRunner actors
are lazily spawned by the owning CardRunner before the first invocation for that
role.

`ensurePlannerActor`, `ensureReviewerActor`, and `ensureExecutorActor` are
idempotent owner-local operations: they reconnect an existing child actor by
deterministic id when present, otherwise they create it once. State entry must not
create duplicate LLMRunner actors for the same card-role pair.

Actor ids are deterministic:

```text
card:<card_id>
planner:<goal_or_project_card_id>
reviewer:<goal_or_project_card_id>
executor:<terminal_card_id>
```

CardRunner actors own their attached LLMRunner actors. Parent CardRunner actors
do not mutate child CardRunner state directly. They send events.

The runtime supervisor preserves the initial single-agent execution model. It
must not allow more than one active model invocation at a time. XState actor
event queues serialize work per actor, but this global admission rule belongs to
the RuntimeSupervisor.

CardRunner entry actions do not call providers directly. They prepare a durable
LLM input envelope and ask the owning LLMRunner to run a turn. The LLMRunner then
requests a provider-call permit from the RuntimeSupervisor. If admission is denied
because another model invocation is active or the runtime is quiescing/paused,
the LLMRunner leaves its persisted input in place and waits for a later supervisor
event to retry admission.

The admission permit covers one provider/model call, not a whole LLMRunner
episode. After the provider response or provider error is persisted, the permit is
released. If local immediate tool calls cause the LLMRunner to need another model
call, it must request admission again.

CardRunner actors may remain in the registry while their card is active,
recoverable, or restartable. The registry stops an actor and removes its active
snapshot when the card is deleted or archived, or when policy decides a settled
non-running card no longer needs in-memory recovery state. Stopping an actor is a
registry/domain operation; other actors still communicate only by events.

Stopping a CardRunner stops its owned in-memory LLMRunner actors. This does not
delete attached AgentSession history. On later restart or reactivation, the
CardRunner recreates owned LLMRunner actors by deterministic id from the attached
AgentSession plus the latest runner snapshot if one exists; otherwise the
LLMRunner starts in `done` and receives fresh episode context before any turn.

## 6. CardRunner Machine

CardRunner state remains card-type-specific.

Goal/project CardRunner:

```ts
type GoalCardRunnerState =
  | 'done'
  | 'planning'
  | 'reviewing'
  | 'cancelling';
```

Terminal CardRunner:

```ts
type TerminalCardRunnerState =
  | 'done'
  | 'executing'
  | 'cancelling';
```

All CardRunner machines also handle coordination events such as `RECOVER`,
`RESUME`, and `QUIESCE` without adding those words to the CardRunner phase enum.
`QUIESCE` asks the CardRunner to snapshot its own state, coordinate quiescence of
owned children, and acknowledge the supervisor checkpoint when durable state is
consistent.

`done`, `failed`, `blocked`, `cancelled`, and `deleted` are public card statuses,
not CardRunner states. `cancelling` is only a transient cleanup phase used while
the CardRunner stops owned work before writing the public `cancelled` outcome.
When a card reaches a terminal public status, its CardRunner actor should be in
`done` unless it is still running that cleanup transition.

Example goal machine shape:

```ts
const goalCardMachine = setup({
  types: {} as {
    context: GoalCardContext;
    events: GoalCardEvent;
  },
  actions: {
    markCardRunning,
    persistSnapshot,
    appendPlannerToolError,
    notifyParentTerminalOutcome,
  },
}).createMachine({
  id: 'goalCard',
  initial: 'done',
  states: {
    done: {
      on: {
        START: {
          guard: 'canStartCard',
          target: 'planning',
          actions: ['markCardRunning', 'ensurePlannerActor', 'persistSnapshot'],
        },
      },
    },
    planning: {
      entry: ['ensurePlannerActor', 'sendPlannerTurnIfAllowed', 'persistSnapshot'],
      on: {
        LLM_TOOL_CALL: { actions: 'handleLlmToolCall' },
        LLM_RESULT: { actions: 'handlePrimaryLlmResult' },
        CHILD_TERMINAL: { actions: 'deliverChildToolResult' },
        REVIEW_READY: { target: 'reviewing', actions: 'setPlannerDone' },
        TERMINAL_OUTCOME: { target: 'done', actions: 'persistTerminalOutcome' },
        CANCEL: { target: 'cancelling' },
      },
    },
    reviewing: {
      entry: ['ensureReviewerActor', 'sendReviewerTurnIfAllowed', 'persistSnapshot'],
      on: {
        LLM_RESULT: { actions: 'handleReviewerLlmResult' },
        REVIEW_PASSED: [
          {
            guard: 'hasPendingPlannerNotes',
            target: 'planning',
            actions: ['persistReviewContext', 'deliverPendingPlannerNotes'],
          },
          { target: 'done', actions: 'persistReviewedDone' },
        ],
        REVIEW_NEEDS_CORRECTIONS: {
          target: 'planning',
          actions: ['appendReviewContext', 'deliverPendingPlannerNotes'],
        },
        REVIEW_FAILED: { target: 'done', actions: 'persistReviewFailure' },
        CANCEL: { target: 'cancelling' },
      },
    },
    cancelling: {
      invoke: {
        src: 'cancelOwnedWork',
        onDone: { target: 'done', actions: 'recordCancelledOutcome' },
        onError: { target: 'done', actions: 'recordCancelledOutcome' },
      },
    },
  },
});
```

The example is illustrative. Planner, reviewer, and executor model work is not a
single XState `invoke` that returns one value. It is a multi-turn LLMRunner
actor. CardRunner states send turn requests to LLMRunner actors, and those
LLMRunner actors send events back as tool calls, raw terminal/reporting result
objects, or recoverable errors. The implementation should keep transitions small
and delegate domain writes to Saivage services.

Entering `planning`, `reviewing`, or `executing` does not mean "call the model
with whatever messages happen to exist." The CardRunner must first prepare a
role-appropriate invocation input envelope for the LLMRunner, described in
[LLMRunner Input And Output](#71-llmrunner-input-and-output). That envelope is
persisted as session context before any provider call is admitted.

The example uses a small self-event pattern for result classification. LLMRunner
actors send generic `LLM_RESULT` events. The owning CardRunner knows which child
LLMRunner produced the event from actor ownership and current CardRunner state,
so it interprets the payload as planner, reviewer, or executor output. CardRunner
actions validate the payload, run Saivage acceptance gates, then send precise
events to the same CardRunner such as `REVIEW_READY`, `TERMINAL_OUTCOME`,
`REVIEW_PASSED`, `REVIEW_NEEDS_CORRECTIONS`, or `REVIEW_FAILED`. Those precise
events own the state transitions and guards. Do not hide state changes inside
opaque action functions, and do not put planner/reviewer/executor branching into
LLMRunner.

Before sending one of those precise self-events, CardRunner must persist the
classified result decision that makes the self-event recoverable. If the process
crashes after classification but before the self-event is handled, recovery reads
the persisted decision and replays or completes the same transition instead of
re-asking the model or losing the result.

For reviewer results, `REVIEW_FAILED` means the activation has reached the
failed-outcome path, such as retry exhaustion or an accepted reviewer/runtime
failure policy. Ordinary `needs_corrections` while retries remain is
`REVIEW_NEEDS_CORRECTIONS`.

## 7. LLMRunner Machine

LLMRunner is generic across planner, reviewer, and executor.

This draft uses `LLMRunner` for the private actor that drives provider turns and
tool waits. `AgentSession` remains the durable attached-agent conversation and
message history; LLMRunner is the runtime actor that advances that conversation.

```ts
type LLMRunnerState =
  | 'done'
  | 'running'
  | 'waiting_for_tool';
```

LLMRunner context includes:

```ts
type LLMRunnerContext = {
  agentId: string;
  role: 'planner' | 'reviewer' | 'executor';
  cardId: string;
  toolCallId?: string;
  toolName?: string;
  wait?:
    | { kind: 'child_card'; childCardId: string }
    | { kind: 'process'; processId: string };
  lastPersistedMessageId?: string;
};
```

LLMRunner owns:

- Appending episode context.
- Calling provider/model adapters.
- Persisting assistant messages and tool calls.
- Entering `waiting_for_tool` when an async runtime tool blocks.
- Appending matching tool results or tool errors.
- Forwarding raw terminal/reporting result objects to the owning CardRunner via a
  generic actor event.

LLMRunner does not decide public card outcomes. The owning CardRunner does.

LLMRunner is a long-lived actor, not a one-shot invoked service. It processes
agent turns until it either blocks on a runtime tool or forwards a raw terminal
result object to its parent. The owning CardRunner decides whether that result is
accepted.

Minimal LLMRunner events:

```ts
type LLMRunnerEvent =
  | { type: 'RUN_TURN'; inputId: string; reason: 'start' | 'tool_result' | 'review_correction' | 'recovery' | 'resume' | 'note_delivery' }
  | { type: 'MODEL_TOOL_CALL'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'APPEND_TOOL_RESULT'; toolCallId: string; content: unknown }
  | { type: 'APPEND_TOOL_ERROR'; toolCallId: string; error: unknown }
  | { type: 'MODEL_TERMINAL_RESULT'; result: unknown }
  | { type: 'RECOVER' }
  | { type: 'RESUME' }
  | { type: 'QUIESCE'; checkpointId: string }
  | { type: 'CANCEL' };
```

Minimal LLMRunner transition shape:

```text
done -- RUN_TURN --> running
running -- MODEL_TOOL_CALL(runtime async wait) --> waiting_for_tool
waiting_for_tool -- APPEND_TOOL_RESULT --> running
waiting_for_tool -- APPEND_TOOL_ERROR --> running
running -- MODEL_TERMINAL_RESULT --> done
running -- CANCEL --> done
waiting_for_tool -- CANCEL --> done
running -- RECOVER --> running | done according to role recovery policy
waiting_for_tool -- RECOVER --> waiting_for_tool | running according to wait reconciliation
done -- RESUME --> done
running/waiting_for_tool -- RESUME --> current state plus admission/reconciliation check
any stable boundary -- QUIESCE --> current state plus QUIESCED acknowledgement
```

Unexpected events in a state are programmer or recovery errors, not no-ops. For
example, `RUN_TURN` while already `running`, or `APPEND_TOOL_RESULT` without a
matching `waiting_for_tool`, should fail fast after enough context is persisted
for diagnosis. The only tolerated duplicate deliveries are ones the Saivage
tool-call or process protocol can prove already received their exactly-once
result.

`RECOVER` is a repair event after process restart or explicit reconstruction.
It may reinvoke from the last durable model boundary, reconcile a child/process
wait, or emit a generic failed/interrupted result object for the parent to
interpret. `RESUME` is not repair; it continues valid paused state and asks the
RuntimeSupervisor for admission when a new model turn is needed.

When an LLMRunner observes a terminal/reporting result from the model, it
persists the assistant tool call and sends one generic event to its owning
CardRunner:

```ts
cardActor.send({ type: 'LLM_RESULT', agentId, result });
```

LLMRunner must not emit `PLANNER_RESULT`, `REVIEWER_RESULT`, or
`EXECUTOR_RESULT`. It is intentionally the same actor machine for planner,
reviewer, and executor sessions. The owning CardRunner already knows the actor id
and its current phase, so it owns role-specific interpretation.

When an LLMRunner accepts a runtime tool call, it persists the assistant tool
call and sends a tool-call event to its owning CardRunner or runtime supervisor.
The receiver decides whether the tool call is local, cross-card, process-backed,
or a terminal/reporting tool.

### 7.1 LLMRunner Input And Output

CardRunner owns the role-specific input envelope. LLMRunner owns generic
provider/message mechanics. This keeps one LLMRunner machine usable for planner,
reviewer, and executor agents without hiding role semantics inside it.

The input envelope is durable context appended to the attached AgentSession by
CardRunner/session services before `RUN_TURN` is sent. It is not XState context
alone, and it is not generated by LLMRunner from CardStore directly.

`RUN_TURN` references the persisted input envelope by `inputId`. This avoids
making an in-memory event payload the only copy of the context needed for
recovery.

Conceptual input envelope:

```ts
type LlmInvocationInput = {
  agentId: string;
  role: 'planner' | 'reviewer' | 'executor';
  cardId: string;
  reason: 'start' | 'tool_result' | 'review_correction' | 'recovery' | 'resume' | 'note_delivery';
  systemPromptRef: string;
  systemPromptVersion: string;
  systemPromptHash: string;
  episodeContext: {
    card: {
      id: string;
      type: string;
      title: string;
      description?: string;
      acceptance?: string[];
      statusText?: string;
    };
    workspace?: {
      root: string;
      workDir?: string;
      relevantFiles?: string[];
    };
    parent?: { cardId: string; title: string };
    children?: Array<{ cardId: string; title: string; status: string }>;
    goalContext?: unknown;
    reviewContext?: unknown;
    deliveredNoteIds?: string[];
  };
};
```

The exact JSON shape can be refined during implementation, but the ownership rule
is fixed:

- CardRunner assembles and persists card objectives, acceptance criteria,
  parent/child context, workspace/work-directory pointers, review context, and
  NoteBox deliveries.
- Agent/session services provide the role system prompt and ensure it is present
  for the attached AgentSession. Initial system prompt setup may happen when the
  LLMRunner/session is first created, but the CardRunner decides why a new episode
  is starting and what current domain context it carries.
- AgentSession metadata records `{ systemPromptRef, systemPromptVersion,
  systemPromptHash, initializedAtMessageId }`. `RUN_TURN` fails fast if the
  protected system prompt is missing or the stored version/hash does not match the
  expected prompt contract.
- LLMRunner loads the persisted input envelope, includes it as model-visible or
  model-filtered session context according to Saivage message policy, then
  requests a model admission permit from the RuntimeSupervisor.
- LLMRunner builds the provider request from the attached AgentSession history,
  protected system prompt, durable episode context, and valid tool-call/tool-result
  history.

LLM conversation history is append-only JSONL. After compaction, the current
conversation segment is closed and a new segment is opened. The new segment starts
with protected system prompt state plus the compaction summary/context needed to
continue. Older closed segments remain audit/recovery artifacts and are not
rewritten in place.

Compaction is allowed only at clean model boundaries. There must be no pending
assistant tool call awaiting a tool result/error in the retained provider-visible
conversation. If compaction must occur while tool state exists, the open
tool-call/tool-result state must be carried losslessly into the new segment so the
next provider request remains protocol-valid. The simpler initial rule should be:
do not compact while any tool-call ledger record for the session is `pending`.

Outputs from LLMRunner are generic. These output events are distinct from
LLMRunner's internal events: `MODEL_TOOL_CALL` is the internal transition
trigger that moves LLMRunner into `waiting_for_tool`; `LLM_TOOL_CALL` is the
output event LLMRunner sends to the owning CardRunner after it has persisted
the tool call and wait state. The same naming distinction applies to
`MODEL_TERMINAL_RESULT` (internal) versus `LLM_RESULT` (output), and model
error transitions (internal) versus `LLM_ERROR` (output).

```ts
type LlmRunnerOutput =
  | { type: 'LLM_TOOL_CALL'; agentId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: 'LLM_RESULT'; agentId: string; result: unknown }
  | { type: 'LLM_ERROR'; agentId: string; error: unknown };
```

The receiving CardRunner interprets those outputs according to its phase and
owned child actor identity. For example, `LLM_RESULT` from `planner:<goal>` while
the CardRunner is `planning` is handled as a planner report; the same generic
event from `reviewer:<goal>` while `reviewing` is handled as a reviewer result.

This also gives recovery a clear boundary: if an input envelope was persisted but
the corresponding provider call was lost, LLMRunner can reinvoke from that durable
boundary. If an output was persisted and forwarded but the parent transition event
was lost, CardRunner recovery can reclassify or replay from the persisted output
and classified decision.

## 8. ProcessRunner Machine

ProcessRunner is generic for durable external process execution.

```ts
type ProcessRunnerState =
  | 'running'
  | 'done';
```

ProcessRunner context includes:

```ts
type ProcessRunnerContext = {
  processId: string;
  ownerAgentId: string;
  toolCallId: string;
  deliveryStatus: 'pending' | 'delivered' | 'abandoned';
  terminalResult?: unknown;
};
```

ProcessRunner owns:

- Starting or reattaching to the external process.
- Persisting process state and terminal result/failure.
- Reporting completion to the waiting LLMRunner.

`toolCallId` and `deliveryStatus` may live in the process record instead of the
XState context, but they must be durable somewhere. Recovery needs them to know
which LLMRunner wait should receive the process result and whether that result was
already delivered.

ProcessRunner `done` is the settled state. It means no active external
process remains for that process record.

Minimal ProcessRunner events:

```ts
type ProcessRunnerEvent =
  | { type: 'ATTACH_OR_START' }
  | { type: 'PROCESS_RESULT'; result: unknown }
  | { type: 'PROCESS_ERROR'; error: unknown }
  | { type: 'RECOVER' }
  | { type: 'QUIESCE'; checkpointId: string }
  | { type: 'CANCEL' };
```

Minimal transition shape:

```text
running -- PROCESS_RESULT --> done
running -- PROCESS_ERROR --> done
running -- CANCEL --> done
running -- RECOVER --> running | done after process registry reconciliation
done -- RECOVER --> done
running/done -- QUIESCE --> current state plus QUIESCED acknowledgement after snapshot
```

`CANCEL` records a best-effort stop or abandonment result; it must not block
forever waiting for a process that cannot be killed. If a process later reports a
result after cancellation, the process registry treats it as late diagnostic data,
not as a second tool result for the waiting LLMRunner.

## 9. Events Instead Of Delayed Calls

The custom delayed-call queue is replaced by XState actor events and invoked
actors.

Examples:

```ts
parentCardActor.send({ type: 'CHILD_TERMINAL', childCardId, outcome });
agentActor.send({ type: 'APPEND_TOOL_RESULT', toolCallId, content });
cardActor.send({ type: 'START', caller });
cardActor.send({ type: 'CANCEL', reason });
```

Event delivery should be treated as async. Public methods that previously would
have enqueued delayed calls become event sends to actors. Runtime must not rely
on synchronous JavaScript call-stack unwinding for correctness.

XState's event queues provide the recursion-breaking mechanism. Persistence and
recovery still come from snapshots and Saivage state, not from persisting an
event queue.

## 10. Tool Call Routing

LLMRunner persists every assistant tool call before routing it.

Tool calls fall into four functional groups:

- Local immediate tools: card reads, file reads, edits, note reads, and similar
  tools that can complete within the current turn.
- Cross-card runtime tools: `activate_card`, `restart_card`, `cancel_card`, and
  destructive card operations that require CardRunner or supervisor decisions.
- Async process tools: tools that create or wait on durable process records.
- Terminal/reporting tools: planner reports, reviewer results, and executor
  results.

Routing rules:

- Local immediate tools append their tool result or tool error to the LLMRunner
  message log and keep the LLMRunner in `running`.
- `activate_card` sets the LLMRunner to `waiting_for_tool`, records
  `wait: { kind: 'child_card', childCardId }`, and sends an event to the owning
  CardRunner to start the child.
- Async process waits create or reuse a ProcessRunner, set the LLMRunner to
  `waiting_for_tool`, record `wait: { kind: 'process', processId }`, and wait for
  the ProcessRunner/process registry to send `APPEND_TOOL_RESULT` or
  `APPEND_TOOL_ERROR`.
- Terminal/reporting tools produce a generic `LLM_RESULT` event to the owning
  CardRunner. The CardRunner validates the result according to its active phase
  and decides the public card outcome.

Tool-call protocol remains Saivage-owned. Every assistant tool call retained in
history must receive exactly one matching tool result or tool error.

Terminal/reporting tool calls are not exempt from the tool protocol. If the
CardRunner accepts a terminal/reporting result, it appends the matching final tool
result before the LLMRunner becomes `done`. If the CardRunner rejects the result
because validation or acceptance gates fail, it appends the matching tool error
and requests another provider turn when appropriate.

Exactly-once tool delivery is enforced by durable tool-call status, not by
in-memory checks. Each assistant tool call has a persisted record keyed by
`{ agentId, toolCallId }` with a small status:

```ts
type ToolCallDeliveryState =
  | 'pending'
  | 'delivered'
  | 'errored'
  | 'abandoned';
```

Appending a tool result/error updates that record with the result status and, when
available, the message id. Recovery uses the record and message log together: if
both prove delivery, do not append again; if neither proves delivery, deliver or
error the tool call according to role policy; if they disagree after a dirty
shutdown, choose the safest explicit repair path rather than pretending the state
is clean.

## 11. Public Card Status

CardStore remains authoritative for public card status:

```text
backlog | changed | running | done | cancelled | failed | blocked | deleted
```

CardRunner actors may keep a mirrored `publicStatus` field in context for guards
and routing, but every status change must be written through CardStore.

`changed` is not a CardRunner state. External analyst/operator changes mark the
card `changed` and notify the responsible planner. A `START` event may consume
`changed` the same way it consumes `backlog`, moving the public card status to
`running` and entering the active CardRunner state.

If the card is already public `running`, an analyst/operator edit does not flip
the public status to `changed` underneath an active CardRunner. The edit is
persisted, added to NoteBox/Goal Context, and delivered to the active or next
primary LLMRunner turn according to CardRunner state. `changed` is for inactive
cards that need later reactivation.

## 12. Goal Context And Notes

Goal Context remains a Saivage concern, not an XState concern. It is delivered
through the CardRunner's NoteBox.

The CardRunner asks Saivage services to append fresh planner context before a
planner LLMRunner receives a turn for:

- First activation of a goal/project card.
- Resume after `activate_card` child completion.
- Resume after reviewer corrections.
- Resume after service restart.
- Delivery of analyst notes or `subtree_changed` context.

Analyst/operator corrections such as `mark_goal_needs_corrections` update card
state, NoteBox entries, and public `changed` status through CardStore. They do
not directly start a CardRunner. They become planner-visible through the NoteBox
and Goal Context on the next planner turn or activation.

## 13. Starting Root And Child Cards

Root project work starts from an external analyst/operator event:

```ts
runtimeSupervisor.send({ type: 'START_PROJECT' });
```

The runtime supervisor sends `START` to `card:<project>`. There is no ready-queue
scan and no automatic project start.

A planner starts a child through `activate_card`. In XState terms:

1. Planner LLMRunner persists the `activate_card` assistant tool call and the
   wait state `waiting_for_tool(child_card)`, then sends a generic `LLM_TOOL_CALL`
   event to the owning CardRunner.
2. CardRunner validates the child can start.
3. Runtime supervisor starts or retrieves `card:<child>`.
4. Parent CardRunner sends `START` to child CardRunner.
5. Parent CardRunner remains in `planning`.

The wait state and child start are in the same durability boundary: the LLMRunner
persisted its wait before the child was started, so recovery can always determine
whether the parent planner was waiting for that child.

`START` expects public status `backlog` or `changed` and CardRunner state `done`.
A `START` event for an already running card is a tool error for the caller.

## 14. Completing A Child Card

When a child CardRunner reaches a terminal public card status, it sends one
terminal event to its parent actor:

```ts
parentCardActor.send({
  type: 'CHILD_TERMINAL',
  childCardId,
  outcome,
});
```

The parent CardRunner then sends the matching tool result to its planner
LLMRunner:

```ts
plannerAgentActor.send({
  type: 'APPEND_TOOL_RESULT',
  toolCallId,
  content: outcome,
});
```

One `activate_card` assistant tool call must receive exactly one matching tool
result or tool error. XState events are the transport, but Saivage still owns the
tool-call protocol invariant.

`CHILD_TERMINAL` is valid only when the parent planner LLMRunner has a matching
`waiting_for_tool(child_card)` record. A child-terminal event received after the
parent cancelled, failed, or already consumed that tool result is a stale event;
it should be recorded for diagnostics or rejected by the exactly-once tool-call
invariant, not delivered as a second result.

## 15. Planner Terminal Report Flow

Planner terminal reports are terminal tool calls handled by the owning
CardRunner, not by the generic LLMRunner.

When the planner LLMRunner accepts `report_goal_done`, `report_goal_failed`, or
`report_goal_blocked`, it sends:

```ts
cardActor.send({ type: 'LLM_RESULT', agentId, result });
```

The goal CardRunner handles the result:

- `report_goal_done` runs acceptance gates before reviewer invocation.
- If subtree readiness or evidence validation fails, the CardRunner sends a tool
  error to the planner LLMRunner, keeps public card status `running`, keeps
  CardRunner state `planning`, and requests another planner turn.
- If gates pass, the CardRunner persists the accepted self-report, mirrors
  `status_text` onto the card, sets the planner LLMRunner to `done`, and
  transitions to `reviewing`.
- `report_goal_failed` persists the self-report, mirrors `status_text`, sets
  public card status `failed`, sets the planner LLMRunner to `done`, transitions to
  `done`, and sends a failed outcome to the parent if any.
- `report_goal_blocked` persists the self-report, mirrors `status_text`, sets
  public card status `blocked`, sets the planner LLMRunner to `done`, transitions to
  `done`, and sends a blocked outcome to the parent if any.

Acceptance-gate failures are planner tool errors. They do not consume reviewer
retry budget and they do not invoke the reviewer.

In the illustrative machine, `LLM_RESULT` is the generic child-actor event.
Because the CardRunner is in `planning`, it interprets the payload as a
planner result. After validation, the CardRunner sends itself a precise
transition event:
`REVIEW_READY` for accepted `report_goal_done`, or `TERMINAL_OUTCOME` for
accepted `report_goal_failed` / `report_goal_blocked`.

## 16. Reviewer Flow

When a planner result is accepted as `done`, the goal CardRunner runs acceptance
gates. If gates pass, it transitions from `planning` to `reviewing`:

```text
planning -> reviewing
```

The planner LLMRunner is `done` before the reviewer LLMRunner is invoked.

Reviewer outcomes:

- Pending NoteBox entries for the planner change the CardRunner transition taken
  for a reviewer result. For example, when the reviewer result is `pass`, the
  normal transition would be `reviewing -> done`. If the NoteBox has
  pending planner notes, the CardRunner must not take that transition. It records
  the reviewer result as context, transitions `reviewing -> planning`, and
  delivers the pending notes plus reviewer context to the
  planner.
- `pass`: persist review result, mark public card status `done`, set reviewer
  LLMRunner to `done`, transition CardRunner to `done`, notify parent if any.
- `needs_corrections`: persist review result, set reviewer LLMRunner to `done`,
  append correction context to planner conversation, transition CardRunner back
  to `planning`.
- If `needs_corrections` arrives while NoteBox entries are pending, both the
  reviewer correction context and pending notes are delivered to the planner. The
  transition is already `reviewing -> planning`; the NoteBox only
  changes the context delivered on entry, not the target state.
- retry exhaustion: persist review result, mark public card status `failed`, set
  reviewer LLMRunner to `done`, transition CardRunner to `done`, notify parent
  with failed outcome.

Reviewer LLMRunner id remains `reviewer:<goal>` across correction cycles.

Review-attempt ids, if retained, live only on persisted review result records.
They are not CardRunner state, LLMRunner state, or reviewer actor identity.

## 17. Terminal Executor Flow

Terminal cards use the terminal CardRunner machine:

```text
done -- START --> executing -- LLM_RESULT(executor) --> done
```

When `executor:<card>` returns a terminal result object, the owning CardRunner
validates and accepts or rejects it. On acceptance, the CardRunner:

- Persists executor result on the card.
- Sets public card status to `done`, `failed`, or `blocked`.
- Mirrors terminal `status_text` onto the card.
- Sets the executor LLMRunner to `done`.
- Transitions itself to `done`.
- Sends the terminal outcome to the parent CardRunner when one is waiting.

Executor LLMRunner id remains `executor:<card>` for restarts of the same card.

## 18. Process Wait Flow

Process waits are LLMRunner waits.

When a tool starts a process that must complete before the LLMRunner continues:

1. Persist the assistant tool call and create a `pending` tool-call ledger record.
2. Persist the LLMRunner wait transition with
   `wait: { kind: 'process', processId }`.
3. Persist the process record, including `toolCallId`, waiting LLMRunner id, and
   delivery status.
4. Start or attach the ProcessRunner in `running`.

When the ProcessRunner reaches `done`, the process registry or ProcessRunner
sends the result through the durable tool-call status record:

```ts
agentActor.send({ type: 'APPEND_TOOL_RESULT', toolCallId, content });
```

Pause does not kill external processes. Completion while paused is persisted or
buffered by the process registry and delivered on resume.

The same status-record rule applies to child-card waits. An `activate_card` tool
call creates a durable activation/wait record keyed by parent `agentId`, parent
`toolCallId`, and child card id. Child completion updates that record when the
parent planner receives the tool result. After a dirty shutdown, recovery uses the
record plus the parent message log to avoid duplicate delivery when possible, or
to produce an explicit tool error/failure when the delivery state is ambiguous.

## 19. Pause And Resume

Pause is runtime-supervisor state, not CardRunner or LLMRunner phase state.

XState parallel states are a good fit at the RuntimeSupervisor level. Model the
runtime's pause mode as an orthogonal supervisor region, separate from the region
that tracks active work and actor registry state. Do not copy `paused` /
`unpaused` into every CardRunner or LLMRunner phase; that would multiply states
without adding useful domain meaning.

Conceptual supervisor shape:

```ts
const runtimeSupervisorMachine = createMachine({
  type: 'parallel',
  states: {
    mode: {
      initial: 'running',
      states: {
        running: {},
        quiescing: {},
        paused: {},
        stopping: {},
      },
    },
    work: {
      initial: 'ready',
      states: {
        ready: {},
        model_invocation_active: {},
        recovering: {},
      },
    },
  },
});
```

The `mode` region answers whether new work may be admitted. The `work` region
answers what the supervisor is currently coordinating. CardRunner and LLMRunner
actors still keep their normal states, such as `planning`, `executing`,
`running`, `waiting_for_tool`, or `done`.

Parallel regions still need cross-region invariants. `paused` requires no active
model-admission permit and a completed quiescence checkpoint. `quiescing` may
coexist with `model_invocation_active` only while the active provider call reaches
its next durable boundary. New provider-call permits are granted only in
`mode.running`.

Conceptual supervisor regions:

```ts
type RuntimeSupervisorModeState =
  | 'running'
  | 'quiescing'
  | 'paused'
  | 'stopping';

type RuntimeSupervisorWorkState =
  | 'ready'
  | 'model_invocation_active'
  | 'recovering';
```

If an implementation needs a service-lifecycle `idle`, keep it outside runner
phases and outside the pause mode region. It should mean "runtime service not
started," not "card/agent work is settled."

Pause order:

1. Supervisor receives `PAUSE`.
2. Supervisor enters `quiescing` and stops granting new model invocation
   admission.
3. Supervisor sends `QUIESCE` to active or recoverable CardRunner actors.
4. Each CardRunner asks its owned LLMRunner and any relevant ProcessRunner waits
   to reach a safe boundary.
5. Actors persist their latest snapshots and reply `QUIESCED` when they are in a
   consistent pausable state.
6. Supervisor records the tree-level pause checkpoint and runtime pause state.
7. Supervisor enters `paused`.

Collaborative pause is a tree protocol, not a queued-event drain. The supervisor
does not rely on in-memory actor queues being empty as authoritative state. Each
actor reports that its own durable state is coherent enough to resume or recover:

- CardRunner has persisted its current phase and any parent/child wait metadata.
- LLMRunner is either `done`, `waiting_for_tool` with a persisted matching tool
  call, or at a durable model boundary where reinvocation/recovery is valid.
- ProcessRunner has persisted the process id and whether the process is still
  running, completed, failed, or abandoned.

A pause request does not interrupt a provider call in the middle of an unsafe
message write. The LLMRunner finishes the current provider/tool persistence
boundary, declines new turns, snapshots, and acknowledges quiescence. External
processes may continue while paused; their completion is persisted by the process
registry and delivered on resume/recovery.

If an actor cannot reach a pausable state within the configured bounded wait, the
supervisor should either keep quiescing with visible operator status or fail the
pause request loudly. It should not silently mark the runtime paused while actor
state is known to be inconsistent.

Minimal collaborative pause events:

```ts
type RuntimePauseEvent =
  | { type: 'PAUSE' }
  | { type: 'QUIESCE'; checkpointId: string }
  | { type: 'QUIESCED'; checkpointId: string; actorId: string }
  | { type: 'QUIESCE_FAILED'; checkpointId: string; actorId: string; reason: string }
  | { type: 'ADMISSION_AVAILABLE' }
  | { type: 'RESUME' };
```

The supervisor tracks expected `QUIESCED` replies in context for the active actor
tree. The acknowledgement set is runtime coordination state; it is not public card
status and not a runner phase.

Resume order:

1. Supervisor receives `RESUME`.
2. Supervisor reloads or validates current snapshots.
3. Supervisor enters `running` mode, which makes model admission possible again.
4. Supervisor sends `RESUME` events to active CardRunner/LLMRunner actors that
   need continuation, or broadcasts `ADMISSION_AVAILABLE` to actors waiting for a
   model permit.

This replaces `_on_resume__*` hooks with explicit `RESUME` events handled by
machines that need resume behavior.

## 20. Cancellation Flow

Cancellation is a public lifecycle outcome plus a CardRunner cleanup transition.

When a card receives `CANCEL`:

- CardRunner enters `cancelling`.
- It stops or marks abandoned owned external work when possible. Cleanup must be
  bounded and best-effort; cancellation must not wait forever for an external
  process or provider call that cannot be interrupted.
- It sets active attached LLMRunner actors to `done`.
- It sets public card status to `cancelled`.
- It transitions to `done`.
- It sends one terminal outcome to the parent when a parent is waiting.

If force-cancel remains distinct, it uses the same transition path but reports a
synthetic failed activation outcome to the parent with cancellation as the reason.

## 21. Restart, Delete, And Archive

Restart, delete, and archive remain Saivage domain operations. XState actors only
participate when those operations affect active or recoverable runtime state.

- `restart_card` on a terminal card resets the public card to `backlog`, clears
  terminal executor result fields as Saivage defines, keeps the deterministic
  `executor:<card>` identity, and leaves the CardRunner actor `done` until a new
  `START` event arrives.
- Re-activating a goal card reuses `planner:<goal>` and `reviewer:<goal>` actor
  identities. Fresh Goal Context is appended before the planner receives a turn.
- `delete_card` archives the card domain record and attached agent histories.
  Active cards cannot be deleted without first reaching a safe cancellation or
  terminal state.
- Actor snapshots for deleted/archive-only cards are removed or archived with the
  domain record. They are not active runtime state.

## 22. Persistence And Recovery

Persist at every durable transition boundary. The project/CardStore state,
CardRunner snapshots, LLMRunner snapshots, process records, NoteBox records, and
message/tool-call history must be flushed before the runtime relies on a later
event to continue. This is not a transaction system: Saivage accepts that an
unexpected shutdown can lose in-memory events that were sent but not yet handled.
Recovery therefore rebuilds a consistent actor tree from durable state and repairs
or fails inconsistent combinations explicitly.

Persist:

- CardStore records.
- Agent message logs and tool-call/tool-result history.
- Process records.
- NoteBox records.
- XState actor snapshots for RuntimeSupervisor, CardRunner, and LLMRunner
  actors that are active or recoverable.
- XState actor snapshots for ProcessRunner actors that are running or have
  terminal results still needed by waiting LLMRunners.

Persistence cadence:

- CardStore records are persisted after every public card status or card-content
  change.
- CardRunner snapshots are persisted after every CardRunner phase transition and
  after any durable context change that affects recovery, such as parent/child
  wait metadata or a classified `LLM_RESULT` decision.
- LLMRunner snapshots are persisted after every interaction boundary with the
  provider or tool protocol: before a provider request is considered in flight,
  after a provider response/error is recorded, after each assistant tool call is
  persisted, after each matching tool result/error is appended, and after every
  transition into or out of `waiting_for_tool`.
- ProcessRunner/process records are persisted after process start/reattach,
  process terminal result/error, cancellation/abandonment, and delivery-status
  changes.
- NoteBox records are persisted when notes are added, delivered/consumed, or
  archived.

Use append-only JSONL for high-churn histories and deltas instead of rewriting
large objects repeatedly. Message logs, tool-call/tool-result history, process
events, runtime events, and runner transition deltas should be appended as JSONL
records. Small current-state snapshots may be rewritten as compact JSON for fast
startup, but the append-only log remains the recovery/audit trail needed to
understand the latest durable transition.

Durability is not a cross-file transaction system. Durable writes should be simple
and recoverable:

- Compact JSON writes use write-to-temp and atomic rename where available.
- JSONL writes include stable record ids and monotonically increasing sequence
  numbers per actor/log. Duplicate record ids are idempotent during replay.
- Related writes may share a lightweight `checkpointId` so recovery can recognize
  that they belonged to the same boundary.
- Recovery verifies snapshot/log continuity on a best-effort basis. If a dirty
  shutdown leaves an ambiguous partial boundary, recovery repairs forward when it
  is safe, otherwise it marks the affected activation failed/abandoned with
  operator-visible diagnostics.

The practical layout can be chosen during implementation, but the model is:

```text
current snapshots: latest compact JSON per card/runner/runtime object
delta logs: append-only JSONL records for transitions and interactions
message logs: append-only JSONL per attached AgentSession/conversation segment
delivery records: small durable status records for tool/note/process/card delivery
```

Rotated or versioned files should have a small companion index manifest that names
the current segment/version. This applies both to append-only logs and to domain
documents that may be versioned independently, such as card objectives,
acceptance criteria, or large card descriptions. Recovery reads the index first,
then opens the referenced current JSON/JSONL file. Do not rely on symbolic links
for current-version pointers because they are not portable across all supported
filesystems and packaging/deployment modes.

Example:

```text
messages/planner:G-12.index.json   # { "current": "planner:G-12.0004.jsonl" }
messages/planner:G-12.0001.jsonl
messages/planner:G-12.0002.jsonl
messages/planner:G-12.0003.jsonl
messages/planner:G-12.0004.jsonl

cards/G-12/objectives.index.json   # { "current": "objectives.0003.json" }
cards/G-12/objectives.0001.json
cards/G-12/objectives.0002.json
cards/G-12/objectives.0003.json
```

The card record or CardStore snapshot may cache small current values for fast
reads, but the authoritative current version for independently versioned content
comes from the companion index manifest. Updating that index is part of the same
durable boundary as creating the new versioned file.

Conversation compaction is a log boundary. When compaction runs, Saivage closes
the current AgentSession message JSONL segment, writes a new segment containing
the protected system prompt state and compaction summary/context, and updates the
current LLMRunner/session pointer to that new segment. Closed segments are kept
for audit and recovery. Do not rewrite old conversation logs in place as the
normal compaction mechanism.

Do not persist XState's transient in-memory event queues as authoritative state.
Recovery recreates actors from snapshots and Saivage persisted state.

Persistence rule of thumb: before an actor emits an event that another actor must
handle later, the emitting actor must first persist the state that makes that
event derivable or safely ignorable during recovery. For example, an LLMRunner
must persist `waiting_for_tool(child_card)` before the child CardRunner is
started, and a ProcessRunner must persist the terminal process result before it
sends `APPEND_TOOL_RESULT`.

The same rule applies to CardRunner self-events. A CardRunner that classifies
`LLM_RESULT` into `REVIEW_READY`, `TERMINAL_OUTCOME`, `REVIEW_PASSED`,
`REVIEW_NEEDS_CORRECTIONS`, or `REVIEW_FAILED` must persist that classified
decision before sending the self-event. Recovery can then replay the transition
if the in-memory self-event was lost.

Recovery procedure:

1. Read CardStore, message logs, process records, and actor snapshots.
2. Recreate RuntimeSupervisor actor.
3. Recreate CardRunner actors for public `running` cards and any actors required
   by unresolved waits.
4. Recreate attached LLMRunner actors from snapshots.
5. Reconnect actor references using deterministic ids.
6. Send a `RECOVER` event to actors that need to verify continuation.
7. Start normal event processing.

LLMRunner state must be persisted at every model/tool boundary. If an
LLMRunner snapshot says `running` after restart, there is no live provider call;
the LLMRunner's `RECOVER` handling resumes from the last persisted message
boundary, either by reinvoking with recovery context or by producing a
failure-handling event according to role policy.

Specific recovery cases:

- Planner recovered while waiting on a child inspects the child card status. If
  the child is terminal, the parent CardRunner delivers the missing tool result;
  otherwise the child CardRunner is recreated or continued.
- Reviewer recovered before `result.review` was persisted follows the existing
  reviewer-interrupted behavior: the goal returns to planner control with a
  `reviewer_interrupted` note in Goal Context, and the reviewer can be rerun if
  the planner reports done again.
- Executor recovered without an accepted terminal result resumes from the last
  durable message boundary or emits the configured failure-handling outcome.
- Planner no-progress recovery remains inside LLMRunner. It may request a
  final-answer/recovery turn, but provider/account diagnostics stay out of model
  context.

Recovery also performs tree consistency checks before normal event processing:

- A public `running` card must have a recoverable CardRunner in an active phase,
  or recovery must move the card to an explicit failed/blocked repair outcome
  with diagnostic context.
- A CardRunner in `planning`, `reviewing`, or `executing`
  must have the corresponding attached LLMRunner actor/session and a compatible
  LLMRunner state. If the child LLMRunner is missing, corrupt, or impossible to
  reconstruct, recovery fails that activation rather than pretending work is
  still running.
- An LLMRunner in `waiting_for_tool(child_card)` must have a matching persisted
  assistant tool call and a child card. If the child is already terminal, recovery
  delivers or verifies the exactly-once tool result. If the child is missing or
  invalid, recovery appends a tool error and lets the parent planner continue or
  marks the activation failed according to role policy.
- An LLMRunner in `waiting_for_tool(process)` must have a matching process record.
  If the process record is terminal, recovery delivers or verifies the exactly-once
  tool result. If the process record is missing or unrecoverable, recovery appends
  a tool error or fails the activation according to role policy.
- A CardRunner in `reviewing` without a recoverable reviewer LLMRunner or
  persisted review result follows the reviewer-interrupted path back to the
  planner with a `reviewer_interrupted` note.
- A terminal CardRunner in `executing` without a recoverable executor
  LLMRunner or accepted executor result should produce the configured failed
  executor-recovery outcome, then notify the parent exactly once if a parent is
  waiting.

Best-effort repair must be explicit and auditable. Prefer a clear failed or
blocked outcome with recovery diagnostics over silently normalizing impossible
state. The repair path should preserve provider/account details out of model
context while leaving enough operator-visible evidence to understand why recovery
failed the activation.

Persisted XState snapshots should be treated as Saivage-owned data, not opaque
framework internals. Store only the actor snapshot data required to reconstruct
state and context, and keep card records, messages, process records, and audit
history in their existing Saivage stores.

At minimum, each persisted actor snapshot should include a Saivage schema version,
actor id, actor kind, current state value, serializable runner context, and update
timestamp. Do not make recovery depend on private XState object references,
closures, or queued events.

## 23. XState Semantics To Rely On

This design relies on these XState properties:

- Actors process events sequentially.
- Actor state transitions are explicit.
- Entry/exit actions are part of transition execution.
- Invoked actors/services model async work.
- Parent and child actors communicate by events.
- Snapshots can represent current actor state for persistence.

This design should not rely on undocumented event-loop behavior or in-memory
event queues surviving process restart.

## 24. Behavioral Coverage

The XState implementation must preserve these Saivage behaviors:

- One `activate_card` assistant tool call receives exactly one matching tool
  result or tool error.
- Parent planners see only `done`, `failed`, or `blocked` activation outcomes.
- Reviewer `needs_corrections` is internal to the child goal activation until
  retry exhaustion.
- Reviewer retry exhaustion reports a failed activation outcome.
- Subtree readiness and evidence validation remain planner tool errors before
  reviewer invocation.
- Public card status remains the externally visible lifecycle state.
- Terminal `status_text` from planner/executor reports is mirrored onto cards.
- Goal Context and analyst/correction notes remain planner-visible context, not
  XState framework state.
- CardRunner-owned NoteBoxes deliver notes to the primary LLMRunner when the
  CardRunner state allows delivery.
- Runtime pause is global and does not mutate public card status or card/agent
  actor phases.
- Pause is collaborative quiescence: the supervisor enters `paused` only after
  active actors acknowledge durable, internally consistent pausable state.
- Recovery accepts that in-memory events may be lost after unexpected shutdown;
  durable actor/card/message/process state must be sufficient to recreate,
  continue, or explicitly fail each active path.
- Cards, CardRunners, LLMRunners, ProcessRunners, NoteBoxes, and message/tool
  histories are persisted at their transition or interaction boundaries so an
  unexpected kill loses at most in-memory events, not the latest completed
  durable boundary.
- High-churn history is append-only JSONL; compaction closes the old conversation
  segment and opens a new one instead of rewriting old logs in place.
- Recovery checks tree consistency, including CardRunner active phase versus
  corresponding LLMRunner state, before normal event processing resumes.
- Cancellation produces exactly one terminal outcome for any active activation
  path.
- Card restart, deletion, and archive preserve current Saivage domain semantics.
- Durable process reattach/reconciliation produces exactly one terminal process
  result or failure for any waiting LLMRunner.
- ProcessRunner uses `done` as its settled state. LLMRunner uses `done` as its
  settled/restartable state.
- Reviewer interruption recovery returns control to the planner with an explicit
  interrupted-review context note.
- Planner no-progress recovery remains agent-visible without exposing provider or
  account diagnostics.
- Old `.saivage` runtime state is not migrated.

## 25. Implementation Slice

The first slice should prove XState value without converting the whole runtime.

1. Add XState as an internal runtime dependency.
2. Implement TerminalCardRunner actor for one terminal card.
3. Implement generic LLMRunner actor only for executor invocation.
4. Persist and reload actor snapshots for that slice.
5. Execute terminal card `START -> executing -> done` with public card status
   updates.
6. Add recovery test for restart while executor LLMRunner is `running` or
   `waiting_for_tool(process)`.
7. Only then model goal planner `activate_card` waiting.

Do not start with recursive goal trees. Use a terminal card to validate the
XState integration, snapshot persistence, and actor ownership boundaries first.

## 26. Decision Points

Before committing to this architecture, answer these with a prototype:

- Are XState snapshots straightforward enough to persist under `.saivage/`?
- Does actor messaging make the parent/child `activate_card` invariant clearer or
  more indirect?
- Can CardRunner own LLMRunner actors without leaking XState concepts into the
  API/UI?
- Does XState's async invocation model simplify provider/tool handling enough to
  justify rewriting role-specific AgentAdapter orchestration as generic
  LLMRunner/provider-turn plumbing?
- Is cancellation/quiescence easier to express as supervisor state than in the
  current dispatcher lifecycle model?

If the prototype requires extensive permanent adapter glue for every transition,
stop and revise the XState design rather than keeping bridge code.
