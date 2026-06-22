# F13 — Design (r3)

Supersedes [02-design-r2.md](02-design-r2.md). Single proposal. Resolves design-review items 1–7 in [01-analysis-review-r2.md](01-analysis-review-r2.md) and the coordination items by adopting the F12 B.1 slim layout inside the F13 framework. Companion: [01-analysis-r3.md](01-analysis-r3.md), [03-plan-r3.md](03-plan-r3.md).

## Project guideline reminder

Architecture-first, no backward compatibility, no migration shims, no dead code, no over-engineering. **Comment/docstring discipline (new — resolves design-review item 7):** modules touched by F13 receive only the code changes required for the rewrite. No new docstrings, no explanatory comments, no `// TODO`s, and no "this used to do X" markers in existing files. New modules created by F13 (`src/cards/state.ts`, `src/cards/apply-mutation.ts`, `src/cards/commit-marker.ts`) get one short header comment naming the module's responsibility and no per-method docstrings; behaviour is documented by tests and identifier names. Reviewers reject PRs that add commentary to files this design does not require to be edited.

## Source of truth (binding)

- `cards/by-id/<id>.json` — only authoritative card-state file. Written via temp + rename inside the critical section.
- `cards/history/<id>.history.jsonl` — append-only audit ledger. Authoritative for audit only; never replayed to reconstruct current state.
- `cards/.commit/<token>.json` — durable commit markers (new on-disk directory). Carries the rename plan and the candidate history entry across a crash. Empty in steady state.

Deleted from the on-disk layout: `cards/index.json`, `cards/dependencies/depends-on.json`, `cards/dependencies/blocks.json`, `cards/tree/<id>.children.json`, the `cards/tree/` directory. **No projection writer, no derived file at rest.** Per analysis-review item 1 and the orchestrator decision, this is the same slim layout F12 r2 B.1 chose.

## Why slim (resolves design-review items 1 and 2)

The r2 Proposal C kept derived files on disk for dashboard/CLI/`git diff` ergonomics. Each of those concerns evaporates without the files:

- **Dashboard.** Reads through the in-memory `CardStore` API; never reads the derived files today (verified by grep over `web/src/`).
- **CLI dumps.** The `bin/saivage.js` CLI reads cards through `CardStore`; the only place that touches `cards/index.json` directly is `initProjectTree`, which is being rewritten.
- **`git diff` ergonomics.** Per-card history files already give per-card change visibility; reviewers comparing two project snapshots use `cards/by-id/*.json` and `cards/history/*.history.jsonl`. The aggregated `cards/index.json` adds no signal that the by-id diff does not already carry.

Removing the derived files eliminates four cost lines from the r2 Proposal C cost table:

| Removed concern | Why it disappears |
| --- | --- |
| Projection writer (`src/cards/projections-writer.ts`) | No file written, no module needed |
| Projection-write failure semantics (design-review item 6) | No write step that can fail |
| Stale-cache failure mode after marker unlink | No cache exists |
| Boot regeneration of every projection on every start | No projection on disk |
| Schemas for derived files (`cardIndexSchema`, `cardDependencyIndexSchema`, `cardBlocksIndexSchema`, `cardChildrenIndexSchema`) | Dead code, deleted |

The r2 cost table claim of "+350 / -550" stops being credible (design-review item 2). The r3 numbers, counted from the deletion inventory in [03-plan-r3.md](03-plan-r3.md):

| Bucket | Files | Net delta |
| --- | --- | --- |
| New modules | `src/cards/state.ts`, `src/cards/apply-mutation.ts`, `src/cards/commit-marker.ts` | +~600 LOC |
| New tests | `tests/utils/card-store-state.test.ts`, `tests/utils/apply-mutation.test.ts`, `tests/utils/card-store-crash-injection.test.ts`, `tests/utils/card-store-boot-recovery.test.ts` | +~700 LOC |
| Rewritten | `src/cards/card-store.ts` (~1100 LOC today → ~450 LOC), `src/persistence/file-tree.ts` (init/`isNewSaivageState` slimmed), `src/persistence/jsonl-ledger.ts` (+`appendSyncIdempotent`) | net ~−700 LOC |
| Deleted | `cardIndexSchema` + family, `defaultCardIndexEntry` + family, `CardHistoryProjection` + registration, `card_history_record_appended` event, `CardStoreHealth*` types/schemas/exports, `HierarchyGraph`, `reconcileCardHistory`, `parseChildrenIndex`, `recomputeBlocks`, `TRACKED_*` constants, `cards/index.json` + 3 derived files on disk | ~−500 LOC source + 4 on-disk files |

Net source delta ~+100 LOC, with the test suite gaining the crash-injection coverage that today's code completely lacks.

## On-disk write sequence

`applyMutation` is the sole entry point for `create` / `update` / `setStatus` / `mutateCard` / `delete` / `archiveAndDeleteSubtree` / `updateDependsOn`. For a single-card mutation on `<id>`:

1. Inside `await projectMutex.lock()` and `await projectLock.acquire()` (the single project-wide mutex; see §"Locking model"):
2. Compute `next: CardRecord` in memory from `state.cards.get(id)` and the patch. Compute `entry: CardHistoryEntry` with a fresh `entry_id = randomUUID()`, the new `version_seq`, the matching `kind`, and the full `changed_fields` diff.
3. Stage `cards/by-id/<id>.json.tmp.<token>` with the full new record (or, for `delete`, record the unlink path). `fsyncSync(tmpFd)`. `fsyncSync(dirfd(cards/by-id/))`.
4. Write `cards/.commit/<token>.json` containing:
   ```ts
   interface CommitMarker {
     token: string;                       // randomUUID, also used in the .tmp suffix
     kind: CardHistoryKind;
     by_id: { tmp_path: string; final_path: string } | { unlink_path: string };
     history: {
       entry_id: string;                  // == entry.entry_id
       entry: CardHistoryEntry;           // exact JSON line to append
       jsonl_path: string;                // cards/history/<id>.history.jsonl
     };
     group?: { group_token: string; index: number; total: number };  // multi-card only
   }
   ```
   `writeFileAtomic` (temp + `fsyncSync` + `renameSync` + `fsyncSync(dirfd(.commit/))`).
5. `renameSync(by-id/<id>.json.tmp.<token>, by-id/<id>.json)` — for delete, `unlinkSync(by-id/<id>.json)`. `fsyncSync(dirfd(cards/by-id/))`.
6. `JsonlLedger.appendSyncIdempotent(history_jsonl_path, entry)` — re-reads the last line of the file; if its `entry_id` matches, skip. Otherwise append and `fsync`. See §"JSONL crash semantics" for partial-line behaviour.
7. `unlinkSync(cards/.commit/<token>.json)`. `fsyncSync(dirfd(.commit/))`.
8. Update in-memory `state` (cards map, adjacency caches). Emit `card_history_appended` on `eventBus` exactly once.
9. Release project lock + mutex.

For multi-card mutations (`archiveAndDeleteSubtree`), see §"Multi-card mutation atomicity".

## Boot recovery (`CardStore.open`)

1. Scan `cards/.commit/`. For each marker file `<token>.json`:
   - Parse the marker; if parse fails, log fatal and refuse boot (no silent discard — analysis-review item 7 from r1 and the project guideline).
   - If `marker.by_id` is a rename plan: if the `tmp_path` exists, `renameSync` to `final_path`. If neither exists and `final_path` does, no-op (already renamed pre-crash). `fsyncSync(dirfd(by-id/))`.
   - If `marker.by_id` is an unlink plan: if `unlink_path` exists, `unlinkSync`. If absent, no-op.
   - Read the last well-formed line of `marker.history.jsonl_path` (see §"JSONL crash semantics"). If its `entry_id` matches `marker.history.entry_id`, skip the append (idempotent). Otherwise `appendSyncIdempotent(marker.history.entry)`.
   - `unlinkSync` the marker. `fsyncSync(dirfd(.commit/))`.
2. Load every `cards/by-id/*.json` into `state.cards` via `cardRecordSchema.parse`.
3. Recompute adjacency (parent index, depends-on adjacency, blocks-inverse adjacency, children-by-parent) in memory.
4. Run the structural validators carried over from `HierarchyGraph.build`: depth ≤ `maxGoalDepth`, exactly one `project` root, parents resolve, no cycles in the parent chain, no terminal children, depends-on closure resolves. **No** index↔by-id equality check (there is no index file).
5. Startup invariant check: for each card, read the last line of `cards/history/<id>.history.jsonl` if the file exists; assert `last.version_seq <= card.version_seq`. If `last.version_seq > card.version_seq`, the orphan is unrecoverable (the marker that would have applied it is absent, so this is committed audit corruption); throw `CardStoreInvariantError` naming the card id, the orphan `version_seq`, the file path, and the recovery instruction (`saivage reset` or hand-edit the history file).

The recovery sequence is idempotent: replaying the same marker set twice produces the same on-disk state.

## Locking model (resolves design-review item 5 and analysis-review-r2 design item 2)

**Single project-wide mutex + single project-wide cross-process lock for ALL card mutations.** Not per-card.

Rationale (binding, addresses the F12 r2 review's "per-card locks unsafe for cross-card state" finding):

- `archiveAndDeleteSubtree` mutates many card records in one logical operation. Per-card locks would require lock-ordering protocols to avoid deadlock and would not actually atomically remove the subtree from the in-memory adjacency.
- A dependency mutation on card A changes the inverse-blocks adjacency for every card in A's old and new `depends_on`. With per-card locks, two concurrent mutations of A and B can each compute neighbour blocks-state from a stale snapshot of the other; the resulting `card.blocks` arrays drift from the actual adjacency until the next full reload.
- The in-memory `CardStoreState` is a single shared structure. Mutating it concurrently from two `applyMutation` calls under different per-card locks requires a separate mutex on the state map anyway — at which point the project-wide mutex is the simpler primitive.

The mutex is in-process (`async-mutex` or a hand-rolled `Promise`-chain — see plan); the cross-process lock is the existing `ProjectLock` on `.saivage/runtime/project.lock` ([src/persistence/project-lock.ts](../../../src/persistence/project-lock.ts#L60)). `JsonlLedger.appendSyncIdempotent` does not re-acquire the project lock (the caller holds it). Throughput: single-card mutations are sub-millisecond after the in-memory adjacency rebuild moves to incremental (touched-card-only) updates; project-wide serialization is acceptable for a single-operator runtime.

## History idempotence model (resolves design-review item 3)

Idempotence is anchored on the schema-level `entry_id` field added to `CardHistoryEntry` (see [01-analysis-r3.md](01-analysis-r3.md) §"Schema-level consequences"):

```ts
appendSyncIdempotent(jsonlPath: string, entry: CardHistoryEntry): void {
  // read last well-formed line; if last.entry_id === entry.entry_id, return; else append+fsync
}
```

The marker carries `entry.entry_id` so recovery can probe the on-disk last line without trusting any other artifact. Two recoveries of the same marker append at most once. A crash between step 6 (append) and step 7 (marker unlink) leaves the marker present and the line written; the next boot reads the last line, matches `entry_id`, skips the append, unlinks the marker — exactly-once delivery on disk.

The design does not depend on a "separate durable marker field that can be checked without changing the history line" (the alternative the reviewer mentioned), because that alternative would require yet another on-disk artifact and a separate fsync per mutation while still needing schema-level identification of which entry the marker refers to.

## JSONL crash semantics (resolves design-review item 4)

The existing `JsonlLedger` quarantines malformed lines on **read** ([src/persistence/jsonl-ledger.ts](../../../src/persistence/jsonl-ledger.ts#L70)) but never truncates a partial last line before a new append. F13 defines the contract `appendSyncIdempotent` must honour:

1. **Read the last 4 KB of the file (or the whole file if smaller).** Find the last `\n`.
2. **If the file ends with `\n`** (the well-formed case), parse the substring between the previous `\n` and the trailing `\n`. If parse succeeds and `parsed.entry_id === entry.entry_id`, return (already appended). Otherwise append.
3. **If the file does NOT end with `\n`** (partial-line case), the last line was written by a process that died mid-write. Behaviour:
   - The partial bytes are **moved to a sidecar** `<jsonlPath>.partial.<ts>` via `renameSync` is not possible on a suffix; instead read the file up to the last `\n`, `writeFileAtomic` it back (truncating the partial tail), and append the partial bytes to `<jsonlPath>.partial.<ts>` for forensic recovery. `fsyncSync` both files.
   - Then proceed with step 2 on the now-well-formed file.
4. **If the file cannot be parsed even up to the last `\n`** (corruption deeper than the last line), throw `CardStoreInvariantError` with the byte offset of the first parse failure; do not append; do not silently rewrite. Operator action required.

This is the truncate-quarantine contract the r2 design left undefined. It is exercised by the crash-injection matrix in [03-plan-r3.md](03-plan-r3.md) §"Crash-injection test matrix" ("partial JSONL append").

## Multi-card mutation atomicity (resolves design-review item 5)

`archiveAndDeleteSubtree(rootId)` writes one **group commit marker** that lists the full ordered plan, plus per-card markers consumed in sequence:

- Compute the descendants-first deletion order in memory: post-order traversal of the parent tree rooted at `rootId`. Each card is unlinked **after** its children. This order preserves the parent-resolves invariant at every prefix — at no point can a descendant exist whose parent has already been unlinked.
- Allocate `group_token = randomUUID()`. Write `cards/.commit/group-<group_token>.json` containing the ordered list of per-card markers (just the `token` + `by_id` + `history` fields, no nested marker files yet).
- For each card in order, execute steps 3–7 of the single-card sequence with `marker.group = { group_token, index, total }`. The per-card marker is written, the by-id is unlinked, history is appended, the per-card marker is unlinked.
- After the last per-card marker is unlinked, unlink the group marker.

Boot recovery:

- If a group marker exists, scan it. For each per-card entry, check whether the by-id record still exists and whether the history entry was appended; resume from the next un-executed step. The descendants-first order guarantees that every prefix is a structurally valid subtree archive (the parent chain remains valid).
- If recovery completes the full plan, unlink the group marker. If the structural validator throws after recovery (e.g. one card in the middle was hand-edited between crash and recovery to point at a nonexistent parent), the boot fails loudly per the standard `CardStoreInvariantError` contract — no silent partial archive.

This replaces the r2 design's incorrect claim that per-card markers alone produce "consistent partial subtree archive". They do not unless descendants-first order is provably preserved at every prefix; with the group marker, the contract is explicit.

## Live projection-write failure semantics (resolves design-review item 6)

**N/A.** No derived projection files are written by `applyMutation`. There is no "after marker unlink, before projection regeneration finishes" window. The dashboard reads in-memory state through `CardStore`; in-memory state is updated atomically with the on-disk by-id record under the project mutex. Any failure inside `applyMutation` before in-memory state is updated leaves both disk and in-memory consistent (the marker recovery brings disk forward on next open; in-memory state is rebuilt from disk on `CardStore.open`). Any failure after in-memory state is updated is impossible by construction (no I/O happens after the in-memory update).

## Read model

All public `CardStore` reads (`read`, `list`, `listChildren`, `descendantsOf`, `getAncestors`, `getBlocks`, `getDependsOn`, `getDescendantIds`, `validateTransition`, `detectCycles`, `getCardAt`, `diffCard`) read from `CardStoreState` in memory. The only read that touches disk is `listCardHistory(id)`, which reads `cards/history/<id>.history.jsonl` through the ledger reader (filtering for `entry_id` uniqueness if a corrupt prefix exists, per the JSONL crash semantics above).

No route handler, agent tool, planner tool, or runtime call site reads `cards/index.json` / `cards/dependencies/*.json` / `cards/tree/*.json` — those files are deleted and the codepaths that touched them are removed (full grep targets in [03-plan-r3.md](03-plan-r3.md) §"Dead-code inventory").

## Event ownership

- `card_history_appended` ([src/events/registry.ts](../../../src/events/registry.ts#L58)) is emitted by `CardStore` exactly once per `applyMutation`, after step 8. The websocket broadcast envelope ([src/contracts/operator-events.ts](../../../src/contracts/operator-events.ts#L110), [src/server/websocket.ts](../../../src/server/websocket.ts#L303)) is unchanged.
- `card_history_record_appended` ([src/events/registry.ts](../../../src/events/registry.ts#L65)) and the `CardHistoryProjection` ([src/projections/ledger-projections.ts](../../../src/projections/ledger-projections.ts#L105)) that consumed it are deleted. The projection was a same-process synchronous step that wrote the same JSONL the store now writes directly inside `applyMutation`; the indirection bought nothing.

`CardStore` keeps its constructor `eventBus` parameter (used to emit `card_history_appended`). This is the F13 stance and it is consistent because event ownership is single (the store) and the broadcast contract is preserved.

## Crash-semantics table (revised)

| Crash point | On-disk state | Recovery on next `CardStore.open` |
| --- | --- | --- |
| Before step 3 (no tmp, no marker) | unchanged | nothing to do |
| Step 3 done, before step 4 (tmp exists, no marker) | orphan tmp visible | `CardStore.open` scans `cards/by-id/` for `.tmp.*` siblings and unlinks them after marker scan; tmp without marker = pre-commit residue |
| Step 4 done, before step 5 (marker + tmp) | marker present, tmp present | marker recovery: `renameSync(tmp → final)`, append history if `entry_id` not already last, unlink marker |
| Step 5 done, before step 6 (marker + new by-id, no history line) | marker present, by-id renamed | marker recovery: by-id rename is no-op (final exists, tmp gone), append history, unlink marker |
| Step 6 done, before step 7 (marker + new by-id + history line) | marker + by-id + history line all present | marker recovery: by-id rename no-op, history append no-op (entry_id matches last line), unlink marker |
| Step 7 done, before step 8 (no marker, by-id + history line) | committed | nothing to do |
| Mid step 6 (partial JSONL line) | marker + by-id + truncated history tail | partial-line contract truncates the tail to a sidecar, then `appendSyncIdempotent` writes the line; marker unlinked |
| Multi-card archive crash after `k` of `N` cards | group marker + remaining per-card markers + first `k` cards unlinked | recovery resumes from card `k+1`; descendants-first order preserved every prefix |
| Marker file corruption (parse failure) | marker unparseable | fatal `CardStoreInvariantError` with marker path; no silent discard |
| Orphan tmp without marker | tmp visible, no marker | tmp unlinked after marker scan |
| Out-of-band rewrite of `cards/by-id/<id>.json` | new content on disk | honored on next `CardStore.open`; no cross-file invariant to violate |
| Out-of-band rewrite of `cards/history/<id>.history.jsonl` truncating committed entries | last line's `version_seq` < `card.version_seq` | accepted (audit gap, no current-state damage). Last line's `version_seq` > `card.version_seq` triggers `CardStoreInvariantError`. |

## Risk

Medium. Surface area is large because every mutation routes through one new primitive, but:

- The on-disk format of `cards/by-id/*.json` is byte-identical to today.
- The on-disk format of `cards/history/*.history.jsonl` adds two required fields (`entry_id`, `kind`) — no reader of pre-F13 files exists in post-F13 code (no compat shim).
- The deleted files (`cards/index.json` and friends) were derived; nothing in `src/` consumes them after the deletion pass.
- The new commit-marker dir is empty in steady state; operators see only `.commit/` in `ls .saivage/cards/` and no file in it.

Dominant operational risk is the async fan-out from making `CardStore.open` async (handled by `Runtime.open` / `ActiveRuntime.open` / awaited server wiring — see [03-plan-r3.md](03-plan-r3.md) §"Async construction chain"). The dominant test risk is fixtures that hand-write `cards/index.json` or build `CardHistoryEntry` objects without `entry_id` / `kind`; all such fixtures are listed in the plan's deletion inventory.
