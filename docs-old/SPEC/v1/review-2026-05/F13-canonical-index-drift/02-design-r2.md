# F13 — Design Proposals (r2)

Supersedes [02-design-r1.md](02-design-r1.md). Rewritten per review items 1-7 in [01-analysis-review-r1.md](01-analysis-review-r1.md). Adds **Proposal C** as the honest middle ground the reviewer asked for; demotes Proposal B with a quantified cost case.

Three proposals: A (minimal commit-marker patch), C (by-id authoritative + derived projections + per-card history ledger), B (full event-sourced rewrite). **Recommended: Proposal C.**

---

## Proposal A — Commit marker around the multi-file mutation (kept for contrast)

### Idea

Hold a `Mutex` for the whole mutation body of `mutateCard`, `update`, `setStatus`, `create`, `delete`, `archiveAndDeleteSubtree`. Stage by-id, index, deps, blocks as `.tmp.<token>`. Write a commit marker `.saivage/cards/.commit/<token>.json` containing the rename plan **and the history entry** (see below); fsync it; rename it into place. Replay each rename. Append history. Unlink marker. On boot, scan `.commit/`; for each marker, either complete the rename plan and append the (idempotent) history line, or treat as no-op.

### Crash semantics (completed per review item 2)

Reviewer item: "If Proposal A remains, the marker replay must include the history append exactly once or explicitly move history into the same authoritative artifact."

Embed the candidate history entry in the marker. Recovery rule: replay rename plan, then check whether the last line of `history/<id>.history.jsonl` already has the marker's `history_entry.entry_id` (a UUID generated when the marker is written); if absent, `JsonlLedger.appendSync` it; then unlink the marker. The `entry_id` makes the append idempotent across multiple recovery attempts. Without this rule, the original r1 design loses the history line on a crash after by-id/index renames but before `appendHistoryEntry`.

**Multi-file atomic-rename caveat (review item 2 + analysis class 1).** `renameSync` is atomic per inode within the same filesystem, but a sequence of three renames (`by-id`, `index`, then optionally `deps`/`blocks`) is *not* atomic as a whole. The commit marker exists precisely to make the **plan** durable; recovery then replays renames idempotently. The replay must therefore handle "some renames done, others not" — which it does, because each `.tmp.<token>` either exists (still to rename) or does not (already renamed). The marker's existence is the only state distinguishing "intent recorded, recovery owes us renames" from "no intent, this is a fresh boot".

### What survives that should not

`validatePersistedState`, `rebuildGraphStrict`, `HierarchyGraph.build`'s index↔by-id equality throw, `canonicalHealth`, `reconcileCardHistory`, the F12 history-on-`update` bug — none of these are addressed by Proposal A unless we also rewrite `update`/`setStatus` to call into the same critical section *and* still maintain the dual authoritative files. The invariant validator continues to own the burden of asserting that two pieces of state agree.

### Honest cost

Smallest LOC delta of the three. Roughly +200 LOC (commit marker, mutex, boot scanner, idempotent history-replay) and –80 LOC (removable bits of `reconcileCardHistory`). Leaves the architectural defect ("two authoritative files for the same fact") intact.

### Disposition

**Rejected** under the architecture-first guideline. Recorded for completeness; not the recommended fix.

---

## Proposal C — by-id is the only authoritative card state; index/deps/blocks are derived; history is a per-card append-only ledger (recommended)

### Idea

- `cards/by-id/<id>.json` is the only durable, authoritative representation of a card. One file per card, written atomically via `writeFileAtomic`.
- `cards/index.json`, `cards/dependencies/depends-on.json`, `cards/dependencies/blocks.json`, and `cards/tree/<id>.children.json` become **derived projections**. They are rebuilt from the by-id set on every boot and after every mutation. They are not read for any decision the store makes; they exist only as cache for the operator UI and for `git diff`/review ergonomics.
- `cards/history/<id>.history.jsonl` stays as an **authoritative** append-only audit log for that card. It is the only artifact other than by-id that carries durable state, and it is committed atomically with the by-id rename via the marker described below.
- One synchronous primitive `applyMutation(id, kind, next, ctx)` is the sole entry point used by `create`, `update`, `setStatus`, `mutateCard`, `delete`, `archiveAndDeleteSubtree`, `updateDependsOn`. It holds the in-process `Mutex` and the `runtime/project.lock` (cross-process) for the whole body.

### On-disk write sequence (one mutation)

Given a single mutated card `<id>` (multi-card mutations like `archiveAndDeleteSubtree` execute the same sequence per card under the same critical section):

1. Stage `cards/by-id/<id>.json.tmp.<token>` (new full record) and write a single commit marker `cards/.commit/<token>.json` containing:
   - `target_by_id_path`, `target_by_id_tmp_path` (or `unlink_by_id_path` for delete).
   - `history_entry_id` (UUID) and `history_entry` (full JSON line to append).
   - `history_jsonl_path`.
   - `kind` (`'create' | 'update' | 'status' | 'mutate' | 'delete' | 'archive' | 'depends'`).
2. `fsyncSync` both temp files and the marker, `renameSync` the marker into `cards/.commit/<token>.json`, `fsyncSync` the directory.
3. `renameSync(by-id/<id>.json.tmp.<token>, by-id/<id>.json)` (or `unlinkSync` for delete).
4. `JsonlLedger.appendSync(history_jsonl_path, history_entry)`. The ledger is idempotent w.r.t. `entry_id`: if the file already ends with this `entry_id`, the append is a no-op.
5. `unlinkSync(marker)`, `fsyncSync(.commit/)`.
6. Regenerate the derived projections from the new in-memory state via `writeAllDerivedProjections(state)` (full rewrite; small and cheap — see "Size bound" below). These writes are best-effort; if a process dies mid-way, boot recovery regenerates them.

Boot recovery (`CardStoreState.fromDisk`):

1. Scan `.commit/`. For each marker `<token>.json`:
   - If `by-id/<id>.json.tmp.<token>` exists, rename it (or unlink for delete).
   - Append `history_entry` if the history file's last `entry_id` is not already this one.
   - Unlink marker.
2. Load every `cards/by-id/*.json`. This is the in-memory state.
3. Reconcile per-card history files: a history line whose `version_seq` exceeds the card's current `version_seq` is kept (it was committed by the recovery in step 1); a line whose `version_seq` is missing relative to the card's current `version_seq` indicates lost history and is logged as a warning, not silently rewritten.
4. Regenerate all derived projections from in-memory state (full rewrite, idempotent).
5. Validate: detect cycles, enforce parent rules, depth, terminal-children, max-depth — same rules `HierarchyGraph.build` runs today. **No** index↔by-id equality check, because index is derived and just got regenerated.

### Read model

All public `CardStore` reads (`read`, `list`, `getBlocks`, `getDependsOn`, `listCardHistory`, `getCardAt`, `diffCard`, `getDescendantIds`, `validateTransition`, `detectCycles`) read from in-memory state. The derived projection files are **never read** by the store itself; route handlers, agent tools, and the runtime go through the in-memory API. This is enforceable via grep: see [03-plan-r2.md](03-plan-r2.md) §Deletion inventory. Only `listCardHistory` reads from disk (the per-card history ledger), because history is the one durable artifact besides by-id.

The dashboard and CLI dumps continue to consume the derived projection files; they are accurate after boot and after each mutation. Between mutation steps 3-6 a concurrent reader of the derived files sees a stale projection — acceptable because the projections are advisory caches, not contracts.

### Why this beats Proposal A

A keeps two authoritative copies of `card.parent_id / status / version_seq` (one in by-id, one in index) and proves they agree via the commit marker. C deletes the second copy. The invariant validator goes away because there is nothing to validate.

### Why this beats Proposal B (event sourcing) — honest comparison

| Concern | Proposal B (event sourcing) | Proposal C (by-id + derived + history ledger) |
| --- | --- | --- |
| New artifacts | `events.jsonl` (global), event schema, replay engine, projection writer | per-card history ledger already exists; commit marker dir; one projection writer |
| Deleted authoritative state | by-id, index, deps, blocks, history (all become derived) | index, deps, blocks (history stays authoritative; by-id stays authoritative) |
| Replay cost on every boot | O(all events ever) regenerating O(all projections); needs readiness gate before serving HTTP | O(N cards) loading by-id files; same readiness gate, but bounded by current card count |
| Sole-source ordering | Per-card `version_seq` and global `seq` and `snapshot.version_seq` all encoded into each event → drift surface in the event payload (review item 3) | Per-card `version_seq` lives only in the by-id record |
| Mutation write footprint | One append + projection rewrites | One marker + one rename + one history append + projection rewrites |
| Code touched | Rewrite of `card-store.ts`, new event/replay/projection layer, `initProjectTree` rewrite, registry changes, ledger projection deletion, every fixture-writing test | `card-store.ts` mutation rewrite, projection writer extraction, `initProjectTree` simplification, projection registry deletion |
| Estimated LOC delta | +900 new, -450 deleted | +350 new, -550 deleted (net negative) |
| Behaviour for hand-edited JSON | Silently overwritten on next mutation, hidden from operator | Hand-edits to `by-id/<id>.json` are honoured on next boot; hand-edits to derived files are silently overwritten (expected, documented) |
| Tests that break | All fixture loaders, all projection assertions, every history test, every contract test on health, plus replay/idempotence/truncation tests | Fixture loaders that write into derived files; history tests on `update`/`setStatus`; health tests |
| Risk of corrupt last log line | Authoritative loss of last event; must define truncate/quarantine/fatal policy (review item 5) | Risk localized to one card's history ledger; `JsonlLedger.appendSync` already quarantines malformed lines via [src/persistence/jsonl-ledger.ts](../../../src/persistence/jsonl-ledger.ts#L70), and a corrupt last line in `history/<id>.history.jsonl` does not lose the card state (which lives in by-id) |
| Boot dirties every projection on git | Yes — full replay touches every projection file every boot, polluting `git status` | Same per-boot rewrite, but only for derived files (`index.json`, `depends-on.json`, `blocks.json`); per-card history files only touched if recovery appended |

The qualitative point the reviewer made — that B is the largest conceptual rewrite and A patches the symptom — survives. C is the smallest rewrite that actually deletes the defective invariant rather than guarding it.

### Data-model changes

- New directory `.saivage/cards/.commit/`. Created on demand. Empty in steady state.
- `defaultCardIndexEntry`, `defaultDependsOnIndex`, `defaultBlocksIndex` (in [src/persistence/file-tree.ts](../../../src/persistence/file-tree.ts)) lose all production callers and are deleted; `initProjectTree` writes `by-id/project.json` only, and the first `CardStore` boot generates the derived files from it.
- No schema change to `CardRecord`, `CardIndex`, `CardDependencyIndex`, `CardBlocksIndex`, `CardHistoryEntry`. The on-disk JSON for these files is byte-identical to today; what changes is **who writes them** and **what role they play**.
- `cards/tree/<id>.children.json` is also a derived projection; it is rewritten by the same projection writer.

### Crash semantics

| Crash point | State on disk after crash | Recovery on next boot |
| --- | --- | --- |
| Before marker rename | by-id tmp may exist; no marker; no history line | Boot deletes orphan tmp; state = pre-mutation |
| After marker rename, before by-id rename | marker present; by-id tmp present | Replay: rename tmp → final; idempotent history append; unlink marker |
| After by-id rename, before history append | marker present; new by-id on disk | Replay sees marker; checks history file's last `entry_id`; appends if missing |
| After history append, before marker unlink | marker present; new by-id; history line written | Replay sees marker; history file's last `entry_id` matches → skip append; unlink marker |
| After marker unlink, before projection regen | clean mutation; projections stale | Boot regenerates projections from in-memory state |
| Multi-card mutation (archive subtree) crashing mid-loop | several markers present (one per card) | Each marker recovered independently; consistent partial subtree archive; operator can re-issue if intent was wider |
| `SIGKILL` exactly at `fsync` boundary | Per POSIX, content may or may not be durable, but rename is atomic. Marker either visible or not. | Same branches as above |
| Out-of-band writer rewriting `by-id/<id>.json` | New content visible | Honoured on next boot; derived files regenerated |
| Out-of-band writer rewriting `cards/index.json` | Derived file stale relative to in-memory state | Silently overwritten by next mutation or next boot regen |

### Atomic-rename invariant — explicit

`renameSync` within one filesystem is atomic for that path. The commit marker's purpose is to make the **rename plan plus history-append intent** durable as a single atomic action (one rename, the marker rename). Subsequent operations (by-id rename, history append, derived projection regen) are recovered idempotently from the marker. The system never relies on multiple `renameSync` calls being atomic as a group.

### Locking model

- In-process `Mutex` around the entire `applyMutation` body. Resolves the synchronous reentrancy class from [01-analysis-r2.md](01-analysis-r2.md) §Class 3.
- Cross-process `ProjectLock` (`.saivage/runtime/project.lock`, [src/persistence/project-lock.ts](../../../src/persistence/project-lock.ts#L60)) held for the same scope. Resolves [01-analysis-r2.md](01-analysis-r2.md) §Class 2 for cooperating processes. (Non-cooperating writers are out of scope; their edits are honoured on next boot.)
- `JsonlLedger.appendSync` already takes its own lock; the cross-process lock around `applyMutation` is a superset and OK.

`ProjectLock.withLock` is async (returns `Promise<T>`). `applyMutation` therefore must be `async`. All current callers of `update`/`setStatus`/`mutateCard`/`create`/`delete`/`archiveAndDeleteSubtree`/`updateDependsOn` already are `async` or are inside an `async` function — see [03-plan-r2.md](03-plan-r2.md) §Async conversion for the call-site list.

### Size bound and boot readiness

- Boot work: load every `cards/by-id/*.json` (typical project ≤ 200 cards, expected ≤ 50). Replay zero or a small handful of commit markers. Regenerate four derived files. Bounded sub-second on the projects the runtime targets.
- Readiness gate: Fastify route registration in [src/server/server.ts](../../../src/server/server.ts) currently awaits runtime startup. The plan ensures `CardStore` constructor's async boot completes before route registration; HTTP requests cannot land on a partially-loaded store. Same gate applies before any `runtime.start()` work.
- Derived projection rewriting on every boot **does** dirty `git status` for those files. Mitigation: the projection writer must produce **byte-identical** output for the same in-memory state (stable key ordering, `JSON.stringify(…, null, 2) + '\n'`, no timestamps). Then `git status` is dirty only when the actual state changed.

### `canonicalHealth` decision

Delete. The hard-coded `{ canonical: 'ok' }` in [src/server/routes/operator-contracts.ts](../../../src/server/routes/operator-contracts.ts#L88) is meaningless; the in-memory probe via [src/server/websocket.ts](../../../src/server/websocket.ts#L95) is meaningless after C lands (the invariant cannot be violated by the store itself). Remove `CardStoreHealth`, `CardStoreCanonicalHealth`, `CardStore.getHealth`, `CardStoreHealthSchema`, the operator contract field, the websocket field, the dashboard rendering, and all associated test assertions. See [03-plan-r2.md](03-plan-r2.md) §Deletion inventory.

### Public broadcast event

Keep `card_history_appended` (the broadcast event consumed by the websocket — [src/events/registry.ts](../../../src/events/registry.ts#L58), [src/contracts/operator-events.ts](../../../src/contracts/operator-events.ts#L110), [src/server/websocket.ts](../../../src/server/websocket.ts#L303)). Delete `card_history_record_appended` (the internal event that drove the now-unnecessary `CardHistoryProjection`). See [03-plan-r2.md](03-plan-r2.md) §Deletion inventory.

### Code that becomes unnecessary (Proposal C)

Listed exhaustively in [03-plan-r2.md](03-plan-r2.md) §Deletion inventory.

### Risk

Medium-low. Surface area is large because every mutation goes through the new primitive, but the on-disk format of every file the operator can already read is unchanged. The dominant operational risk is async-conversion fan-out (see [03-plan-r2.md](03-plan-r2.md) §Async conversion). The dominant test risk is fixtures that write `index.json` or `dependencies/*.json` directly; those must be rewritten to seed by-id files and let the store regenerate the projections.

---

## Proposal B — Event-sourced `events.jsonl` (rejected; kept for trace)

The full r1 design is preserved at [02-design-r1.md](02-design-r1.md) §Proposal B. Reviewer items 3-6 are not honestly fixable without making B materially larger than C while delivering the same invariant elimination. Specifically:

- **Ordering source of truth (review item 3).** B duplicates `seq`, `version_seq`, and `snapshot.version_seq` in each event. The minimum honest fix is to derive `version_seq` as `count(events for card_id)` and drop it from the wire schema, and either derive `snapshot.version_seq` from the same count or drop `snapshot` from the wire and reconstruct it via replay. Both choices increase reader complexity (a single-event read no longer suffices) for no operator benefit over Proposal C.
- **Boot rebuild + readiness (review item 4).** B's replay is O(all events ever recorded), unbounded in time, with no readiness gate defined in the r1 plan. Adding the gate is mechanical, but the cost of unbounded replay grows with project age, while C's cost is bounded by the current card count.
- **Truncated last line (review item 5).** r1 claimed `JsonlLedger` solves this; it does not — see [src/persistence/jsonl-ledger.ts](../../../src/persistence/jsonl-ledger.ts#L70). Under B, defining the policy (truncate / quarantine / fatal) is mandatory because the corrupt line *is* the lost mutation. Under C, the equivalent risk is corruption of the last line of one card's history ledger, which loses an audit entry but not the card state.
- **No-back-compat boot policy (review item 6).** r1 said the constructor creates an empty event log if missing — a silent migration shim. Under B this must become "missing `events.jsonl` is fatal unless the project's by-id set is also empty, in which case Step 6 (`initProjectTree`) must have just run inside the same critical section". Under C the equivalent is trivial: missing by-id directory is the same as a fresh project.

B's only structural advantage over C — a single global ordering of all card mutations — has no live consumer in this codebase. Per-card `version_seq` plus per-card history files already provide the audit ordering each operator surface needs.

**Disposition: rejected.** Recorded for the metaplan trace.

---

## Recommendation

**Proposal C.**

- Eliminates the F13 invariant by deleting one of the two authoritative copies, not by guarding the gap between them.
- Subsumes F12 by making history-append part of the single `applyMutation` primitive that all mutating paths (including `update` and `setStatus`) flow through.
- Net negative LOC, single boot-time rebuild bounded by card count, no new global ordering authority, no replay engine, no schema change on operator-readable JSON files.
- The remaining work — async conversion of mutation call sites, fixture cleanup, deletion of `canonicalHealth` plumbing — is mechanical and listed in [03-plan-r2.md](03-plan-r2.md).
