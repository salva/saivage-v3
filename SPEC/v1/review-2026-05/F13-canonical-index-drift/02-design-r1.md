# F13 — Design Proposals (r1)

Both proposals address the multi-file-mutation invariant drift between [src/cards/card-store.ts](../../../src/cards/card-store.ts) `mutateCard` step 2 (by-id write) and step 3 (index write). Proposal A is a focused atomicity fix; Proposal B is one level up — event sourcing.

## Proposal A — Single in-process critical section + group-fsync, no schema change

### Idea

Wrap the entire by-id/index/depends-on/blocks/history write sequence of `mutateCard`, `update`, `create`, `delete`, `archiveAndDeleteSubtree` in:

1. An **in-process `Mutex`** held for the full mutation body. Removes the latent reentrancy / async-handler race ([F13 analysis §Race windows](01-analysis-r1.md)).
2. A **two-phase commit on disk** for the file pair that must agree (by-id record + index entry):
   - Phase write: write `.saivage/cards/by-id/<id>.json.tmp.<token>` and `.saivage/cards/index.json.tmp.<token>` (full new contents for index).
   - `fsyncSync` both temp files.
   - Write a **commit marker** `.saivage/cards/.commit/<token>.json` containing `{ targets: [<by-id-path>, <index-path>], history_entry: <full-entry> }`, fsync it, then rename it into place atomically.
   - Rename each `.tmp.<token>` → final path, fsync the parent directory.
   - Append the history entry via `JsonlLedger.appendSync` (already locked + fsynced inside `JsonlLedger`).
   - Unlink the commit marker.
3. On boot, `validatePersistedState` scans `.saivage/cards/.commit/`. For each leftover marker: if all targets exist as `.tmp.<token>`, complete the rename; if marker exists without temps, treat as no-op (post-rename crash) and unlink. Then run the existing `HierarchyGraph.build` validator.

### Correctness

- Crash before commit-marker rename: temps + (maybe) partial work → boot scans `.commit/`, sees nothing committed, deletes orphan temps. State equals pre-mutation.
- Crash after commit-marker rename, before any final rename: boot replays the rename plan from the marker, then deletes it. State equals post-mutation.
- Crash after some renames: same replay path completes the remaining renames idempotently.
- Concurrent single-process callers: the in-process `Mutex` linearises them; the `ProjectLock` in `JsonlLedger.appendSync` already serialises history.
- Future multi-process: the on-disk commit marker handles a second process the same way it handles a crash, *provided* both processes also acquire the same `ProjectLock` around the mutation body. That lock is currently only acquired inside the projection — extend `mutateCard`/`update`/`create`/`delete` to hold it for the whole body.

### Data-model changes

- Add `.saivage/cards/.commit/` directory (created on demand). No card schema change. No on-disk file format change.

### API impact

- None on the operator HTTP API.
- Internal: `CardStore` constructor optionally takes a `ProjectLock` (defaults to `runtime/project.lock`).

### Test impact

- New tests: simulated crashes via injected aborts between phase-write, marker-rename, target-renames, ledger-append. Cover the four crash points above plus the boot recovery path.
- Existing tests under `tests/cards/`: anything that asserts on the exact set of files written, the exact write order, or that no `.tmp.*` files exist mid-test must accept the additional `.commit/` directory.
- F12 fix that also lives on `update`/`setStatus` must be folded into the same critical section (otherwise atomic guarantees apply to `mutateCard` only and `update` keeps drifting).

### Code that becomes unnecessary

- `CardStore.reconcileCardHistory` ([src/cards/card-store.ts](../../../src/cards/card-store.ts) line 552) can be deleted: history is committed atomically with the by-id bump; orphan trailing entries cannot exist.
- The "self-heal on next mutation" implicit reliance on `rebuildGraphStrict` setting `canonicalHealth='ok'`: the flag now means what its name suggests.

## Proposal B — Event-sourced card store; `events.jsonl` is the only source of truth

### Idea

`.saivage/cards/events.jsonl` becomes the sole writeable artefact. Every mutation appends exactly one event:

```
{ "seq": <monotonic>, "ts": <iso>, "actor": ..., "surface": ..., "reason": ...,
  "kind": "card_created" | "card_updated" | "card_deleted" | "card_archived",
  "card_id": <id>, "version_seq": <n>, "snapshot": <full CardRecord> }
```

On boot the store reads the log front-to-back and reconstructs three in-memory structures:

- `Map<string, CardRecord>` (the by-id state)
- `CardIndex` (the index)
- `dependsOn` / `blocks` maps

After replay, the store regenerates the on-disk projections (`cards/by-id/*.json`, `cards/index.json`, `cards/dependencies/{depends-on,blocks}.json`, `cards/history/<id>.history.jsonl`) from the in-memory state. These files are **derived** and exist only so external tools (the operator UI, CLI dumps, `git diff` reviews) can read them without parsing JSONL. They are never authoritative.

Each subsequent mutation:

1. Compute the new `CardRecord` in memory.
2. `JsonlLedger.appendSync` the event to `events.jsonl` (fsynced, locked — already the only durable contract).
3. Best-effort rewrite of the affected projection files (`by-id/<id>.json`, `index.json`, per-card history). If any of these crashes mid-write, boot replay rebuilds them.

The "canonical invariant validator" collapses to: replay log, build in-memory state, then optionally diff the in-memory state against the on-disk projections; any drift simply triggers projection regeneration. There is no "the two files disagree" failure mode — there is only one file.

### Correctness

- Crash anywhere: on boot, log is the truth. Projections are rebuilt unconditionally on first read after a startup that detects partial-write markers (last log line incomplete) — `JsonlLedger.appendSync` already pre-validates and `JsonlLedger` reads tolerate trailing whitespace, but we should treat a half-written last line as "event did not happen" and truncate it.
- Concurrent single-process callers: serialised by `ProjectLock` around `appendSync`, exactly like every other ledger.
- Future multi-process: the existing `ProjectLock` provides cross-process mutual exclusion for the append; readers can tail the log without coordination.
- Reentrant subscribers can no longer corrupt anything because there is only one mutation primitive (append), not three.

### Data-model changes

- New file: `.saivage/cards/events.jsonl` with a schema in `src/schemas/index.ts` (`cardEventSchema`). Event payload reuses `cardRecordSchema` as `snapshot`.
- Existing files `.saivage/cards/index.json`, `.saivage/cards/by-id/*.json`, `.saivage/cards/dependencies/{depends-on,blocks}.json`, `.saivage/cards/history/*.history.jsonl` continue to exist but are downgraded to **derived projections** rebuilt from the log on boot. They are still committed-to-git friendly for review.
- `version_seq` and `created_at`/`updated_at` move from "fields the store sets" to "fields determined by the position of events in the log". The `seq` field on each event is the global monotonic counter; per-card `version_seq` is `count(events for this card_id)`.

### API impact

- None on the operator HTTP API.
- Internal `CardStore` surface unchanged: `create / read / update / mutateCard / delete / setStatus / list / listCardHistory / getCardAt / diffCard / archiveAndDeleteSubtree / recomputeBlocks / detectCycles / validateTransition / getDescendantIds / …`. All methods are rewritten on top of the in-memory state and append a single event when they mutate. `update` and `setStatus` start emitting events too — F12 dissolves.

### Test impact

- New tests: log replay, projection rebuild idempotence, truncated-last-line recovery, monotonic `seq`, per-card `version_seq` derivation.
- Tests that become unnecessary (subject to grep in `tests/`): anything asserting that `cards/index.json` and `cards/by-id/<id>.json` are written in a particular order; anything asserting on `reconcileCardHistory` warning messages; anything that depends on `canonicalHealth='invalid'` ever being observable.
- Tests that become wrong: any test that writes directly to `cards/index.json` or `cards/by-id/*.json` as fixtures and expects the store to honour them. Fixture-loading must move to writing event log entries.
- F12 acceptance test (history-on-update) is satisfied by construction.

### Code that becomes unnecessary (Proposal B — explicit removal list)

In [src/cards/card-store.ts](../../../src/cards/card-store.ts):

- Function `validatePersistedState` (line 320) — replaced by `replayEventLog`.
- Function `rebuildGraphStrict` (line 440) — replaced by `regenerateProjectionsFromState`.
- Field `validatedPersistedState` and method `ensurePersistedStateValidated` — boot always replays.
- Field `canonicalHealth`, type `CardStoreCanonicalHealth`, `CardStoreHealth.canonical`, method `getHealth` — the "invariant failed" failure mode no longer exists; if a health probe is still wanted, it becomes "log-replay-succeeded boolean".
- Function `loadCanonicalCardsFromDisk` (line 432).
- Function `reconcileCardHistory` (line 552) — log is authoritative; nothing to reconcile.
- Function `addToIndex` / `removeFromIndex` (lines 487, 500) — index is derived, never partially mutated.
- Function `writeCard` (line 484) — by-id is rewritten in full by the projection rebuilder.
- The "Canonical hierarchy invariant failed" throws inside `HierarchyGraph.build` covering index↔by-id agreement (lines 73-94). The parent/depth/cycle/terminal/max-depth checks stay; the agreement check is removed.
- Branch in `validatePersistedState` rejecting legacy records without `version_seq` (lines 333-340): legacy on-disk JSON is no longer read, so the rejection collapses into "fail to find an event log, refuse to start, ask operator to reset" — already covered by the new replay error path.
- `appendHistoryEntry` (line 543) and the `card_history_record_appended` event kind: history is the event log itself. The per-card `history/*.history.jsonl` projection is rebuilt from the log.

In [src/projections/ledger-projections.ts](../../../src/projections/ledger-projections.ts):

- Class `CardHistoryProjection` (line 105) and `registerCardHistoryProjection` (line 166), plus the `card_history_record_appended` event kind in [src/events/index.ts](../../../src/events/index.ts). The projection is now an internal concern of the store.

In [src/cards/index.ts](../../../src/cards/index.ts):

- Type re-exports `CardStoreCanonicalHealth`, `CardStoreHealth` (delete with their declarations).

In [src/persistence/file-tree.ts](../../../src/persistence/file-tree.ts):

- The `initProjectTree` calls that write `cards/index.json`, `cards/by-id/project.json`, `cards/dependencies/{depends-on,blocks}.json` (lines 148-152) become "write the initial event into `cards/events.jsonl`". The projection rebuilder produces the same on-disk files on first boot.

Operator API code stays untouched — it reads `CardStore` methods.

## Recommendation

**Proposal B.**

Project guideline: *architecture-first, no backward compatibility, actively remove code supporting old structures*. Proposal A patches the symptom and leaves the dual-file invariant intact; the validator, the self-heal flag, the `reconcileCardHistory` heuristic, and the F12 history-on-`update` bug all survive as separate concerns. Proposal B collapses the invariant out of existence: there is only one writer, one file, one append. The very class of bugs F12 + F13 represent — "two pieces of state drifted because nothing made them move together" — cannot recur because there is no second piece of state.

Proposal A's cost (commit-marker dance, boot scan, in-process Mutex) is roughly the same engineering effort as Proposal B (event schema, replay, projection rebuilder), and Proposal A leaves us owning a more complicated invariant validator forever. Proposal B *deletes* `validatePersistedState`, `rebuildGraphStrict`, `reconcileCardHistory`, `canonicalHealth`, and a chunk of `HierarchyGraph.build` — net negative line count, simpler mental model.

F12 is subsumed: once `update` and `setStatus` route through the event log, history is automatic.

The single significant risk is operator-tool compatibility (anyone editing `cards/index.json` by hand). Per the no-backward-compat guideline this is acceptable; the projections are still emitted, and any human edit is now a no-op overwritten on the next mutation. The operator playbook gains one rule: "edit through the API or the CLI, not the JSON files directly."
