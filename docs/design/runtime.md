# Runtime


> **Authority status: stale.** This page is retained only as a pointer and limited provenance note. Do not use it for current runtime-control, operator, or implementation guidance.
>
> Current authority lives in:
>
> - [`docs/goal-planning-runtime.md`](../goal-planning-runtime.md) for explicit root runtime commands, runtime/planner state ownership, activation ledgers, restart repair, confirmation scope, and UI separation.
> - [`docs/operation.md`](../operation.md) for operator REST controls, runtime state snapshots, Runtime Console use, and live observational WebSocket runtime ledger events.
> - [`docs/agents.md`](../agents.md) for current agent lifecycles and planner-owned `activate_card` behavior.
> - [`docs/v3-planner-control-mcp-contract.md`](../v3-planner-control-mcp-contract.md) for planner-control tool contracts and actionable `activate_card` errors.

## Current runtime-control model

This design page no longer describes current Saivage runtime behavior. The current model is intentionally runtime-command and activation-ledger driven:

- Root project execution starts through explicit runtime controls such as `POST /api/runtime/start_project` and stops through `POST /api/runtime/stop_project`.
- Child work starts only when an active parent planner calls `activate_card` and the runtime records/links the activation and child run.
- Planner/card state is not an executable trigger. Changing a card status or planner-state field does not enqueue, wake, resume, start, stop, or activate work.
- Directive files, ready-card queues, legacy startup rituals, `lets_dance`, and preview-confirmation fields are not runtime start/stop/activation mechanisms.
- WebSocket runtime ledger events are live observations of persisted runtime command/run/activation/actionable-error records; REST command responses and `GET /api/state` remain authoritative operator snapshots.

For implementation and operations, follow the current authority documents listed above instead of reconstructing behavior from this stale page.

## Historical context retained from the old page

Earlier drafts of Saivage runtime design mixed several responsibilities that have since been separated:

- root kickoff was discussed alongside analyst prompt rituals and directive handoffs;
- card status and dependency readiness were described near dispatch selection;
- startup recovery text blended runtime-state repair with work discovery;
- confirmation prose was broad enough to be confused with card/runtime mutation gates; and
- UI/status-board guidance did not clearly separate planning views from runtime controls.

Those couplings are historical context only. They explain why the current docs emphasize explicit `start_project` / `stop_project`, parent-planner `activate_card`, planner-owned card state, runtime-owned execution ledgers, bounded restart repair, and a Runtime Console distinct from the Planning Tree.

## What this page intentionally omits

This page intentionally does not restate the old startup sequence, runtime loop, dispatch rules, ready-card selection, directive consumption, preview-hash confirmation flow, runtime-state schema, event-bus tables, model-router behavior, process registry, stash behavior, or stuck-agent details. Any still-relevant portions of those topics must be read from current docs and source anchors, not from this stale page.
