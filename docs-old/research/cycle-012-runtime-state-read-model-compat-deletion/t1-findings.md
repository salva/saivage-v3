# Wave 012 read-only findings

Date: 2026-05-27  
Task: `t1-readonly-scope-and-proposals`

## Executive summary

Wave 012 remains correctly scoped: the backend public runtime state and web UI still expose stale `queue`/`running_processes` compatibility fields even though runtime runs, activations, commands, and explicit process records now exist.

Key artifacts written:

- `architecture-audit/cycle-012-runtime-state-read-model-compat-deletion/scope-check.md`
- `architecture-audit/cycle-012-runtime-state-read-model-compat-deletion/proposals/proposal-direct.md`
- `architecture-audit/cycle-012-runtime-state-read-model-compat-deletion/proposals/proposal-restructure.md`

## Evidence highlights

- `src/schemas/types.ts:96` exports `RuntimeState` with `queue` and `running_processes` plus the newer runtime ledger fields.
- `src/schemas/validators.ts:110` requires both stale fields in `runtimeStateSchema`.
- `src/contracts/operator-api.ts:103-108` uses `runtimeStateSchema` for `/api/state`, so the fields are public.
- `web/src/stores/runtime.ts:67-70` computes queue/process compatibility values and marks queue as temporary compatibility.
- `web/src/views/DashboardView.vue:83-84` displays process count from the stale runtime-state field.
- `web/src/views/DebugView.vue:37` displays running process count from `debugRuntime.running_processes`.
- `src/server/routes/processes.ts:100-103` already provides an explicit `/api/processes` read model for process records.
- `tests/playwright/fixtures/operator-rest-fixtures.ts:15-21` and `tests/playwright/fixtures/operator-websocket-shim.ts:27-33` still fixture the compatibility fields.

## Recommendation

The direct proposal is the best fit for one wave: delete the fields from public contracts and web usage, preserve freeze manifest internals, and update tests/fixtures. The restructure proposal is cleaner if review decides public `RuntimeState` is too entangled with persistence, but it is broader.

## Caveats

- The working tree was already dirty before this task. Implementation must stage only scoped Wave 012 files.
- `rg` and `python` were unavailable; evidence collection used `grep` and `python3`. No code/source files were modified during scanning.
