# Planner Redesign Implementation Plan

This is the implementation plan for the Saivage v3 planner redesign.
The central rule is simple: a planner does not call another planner or
executor directly. A planner creates or edits cards, then asks the
runtime to `activate_card(card_id)`. The runtime decides how to run
that card, owns the planner/reviewer cycle for goal cards, and returns
one terminal result to the caller.

`activate_card` is named for the control-transfer semantics: the same
planner session that owns a goal card may receive control again on a
subsequent `activate_card` call from its parent. Executor sessions
are one-shot per activation; a re-activation of a terminal card
always opens a new executor session. It is not a one-shot "run".

No backward compatibility is required. Existing `.saivage/` state,
session logs, RuntimeState files, card result shapes, tests, and HTTP
API shapes from previous Saivage v3 invocations are discarded or
rewritten. A clean architecture is the priority.

## 1. Design Rules

- **Cards are the unit of work.** A card is activated through the
  runtime tool `activate_card(card_id)`. The parent planner does not
  know or care whether the child is handled by an executor, a planner,
  a reviewer, or a retry loop.
- **`activate_card` is terminal at the parent boundary.** It returns
  only `done`, `failed`, or `blocked`. `needs_corrections` is an
  internal reviewer verdict handled inside the active activation.
- **Single active planner.** At most one planner session is `Running`
  globally. Ancestor planners are `AwaitingChild` by virtue of holding
  an unresolved `activate_card` tool call; the runtime does not
  persist an ancestor chain separately.
- **Idle bootstrap.** The runtime starts idle. The analyst calls
  `lets_dance` to record a kickoff directive on the project card; the
  runtime itself calls `activate_card(projectCardId)` on its next safe
  tick. There is no other project bootstrap path.
- **Reviewer is runtime-owned and gated.** The planner signals
  completion with `report_goal_done`; the runtime first checks subtree
  readiness (§3.3) and evidence (§3.2), then invokes the reviewer,
  applies the verdict, and either finishes the card or resumes the
  same planner inside the same activation until the retry limit is
  reached.
- **Status flows only at terminal report.** Every executor terminal
  response and every `report_goal_*` call carries a `status_text`.
  The runtime mirrors it onto the card. There is no `set_status_text`
  tool and no mid-run status update obligation.
- **Reviewer results live on the card.** A `failed` activation does
  not duplicate reviewer issues into the `tool_result`; the parent
  reads them from `card.result.review` on the failed child card.
- **Evidence and subtree-readiness failures are tool errors, not
  reviewer corrections.** `report_goal_done` rejects with explicit
  `subtree_not_ready` / `invalid_evidence` tool errors that do not
  consume `max_review_retries`.
- **No notification acknowledgement gate.** Notifications never block
  `report_goal_done` and never wake a planner.
- **Parentage comes from the card tree.** Use
  `CardStore.getParent(card_id)` for hierarchy. `AgentSession` does
  not store `parent_session_id` or `parent_tool_call_id`.
- **Transient caller edges are runtime state.** The active caller edge
  for the in-flight leaf card-run lives in
  `RuntimeState.active_card_run`, not on the child session.
- **Async shape is only for shell processes.** The asynchronous
  primitive exposed to agents is the durable shell-process layer:
  synchronous `start_and_wait` / `run_project_command` plus
  `wait_for_process` and `kill_process` over persisted
  `ProcessRecord`s.
- **Analyst mutates state through pause → mutate → unpause.** The
  active planner sees changes via a synthetic note appended on resume.
- **Clean-slate boot.** If the new runtime finds a `.saivage/`
  directory created by old v3 code, it moves it aside to
  `.saivage.discarded-<timestamp>/` and starts from an empty state.

## 2. Scope

### Remove

- `src/utils/planner-control.ts`, `PlannerControlFrame`,
  `DispatchRecord`, dispatch queue persistence, and old frame files
  under `.saivage/runtime/`.
- `Runtime.dispatchGoal`, `Runtime.applyPlannerResult`,
  `Runtime.executeReadyCards`, `_dispatchReadyCards`,
  `_checkContinuousImprovement`, and any `MAX_ITERATIONS` dispatch
  loop.
- `PlannerResult` and `PlanningResult` as the planner output and
  Goal-Context types. Replaced by `LatestSelfReport` (§8).
- `AgentRuntime.invokePlanner(goalId, prompt)` and old per-step
  planner execution APIs.
- Planner tools named `start_planner`, `start_executor`, any
  intermediate name `run_card` from earlier drafts, and
  `set_status_text`.
- `resumePlannerSession`, `PlannerResumeDirective`, and runtime paths
  that resume non-project planners outside an activation.
- `RuntimeState.current_card_id`, `current_agent_session_id`, dispatch
  queue fields, `active_planner_sessions`, and `reviewer_in_flight`.
- Session fields `parent_session_id` and `parent_tool_call_id` from
  `AgentSession`.
- Session status values inherited from legacy state, including
  `active`, `done`, `failed`, and `awaiting_review`.
- The `unacknowledged_notification` gate on `report_goal_done`, the
  `Suspended` session lifecycle state, and any `acknowledge_notification`
  planner tool.
- The `running-blocked` card status (replaced by `changed`, §5).
- `POST /api/runtime/dispatch` and tests that assert on the old
  dispatch loop.
- Any test that expects `needs_corrections` as a parent-visible
  activation result, `start_planner`/`start_executor`/`run_card` tool
  names, session parent fields, Tier-A/Tier-B correction propagation,
  runtime-driven resumption of a non-project planner, or a notification
  acknowledgement gate.

### Add or Rewrite

- Planner tool `activate_card(card_id) -> CardActivationOutcome`.
- `report_goal_done / _failed / _blocked` carrying a required
  `status_text` field; runtime mirrors it onto the card.
- Executor terminal response shape carrying a required `status_text`
  field; runtime mirrors it onto the card.
- Analyst tool `lets_dance()` and HTTP `POST /api/runtime/lets_dance`.
- `AgentRuntime.activateCard(cardId, caller)` as the runtime umbrella
  method for card activation.
- `AgentRuntime.ensurePlannerSession(goalId)` as an idempotent helper
  used by `activateCard` to create or resume the planner for a goal
  card.
- `AgentRuntime.invokeExecutor(cardId, goalId, prompt)` for terminal
  card execution.
- `AgentRuntime.invokeReviewer(goalId, assessmentId, prompt)` for the
  runtime-owned review step.
- Runtime safe-tick loop that, when idle and unpaused, consumes a
  pending `lets_dance` or project-correction directive by calling
  `activate_card(projectCardId)` itself.
- Runtime acceptance gates on `report_goal_done`:
  `subtree_not_ready`, then `invalid_evidence`, then reviewer.
- `recordReviewerVerdict`, `addPendingCorrectionNote`, and card-side
  review/correction persistence.
- Card-side `status_text`, `status_text_updated_at`, and
  `status_text_author_session_id` fields written by the runtime from
  terminal agent responses.
- `RuntimeState.active_card_run`, the single leaf card-run record (or
  `null` when idle).
- `ProcessRecord` parent/caller fields and synchronous process tools
  (`start_and_wait`, `run_project_command`) are in scope. Durable
  async process handling (`wait_for_process`, `kill_process`,
  persistent `ProcessRecord`s with `command_hash`, `cwd_canonical`,
  `started_at_monotonic`, and process reattach across restart) is a
  future stage (§14).
- Card status `changed` (replaces `running-blocked`) and
  `subtree_changed` note kind injected into Goal Context.
- Synthetic-note injection after pause→mutate→unpause so the active
  planner sees analyst changes on its next turn.
- Planner prompt text that says planners create child cards, call
  `activate_card`, and include `status_text` in every terminal report.
- A basic Goal Context schema surfaced on planner creation and every
  runtime resume, with `status_text` mirrored on every child node,
  `latest_self_report`, and an explicit `resume_reason` that includes
  `subtree_changed`.
- Tests around activation, internal review retries, retry exhaustion,
  status-text propagation, subtree-readiness and evidence tool errors,
  `lets_dance` bootstrap, analyst pause-mutate-unpause, clean-state
  boot, and restart repair.

## 3. Runtime Tool Contract

Planner sessions get one runtime dispatch tool:

```ts
type CardActivationOutcome =
  | {
      result: 'done';
      summary: string;
      evidence_card_ids?: string[];
    }
  | {
      result: 'failed';
      summary: string;
      error: string;
      failure_kind?:
        | 'executor_failed'
        | 'planner_failed'
        | 'review_retries_exhausted'
        | 'planner_force_cancelled'
        | 'service_restart';
    }
  | {
      result: 'blocked';
      summary: string;
      blocked_reason: string;
    };

activate_card(card_id: string): Promise<CardActivationOutcome>;
```

The tool is subtree-scoped: the caller can only activate cards in its
goal subtree. The card must already exist. The parent planner creates
cards with `create_card`, then activates them with `activate_card`.

For terminal cards, the runtime runs one executor session to
completion, persists artifacts and the executor result, updates the
card (including `status_text` from the executor's terminal response),
and returns a terminal `CardActivationOutcome`.

For goal cards, the runtime runs the goal planner and reviewer loop
to a terminal state. The parent planner never sees reviewer-internal
`needs_corrections` verdicts; on retry exhaustion it sees `failed`
and reads issues from `card.result.review`.

Re-activating the same `Dormant` planner is a normal operation: the
parent adds a note (typically with `add_note`) explaining what to
correct and calls `activate_card(card_id)` again. The runtime resumes
the same planner with the new Goal Context.

Completion tools (every variant carries `status_text` for the runtime
to mirror onto the goal card):

```ts
report_goal_done({
  summary: string;
  status_text: string;
  evidence_card_ids?: string[];
}): void;

report_goal_failed({
  summary: string;
  status_text: string;
  error?: string;
}): void;

report_goal_blocked({
  summary: string;
  status_text: string;
  blocked_reason: string;
}): void;
```

Executor terminal response includes the same `status_text` field
alongside the executor result payload.

### 3.1 Destructive Card Operations

The planner has three card-structural tools beyond `create_card` and
`edit_card`:

- `cancel_card(card_id)` transitions a card from `backlog`, `active`,
  or `changed` to `cancelled`. Refused for the active leaf, for any
  card whose subtree contains the active leaf, for cards in status
  `running`, and for cards already in a terminal status
  (`done`/`failed`/`blocked`/`cancelled`). Cancellation cascading
  onto running ancestors of the active leaf is a future stage (§14).
  Persists a synthetic `latest_self_report` of result `failed` with
  reason `cancelled` when none exists. Emits `card_cancelled`. This
  is the prerequisite to `delete_card` for non-terminal cards.
- `delete_card(card_id)` is refused if the target or any descendant
  equals `active_card_run?.card_id` or has a non-`Dormant` planner.
  Allowed for `backlog`, `done`, `failed`, `blocked`, or `cancelled`
  cards. To delete an `active` or `changed` card, the caller must
  first call `cancel_card`. Deleting a `running` card is not allowed
  in this stage (see §14). Archives
  `(fields, notes, result, evidence references)` under
  `.saivage/archive/cards/<card_id>.json`, removes the card from
  `CardStore`, and emits `card_destructive_delete`. The cascade is
  all-or-nothing: any failing precondition aborts the operation.
- `restart_card(card_id)` transitions a card from `done`, `failed`,
  `blocked`, `cancelled`, or `changed` back to `active`. Refused
  while the card is the active leaf. For terminal cards it clears
  `result.executor` (the next executor run will overwrite
  `status_text`). For goal cards it clears `result.review`, clears
  `latest_self_report`, and resets `correction_attempts`; it does
  NOT wake the planner. The parent must follow with
  `activate_card(card_id)` to give control back. Reset of a
  planner's LLM message log is deferred (see §14).

### 3.2 Evidence Tool Error

`report_goal_done` validates evidence before the reviewer phase.

- If evidence validation fails, the call returns a `tool_error` of
  kind `invalid_evidence` with per-card breakdown. The planner stays
  `Running`; no card activation outcome is emitted.
- The error does not consume `max_review_retries`.
- A runtime event `goal_report_rejected { kind: 'invalid_evidence' }`
  is emitted.
- `active_card_run` is not cleared and no reviewer is invoked.
- **A rejected `report_goal_*` call does NOT mirror its `status_text`
  onto the card and does NOT update `latest_self_report`.** Those
  fields are written only when a `report_goal_*` call is accepted.
- Repeated `invalid_evidence` errors are governed only by the
  standard stuck-supervisor path; there is no separate cap.

### 3.3 Subtree-Readiness Tool Error

Before evidence validation, `report_goal_done` runs the subtree-
readiness gate.

```ts
type SubtreeReadinessReason =
  | { kind: 'descendant_blocking'; card_id: string; status: 'blocked' | 'changed' };
```

The runtime rejects `report_goal_done` with a `tool_error` of kind
`subtree_not_ready` and payload `{ reasons: SubtreeReadinessReason[] }`
when any descendant card is in status `blocked` or `changed` (the
configurable "not-safe-to-close" set, extendable in future stages).

The gate intentionally does not scan descendants for live
subprocesses: a subgoal cannot have reported `done` while it held
live processes, because its own readiness gate would have rejected
the report. The complementary `pending_subprocess` reason (for the
goal card's own processes) lands together with the durable
async-process stage (§14).

On rejection:

- The runtime appends a synthetic note on the goal card naming the
  offending descendants.
- The planner stays `Running`; `active_card_run` is not cleared;
  `correction_attempts` is not incremented.
- Event `goal_report_rejected { kind: 'subtree_not_ready' }` is
  emitted.

Gate order on `report_goal_done` is fixed:

1. `subtree_not_ready` (§3.3).
2. `invalid_evidence` (§3.2).
3. Reviewer phase (§7.4).

## 4. Card Run State

`RuntimeState` stores only the single leaf card-run; the ancestor
chain is derived on demand from `CardStore.getParent`.

```ts
type RuntimeState = {
  paused: boolean;
  notice?: string | null;
  active_card_run: ActiveCardRun | null;
};

type ActiveCardRun = {
  card_id: string;
  card_type: CardType;
  runtime_status: 'running' | 'force_cancelled';
  phase: 'executor' | 'planner' | 'reviewer';
  caller_session_id: string | null;
  caller_tool_call_id: string | null;
  planner_session_id?: string;
  executor_session_id?: string;
  reviewer_session_id?: string;
  correction_attempts: number;
  started_at: string;
  last_turn_at: string;
};
```

Invariants:

- `active_card_run` is `null` when the runtime is idle; otherwise it
  points at the single card-run currently doing work.
- An ancestor planner's `AwaitingChild` status is implied by its
  having an unresolved `activate_card` tool call in its message log;
  no separate field is persisted.
- Each card has at most one activation in flight at any moment. A
  planner session may have at most one unresolved `activate_card`
  tool call at any time and may not wait on a process and an
  `activate_card` simultaneously. Synchronous shell tools
  (`start_and_wait`, `run_project_command`) complete within an LLM
  turn, so this stage has no concept of a long-lived process wait
  that survives across `activate_card`; that lands with the
  durable async-process stage (§14).
- Caller-edge reconstruction: when the active leaf terminates, the
  runtime computes
  `parentCardId = CardStore.getParent(leaf.card_id)`, looks up
  planner session `planner:<parentCardId>` (which must be
  `AwaitingChild`), finds the unique unresolved
  `activate_card(leaf.card_id)` tool call in its message log, and
  uses that session id + tool_call_id as the caller edge. The
  parent's `ActiveCardRun` is reconstructed with `phase: 'planner'`
  and the synthesized `CardActivationOutcome` is delivered as the
  parent's next `tool_result`. Unwinding repeats recursively. No
  persisted caller stack is required; restart repair uses the same
  algorithm.
- System-caller path: if `parentCardId === null` the leaf is the
  project card. The runtime persists the outcome on the project card
  (status, `result.review` when applicable, `latest_self_report`),
  clears `active_card_run` to `null`, emits
  `project_run_completed` (§13), and returns to idle. The specific
  operator-notification flow after a project completion is a future
  stage (§14).
- `ForceCancelled` applies to the leaf. Force-cancel emits exactly
  one synthetic `failed` tool_result to the leaf's parent and clears
  `active_card_run`; the parent becomes `Running` again on its next
  turn. If the cancelled leaf is the project card, the runtime
  persists a synthetic `failed` outcome on the project card and
  emits `project_run_completed` (no tool_result is delivered).
- Runtime pause is a pure global gate (`RuntimeState.paused`); it
  does not change `active_card_run` or any session lifecycle state.
  In-flight tool dispatch finishes synchronously, then the runtime
  stops scheduling new LLM turns. There is no buffered-result
  schema in this stage; pause-time buffering of durable process
  results lands with §14.

`caller_session_id` and `caller_tool_call_id` are transient runtime
edges used to resolve the parent planner's outstanding `activate_card`
tool_call. They are not written into `AgentSession`.

The Web UI renders an active breadcrumb computed server-side by
walking `CardStore.getParent` from `active_card_run.card_id` up to
the project card; the breadcrumb is not persisted.

## 5. Card Status and Status Reporting

Card statuses:

- `backlog`, `active`, `running`, `done`, `failed`, `blocked`,
  `cancelled`.
- `changed`: the card's state was externally modified (by the analyst
  or by a descendant subtree correction) since its planner last saw
  it. The card is NOT immediately re-activated. The parent planner
  (and, recursively, any ancestor) sees a `subtree_changed` note in
  its next Goal Context and decides whether to call
  `activate_card(card_id)` on the affected descendant. The
  reactivation is eventual.

`changed` replaces the old `running-blocked` status and applies
broadly: it can land on the analyst-flagged origin goal, on a
descendant edited under pause, or on any card whose stored state
diverges from the planner's last self-report.

Status transitions driven by `activate_card`:

| Source status | Effect of `activate_card(card_id)` |
|---|---|
| `backlog`, `active` | Card transitions to `running`. |
| `changed` | Card transitions to `running`. The `changed` marker is consumed; any queued `subtree_changed` notes referencing this card are delivered once and then discarded (§10). |
| `done`, `failed`, `blocked`, `cancelled` | Re-activation is allowed for goal cards as the normal correction path (the `Dormant` planner is resumed with fresh notes); the card transitions back to `running`. For terminal cards, `restart_card` is required first to clear `result.executor`; otherwise `activate_card` returns a `tool_error` of kind `terminal_card_requires_restart`. |
| `running` | Tool error of kind `card_already_active`: only one activation may be in flight per card. |

The terminal outcome (`done`, `failed`, or `blocked`) replaces
`running` when control returns to the parent.

Every card carries:

```ts
type CardStatusText = {
  status_text: string | null;                          // free-form, short; null until first accepted report
  status_text_updated_at: string | null;               // ISO timestamp
  status_text_author_session_id: string | null;        // writer session id
};
```

`status_text` is written by the runtime, never by an agent tool.
Sources:

- Executor terminal response includes `status_text`; the runtime
  mirrors it onto the card when persisting the executor result.
- `report_goal_done / _failed / _blocked` includes `status_text`; the
  runtime mirrors it onto the goal card.
- `restart_card` does not touch `status_text` on goal cards; for
  terminal cards the next executor run overwrites it.

There is no `set_status_text` tool. Mid-run progress is not
surfaced; the operator and ancestor planners see the most recent
terminal `status_text`.

Ancestors observe descendant progress through `child_card_tree`
inside Goal Context, never by writing.

## 6. Agent Sessions

Planner session ids are deterministic:

```text
planner:<goal_card_id>
```

Executor session ids include the caller tool call because executor
work is one-shot and tied to a specific activation:

```text
executor:<card_id>:<caller_tool_call_id>
```

Reviewer session ids include a preallocated assessment id:

```text
reviewer:<goal_card_id>:<assessment_id>
```

The runtime allocates `assessment_id` before invoking the reviewer
so the reviewer session and persisted assessment share a stable
identity.

`AgentSession` stores the session's own identity and lifecycle only.
It does not store `parent_session_id` or `parent_tool_call_id`. The
card hierarchy gives durable parentage; `active_card_run` and
`ProcessRecord` give transient runtime caller edges.

Planner lifecycle states:

- `Running`: the only planner currently receiving LLM turns.
- `AwaitingChild`: the planner owns an outstanding `activate_card`
  or process wait and consumes no LLM turns.
- `Dormant`: the planner has emitted `report_goal_done`,
  `report_goal_failed`, or `report_goal_blocked` and is waiting for
  a future activation of the same goal.
- `ForceCancelled`: supervisor or operator stopped the session.

Runtime pause is global (`RuntimeState.paused`) and is not a
per-session state. There is no `Suspended` state.

There is no `AwaitingReview`. Reviewer progress is represented by
`active_card_run.phase === 'reviewer'` and by the goal card's
`result.review` once persisted.

## 7. Runtime Algorithms

### 7.1 Startup and Idle Loop

1. Load configuration and check the target project's `.saivage/`
   layout.
2. If the directory is from an older v3 schema, move it to
   `.saivage.discarded-<timestamp>/` and initialize a clean runtime.
3. Load CardStore, NotificationCenter, ProviderRegistry,
   AgentAdapter, process-runner registry, and StuckSupervisor.
4. Reconcile persisted process records. Only synchronous shell
   commands are exposed in this stage; durable async processes,
   restart identity probes, and pause-time buffering of process
   terminal results land with §14.
5. Reconcile orphan planner tool calls. A planner message log with
   an `activate_card` call and no matching result is repaired from
   `active_card_run`, the child card's terminal status, or a
   synthetic `service_restart` failure. If `active_card_run` is in
   `phase: 'reviewer'` with no persisted `result.review`, follow the
   reviewer-interrupt recovery path (§7.4): transition the goal's
   planner session back to `Running`, set `phase: 'planner'`, and
   queue a `reviewer_interrupted` note in Goal Context.
6. Enter the idle loop. The runtime is idle when
   `active_card_run === null` and not paused. On every safe tick,
   the runtime checks for a pending `lets_dance` or
   project-correction directive on the project card; if one is
   present and no in-flight startup repair remains, the runtime
   calls `activate_card(projectCardId)` itself.
7. Start REST, WebSocket, and supervisor surfaces.

The runtime never enumerates goal cards at startup to spawn their
planners. Every planner, including the project planner, is created
or resumed only through `activate_card`.

### 7.2 Activating a Terminal Card

1. Assert the card is inside the caller's subtree and is a terminal
   card.
2. Set `active_card_run` to an `ActiveCardRun` for `card_id` with
   `phase: 'executor'` and the caller edge.
3. Create or reattach `executor:<card_id>:<caller_tool_call_id>`.
4. Run the executor to completion. The executor's terminal response
   carries `status_text`; the runtime mirrors it onto the card.
5. Persist artifacts, attachments, and `card.result.executor`.
6. Mark the card `done`, `failed`, or `blocked` according to the
   executor result.
7. Walk one step up via `CardStore.getParent`, reconstruct the
   parent's `ActiveCardRun`, and resolve the parent's
   `activate_card` tool call with a terminal outcome. If no parent
   exists (the leaf was the project card), set
   `active_card_run = null`.

### 7.3 Activating a Goal Card

1. Assert the goal is inside the caller's subtree.
2. Set `active_card_run` to an `ActiveCardRun` for `goalId` with
   `phase: 'planner'` and the caller edge.
3. Call `ensurePlannerSession(goalId)`. If the session exists as
   `Dormant`, transition it to `Running` and inject the freshly
   rebuilt Goal Context (with `resume_reason`) as a synthetic user
   turn.
4. Drive the planner until it reports done, failed, or blocked. The
   planner's terminal report carries `status_text`; the runtime
   mirrors it onto the goal card.
5. On `report_goal_failed`, mark the goal `failed`, persist
   `latest_self_report`, mark the planner `Dormant`, unwind to the
   parent.
6. On `report_goal_blocked`, mark the goal `blocked`, persist
   `latest_self_report`, mark the planner `Dormant`, unwind to the
   parent.
7. On `report_goal_done`, run §7.4. Subtree-readiness and evidence
   validation happen there as tool errors that bounce back into the
   planner without clearing `active_card_run`.

### 7.4 Acceptance Gates and Reviewer Phase

Inside the active activation, in this fixed order:

1. **Subtree readiness.** Walk descendants of the goal. If any is in
   status `blocked` or `changed`, return `report_goal_done` as a
   `tool_error` of kind `subtree_not_ready` with `reasons` per §3.3.
   Append a synthetic note on the goal card listing the offending
   descendants. Do not clear `active_card_run`. Do not increment
   `correction_attempts`. (The `pending_subprocess` reason lands
   with the durable async-process stage, §14.)
2. **Evidence.** Every evidence card must be a descendant of the
   goal card and must carry durable evidence per §8. On failure,
   return `report_goal_done` as a `tool_error` of kind
   `invalid_evidence` per §3.2. Do not clear `active_card_run`.
   Do not increment `correction_attempts`.
3. Preallocate `assessment_id`, create reviewer session id
   `reviewer:<goalId>:<assessment_id>`, transition the goal's
   planner session to `Dormant`, set
   `active_card_run.phase = 'reviewer'`, and invoke the reviewer.
   On `needs_corrections` (step 6) the planner is transitioned back
   to `Running` before being resumed.
4. Persist the assessment on the goal card as `result.review`.
5. On `pass`, reset `correction_attempts`, mark the goal `done`,
   mirror `status_text` from the accepted `report_goal_done` onto
   the card, persist `latest_self_report`, unwind to the parent
   with `done`.
6. On `needs_corrections`, increment `correction_attempts`. If
   `correction_attempts <= max_review_retries`, transition the
   planner back to `Running` with the assessment available in Goal
   Context as `latest_review_result` and
   `resume_reason: 'reviewer_correction'`, set
   `active_card_run.phase = 'planner'`, and loop back to step 4 of
   §7.3. The rejected `report_goal_done`'s `status_text` and
   `latest_self_report` are NOT mirrored onto the card.
7. If `correction_attempts > max_review_retries`, write
   `pending_subtree_correction` notes on the origin goal and every
   strict ancestor goal, mark the origin `changed`, mark the
   planner `Dormant`, and unwind to the parent with `failed` and
   `failure_kind: 'review_retries_exhausted'`. The reviewer issues
   stay on `card.result.review`; they are NOT copied into the
   tool_result.

**Reviewer interrupt recovery.** If a service restart (or supervisor
force-cancel) interrupts a reviewer session before `result.review`
is persisted, the runtime resumes the goal's planner with
`resume_reason: 'reviewer_interrupted'` and a `reviewer_interrupted`
synthetic note in Goal Context. The planner inspects the subtree,
confirms the work is still complete, and re-issues
`report_goal_done`; the runtime re-runs the gates and reviewer with
a fresh `assessment_id`. The interrupted reviewer session is
discarded.

`max_review_retries` defaults to 3 (runtime config). Per-card
override via `card.metadata.max_review_retries`. Semantics: a value
of `N` means the runtime allows up to `N` planner resumes after a
`needs_corrections` verdict; the `N + 1`-th consecutive verdict
fails the activation. `correction_attempts` is reset to 0 on `pass`
and on `restart_card`.

Persisted JSON uses `snake_case`; the in-memory TypeScript mirror
uses `camelCase`.

## 8. Goal Context Schema

Goal Context is rebuilt for every planner creation or runtime
resume. Keep it intentionally basic for now:

```ts
type GoalContext = {
  id: string;
  type: 'goal' | 'project';
  parent_card_id: string | null;
  depth: number;
  title: string;
  description?: string;
  acceptance?: string[];
  tags?: string[];
  priority?: number;
  depends_on?: string[];
  blocks?: string[];
  status_text?: string;
  child_card_tree: GoalContextCardNode[];
  notes: GoalContextNote[];
  latest_self_report?: LatestSelfReport;
  latest_review_result?: ReviewAssessment;
  correction_attempts: number;
  max_review_retries: number;
  resume_reason: 'initial' | 'reviewer_correction' | 'analyst_directive' | 'subtree_changed' | 'service_restart';
};

type GoalContextCardNode = {
  id: string;
  type: CardType;
  title: string;
  status: CardStatus;
  status_text?: string;
  child_card_tree?: GoalContextCardNode[];
};

type GoalContextNote =
  | {
      kind: 'pending_subtree_correction';
      origin_card_id: string;
      issues: AnalystIssue[];
      body: string;
      at: string;
    }
  | {
      kind: 'subtree_changed';
      descendant_card_ids: string[];
      body: string;
      at: string;
    }
  | { kind: 'subtree_not_ready'; reasons: SubtreeReadinessReason[]; at: string }
  | { kind: 'reviewer_interrupted'; assessment_id: string; at: string }
  | { kind: 'analyst_note'; body: string; at: string };

type LatestSelfReport = {
  result: 'done' | 'failed' | 'blocked';
  summary: string;
  status_text: string;
  at: string;
};

type ReviewerIssue = {
  summary: string;
  severity: 'info' | 'warning' | 'blocker';
  evidence_card_id?: string;
  recommendation?: string;
};

type ReviewerResult = {
  result: 'pass' | 'needs_corrections';
  summary: string;
  achieved: string[];
  issues: ReviewerIssue[];
  evidence_card_ids: string[];
};

type ReviewAssessment = ReviewerResult & {
  assessment_id: string;
  at: string;
};
```

`latest_self_report` is the most recent terminal report this planner
filed for this goal, persisted on the card. It replaces the old
`PlanningResult`/`latest_planning_result` field, which is deleted.

Resume mechanics:

- Every runtime resume appends one synthetic user turn to the
  planner's message log containing the freshly rebuilt Goal Context
  block plus a one-line resume reason.
- Prior synthetic context turns are kept. Compaction handles drift.
- Resume reasons: `initial`, `reviewer_correction`,
  `analyst_directive`, `subtree_changed`, `reviewer_interrupted`,
  `service_restart`.
- The `subtree_changed` resume_reason is used when an ancestor
  planner is reactivated to react to descendants that landed in
  `changed` status under the analyst pause-mutate-unpause pattern
  (§10).

Only the directive note kinds shown above are injected into `notes`;
ordinary notes remain available through note tools.

Durable evidence is one of, scoped to descendants of the goal:

- A registered artifact.
- A registered attachment.
- For terminal cards, a non-null `result.executor` object that
  validates against the executor result schema for that card type.
- For goal cards, a `result.review.result === 'pass'` assessment.

## 9. Planner Prompt

The planner prompt must teach the new boundary:

```text
You are the planner for goal "<title>" (id: <id>).
You own the cards in this goal subtree.

Create child cards for work. When a child card should be worked,
call activate_card(card_id). The runtime will pass control to the
agent that owns that card (executor or another planner) and return
one terminal result: done, failed, or blocked. The same planner may
resume on a later activate_card on the same goal; executor sessions
are one-shot per activation.

For non-trivial implementation, test, doc, data, research, ops, or
architecture work, create a terminal card and call activate_card on
it. For larger work, create a goal card and call activate_card on it.

When you finish this goal, call report_goal_done with a summary,
status_text (a short progress line the operator and your parent
will see on the card), and evidence_card_ids. The runtime then
checks: (1) no descendant is in `blocked` or `changed` status;
(2) every evidence card is durable.
If either check fails, you receive a tool error (subtree_not_ready
or invalid_evidence) and you must fix the state without consuming a
review retry. If both checks pass, the runtime runs the reviewer.
If reviewer corrections are needed, the runtime may resume you
inside the same activation with reviewer feedback in Goal Context.
You do not call the reviewer yourself.

If activate_card returns failed for a child, read the child card's
result.review (if any) to see the reviewer's issues, then decide
whether to add notes and re-activate the child, restructure with
delete_card/restart_card, or report this goal as failed or blocked.

If you are resumed with `resume_reason: 'reviewer_interrupted'`,
a previous reviewer was interrupted before persisting its result.
Inspect the subtree and the card; if the work is still complete,
call report_goal_done again. The runtime will re-run the gates
and reviewer.

If a descendant lands in `changed` status (you will see this in the
child_card_tree and as a subtree_changed note), decide whether to
re-activate the affected descendant, restructure, or escalate.

If this goal cannot be completed, call report_goal_failed or
report_goal_blocked, again with a status_text field.
```

The project planner is an ordinary goal planner whose goal is the
project card. Its prompt gets one additional instruction: it
schedules top-level goals by creating top-level cards and calling
`activate_card` on each one. It is brought to `Running` by the
runtime when a `lets_dance` directive is pending; the runtime does
not auto-spawn it on boot.

## 10. Analyst, `lets_dance`, and Operator Paths

Analyst tools:

- `lets_dance()`: records a `lets_dance` directive on the project
  card. The runtime's idle safe-tick consumes the directive and
  calls `activate_card(projectCardId)` itself once the runtime is
  idle and unpaused. The system is kicked off this way; there is no
  other project-bootstrap path.
- `mark_goal_needs_corrections(goalId, issues, note?)`: writes
  `pending_subtree_correction` notes on the origin goal card and
  each strict ancestor goal card and may flip the origin card from
  `done`, `running`, or `blocked` to `changed`. Resumes no planner.
- `mark_project_needs_corrections(issues, note?)`: writes a
  directive note on the project card. The runtime decides on its
  next safe tick whether to call `activate_card(projectCardId)`
  (same conditions as `lets_dance`).
- `pause_runtime()` / `resume_runtime()`: toggle the global pause
  gate.

Analyst interaction with mutable state uses the pause-mutate-unpause
pattern:

1. `pause_runtime`.
2. Write notes, flip statuses (e.g. mark descendants `changed`),
   record directives, edit card fields.
3. `resume_runtime`.

On resume, if a planner is `Running` or `AwaitingChild`, the runtime
appends a synthetic user turn to the active planner's message log
summarizing the analyst's mutations (note kinds:
`analyst_note`, `pending_subtree_correction`, and/or
`subtree_changed` with the affected `descendant_card_ids`).

**Note injection.** Synthetic notes are queued on the target
planner's session and injected as a synthetic user turn the next
time that planner is about to receive an assistant turn (a freshly
landed `tool_result`, a fresh activation, or a runtime resume).
Injection is one-shot per note: once the synthetic turn is
appended, the note is removed from the queue and is not
redelivered. The card-side status (e.g. `changed`) and persisted
correction records remain on the card; the queued note is just the
delivery vehicle into the LLM conversation.

**Note routing.** A synthetic note is queued on the session of the
deepest planner whose goal subtree contains the affected card. If
that planner is currently `Dormant`, the note remains queued and is
delivered the next time the planner is brought to `Running` by
`activate_card`.

**`changed` consumption.** When `activate_card(card_id)` is called
on a card in status `changed`, the runtime transitions the card to
`running` and consumes the `changed` marker; any queued
`subtree_changed` notes referencing this card are delivered once
and then discarded.

Guaranteeing semantic consistency of these mutations against
in-flight runtime state is deferred to a future stage (§14).

The `changed` flow is recursive: when a descendant is marked
`changed`, ancestor goal cards get a `subtree_changed` note. When
control unwinds to an ancestor planner via `activate_card`'s
outcome, that ancestor sees the note in its next Goal Context and
decides what to do (re-activate the affected descendant,
restructure, or escalate).

Notifications never resume a planner and never block
`report_goal_done`. The notification acknowledgement gate from
earlier drafts is removed.

Analyst issues and HTTP issues use one canonical shape:

```ts
type AnalystIssue = {
  summary: string;
  severity?: 'info' | 'warning' | 'blocker';
  evidence_path?: string;
};
```

The analyst tool and the HTTP endpoint accept the same array shape;
`flagged_by` is derived server-side from the authenticated session
and is never accepted from the client body.

## 11. HTTP API

- Remove `POST /api/runtime/dispatch`.
- Add `POST /api/runtime/lets_dance`. No body required. Returns
  `{directive_recorded: true, runtime_status: 'idle' | 'running' | 'paused'}`.
  The runtime calls `activate_card(projectCardId)` itself on its next
  safe tick.
- Add `POST /api/runtime/goals/:id/needs_corrections` with body
  `{issues: AnalystIssue[], note?: string}`. Records notes and
  returns `{origin_goal_id, notes_recorded_on_goal_ids,
  status_transition}`. The response never includes
  `resumed_planner_session_id`.
- Add `POST /api/runtime/project/needs_corrections` with body
  `{issues: AnalystIssue[], note?: string}`. Records a project
  directive note and returns
  `{directive_recorded: true, runtime_status: 'idle' | 'running' | 'paused'}`.
  The runtime decides on its next safe tick whether to activate the
  project card.
- Add `POST /api/runtime/pause` and `POST /api/runtime/resume`.
  Returns the updated `RuntimeState`.
- Add `GET /api/runtime/card-runs`, returning a typed union:

  ```ts
  type CardRunsResponse = {
    active_card_run: ActiveCardRun | null;
    active_breadcrumb: CardBreadcrumbNode[]; // server-computed, project -> leaf
    dormant_planners: DormantPlannerRow[];
    cards_with_pending_corrections: PendingCorrectionRow[];
  };

  type CardBreadcrumbNode = {
    card_id: string;
    card_type: CardType;
    title: string;
    status_text?: string;
  };

  type DormantPlannerRow = {
    goal_card_id: string;
    planner_session_id: string;
    latest_self_report: LatestSelfReport | null;
  };

  type PendingCorrectionRow = {
    card_id: string;
    status: CardStatus;
    note_count: number;
    last_note_at: string | null;
  };
  ```

## 12. Tests

### Unit Tests

- `activate_card` authorization and subtree guard.
- Terminal-card activation maps executor outcomes to terminal parent
  outcomes, mirrors executor `status_text` onto the card, and sets
  then clears `active_card_run` exactly once.
- Goal-card activation loops planner -> reviewer -> planner
  internally on reviewer corrections.
- Retry exhaustion returns `failed` with
  `failure_kind: 'review_retries_exhausted'`; the tool_result does
  NOT duplicate reviewer issues; the issues are present on
  `card.result.review`; the origin card status is `changed`.
- `report_goal_done` with a descendant in `blocked` or `changed`
  status returns a `tool_error` of kind `subtree_not_ready` with the
  offending card id and status.
- `report_goal_done` with bad evidence returns a `tool_error` of
  kind `invalid_evidence`, leaves `active_card_run` set, and does
  not increment `correction_attempts`.
- Subtree-readiness gate runs before evidence; both gates run before
  the reviewer.
- A rejected `report_goal_done` does NOT mirror `status_text` and
  does NOT update `latest_self_report`; only an accepted
  `report_goal_*` (or accepted executor terminal result) updates
  those fields.
- `activate_card` on a completed terminal card without a preceding
  `restart_card` returns a `tool_error` of kind
  `terminal_card_requires_restart`.
- `activate_card` on a card in status `running` returns a
  `tool_error` of kind `card_already_active`.
- `activate_card` on a card in status `changed` consumes the
  `changed` marker, transitions the card to `running`, and the
  queued `subtree_changed` note(s) referencing that card are
  delivered to the planner exactly once and then removed from the
  queue.
- Restart while `active_card_run.phase === 'reviewer'` with no
  persisted `result.review` resumes the planner with
  `resume_reason: 'reviewer_interrupted'` and a
  `reviewer_interrupted` note; the planner re-issues
  `report_goal_done`, gates re-run, a fresh `assessment_id` is
  used, the discarded reviewer session is not persisted.
- `cancel_card` refuses any target whose subtree contains the
  active leaf; otherwise it accepts `backlog`, `active`, or
  `changed` and writes a synthetic `latest_self_report` with
  reason `cancelled` when none exists.
- `report_goal_*` mirrors `status_text` onto the goal card and
  records `latest_self_report` with summary, status_text, and
  timestamp.
- Goal Context surfaces each child card's `status_text`,
  `latest_self_report`, and includes `resume_reason`.
- `AgentSession` rejects `parent_session_id`, `parent_tool_call_id`,
  and legacy statuses (`active`, `done`, `failed`,
  `awaiting_review`, `suspended`).
- `RuntimeState` validates the single-`active_card_run` shape and
  rejects legacy current fields and any persisted ancestor chain.
- Goal Context includes the basic fields, latest review/self
  report, filtered correction notes, `subtree_changed` notes, and
  retry counters.
- Durable evidence validation rejects siblings and cards without
  registered artifacts, attachments, valid executor results, or a
  passed review for goal cards.
- `delete_card` / `restart_card` honour the leaf and subtree
  preconditions and behave per §3.1. `restart_card` accepts the
  `changed` status as input.
- No `set_status_text` tool is exposed; planner attempts to call it
  produce a hard tool error.
- No `acknowledge_notification` tool is exposed; planner attempts to
  call it produce a hard tool error.

### Integration Tests

- Boot sequence: runtime starts idle; no planner is `Running`; no
  card is activated until the analyst calls `lets_dance`. After
  `lets_dance`, the runtime itself calls
  `activate_card(projectCardId)` on its next safe tick.
- Project planner creates a top-level goal and calls `activate_card`
  on it; `active_card_run` points at the project card immediately
  before the call and at the top-level goal immediately after.
- Nested goal activation preserves the single-`Running`-planner
  invariant across arbitrary depth, with `active_card_run` always
  pointing at the deepest active card; unwinding restores
  `active_card_run` to each ancestor in turn.
- Reviewer corrections are handled internally until pass; the parent
  sees only `done`.
- Reviewer corrections exhaust the retry limit; the parent sees
  `failed`, ancestors receive correction notes, the origin card is
  `changed`, and the child card has `result.review` set.
- Parent re-activates a `Dormant` child after adding a note; the
  same planner resumes with the new Goal Context.
- Analyst pause-mutate-unpause: while a planner is `Running`, the
  analyst pauses, marks a descendant card `changed`, and unpauses.
  The planner's next turn delivers a synthetic note with the
  affected descendant ids; the planner can call `activate_card` on
  the descendant.
- Analyst late re-open records notes without activating any card; a
  later `mark_project_needs_corrections` records a directive that
  the runtime consumes on its next idle safe tick (if the project
  has already gone `Dormant`).
- Restart with an orphan `activate_card` call repairs exactly one
  parent `tool_result` from persisted card/session state.
- Restart after `report_goal_done` but before reviewer invocation
  re-runs the acceptance gates and invokes the reviewer without
  making the planner `Running`.
- Restart after reviewer invocation but before `result.review` is
  persisted re-runs the reviewer-interrupt recovery path: the
  planner is resumed with `resume_reason: 'reviewer_interrupted'`,
  the planner re-calls `report_goal_done`, the gates and reviewer
  re-run with a fresh `assessment_id`, and the parent eventually
  sees `done`.
- Pause/resume preserves the in-flight leaf and process records;
  shell processes that started before pause continue running; their
  terminal `tool_result` is buffered until resume.
- Stuck planner force-cancel emits exactly one synthetic `failed`
  tool_result with `failure_kind: 'planner_force_cancelled'` and
  clears `active_card_run`; the parent becomes `Running` on its
  next turn.
- Status text propagation: a deep terminal card's executor
  `status_text` is mirrored onto its card; the project planner's
  next Goal Context shows the value via `child_card_tree`.

### Delete Old Tests

- Dispatch-loop tests.
- `PlannerResult` / `PlanningResult` parser tests.
- `start_planner`, `start_executor`, `run_card`, `set_status_text`,
  `acknowledge_notification`, `resumePlannerSession`, Tier-A/Tier-B,
  `awaiting_review`, `suspended`, `running-blocked`, and
  `active_planner_sessions` tests.
- Tests expecting backward compatibility with old `.saivage/` state.
- Tests asserting on the notification acknowledgement gate.

## 13. Runtime Events

Add or keep these event kinds:

- `card_activation_started`
- `card_activation_phase_changed`
- `card_activation_completed`
- `project_run_completed` — payload
  `{ project_card_id, result: 'done' | 'failed' | 'blocked', summary: string, failure_kind?: CardActivationOutcome['failure_kind'], blocked_reason?: string }`.
- `card_cancelled`
- `reviewer_interrupted`
- `goal_report_rejected` (with `kind: 'subtree_not_ready' | 'invalid_evidence'`)
- `goal_review_needs_corrections`
- `correction_notes_recorded`
- `review_retry_exhausted`
- `planner_direct_write`
- `card_destructive_delete`
- `card_restarted`
- `card_marked_changed`
- `planner_session_force_cancelled`
- `planner_compaction_throttled`
- `goal_reopened_by_analyst`
- `planner_stale`
- `status_text_updated`
- `lets_dance_received`
- `runtime_idle_tick_consumed_directive`
- `process_started`
- `process_timed_out`
- `process_killed`
- `process_reconciled_dead` — emitted only during restart-time durable
  process reconciliation when a previously running process is found
  dead/lost; persisted alongside the synthetic terminal record.
- `process_reattach_rejected` — emitted only during restart-time
  durable process reconciliation when identity matches but reattach is
  rejected; persisted alongside the synthetic terminal record.

Durable async process terminal records and restart-time process
reconciliation audit events are current scope.

Remove Tier-A/Tier-B-era correction events, legacy dispatch-loop
events, and any `notification_acknowledged` events tied to the
removed gate.

Event payloads share a common envelope
`{ event_id: string; runtime_session_id: string; at: string }` plus
event-specific fields named after the event kind. Examples:
`project_run_completed { result, summary }`;
`card_cancelled { card_id, cancelled_by_session_id }`;
`goal_report_rejected { kind, goal_card_id, session_id }`;
`card_destructive_delete { card_id, archive_path }`.

## 14. Phasing

1. Clean-state boot and schema deletion: remove legacy state
   readers, add `.saivage` discard behavior, rewrite validators.
2. Card model and status_text: extend `Card` with the three
   status_text fields; remove `set_status_text`; wire runtime
   mirroring from executor terminal response and `report_goal_*`.
3. Planner tools and prompt: add `activate_card`, drop `start_*`,
   any earlier `run_card` name, `set_status_text`, and
   `acknowledge_notification`; update planner and project-planner
   prompts to include `status_text` in every terminal report.
4. Runtime activation implementation: terminal cards, goal cards,
   single `active_card_run`, single-active-planner enforcement,
   unwinding, `delete_card` and `restart_card`.
5. Reviewer loop and acceptance-gate tool errors: subtree-readiness
   gate, evidence gate, preallocated assessment ids, retry
   counters, retry exhaustion with reviewer issues left on the
   card, status flip to `changed`.
6. Analyst and API paths: correction notes, `lets_dance` bootstrap
   endpoint, pause-mutate-unpause synthetic-note injection,
   card-run operator endpoint with the typed union response,
   `AnalystIssue` shape unification.
7. Restart and orphan repair: orphan `activate_card` repair
   (including reviewer-interrupt recovery per §7.4) plus durable
   process reconciliation and identity probes.
8. Test deletion and rebuild: remove obsolete tests, add focused
   unit and integration coverage, then run build and docs
   verification.

Future stages (not in this redesign):

- Split `.saivage/` into per-concern subdirectories
  (sessions/cards/runtime/archive/notifications).
- Reset-planner feature to truncate a `Dormant` planner's LLM
  message log so a re-activation starts fresh.
- Continuous improvement agent: the `continuousImprovement` config
  flag is reserved for a future stage that auto-emits `lets_dance`
  on a schedule. The flag is read but has no runtime effect today.
- Project-level recovery loop after `failed` / `blocked` outcomes,
  and the operator-notification / analyst-handoff side of
  `project_run_completed`.
- Analyst-mutation consistency guarantees against in-flight runtime
  state.
- Subtree-readiness `pending_subprocess` gate extension for the goal
  card's own processes. Durable `ProcessRecord`s now exist and are
  observable, but `report_goal_done` gate ordering remains
  `subtree_not_ready` → `invalid_evidence` → reviewer until this future
  gate extension lands.
- Cancel-cascade through running ancestors. Cancelling a card whose
  subtree contains the active leaf would require cascading
  cancellation through the running ancestor chain and the active
  leaf itself; deferred.
- Artifact and attachment registration schemas (their on-disk
  layout and the registration API). Evidence validation (§8)
  references registered artifacts and attachments without
  specifying the registration schema here.

## 15. Ninth-Round Review Fixes

The ninth review against the eighth-round design surfaced nine
findings (five major plus four medium/low) plus a request to
explicitly track everything deferred to future stages. Each is
addressed by the sections noted, or explicitly deferred to §14.

| # | Issue | Resolution |
|---|---|---|
| 1 | Durable async process layer (`wait_for_process`, `kill_process`, persistent `ProcessRecord`, restart identity probes, process reattach, pause-time buffering of process results) is implemented separately from activation gates. | Current scope includes durable process records and terminal buffering; the descendant-process subtree gate remains deferred to §14. |
| 2 | `pending_tool_result` payload on `ActiveCardRun` was needed only by the deferred async-process pause-buffering case. | Removed. Pause is a pure global gate; in-flight tool dispatch completes synchronously then the runtime stops scheduling new LLM turns (§4). |
| 3 | `ReviewerIssue` was referenced but never typed. | `ReviewerIssue` schema added: `{ summary, severity: 'info' \| 'warning' \| 'blocker', evidence_card_id?, recommendation? }`. `ReviewerResult.issues: ReviewerIssue[]` (§8; agents.md §10). |
| 4 | `status_text` and `latest_self_report` write timing on rejected `report_goal_done` was ambiguous. | Explicit: only an accepted `report_goal_*` (or accepted executor terminal result) mirrors `status_text` and writes `latest_self_report`. Rejected reports (`subtree_not_ready`, `invalid_evidence`, `needs_corrections`) write neither (§7.4, §12; agents.md §10). |
| 5 | Cancelling an ancestor of the active leaf was implied but its cascade through running ancestors was unspecified. | Cancel-cascade through running ancestors deferred (§14). `cancel_card` now refuses any target whose subtree contains the active leaf and only accepts `backlog`/`active`/`changed` (§3.1, §12; agents.md §7.1). |
| 6 | Subtree-readiness gate recursed into descendants for live subprocesses. | Removed the recursion. Subgoals cannot return `done` while holding live processes (their own readiness gate would reject), so the ancestor gate only needs to check the goal card's own state. With async processes deferred, the gate reduces to "no descendant in `blocked` or `changed` status" (§3.3, §7.4; agents.md §8.2). |
| 7 | Synthetic-note injection timing distinguished resume vs. next LLM turn. | Simplified: notes are injected the next time the target planner's LLM conversation has room to admit a synthetic user turn (a freshly landed `tool_result`, a fresh activation, or a runtime resume). Each note is one-shot (§10; agents.md §11). |
| 8 | Reviewer interrupt (restart while `phase: 'reviewer'`) had no documented recovery path. | Recovery path documented: planner is resumed with `resume_reason: 'reviewer_interrupted'` and a `reviewer_interrupted` synthetic note. The planner inspects the subtree, re-issues `report_goal_done`, and the gates and reviewer re-run with a fresh `assessment_id` (§7.1, §7.4, §8, §9; agents.md §10, §11, §12). |
| 9 | Several minor: terminal-card-without-restart returned an unnamed tool error; `activate_card` on `running` card had unnamed error; `restart_card` did not say what happens to `latest_self_report`; `project_run_completed` payload was thin; cross-ref bug "§10, §14 of the plan". | Named errors `terminal_card_requires_restart` and `card_already_active` (§5; agents.md §4.2). `restart_card` on goal cards clears `latest_self_report` (§3.1; agents.md §7.1). `project_run_completed` payload typed (§13; agents.md §6). Cross-ref fixed (agents.md §8.2). |

## 16. Eighth-Round Review Fixes

The eighth review against the seventh-round design surfaced sixteen
findings (three major plus thirteen medium/low). Each is addressed by
the sections noted.

| # | Issue | Resolution |
|---|---|---|
| 1 | Caller-edge contract underspecified for nested unwinding. | Caller-edge reconstruction algorithm documented: `CardStore.getParent` → `planner:<parentCardId>` (`AwaitingChild`) → unique unresolved `activate_card` tool call. No persisted stack. Each card has at most one activation in flight at a time (§4; agents.md §6). |
| 2 | Root activation / system-caller path missing. | System-caller path documented: on project-card termination the runtime persists the outcome on the project card, clears `active_card_run`, emits `project_run_completed`, and returns to idle. Operator-notification flow deferred (§4, §13, §14; agents.md §6, §17). |
| 3 | `activate_card` source-status matrix undefined. | Added status-transition table in §5 and agents.md §4.2 covering `backlog`/`active`/`changed`/terminal/`running`. |
| 4 | Status transitions on activation not specified. | Same table as #3: cards transition to `running` on activation; terminal outcome replaces `running` on unwind. |
| 5 | Pause buffering not persisted in `ActiveCardRun`. | Added `pending_tool_result?: { tool_call_id, payload, received_at }` to `ActiveCardRun`; durable across restart (§4; agents.md §6). |
| 6 | Synthetic-note routing unspecified. | Note routing rule: queued on the deepest planner whose goal subtree contains the affected card; if `Dormant`, queued until next `activate_card` (§10; agents.md §11). |
| 7 | `changed` / note resolution lifecycle unclear. | `changed` is consumed on `activate_card` (card transitions to `running`). Notes are injected once into the LLM conversation and then discarded (§5, §10; agents.md §4.2, §11). |
| 8 | Rejected `report_goal_*` could mirror stale `status_text`. | Explicit rule: rejected `report_goal_*` does NOT mirror `status_text` or update `latest_self_report` (§3.2; agents.md §8.1). |
| 9 | `delete_card` required cancellation but no cancel op existed. | Added `cancel_card(card_id)` planner tool; required prerequisite for deleting non-terminal cards (§3.1; agents.md §7, §7.1). |
| 10 | Readiness gate missed processes on the goal card itself. | Gate now checks descendants AND the goal card itself for live subprocesses (§3.3; agents.md §8.2). |
| 11 | Project correction vs deferred recovery loop reconciliation. | `mark_project_needs_corrections` records a directive consumed by the same idle safe-tick as `lets_dance`; full operator/analyst recovery loop deferred (§10, §14; agents.md §11). |
| 12 | Reviewer-phase planner lifecycle not explicit. | Planner transitions to `Dormant` at reviewer start, back to `Running` on `needs_corrections` retry (§7.4). |
| 13 | Missing schemas: `ReviewAssessment`, `DormantPlannerRow`, `PendingCorrectionRow`, event payloads. | All four added (§8, §11, §13; agents.md §9, §14). |
| 14 | `pending_subtree_correction` note shape too thin. | Expanded to `{ kind, origin_card_id, issues: AnalystIssue[], body, at }` (§8; agents.md §9). |
| 15 | `status_text` fields non-nullable for new cards. | All three `status_text` fields made nullable; `null` until first accepted terminal report (§5; agents.md §4.1). |
| 16 | Intro wording conflated planner and executor recurrence. | Reworded: planners recur on the same goal; executors are one-shot per activation (§1; agents.md intro). |

## 17. Seventh-Round Review Fixes

The seventh review (against the leaf-only `activate_card` design)
surfaced 13 issues plus two additional design directives. Each is
addressed by the sections noted, or explicitly deferred.

| # | Issue | Resolution |
|---|---|---|
| 1 | Root/project activation contract underspecified. | Runtime is idle on boot. Analyst calls `lets_dance`; the runtime itself calls `activate_card(projectCardId)` on its next safe tick (§7.1, §10, §11; agents.md §11). |
| 2 | Single `active_card_run` loses nested caller edges. | Unwinding is explicit: on leaf termination the runtime walks one step up via `CardStore.getParent`, reconstructs the parent's `ActiveCardRun`, and delivers the synthesized outcome (§4, §7.2, §7.3; agents.md §3, §6). |
| 3 | Unwinding from leaf to parent underspecified. | Same as #2; recursive unwinding documented in §4 and agents.md §3. |
| 4 | Analyst/root activation conflicts with synchronous parent-tool semantics. | Analyst always works through pause-mutate-unpause; the runtime, not the analyst, calls `activate_card(projectCardId)`. Consistency of mutations is deferred (§10, §14; agents.md §11). |
| 5 | Project correction endpoint response was stale/narrow. | Endpoint records a directive only; runtime decides; response is `{directive_recorded, runtime_status}`. Operator/analyst fix loop after `failed`/`blocked` is deferred (§11, §14). |
| 6 | Pause buffering not persisted/typed. | Pause is a global gate; in-flight processes keep running and their terminal `tool_result` is buffered until resume (§4; agents.md §6, §12). |
| 7 | Notification acknowledgement tool was referenced but not exposed. | Removed entirely. No `acknowledge_notification` tool; no `unacknowledged_notification` gate; notifications never block `report_goal_done` (§2 Remove, §3.2, §10). |
| 8 | Evidence tool error could loop forever. | Accepted: governed by the standard stuck-supervisor path; no separate cap (§3.2; agents.md §8.1). |
| 9 | `PlanningResult` remained orphaned in Goal Context. | Removed. Replaced by `latest_self_report: LatestSelfReport` populated from the most recent terminal `report_goal_*` call (§8; agents.md §9). |
| 10 | `continuousImprovement` config flag is orphaned. | Kept in config as a deferred no-op; documented as Future Stages (§14; agents.md §17). |
| 11 | `running-blocked` reactivation path ambiguous. | Renamed to `changed`. The card is NOT immediately re-activated; ancestor planners see a `subtree_changed` note in their next Goal Context and decide whether to call `activate_card`. Reactivation is recursive and eventual (§5, §8, §10; agents.md §4.2, §11). |
| 12 | Analyst correction against the active card not defined. | Pause-mutate-unpause appends a synthetic note to the active planner's message log on resume; the planner sees it on its next LLM turn and replans (§10; agents.md §11). |
| 13 | Stale wording: file map "active card chain", "project wake path", changelog entries. | Replaced throughout. File map mentions `lets_dance` and single active card-run; analyst tools row says `lets_dance` bootstrap (agents.md §16). |
| A | Runtime owns project activation timing. | Runtime safe-tick loop activates the project card itself when idle and a `lets_dance` / project-correction directive is pending (§7.1, §10; agents.md §11). |
| B | Runtime acceptance gates beyond the reviewer. | New `subtree_not_ready` tool error rejects `report_goal_done` if any descendant has a live subprocess or is in `blocked`/`changed` status. Runs before evidence and the reviewer; does not consume `max_review_retries` (§3.3, §7.4; agents.md §8.2). |
| C | Status text writes were a special tool action. | Removed `set_status_text`. `status_text` is a required field on every executor terminal response and every `report_goal_*` call; the runtime mirrors it onto the card (§3, §5; agents.md §4.1, §4.3, §7). |

## 18. Sixth-Round Review Fixes (Recap)

The sixth review surfaced 18 issues against an earlier draft. They
were addressed by the previous revision of this plan and remain in
force unless superseded by §17 (Seventh-Round), §16 (Eighth-Round),
or §15 (Ninth-Round)
above. Highlights:

1. Restart receipts for `run_card`: reset-planner feature deferred
   to §14.
2. Nested active runs reduced to a single leaf `active_card_run`;
   ancestor `AwaitingChild` derived from each planner's unresolved
   `activate_card` tool call.
3. No child-status aggregation: `card.status_text` is canonical;
   child-tree mirror surfaces it in Goal Context.
4. Retry exhaustion does not duplicate reviewer issues into the
   `failed` tool_result.
5. Evidence and (originally) notification gates promoted to
   `report_goal_done` tool errors that do not consume retries; the
   notification arm has since been removed entirely (§17.7).
6. `run_card` renamed to `activate_card`.
7. `.saivage/` subdirectory layout deferred.
8. Destructive card ops fully specified in §3.1.
9. Project planner modelled like any other planner; bootstrap
   updated to runtime-owned `lets_dance` flow (§17.1).
10. Retry semantics: `N` resumes allowed; `N+1`-th
    `needs_corrections` fails the activation.
11. Goal Context resume mechanics: one synthetic user turn per
    resume.
12. Durable evidence restricted to descendants.
13. Re-entrant `activate_card` documented as the normal correction
    path.
14. Pause vs. force-cancel semantics clarified.
15. Planner tool authority policy aligned with executor's.
16. `AnalystIssue` unified across analyst tool and HTTP endpoint.
17. `GET /api/runtime/card-runs` returns a typed union with a
    server-computed breadcrumb.
18. Changelog wording softened.

## 19. Fifth-Round Review Fixes (Recap)

The fifth review found 21 design issues. They are addressed by the
clean-slate activation model and refined further by the sixth-,
seventh-, eighth-, and ninth-round fixes (§18, §17, §16, §15).
Highlights:

1. Parent planners no longer call planners; they activate cards
   through `activate_card`.
2. `start_planner` / `start_executor` removed.
3. Reviewer/planner interaction is inside the runtime-owned
   activation.
4. `needs_corrections` is no longer a parent-visible child outcome.
5. Single-active-planner invariant preserved without an explicit
   chain structure.
6. Planner parentage derived from the card tree.
7. `parent_session_id` / `parent_tool_call_id` removed from
   `AgentSession`.
8. Runtime caller edges live on `active_card_run` and
   `ProcessRecord`.
9. `active_planner_sessions` replaced by a single `active_card_run`
   plus derived ancestor walking.
10. `AwaitingReview` removed.
11. Reviewer session ids use preallocated assessment ids.
12. `max_review_retries` defaults to 3, per-card overridable.
13. Retry exhaustion returns `failed` to the parent; reviewer
    issues stay on the card.
14. Goal Context has a basic, explicit schema with `resume_reason`.
15. Durable evidence definition fixed.
16. Clean-slate boot discards old `.saivage/` state.
17. HTTP responses no longer expose `resumed_planner_session_id`.
18. Continuous improvement reserved as a deferred future stage
    (§17.10).
19. Tests rewritten around activations and internal reviewer
    retries.
20. Stale Tier-A/Tier-B and parent-only-resumption language
    removed.
21. Runtime and architecture docs aligned.

## 20. Validation

Run from `/home/salva/g/ml/saivage-v3`:

```bash
npm run docs:verify
```

When code changes implement the plan, also run:

```bash
npm run typecheck
npm run build
NODE_OPTIONS=--experimental-vm-modules npx jest --runInBand --forceExit
```
