# Goal Planning Runtime


This page summarizes the current Saivage v3 runtime-control and ledger ownership model. It supersedes older queue/status-driven descriptions, but normative runtime/card/agent behavior lives in [Agents and runtime architecture](/agents).

## Ownership boundary

Saivage has two durable state planes:

- **Planner/card state** is owned by planners and `CardStore`: hierarchy, descriptions, dependencies, evidence, and card status fields such as `backlog`, `running`, `changed`, `done`, `failed`, `blocked`, and `cancelled`.
- **Runtime execution state** is owned by the runtime: `runtime_intent`, `runtime_commands`, `runtime_runs`, `runtime_activations`, active-card-run state, process records, and recovery metadata.

Planner/card state is not executable. Moving a card to `backlog`, `running`, `changed`, `done`, or another card status does not enqueue, wake, resume, or dispatch work. Session lifecycle states such as `AwaitingChild` belong to planner/card-runner execution, not to durable card status.

## Root project start and stop

Root execution starts only through an explicit runtime command:

1. the start-project runtime command, requested through the Analyst/control surface, records a `start_project` command.
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

From the parent planner's point of view, `activate_card` is a synchronous logical barrier: the parent is not scheduled again until exactly one terminal child outcome is delivered. The runtime may derive a running ancestor chain from the card hierarchy and activation ledger, but only the active leaf run is doing real work at any moment.

## Restart repair

Runtime startup reads the authoritative state file under `.saivage/tmp/state/runtime.json`. It preserves intent, commands, runs, activations, and active-card-run information so operators can see what was requested and what remains unresolved. Legacy state layout migration is bounded to file-layout repair; it does not revive old directive or status-driven execution semantics.

## Actionable errors

Card mutations, planner-state updates, runtime commands, and `activate_card` have no interactive confirmation gate: authz returns `allow` (commit) or `deny` (reject). Invalid requests return actionable error envelopes with a stable `code`, context/current state, and `nextAction`.

## UI model

The operator workspace projects runtime intent, command/run/activation ledgers, recovery signals, card hierarchy, planner metadata, dependencies, evidence, and discussion. User-visible mutations are mediated by the Analyst and canonical runtime/control services; card status edits and read-only workspace navigation are never execution triggers.

## Source grounding

Core implementation anchors: `src/runtime/actors/`, `src/application/xstate-runtime-api-factory.ts`, `src/runtime/state.ts`, `src/agents/planner-control-executor.ts`, the contract-backed operator route handlers under `src/server/routes/operator-*-handlers.ts`, and the web Dashboard runtime console / planning-tree components under `web/src`.
