# Record-Backed Card Storage Plan

Status: proposal. Scope: card persistence, card records, record access, commit infrastructure, and card-facing tools. This plan does not change non-card Analyst tools.

## Decision Summary

Use the same versioned record structure for card state and card-authored documents.

- `record://card.json` is the **canonical persisted card state**, not a projection.
- The in-memory `CardStore` becomes an index/cache loaded from latest `card.json` records.
- Structured card mutation history is `card.json` version history.
- Related intent text is one record, `record://brief.md`, not separate goal/instructions/acceptance records.
- Keep separate records only when ownership/timing differs: `brief.md`, `status.md`, `review.md`.
- Do not add `result.json` initially. Structured outputs that matter to scheduling, review, or display belong directly in `card.json`; narrative outputs belong in `status.md` or `review.md`.
- All writes use shared commit infrastructure. Multi-card structural changes use a batch commit primitive.
- Analyst card mutations are accepted only while the runtime is paused. They are committed during the pause and announced to affected cards when the runtime is unpaused.

This is a brave refactor, but it removes duplicate persistence models and makes versioned storage uniform.

## Non-Goals

- Do not keep the existing card-history store as a second source of history after migration.
- Do not split card intent into separate `goal.md`, `instructions.md`, and `acceptance.md` records.
- Do not add `result.json` until a concrete structured-result need cannot be represented cleanly in `card.json`.
- Do not add record-level read permissions. Any agent can read card records.
- Do not encode lifecycle behavior, propagation policy, append-only policy, or required-at-state rules in record slot metadata.
- Do not expose raw writes into the record namespace.
- Do not keep compatibility aliases after the new card API is fully migrated.
- Do not attempt crash-proof multi-file transaction recovery. Recovery is best-effort after unexpected write failures.

## Storage Model

Each card has a record namespace:

```text
.saivage/outputs/cards/<card-id>/card/<version>.json
.saivage/outputs/cards/<card-id>/brief/<version>.md
.saivage/outputs/cards/<card-id>/status/<version>.md
.saivage/outputs/cards/<card-id>/review/<version>.md
```

The exact directory layout can reuse the existing record-slot layout. The important model is:

- every slot has a version index,
- the latest closed `card.json` is the card's current structured state,
- the latest closed `brief.md` is the card's current goal/instructions/acceptance brief,
- `status.md` and `review.md` are role-owned reports.

## Record Slots

Keep slot policy minimal:

```ts
interface RecordSlotDefinition {
  path: `record://${string}`;
  format: 'json' | 'markdown' | 'text';
  writers: readonly AgentRole[];
  schema?: string;
}
```

Initial slots:

| Record | Format | Writers | Purpose |
|---|---|---|---|
| `record://card.json` | json | runtime | Canonical structured card state. Written by card store/runtime services only. |
| `record://brief.md` | markdown | analyst, planner | Goal, instructions, acceptance criteria, and other operator/planner intent. |
| `record://status.md` | markdown | planner, executor | Planner/executor status report or completion narrative. |
| `record://review.md` | markdown | reviewer | Reviewer assessment. |

Slot availability may vary by card type. The commit path rejects unknown slots for the target card type unless the slot registry explicitly allows them.

## Card JSON Shape

`card.json` should hold structured state that actors and the scheduler need to reason about a card:

```ts
interface StoredCardDocument {
  id: string;
  type: CardType;
  parent: string | null;
  depth: number;
  position: number;
  title: string;
  status: CardStatus;
  lifecycle: CardLifecycleState;
  tags: string[];
  priority: number;
  urgency: Urgency;
  created_by: CreatedBy;
  created_at: string;
  version_seq: number;
  depends_on: string[];
  related: string[];
  metrics?: Record<string, number | string | boolean | null> | null;
  estimate?: string | null;
  started_at?: string | null;
  duration_ms?: number | null;
  latest_self_report?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  retries: number;
}
```

Do not store narrative status text in `card.json`. `status.md` is the source for planner/executor status narrative.

Do not store `updated_at` in `card.json`. `get_card` calculates effective update time dynamically from latest `card.json`, `brief.md`, `status.md`, and `review.md` metadata.

`version_seq` is the logical card version and must match the `card.json` slot version. If `card.json` version 12 is current, its document contains `version_seq: 12`.

Remove long-form intent fields from `card.json` during migration:

- `description` moves to `brief.md`.
- `acceptance` moves to `brief.md`.
- `instructions_file` is replaced by `brief.md` and record URLs returned by `get_card`.

Most structured result data should live in `card.json` fields such as `metrics`, `latest_self_report`, lifecycle result summaries, or future explicit structured fields. Use Markdown records for narrative evidence. Add `result.json` only if a concrete future use case needs large structured data that should not live in card state.

## Brief Markdown Shape

`brief.md` replaces separate goal/instructions/acceptance records.

Recommended schema:

```md
# Goal

...

# Instructions

...

# Acceptance Criteria

...
```

Validation should require the three headings for cards whose type needs a complete brief. The schema can allow empty sections during bootstrap if card creation needs staged completion.

Why one record:

- goal, instructions, and acceptance criteria are interdependent;
- agents usually need to read all three together;
- one version history is easier to reason about than coordinated versions across three slots;
- one `patch_card` write can update the whole intent coherently.

## Record URLs

Use the existing concrete URL shape unless a separate URL cleanup is planned:

```text
record://card.json?card=card-1
record://card.json?card=card-1&v=4
record://brief.md?card=card-1
record://brief.md?card=card-1&v=2
```

Rules:

- A URL without `v` resolves to the latest closed version.
- A URL with `v` resolves to that concrete version.
- `card` is required for generic file reads.
- Tool responses may show short paths like `record://brief.md`, but generic reads must receive concrete URLs with `card`.

## Read Access

Generic file reads support record URLs:

```ts
read_file({ path: 'record://card.json?card=card-1' })
read_file({ path: 'record://brief.md?card=card-1' })
read_file({ path: 'record://review.md?card=card-1&v=3' })
```

Add a distinct metadata API:

```ts
read_record_metadata({ path: 'record://brief.md?card=card-1' })
```

`read_record_metadata` returns:

```ts
interface RecordMetadataView {
  cardId: string;
  path: `record://${string}`;
  latest: number | null;
  versions: Array<{
    version: number;
    status: 'closed' | 'discarded';
    size: number | null;
    committedAt: string | null;
    writer: AgentRole | null;
    cardVersionSeq: number | null;
    globalSeq: number | null;
    url: string;
  }>;
  format: 'json' | 'markdown' | 'text';
  schema?: string;
  writers: readonly AgentRole[];
}
```

Open versions remain an internal terminal-tool implementation detail.

Record slot versions are consecutive per slot. Each closed version metadata entry stores:

- slot-local version number,
- the current `card.json` `version_seq` when the record was committed,
- a project-wide monotone `globalSeq`,
- writer,
- committed timestamp,
- size,
- format and schema.

The project-wide `globalSeq` is used only to reconstruct cross-card/project history. It is not a replacement for slot-local versions or `card.json` `version_seq`.

## `get_card` Read Model

`get_card` is still useful as a compact read model assembled from latest records and indexes:

```ts
interface CardRecordSummary {
  path: `record://${string}`;
  url: string;
  latest: number | null;
  format: 'json' | 'markdown' | 'text';
  schema?: string;
  writers: readonly AgentRole[];
  size: number | null;
  modifiedAt: string | null;
  writer: AgentRole | null;
  inline?: { content: string; truncated: boolean };
}

interface GetCardView {
  card: StoredCardDocument;
  children: CardRefView[];
  dependencies: CardRefView[];
  records: CardRecordSummary[];
}
```

Inline snippets should be bounded. Good initial inline candidates are `brief.md`, latest `status.md`, and latest `review.md`. `card.json` is returned as structured `card`, so it does not need an inline content string.

`get_card` should include an `effective_updated_at` field computed as the max committed timestamp across current `card.json`, `brief.md`, `status.md`, and `review.md` records.

## Commit Infrastructure

Create one shared commit primitive for a single closed record version:

```ts
interface CommitRecordInput {
  projectRoot: string;
  cardId: string;
  path: `record://${string}`;
  writer: AgentRole;
  content: string;
  reason: string;
  surface: ControlActionSurface | 'runtime';
}

interface CommittedRecord {
  cardId: string;
  path: `record://${string}`;
  url: string;
  version: number;
  size: number;
  committedAt: string;
  writer: AgentRole;
}
```

`commitRecord(input)` must:

1. Verify the card namespace exists, except when creating a new `card.json`.
2. Resolve the record slot for the card type or creation context.
3. Check `writer` is listed in the slot's `writers`.
4. Validate basic format.
5. Validate schema if configured.
6. Fail if the slot has an open latest version owned by an active terminal-tool flow.
7. Allocate the next version from the slot index.
8. Write the new version file durably.
9. Write a complete new index file beside the current index.
10. Atomically rename the new index over the current index.
11. Store writer, committed timestamp, size, schema, format, `cardVersionSeq`, and `globalSeq` metadata in the slot index.
12. Record a control action/audit entry.
13. Call active card processor `onRecordWritten` synchronously if one exists.
14. Return the committed record descriptor.

No version is committed if authorization, format validation, or schema validation fails.

### Existing Open/Close Terminal Records

Keep the existing `openRecordSlot` / `closeOpenRecordSlot` terminal-tool flow for `status.md?v=next` and `review.md?v=next`, but make close/finalization share validation, metadata, audit, and hook internals with `commitRecord`.

The split is:

- Open phase: allocate a tentative next version and mark it `open` in the slot index.
- Write phase: the terminal actor writes content to the open version file.
- Close phase: validate format/schema, write a complete new index, atomically rename it over the old index, audit, and fire hooks.
- `commitRecord`: performs open, write, and close in one call.

When a card processor actor changes state, it commits any uncommitted record files it owns. Other lifecycle events may also force commits; for example, activating a child card may commit the child card and all its open records.

## Batch Commit Infrastructure

Versioned `card.json` makes multi-card mutations explicit. Add a batch primitive for structural changes:

```ts
interface CommitRecordBatchInput {
  projectRoot: string;
  writer: AgentRole;
  reason: string;
  surface: ControlActionSurface | 'runtime';
  records: Array<{
    cardId: string;
    path: `record://${string}`;
    content: string;
  }>;
}
```

`commitRecordBatch(input)` must:

1. Acquire the project/card-store lock.
2. Preflight every record: slot, writer, format, schema, and structural invariants.
3. Allocate all versions.
4. Write all record files and indexes durably.
5. Update the in-memory `CardStore` index/cache after successful writes.
6. Audit one batch action with per-record descriptors.
7. Call active processor hooks synchronously for affected cards.
8. Return committed record descriptors.

Atomicity rule:

- Preflight must happen before writes.
- The lock prevents concurrent mutation interleaving.
- Every individual record update uses write-new-version-file, write-new-index-file, atomic-rename-index.
- If a write fails after writes begin, throw loudly. Do not silently pretend the batch was atomic.
- Recovery is best effort. Ordered shutdown/restart should recover cleanly. Unexpected process errors during multi-file writes are not guaranteed to be fully recovered.
- Do not add batch marker files or transactional journals unless a concrete failure mode proves they are needed.

Use batch commits for:

- create card (`card.json` + initial `brief.md`),
- reorder children,
- cancel subtree,
- archive subtree,
- dependency changes that alter multiple cards,
- any future structural mutation involving more than one `card.json`.

## Analyst Mutation Rules

Analyst card mutations are intentionally permissive but only while the runtime is paused.

Rules:

- If the runtime is not paused, `patch_card`, `create_card`, `reorder_child`, `cancel_card`, and `delete_card` fail with a runtime-state error.
- Paused runtime means no actor is executing, but cards may still have `running` or other active statuses.
- The Analyst may patch a `running` card while paused if every touched record is closed and the requested patch passes schema/invariant checks.
- Structural mutations that would invalidate an active subtree remain denied for `running` cards unless explicitly designed later.
- Analyst patches fail when the target slot has an open latest version.
- Analyst changes are committed during the pause.
- On unpause, the runtime queues notifications for affected cards. Prefer one notification per affected card; one notification per edited item is acceptable when that is simpler.
- Notifications tell running/active agents that unexpected card records changed while the runtime was paused.

## Processor Hook

Card processors may observe successful commits synchronously:

```ts
interface CardProcessor {
  onRecordWritten?(event: {
    cardId: string;
    path: `record://${string}`;
    writer: AgentRole;
    version: number;
    previousVersion: number | null;
  }): void;
}
```

Rules:

- The hook is not async.
- Commit correctness never depends on the hook.
- If no active processor exists, nothing special happens.
- Processors reconcile from latest records when they start or resume.

## Card Store Refactor

The final `CardStore` should be an in-memory index/cache over latest `card.json` records.

Responsibilities:

- load latest closed `card.json` for every active card at startup,
- validate all loaded card schemas,
- build parent/child/dependency indexes,
- serve synchronous reads from memory,
- implement mutations by producing new `card.json` documents and committing them through `commitRecord` or `commitRecordBatch`,
- invalidate/reload after external record commits when necessary,
- preserve current sync mutation behavior for callers.

The old card persistence and separate card history files should be removed after the store is fully record-backed.

## Unified Card Patch Tool

Replace broad `edit_card` and separate record/metadata tools with one cohesive card patch tool:

```ts
interface PatchCardInput {
  id: string;
  card?: {
    title?: string;
    tags?: string[];
    priority?: number;
    urgency?: Urgency;
    depends_on?: string[];
    related?: string[];
  };
  records?: {
    'brief.md'?: string;
  };
}
```

`patch_card` behavior:

1. Load target card.
2. Require paused runtime.
3. Preflight card patch through `card.json` schema and invariants.
4. Preflight record patch through slot writer/schema checks.
5. Fail if any touched record has an open latest version.
6. Commit changed `card.json` and any changed records in one batch.
7. Register affected-card notifications for delivery when runtime unpauses.
8. Propagate once after successful commit.
9. Return updated `get_card` view plus committed record descriptors.

## Other Card Tools

Target card-facing tools:

| Tool | Purpose |
|---|---|
| `list_cards` | Query/filter cards from the in-memory card index. |
| `get_tree` | Inspect hierarchy from the in-memory card index. |
| `get_card` | Compact card read model with `card.json`, record URLs, and snippets. |
| `read_file` | Read `record://` URLs returned by `get_card`. |
| `read_record_metadata` | Inspect versions and metadata for `card.json`, `brief.md`, `status.md`, and `review.md`. |
| `create_card` | Create `card.json` plus initial `brief.md`. |
| `patch_card` | Patch card structure fields and/or `brief.md`. |
| `reorder_child` | Reorder children of a non-running parent by committing changed `card.json` records. |
| `cancel_card` | Cancel obsolete work by committing changed `card.json` while paused. |
| `delete_card` | Remove cards/subtrees from the active index while moving their full record namespaces to archive storage. |
| `queue_notification` | Steer active/running cards without direct mutation. |

Tools to remove or avoid as Analyst card-specific tools:

- `get_card_output`: replaced by record URLs and generic reads.
- `get_card_record`: unnecessary if generic reads support `record://`.
- `edit_card`: replaced by `patch_card`.
- `write_card_record`: internalized by `patch_card` and runtime callers through commit primitives.
- `move_card`: not needed.
- `restart_card`, `restart_goal`, `restart_card_or_subtree`: not needed for Analyst card steering.
- `archive_card`: use `delete_card`; deletion archives records under the hood instead of removing them.
- `abort_goal_subtree`: use `cancel_card` for dormant work and `queue_notification` for running work.
- `activate_card`: planner/runtime authority.
- Planner report tools: planner authority.

## State Rules

| Card status | Create child | Patch card/brief | Reorder siblings | Cancel | Delete/archive data |
|---|---:|---:|---:|---:|---:|
| `backlog` | yes | yes | yes | yes | yes |
| `changed` | yes | yes | yes | yes | yes |
| `blocked` | yes | yes | yes | yes | yes |
| `done` | yes | yes | yes | no | yes |
| `failed` | yes | yes | yes | no | yes |
| `cancelled` | yes | yes | yes | no | yes |
| `needs_verification` | yes | yes | yes | yes | yes |
| `running` | no | notify only | no | notify only | no |

All Analyst mutations require paused runtime. Patches may target running cards while paused if touched records are closed and schemas/invariants pass. Structural mutations that invalidate running subtrees remain denied unless designed explicitly later.

## Delete/Archive Semantics

The public tool is `delete_card` because the operator intent is to remove cards from the active project. The implementation archives data rather than destroying it.

Rules:

- Move every deleted card's full record namespace, including all slots and all versions, to an archive directory.
- Preserve enough index metadata to inspect archived records for forensic purposes.
- Commit a new parent `card.json` version when the deleted card is removed from the active hierarchy.
- Remove deleted cards from the active in-memory index.
- Do not keep an active soft-delete flag on `card.json`.

## Implementation Phases

### Phase 1: Slot Registry And Commit Metadata

- Add `RecordSlotDefinition` registry keyed by card type and slot path.
- Add `card.json` and `brief.md` schemas.
- Extend slot indexes to persist writer, committed timestamp, size, format, schema, `cardVersionSeq`, and `globalSeq` for closed versions.
- Add project-wide monotone `globalSeq` allocation for committed record metadata.

### Phase 2: Commit Primitives

- Implement `commitRecord`.
- Implement `commitRecordBatch` with project/card-store locking and best-effort write-new-file/write-new-index/atomic-rename-index semantics.
- Refactor existing terminal record close paths to use shared finalization internals.
- Add synchronous active-processor callback dispatch.

### Phase 3: Generic Record Reads

- Teach `read_file` to resolve `record://...` URLs with `card` and optional `v` query params.
- Add `read_record_metadata`.
- Ensure containment checks resolve only inside `.saivage/outputs/cards/<card>/<slot>/`.

### Phase 4: Record-Backed CardStore Loader

- Load latest closed `card.json` records at startup.
- Build in-memory parent/child/dependency indexes.
- Validate card schemas and hierarchy invariants.
- Keep current synchronous read API backed by the loaded index.

### Phase 5: Record-Backed Mutations

- Change create/update/status/reorder/delete/cancel paths to produce new `card.json` documents.
- Commit single-card mutations through `commitRecord`.
- Commit multi-card mutations through `commitRecordBatch`.
- Remove writes to old card persistence once equivalent paths are covered.

### Phase 6: Brief Record Migration

- Create `brief.md` for new cards.
- Migrate existing `description` and `acceptance` into `brief.md`.
- Update planner/executor/reviewer prompt assembly to read `brief.md`.
- Remove `description`, `acceptance`, and `instructions_file` from `CardRecord` after all runtime code uses `brief.md`.

### Phase 7: Enriched Reads And Analyst Patch Tool

- Update `get_card` to return record summaries and bounded inline snippets.
- Add `patch_card`.
- Update Analyst prompt/tool descriptions.
- Remove broad `edit_card` after `patch_card` is complete.

### Phase 8: Remove Old Persistence/History

- Remove separate card history files after `card.json` version history covers mutation history.
- Remove card-output-specific reads after generic record reads cover status/review inspection.
- Remove compatibility code and old field aliases.

### Planner Diary

`get_plan_diary` is currently used by the Analyst surface and UI. The diary stores planner invocations, planner decisions, card mutations, failure handling, and embedded review assessments as an append-only log.

For this refactor, keep planner diary separate. It serves as a planning-event log, not current card state or current authored record content. Converting it to record storage would require append-only slot semantics, which this design intentionally avoids.

Revisit diary storage only after record-backed cards are implemented and the remaining diary use cases are clearer.

## Validation

Add focused tests for:

- `commitRecord` rejects unauthorized writers.
- `commitRecord` rejects unknown slots for a card type.
- `commitRecord` rejects invalid `card.json` and invalid `brief.md` content without creating a version.
- `commitRecord` rejects Analyst writes when the runtime is not paused.
- `commitRecord` rejects Analyst writes to an open latest version.
- `commitRecordBatch` preflights all records before writing.
- `commitRecordBatch` writes new version files and atomically renames new indexes under lock.
- `read_file` reads latest and versioned `record://` URLs.
- `read_record_metadata` returns slot policy and version metadata.
- `CardStore` loads from latest `card.json` records.
- structural mutations create new `card.json` versions.
- card history/diff can be reconstructed from `card.json` versions.
- effective update time is computed from record metadata instead of stored `updated_at`.
- `get_card` returns card state, record URLs, and bounded snippets.
- active processor `onRecordWritten` is called synchronously after commit.
- no active processor is required for a successful commit.
- card actors reconcile from latest records on activation.
- `patch_card` commits `card.json` and `brief.md` in one batch and propagates once.
- Analyst edits queue affected-card notifications for runtime unpause.
- `delete_card` moves full record namespaces with all versions to archive storage.
- prompt assembly uses `brief.md` as source of truth.
