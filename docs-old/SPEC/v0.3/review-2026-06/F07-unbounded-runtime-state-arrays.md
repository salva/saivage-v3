# F07: Runtime State Arrays Grow Without Bounds

**Severity:** MEDIUM  
**Transversality:** CROSS-CUTTING  
**Category:** Bad data representation  
**Verdict:** SOUND — confirmed at `src/runtime/state.ts`

## Summary

`RuntimeState` contains `runtime_commands`, `runtime_runs`, and `runtime_activations` arrays with no compaction or archival. `runtime_runs` does filter out the same `run_id` on `appendRuntimeRun`, but otherwise all three arrays grow indefinitely as the runtime state file is rewritten.

## Corrected Evidence

- `src/runtime/state.ts:83-100` — Default state initialization with empty arrays
- `src/runtime/state.ts:193-199` — `appendRuntimeCommand`: appends with no pruning
- `src/runtime/state.ts:210-217` — `appendRuntimeRun`: filters existing `run_id` but appends the new entry
- `src/runtime/state.ts:232-242` — `upsertRuntimeActivation`: deduplicates by `idempotency_key` but all entries stay in the array
- `src/runtime/state.ts:123-133,165-187` — Full state writes on every mutation

Overstatement corrected: `runtime_runs` is not a pure blind append — it deduplicates by `run_id`. The problem remains: there is no retention, archival, or bounded read model for historical data.

## Clean Architecture Approach

Move commands, runs, and activations to append-only event/ledger files with indexed current-state views. Keep runtime state as a compact current-state snapshot, not historical storage. Rebuild current-state views from event files on startup.