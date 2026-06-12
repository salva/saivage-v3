# F13 — Design (r5)

Supersedes [02-design-r4.md](02-design-r4.md). Resolves design-review items 1–2 in [01-analysis-review-r4.md](01-analysis-review-r4.md). Companion: [01-analysis-r5.md](01-analysis-r5.md), [03-plan-r5.md](03-plan-r5.md).

## Project-guideline reminder

Architecture-first, no backward compatibility, no migration shims, no new docstrings/comments in untouched code, no dead code. New modules (`src/cards/state.ts`, `src/cards/apply-mutation.ts`, `src/cards/commit-marker.ts`, `src/cards/project-mutex.ts`) get one short header line and no per-method docstrings; behaviour is documented by tests and identifier names.

## Source of truth (binding)

- `cards/by-id/<id>.json` — only authoritative card-state file. Atomic temp + rename inside the critical section.
- `cards/history/<id>.history.jsonl` — append-only audit ledger. Authoritative for audit only; never replayed to reconstruct current state. Per-card history file is preserved across `delete` / `archive` (the deleted card's history remains queryable; see [01-analysis-r5.md](01-analysis-r5.md) §"CardHistoryEntry semantics table"). Absent / empty for a card with `card.version_seq === 1` (post-create baseline, no public history row yet).
- `cards/.commit/<token>.json` — durable commit markers. Empty in steady state. `create`-kind mutations also write a marker (to make the by-id rename crash-safe) but the marker's `history` field is `null` so recovery never appends a public history row for `create`.

Deleted from the on-disk layout: `cards/index.json`, `cards/dependencies/`, `cards/tree/`, `cards/views/`. Rationale for `cards/views/`: grep across `src/`, `tests/`, `web/` (see [01-analysis-r5.md](01-analysis-r5.md) §"Source-of-truth decision") shows zero readers/writers other than the `SAIVAGE_DIRS` declaration and the file-tree test expectation, so the directory is dead.

## On-disk write sequence (resolves r3 design-review item 1; carried forward)

`applyMutation` is the sole entry point for `create` / `update` / `setStatus` / `mutateCard` / `delete` / `archiveAndDeleteSubtree` / `updateDependsOn`. For a single-card mutation on `<id>`:

1. Acquire **both** locks in the order specified by §"Locking model".
2. Compute `next: CardRecord` in memory from `state.cards.get(id)` and the patch. For every kind **except `create`**, compute the durable history row from the pre-mutation card: `entry: CardHistoryEntry` with `entry_id = randomUUID()`, `kind` per the call site, `version_seq = current.version_seq` (i.e. the *pre-mutation* sequence; after the rename in step 5 the by-id record carries `version_seq = current.version_seq + 1`, so the invariant `max(history[].version_seq) === card.version_seq - 1` holds by construction), `snapshot = current` (the full pre-mutation `CardRecord`), and the full `changed_fields` diff of `next` vs. `current`. For `create`, **no history row is computed and none is written**; the marker's `history` field is `null` and step 6 is skipped.
3. Stage `cards/by-id/<id>.json.tmp.<token>` with the full new record (or record the unlink path for `delete`). `fsyncSync(tmpFd)`; `fsyncSync(dirfd(cards/by-id/))`.
4. Write `cards/.commit/<token>.json` containing the marker (rename plan, optional history entry, optional group fields). `writeFileAtomic` (temp + fsync + `renameSync` + `fsyncSync(dirfd(.commit/))`).
5. `renameSync(by-id/<id>.json.tmp.<token>, by-id/<id>.json)` — for delete, `unlinkSync(by-id/<id>.json)`. `fsyncSync(dirfd(cards/by-id/))`.
6. If `marker.history !== null`: `JsonlLedger.appendSyncIdempotent(cards/history/<id>.history.jsonl, entry)` — re-read the last line of the file; if `last.entry_id === entry.entry_id`, skip; otherwise append + `fsync`. For `create`, this step is skipped because `marker.history === null`.
7. `unlinkSync(cards/.commit/<token>.json)`. `fsyncSync(dirfd(.commit/))`.
8. Update in-memory `state` (cards map, adjacency caches). **Capture** the `card_history_appended` payload locally (only when `marker.history !== null`; `create` captures no payload and emits no event).
9. Release the locks in the order specified by §"Locking model".
10. After both locks are released, if a payload was captured, `eventBus.emit('card_history_appended', capturedPayload)`. See §"Event emission outside the lock".

For multi-card mutations (`archiveAndDeleteSubtree`), see §"Multi-card mutation atomicity".

## Locking model (resolves r4 review design item 1; rewritten for the real API)

The existing cross-process `ProjectLock` API ([src/persistence/project-lock.ts#L28](../../../src/persistence/project-lock.ts#L28)) exposes only `new ProjectLock(lockPath, options?)`, `withLockSync<T>(fn)`, `withLock<T>(fn)`, and `assertOwns(handle)`. There is no `create` / `acquire` / `release` shape. F13 composes against the real API; no new public methods are added to `ProjectLock`.

**Outer lock:** in-process `ProjectMutex.lock()` (new primitive in [03-plan-r5.md](03-plan-r5.md) §"Mutex implementation"). Returns a `release: () => void` callback; the caller must invoke it from a `finally` block.

**Inner lock:** cross-process `projectLock.withLock(async (handle) => { ... })`. `withLock` already wraps acquire/release in a try/finally, so the cross-process file lock is released automatically when the inner async body returns or throws. The `handle: LockHandle` is passed down to persistence calls that need `projectLock.assertOwns(handle)` checks.

**Why the in-process mutex is outer and the project lock is inner.** Two reasons:

1. `ProjectLock.withLock` is already internally queued (see [src/persistence/project-lock.ts#L64-L107](../../../src/persistence/project-lock.ts#L64)), so wrapping it in the in-process mutex would not regress its concurrency guarantees. Wrapping it the other way around (`withLock` outer, mutex inner) would force every same-process caller through the cross-process `openSync('wx')` retry loop, multiplying syscalls for no correctness gain.
2. Releasing the in-process mutex first (i.e. making it the inner lock) would let another same-process mutation enter the critical section while the first process still owns the cross-process file lock; that second caller would then immediately block on `openSync('wx')` until the first call returns from `withLock`, but it would already hold the in-process mutex, blocking any third caller in the same process from making progress even though the first caller has already returned. Making the mutex the outer lock keeps the in-process queue strictly serial with respect to the same-process critical section.

Pseudo-code (canonical form for `applyMutation`):

```ts
const release = await projectMutex.lock();
let capturedPayload: CardHistoryAppendedPayload | null = null;
try {
  await projectLock.withLock(async (handle) => {
    // steps 2–8 of §"On-disk write sequence" run here.
    // persistence calls that need ownership pass `handle`; e.g. assertOwns(handle).
    // step 8 sets `capturedPayload` (or leaves it null for `create`).
  });
  // inner lock is released by withLock's own try/finally before we get here.
} finally {
  release(); // outer in-process mutex always released last, even on throw.
}
// step 10: emit event after BOTH locks are released, using the captured payload.
if (capturedPayload !== null) {
  eventBus.emit('card_history_appended', capturedPayload);
}
```

The release order is therefore: **(a)** `withLock` releases the cross-process file lock when its callback returns/throws; **(b)** the outer `finally` releases the in-process mutex; **(c)** the event emission happens AFTER both releases, using the locally-captured payload. A subscriber that calls back into `cardStore.update(...)` re-enters `applyMutation` cleanly: it acquires the mutex (free), runs, releases, and returns — no deadlock, no re-entrancy violation.

No `async-mutex` dependency is added; the in-process mutex is a ≈ 10-LOC promise-chain primitive ([03-plan-r5.md](03-plan-r5.md) §"Mutex implementation"). `JsonlLedger.appendSyncIdempotent` does not re-acquire the project lock; the caller holds it via `handle` for the duration of the `withLock` body.

## Boot recovery (`CardStore.open`)

1. Scan `cards/.commit/`. For each marker file `<token>.json`:
   - Parse the marker; if parse fails, log fatal and **refuse boot** with `CardStoreInvariantError` naming the marker path. No silent discard.
   - If `marker.by_id` is a rename plan: if `tmp_path` exists, `renameSync` to `final_path`. If neither exists and `final_path` does, no-op (already renamed pre-crash). `fsyncSync(dirfd(by-id/))`.
   - If `marker.by_id` is an unlink plan: if `unlink_path` exists, `unlinkSync`. If absent, no-op.
   - If `marker.history !== null`: read the last well-formed line of `marker.history.jsonl_path` (see §"JSONL crash semantics"). If `last.entry_id === marker.history.entry_id`, skip the append; otherwise `appendSyncIdempotent(marker.history.entry)`. If `marker.history === null` (the `create` case), skip this step.
   - `unlinkSync` the marker. `fsyncSync(dirfd(.commit/))`.
2. Group markers (`group-<group_token>.json`) recover via the state machine in §"Group-marker recovery state machine".
3. Load every `cards/by-id/*.json` into `state.cards` via `cardRecordSchema.parse`. Orphan `*.tmp.<token>` files without a referencing marker are unlinked after step 1 completes (pre-commit residue).
4. Recompute adjacency in memory (parent index, depends-on, blocks-inverse, children-by-parent).
5. Run structural validators carried from `HierarchyGraph.build`: depth ≤ `maxGoalDepth`, exactly one `project` root, parents resolve, no cycles, no terminal children, depends-on closure resolves. No index↔by-id equality check.
6. **Startup history invariant (resolves r3 design-review item 2; tightened for the no-seq-0 decision):** for every card `c` with `c.version_seq = V`:
   - If `V === 1`: the history file may be absent or present-and-empty; **any row present is a fatal `CardStoreInvariantError`**.
   - If `V >= 2`: the history file must exist and contain a contiguous set of rows with `version_seq` values exactly `{1, 2, ..., V - 1}` after de-duplication by `entry_id`. Any duplicate `entry_id` past the first occurrence is removed in-memory but not rewritten on disk (the on-disk dup is harmless residue from an idempotent retry; loud rewrite would defeat the point of de-dup). Any gap, any orphan with `version_seq > V - 1`, **any row with `version_seq < 1`** (explicitly including `version_seq === 0`), and any truncated tail (file ends without a newline AND the last partial bytes do not match a known marker) are fatal `CardStoreInvariantError`s naming card id, file path, observed sequence set, and recovery hint (`saivage reset` or operator hand-edit).
   - **No "audit gap is acceptable" path.** History truncation is loud.

The recovery sequence is idempotent: replaying the same marker set twice produces the same on-disk state.

## History idempotence model (unchanged from r4)

Anchored on `entry_id`. `appendSyncIdempotent(jsonlPath, entry)` reads the last well-formed line; if `last.entry_id === entry.entry_id`, returns; otherwise appends + `fsync`. The marker carries `entry.entry_id` so recovery is exactly-once on disk without needing a separate marker-side artifact. For `create` markers, `marker.history === null` and `appendSyncIdempotent` is not invoked.

## JSONL crash semantics (unchanged from r4)

The 4 KB tail-read in r3 cannot parse a final complete line if a `CardRecord` snapshot makes the line longer than 4 KB. The r4 contract carries forward verbatim:

`JsonlLedger.appendSyncIdempotent(jsonlPath, entry)` and `JsonlLedger.lastLineSync(jsonlPath)`:

1. Open the file. If absent, treat as empty.
2. **Find the last `\n` by backwards scan** from the file end: read up to a 4 KB rolling window, scan backwards for `\n`; if no `\n` is found in the window, slide the window 4 KB earlier and continue. Bound the total backwards read at the file size; if the scan reaches byte 0 without finding a `\n`, the entire file is "the last line".
3. The substring after the last `\n` (or the entire file if no `\n` was found) is the "tail". The substring between the previous `\n` and the trailing `\n` (or empty for a one-line file) is the "last complete line".
4. **If the file ends with `\n`** (well-formed): parse the last complete line. If parse succeeds and `parsed.entry_id === entry.entry_id`, return (already appended). Otherwise append `entry` + `\n`, `fsync` file, `fsync(dirfd)`.
5. **If the file does NOT end with `\n`** (partial last line from a mid-write crash):
   - Truncate the file in-place to the end of the previous `\n` via a temp-file rewrite (`writeFileAtomic` of the file's well-formed prefix), preserving fsync semantics.
   - Move the partial tail bytes to `<jsonlPath>.partial.<ts>` for forensic recovery.
   - Re-run from step 4 against the now-well-formed file.
6. **Deep corruption** (any complete line fails `cardHistoryEntrySchema.parse` during the startup contiguous-history check, OR `lastLineSync` is asked to parse but the last complete line is unparseable AND no marker references its expected `entry_id`): throw `CardStoreInvariantError` with the byte offset of the first parse failure. **No silent rewrite.**

Boot-path scope:

- `CardStore.open` step 1 (marker recovery): tail-trim is allowed because the marker carries the canonical `entry` to append. Skipped for `create` markers (where `marker.history === null`).
- `CardStore.open` step 6 (startup invariant): every complete history line must parse; any complete-line parse failure is fatal. Tail-trim is **not** allowed at this stage.

`appendSyncIdempotent` itself never tail-trims outside marker recovery (callers in steady-state mutation always hold a marker before they call append).

## Multi-card mutation atomicity (unchanged from r4)

`archiveAndDeleteSubtree(rootId)` writes one **group commit marker** plus per-card markers consumed in sequence:

- Compute the descendants-first deletion order in memory: post-order traversal of the parent tree rooted at `rootId`. Each card is unlinked after its descendants.
- **Survivor `depends_on` recompute.** Build the set `D = { all card ids being archived in this call }`. For every card `s` not in `D` whose `depends_on` array contains any id in `D`: compute `s.depends_on' = s.depends_on \ D` and a new in-memory `CardRecord`. These survivor rewrites are part of the same atomic group and receive their own per-card marker inside the group with `kind: 'depends'` and `entry_id` as usual.
- **Survivor `blocks` recompute.** `card.blocks` arrays are derived in-memory from `depends_on`. Only survivors whose `depends_on` actually changes get a history row.
- Allocate `group_token = randomUUID()`. Write `cards/.commit/group-<group_token>.json` containing the ordered list of per-card markers.
- For each card in order, execute steps 3–7 of the single-card sequence with `marker.group = { group_token, index, total }`. All archived-card markers carry `kind: 'archive'` and a non-null `history`.
- After the last per-card marker is unlinked, unlink the group marker.

## Group-marker recovery state machine (unchanged from r4)

Same five-state table (a)–(e) as r4: (a) group present, no per-card; (b) group + per-card present, by-id not done; (c) per-card unlinked, group still present; (d) corrupt per-card → fatal; (e) corrupt group → fatal. The marker/entry presence checks MUST use the same primitives as steady-state recovery (`existsSync`, `lastLineSync`).

## Event emission outside the lock (resolves r4 review design item; rewritten release order)

The event-bus is synchronous. A subscriber that calls back into `CardStore` would deadlock or violate the project mutex's non-reentrancy. F13 chooses the **emit-after-release** option:

- Step 8 (in-memory state update) computes the full `card_history_appended` payload (card id, post-mutation `card`, the history entry, the optional group token). The payload is captured into a local variable **inside** the `withLock` body, before that body returns.
- The `withLock` callback returns, which causes `withLock`'s own try/finally to release the cross-process file lock.
- The outer `finally` releases the in-process mutex.
- The event is emitted from the now-unlocked context, using the locally-captured payload.

For `create`, no payload is captured and no event is emitted. For every other kind that bumps `version_seq`, exactly one event is emitted.

This makes a subscriber that calls back into `CardStore.update` safe: the subscriber's call re-enters `applyMutation`, which acquires the mutex (free), runs, releases, and returns. No deadlock, no reentrancy violation.

The non-reentrant dispatch alternative (track an in-flight flag, throw if a subscriber re-enters) is rejected for the same reasons as r4: it would break legitimate cascading writes.

Test coverage in [03-plan-r5.md](03-plan-r5.md): a unit test installs a subscriber on `card_history_appended` that calls `cardStore.update(...)` and asserts no deadlock, both mutations commit in order, and `card.version_seq` advances by 2.

## `transitionCard` is async (binding cross-issue contract with F19 r4)

`CardStore.transitionCard(id, fromStatus, toStatus, reason)` becomes `async`. Its body composes the outer mutex + inner `projectLock.withLock` and routes the durable effect through `applyMutation` with `kind: 'status'`. The return type changes from synchronous `{ card: CardRecord }` to `Promise<{ card: CardRecord }>`. All call sites are part of the async-constructor fanout grep in [03-plan-r5.md](03-plan-r5.md). F19 r4 and F13 must land together or in dependency order.

## Live projection-write failure semantics

N/A. No derived projection files are written by `applyMutation`. The dashboard reads in-memory state through `CardStore`; in-memory state is updated atomically with the on-disk by-id record under the project mutex.

## Read model (unchanged from r4)

All public `CardStore` reads return from `CardStoreState` in memory. Only `listCardHistory(id)` and `getCardHistoryEntry(id, seq)` touch disk (via the ledger reader). Deleted-card history reads are explicitly supported: the route handler does not require `state.cards.has(id)`; it requires `existsSync(cards/history/<id>.history.jsonl)`. For a freshly-created card with `version_seq === 1`, `listCardHistory` returns `[]` and `total === 0`.

## Event ownership (unchanged from r4)

`card_history_appended` emitted by `CardStore` exactly once per `applyMutation` that bumps `version_seq` **and** writes a history row (i.e. every kind except `create`), after both locks released. `card_history_record_appended` and `CardHistoryProjection` are deleted. `CardStore` keeps its constructor `eventBus` parameter.

## Crash-semantics table

Carried verbatim from r4 §"Crash-semantics table" with the following addendum applied across every row: for `create` markers, the "append history if `entry_id` not last" recovery step is a no-op because `marker.history === null`; the recovery still completes the by-id rename and unlinks the marker. The startup invariant accepts the resulting (`V === 1`, history absent/empty) state.

## Risk

Medium. Surface area is large because every mutation routes through one new primitive. The dominant operational risk is the async fan-out from the async-constructor chain (handled mechanically in [03-plan-r5.md](03-plan-r5.md)) and the schema fanout for `entry_id` / `kind` on every fixture. The dominant correctness risk is the contiguous-history invariant turning latent on-disk drift into loud boot failures — that is the intended behaviour and is the explicit replacement for the deleted `reconcileCardHistory`.
