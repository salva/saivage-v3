# F13 — Design (r4)

Supersedes [02-design-r3.md](02-design-r3.md). Resolves design-review items 1–6 in [01-analysis-review-r3.md](01-analysis-review-r3.md). Companion: [01-analysis-r4.md](01-analysis-r4.md), [03-plan-r4.md](03-plan-r4.md).

## Project-guideline reminder

Architecture-first, no backward compatibility, no migration shims, no new docstrings/comments in untouched code, no dead code. New modules (`src/cards/state.ts`, `src/cards/apply-mutation.ts`, `src/cards/commit-marker.ts`, `src/cards/project-mutex.ts`) get one short header line and no per-method docstrings; behaviour is documented by tests and identifier names.

## Source of truth (binding)

- `cards/by-id/<id>.json` — only authoritative card-state file. Atomic temp + rename inside the critical section.
- `cards/history/<id>.history.jsonl` — append-only audit ledger. Authoritative for audit only; never replayed to reconstruct current state. Per-card history file is preserved across `delete` / `archive` (the deleted card's history remains queryable; see [01-analysis-r4.md](01-analysis-r4.md) §"CardHistoryEntry semantics table").
- `cards/.commit/<token>.json` — durable commit markers. Empty in steady state.

Deleted from the on-disk layout: `cards/index.json`, `cards/dependencies/depends-on.json`, `cards/dependencies/blocks.json`, the `cards/tree/` directory.

## On-disk write sequence (resolves design-review item 1)

`applyMutation` is the sole entry point for `create` / `update` / `setStatus` / `mutateCard` / `delete` / `archiveAndDeleteSubtree` / `updateDependsOn`. For a single-card mutation on `<id>`:

1. `await projectMutex.lock()` (single project-wide in-process mutex; see §"Locking model") then `await projectLock.acquire()` (single project-wide cross-process lock).
2. Compute `next: CardRecord` in memory from `state.cards.get(id)` and the patch. Compute the durable history row from the **pre-mutation** card: `entry: CardHistoryEntry` with `entry_id = randomUUID()`, `kind` per the call site, `version_seq = current.version_seq` (i.e. the *pre-mutation* sequence; after the rename in step 5 the by-id record carries `version_seq = current.version_seq + 1`, so the invariant `max(history[].version_seq) === card.version_seq - 1` holds by construction), `snapshot = current` (the full pre-mutation `CardRecord`), and the full `changed_fields` diff of `next` vs. `current`. For `create`, `current` is the synthetic tombstone defined in [01-analysis-r4.md](01-analysis-r4.md) §"CardHistoryEntry semantics table".
3. Stage `cards/by-id/<id>.json.tmp.<token>` with the full new record (or record the unlink path for `delete`). `fsyncSync(tmpFd)`; `fsyncSync(dirfd(cards/by-id/))`.
4. Write `cards/.commit/<token>.json` containing the marker (rename plan, history entry, optional group fields). `writeFileAtomic` (temp + fsync + `renameSync` + `fsyncSync(dirfd(.commit/))`).
5. `renameSync(by-id/<id>.json.tmp.<token>, by-id/<id>.json)` — for delete, `unlinkSync(by-id/<id>.json)`. `fsyncSync(dirfd(cards/by-id/))`.
6. `JsonlLedger.appendSyncIdempotent(cards/history/<id>.history.jsonl, entry)` — re-read the last line of the file; if `last.entry_id === entry.entry_id`, skip; otherwise append + `fsync`. See §"JSONL crash semantics".
7. `unlinkSync(cards/.commit/<token>.json)`. `fsyncSync(dirfd(.commit/))`.
8. Update in-memory `state` (cards map, adjacency caches). **Capture** the `card_history_appended` payload locally.
9. Release `projectLock`, then `projectMutex`.
10. After both locks are released, `eventBus.emit('card_history_appended', capturedPayload)`. See §"Event emission outside the lock".

The marker's `history.entry` carries the **pre-mutation** `version_seq` because the durable row is computed in step 2 from the pre-mutation card. The by-id file written in step 5 carries `current.version_seq + 1`. Therefore `max(history[].version_seq) === card.version_seq - 1` is enforced by construction on both happy path and recovery path.

For multi-card mutations (`archiveAndDeleteSubtree`), see §"Multi-card mutation atomicity".

## Boot recovery (`CardStore.open`)

1. Scan `cards/.commit/`. For each marker file `<token>.json`:
   - Parse the marker; if parse fails, log fatal and **refuse boot** with `CardStoreInvariantError` naming the marker path. No silent discard.
   - If `marker.by_id` is a rename plan: if `tmp_path` exists, `renameSync` to `final_path`. If neither exists and `final_path` does, no-op (already renamed pre-crash). `fsyncSync(dirfd(by-id/))`.
   - If `marker.by_id` is an unlink plan: if `unlink_path` exists, `unlinkSync`. If absent, no-op.
   - Read the last well-formed line of `marker.history.jsonl_path` (see §"JSONL crash semantics"). If `last.entry_id === marker.history.entry_id`, skip the append; otherwise `appendSyncIdempotent(marker.history.entry)`.
   - `unlinkSync` the marker. `fsyncSync(dirfd(.commit/))`.
2. Group markers (`group-<group_token>.json`) recover via the state machine in §"Group-marker recovery state machine".
3. Load every `cards/by-id/*.json` into `state.cards` via `cardRecordSchema.parse`. Orphan `*.tmp.<token>` files without a referencing marker are unlinked after step 1 completes (pre-commit residue).
4. Recompute adjacency in memory (parent index, depends-on, blocks-inverse, children-by-parent).
5. Run structural validators carried from `HierarchyGraph.build`: depth ≤ `maxGoalDepth`, exactly one `project` root, parents resolve, no cycles, no terminal children, depends-on closure resolves. No index↔by-id equality check.
6. **Startup history invariant (resolves design-review item 2):** for every card `c` with `c.version_seq = V`:
   - If `V === 1`: the history file may be absent or present-and-empty; any row present is a `CardStoreInvariantError`.
   - If `V >= 2`: the history file must exist and contain a contiguous set of rows with `version_seq` values exactly `{1, 2, ..., V - 1}` after de-duplication by `entry_id`. Any duplicate `entry_id` past the first occurrence is removed in-memory but not rewritten on disk (the on-disk dup is harmless residue from an idempotent retry; loud rewrite would defeat the point of de-dup). Any gap, any orphan with `version_seq > V - 1`, any orphan with `version_seq < 1`, and any truncated tail (file ends without a newline AND the last partial bytes do not match a known marker) are fatal `CardStoreInvariantError`s naming card id, file path, observed sequence set, and recovery hint (`saivage reset` or operator hand-edit).
   - **No "audit gap is acceptable" path.** History truncation is loud. The r3 design's matrix row that accepted out-of-band history truncation as "current-state-safe" is deleted.

The recovery sequence is idempotent: replaying the same marker set twice produces the same on-disk state.

## Locking model (carried, with explicit no-dependency note)

Single project-wide in-process mutex (`projectMutex`, a hand-rolled promise-chain primitive — see [03-plan-r4.md](03-plan-r4.md) §"Mutex implementation"; **no `async-mutex` dependency**) plus the existing single project-wide cross-process `ProjectLock` ([src/persistence/project-lock.ts#L60](../../../src/persistence/project-lock.ts#L60)) for all card mutations. Not per-card. Rationale identical to r3 (multi-card archive, neighbour inverse-blocks adjacency, shared `CardStoreState` map). `JsonlLedger.appendSyncIdempotent` does not re-acquire the project lock; the caller holds it.

## History idempotence model (unchanged from r3)

Anchored on `entry_id`. `appendSyncIdempotent(jsonlPath, entry)` reads the last well-formed line; if `last.entry_id === entry.entry_id`, returns; otherwise appends + `fsync`. The marker carries `entry.entry_id` so recovery is exactly-once on disk without needing a separate marker-side artifact.

## JSONL crash semantics (resolves design-review item 3)

The 4 KB tail-read in r3 cannot parse a final complete line if a `CardRecord` snapshot makes the line longer than 4 KB. The r4 contract:

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

Which boot path throws on deep corruption vs. tail-trims:

- `CardStore.open` step 1 (marker recovery): tail-trim is allowed because the marker carries the canonical `entry` to append. The pre-trim partial bytes are sidelined to `.partial.<ts>`; the marker's `entry_id` matches the now-trimmed tail or the about-to-append entry. Deep corruption (a complete-but-unparseable line further back) is fatal.
- `CardStore.open` step 6 (startup invariant): every complete history line must parse; any complete-line parse failure is fatal. Tail-trim is **not** allowed at this stage because no marker covers it (markers were already drained in step 1).

`appendSyncIdempotent` itself never tail-trims outside marker recovery (callers in steady-state mutation always hold a marker before they call append).

## Multi-card mutation atomicity (resolves design-review item 4)

`archiveAndDeleteSubtree(rootId)` writes one **group commit marker** plus per-card markers consumed in sequence:

- Compute the descendants-first deletion order in memory: post-order traversal of the parent tree rooted at `rootId`. Each card is unlinked after its descendants.
- **Survivor `depends_on` recompute (new — resolves design-review item 4).** Build the set `D = { all card ids being archived in this call }`. For every card `s` not in `D` whose `depends_on` array contains any id in `D`: compute `s.depends_on' = s.depends_on \ D` and a new in-memory `CardRecord`. These survivor rewrites are part of the same atomic group and receive **their own per-card marker inside the group** with `kind: 'depends'` and `entry_id` as usual. The group marker's ordered plan lists archive entries first (descendants-first) and survivor rewrites after, so a crash mid-group never leaves a survivor pointing at an unlinked descendant in the durable record. After all archives and survivor rewrites are applied, the structural validator's depends-on closure check passes by construction.
- **Survivor `blocks` recompute.** `card.blocks` arrays are derived in-memory from `depends_on` (the `cards/dependencies/blocks.json` file is deleted). After the group applies, the in-memory recompute regenerates every affected card's `blocks` adjacency in one pass. The on-disk `CardRecord.blocks` field on each survivor is updated through the survivor's `kind: 'depends'` per-card marker if and only if that survivor had its `depends_on` recomputed; survivors whose only change is a downstream blocks-array delta (i.e. they neither archive nor lose a `depends_on` neighbour) are **not** rewritten and do not get a history row. This avoids history-row noise for cards whose authoritative state (`depends_on`) did not change.
- Allocate `group_token = randomUUID()`. Write `cards/.commit/group-<group_token>.json` containing the ordered list of per-card markers (each per-card marker carries its own `token`, `by_id` plan, and `history` entry).
- For each card in order, execute steps 3–7 of the single-card sequence with `marker.group = { group_token, index, total }`. The per-card marker is written, the by-id is unlinked/renamed, the history is appended, the per-card marker is unlinked.
- After the last per-card marker is unlinked, unlink the group marker.

## Group-marker recovery state machine (resolves design-review item 5)

For each `group-<group_token>.json` found at boot, scan the ordered plan and probe each per-card entry's presence to determine the recovery state:

| Observed state | Action | Idempotence check |
| --- | --- | --- |
| (a) Group marker present, **no per-card marker yet** | Begin executing the plan from `index = 0`. | Before starting card `i`, probe: per-card marker file exists? If yes, the plan is partially executed (case b). If no AND `by-id/<id>.json` for the plan entry has already reached its post-state (renamed/unlinked) AND the history row with the expected `entry_id` is the last well-formed line of the corresponding history file, then card `i` is already committed; advance to `i+1`. Otherwise execute steps 3–7 for card `i`. |
| (b) Group marker present, **per-card marker `t` written, by-id not yet executed** | Execute steps 5–7 of the single-card sequence for `t`: rename/unlink by-id, `appendSyncIdempotent` history (no-op if `last.entry_id` matches), unlink the per-card marker. Then continue with `i+1`. | Probing the by-id final path tells whether step 5 ran. Probing the last line of the history file tells whether step 6 ran. Each is individually idempotent. |
| (c) Group marker present, **per-card marker for `t` unlinked, by-id done, history done** but group marker still present | Advance to `i+1` without re-executing. If `i+1 == total`, unlink the group marker. | The per-card marker's absence is the durable signal that the per-card sequence completed; the group marker's presence is the signal that the group sweep has not finished. |
| (d) Group marker present, **per-card marker for `t` exists but is corrupt** (parse fails) | Fatal `CardStoreInvariantError` naming the per-card marker path AND the group marker path. **Do not** unlink either marker. Operator-visible. | Same fatal-marker rule as single-card recovery. |
| (e) Group marker corrupt | Fatal `CardStoreInvariantError`. | Same. |

After all per-card markers are processed and the group plan is complete, unlink the group marker. `fsyncSync(dirfd(.commit/))`.

The marker/entry presence checks above MUST be performed using the same primitives as steady-state recovery (`existsSync` for files, `lastLineSync` for the history tail) so test code can simulate them deterministically.

## Event emission outside the lock (resolves design-review item 6)

The event-bus is synchronous. A subscriber that calls back into `CardStore` would deadlock or violate the project mutex's non-reentrancy. F13 chooses the **emit-after-release** option:

- Step 8 (in-memory state update) computes the full `card_history_appended` payload (card id, post-mutation `card`, the history entry, the optional group token).
- The payload is **captured into a local variable** before releasing the project lock and mutex.
- Step 9 releases both locks (project lock then mutex).
- Step 10 emits the event from the now-unlocked context.

This makes a subscriber that calls back into `CardStore.update` safe: the subscriber's call re-enters `applyMutation`, which acquires the mutex (free), runs, releases, and returns. No deadlock, no reentrancy violation.

The non-reentrant dispatch alternative (track an in-flight flag, throw if a subscriber re-enters) is rejected: it would break legitimate cascading writes (e.g. notifications that update a card based on the just-emitted event) and would require an in-flight-flag test that any well-behaved subscriber violates by accident.

Test coverage in [03-plan-r4.md](03-plan-r4.md): a unit test installs a subscriber on `card_history_appended` that calls `cardStore.update(...)` and asserts no deadlock, both mutations commit in order, and `card.version_seq` advances by 2.

## `transitionCard` is async (binding cross-issue contract with F19 r4)

`CardStore.transitionCard(id, fromStatus, toStatus, reason)` becomes `async`. Its body composes with `await projectMutex.lock()` and routes the durable effect through `applyMutation` with `kind: 'status'`. The return type changes from synchronous `{ card: CardRecord }` to `Promise<{ card: CardRecord }>`. All call sites are part of the async-constructor fanout grep in [03-plan-r4.md](03-plan-r4.md). F19 r4 and F13 must land together or in dependency order.

## Live projection-write failure semantics

N/A. No derived projection files are written by `applyMutation`. The dashboard reads in-memory state through `CardStore`; in-memory state is updated atomically with the on-disk by-id record under the project mutex.

## Read model (unchanged from r3)

All public `CardStore` reads return from `CardStoreState` in memory. Only `listCardHistory(id)` and `getCardHistoryEntry(id, seq)` touch disk (via the ledger reader). Deleted-card history reads are explicitly supported: the route handler does not require `state.cards.has(id)`; it requires `existsSync(cards/history/<id>.history.jsonl)`.

## Event ownership (unchanged from r3)

`card_history_appended` emitted by `CardStore` exactly once per `applyMutation`, after lock release. `card_history_record_appended` and `CardHistoryProjection` are deleted. `CardStore` keeps its constructor `eventBus` parameter.

## Crash-semantics table

| Crash point | On-disk state | Recovery on next `CardStore.open` |
| --- | --- | --- |
| Before step 3 | unchanged | nothing to do |
| Step 3 done, before step 4 | orphan tmp present | tmp unlinked after marker scan |
| Step 4 done, before step 5 | marker + tmp | recovery: rename tmp → final, append history if `entry_id` not last, unlink marker; post-state: `max(history[].version_seq) === card.version_seq - 1`, contiguous history |
| Step 5 done, before step 6 | marker + new by-id, no history line | recovery: by-id rename no-op, append history, unlink marker; post-state invariants hold |
| Step 6 done, before step 7 | marker + new by-id + history line | recovery: by-id no-op, history append no-op (entry_id matches), unlink marker; post-state invariants hold |
| Step 7 done, before step 9 (lock release) | committed; no in-memory update | next `CardStore.open` rebuilds in-memory state from disk; invariants hold |
| Step 9 done, before step 10 (event emit) | committed; in-memory state up to date; event not emitted | event loss is acceptable (the event bus is at-most-once on a crash); next read returns the committed state; downstream consumers re-derive from `CardStore` |
| Mid step 6 (partial JSONL line) | marker + by-id + truncated tail | partial-tail contract sidelines the partial bytes, appends, unlinks marker; post-state invariants hold |
| Group mid-execution (per-card `k` of `N`) | group marker + per-card marker for next card + first `k` already committed | recovery resumes per the §"Group-marker recovery state machine" table; final post-state invariants hold for every survivor and every archived card's preserved history file |
| Marker file corruption (parse failure) | corrupt marker | fatal `CardStoreInvariantError`; no silent discard |
| Orphan tmp without marker | tmp present, no marker | tmp unlinked |
| Out-of-band rewrite of `cards/by-id/<id>.json` whose history file is still contiguous up to its `version_seq - 1` | honored on next open | invariants hold |
| Out-of-band rewrite of `cards/by-id/<id>.json` that breaks the contiguous-history invariant (e.g. bumps `version_seq` past `last_history_seq + 1`) | gap | fatal `CardStoreInvariantError` |
| Out-of-band truncation of `cards/history/<id>.history.jsonl` for any card with `V >= 2` | gap | fatal `CardStoreInvariantError` (audit truncation is loud) |

## Risk

Medium. Surface area is large because every mutation routes through one new primitive. The dominant operational risk is the async fan-out from the async-constructor chain (handled mechanically in [03-plan-r4.md](03-plan-r4.md)) and the schema fanout for `entry_id` / `kind` on every fixture. The dominant correctness risk is the contiguous-history invariant turning latent on-disk drift into loud boot failures — that is the intended behaviour and is the explicit replacement for the deleted `reconcileCardHistory`.
