# Goal Planning Runtime

<!-- doc-authority
status: current
disposition: keep
owner: docs-maintainers
superseded_by: none
last_verified_against: src/runtime/runtime.ts:1
-->

This page describes the current Saivage v3 runtime-control model. It supersedes older queue/status-driven descriptions.

## Ownership boundary

Saivage has two durable state planes:

- **Planner/card state** is owned by planners and `CardStore`: hierarchy, descriptions, dependencies, evidence, and planner-state/status fields.
- **Runtime execution state** is owned by the runtime: `runtime_intent`, `runtime_commands`, `runtime_runs`, `runtime_activations`, active-card-run state, process records, and recovery metadata.

Planner/card state is not executable. Moving a card to `active`, `backlog`, `done`, or another planner-state value does not enqueue, wake, resume, or dispatch work.

## Root project start and stop

Root execution starts only through an explicit runtime command:

1. the start-project runtime command, the Dashboard Runtime Console, or the equivalent runtime command API records a `start_project` command.
2. The runtime sets durable intent to `running`.
3. The runtime appends a root `runtime_runs` record for `project`.
4. Dispatch proceeds from that runtime-owned run.

Root execution stops only through `stop_project`, which records a stop command, sets intent to `stopped`, and terminally marks open root runs. Analyst prompts, directive files, notes, and card status changes are not root-start mechanisms.

## Child activation

Child work starts only from the active parent planner. The planner calls `activate_card` for a child card; the runtime validates:

- the parent card has a currently running planner `runtime_runs` entry;
- the tool call belongs to that parent session;
- the child exists and dependencies are complete.

On success, the runtime creates or returns a durable `runtime_activations` record and links it to a child `runtime_runs` record. Retries are idempotent while an activation is unresolved, so restart or model retry does not create duplicate orphan child runs.

## Restart repair

Runtime startup reads the authoritative state file under `.saivage/tmp/state/runtime.json`. It preserves intent, commands, runs, activations, and active-card-run information so operators can see what was requested and what remains unresolved. Legacy state layout migration is bounded to file-layout repair; it does not revive old directive or status-driven execution semantics.

## Confirmation and actionable errors

`confirmed` and `preview_hash` are used only by preview-style tool contracts such as analyst shell command confirmation. Card mutations, planner-state updates, runtime commands, and `activate_card` do not use preview hashes as mutation gates. Invalid requests return actionable error envelopes with a stable `code`, context/current state, and `nextAction`.

## UI model

Use the Dashboard **Runtime Console** for runtime intent, `start_project`, `stop_project`, command/run/activation ledgers, and recovery signals. Use the **Planning Tree** for card hierarchy, planner metadata, dependencies, evidence, and discussion. The Planning Tree intentionally does not offer status-as-run controls.

## Source grounding

Core implementation anchors: `src/runtime/runtime.ts`, `src/runtime/state.ts`, `src/agents/planner-control-executor.ts`, the contract-backed operator route handlers under `src/server/routes/operator-*-handlers.ts`, and the web Dashboard runtime console / planning-tree components under `web/src`.
