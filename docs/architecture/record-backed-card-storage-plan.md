# Record-Backed Card Storage Plan

Status: obsolete planning document. Keep for historical design context only. Current remaining work, drift decisions, and execution order are consolidated in [Remaining Work Consolidated Plan](./remaining-work-consolidated-plan.md). The record-backed card storage architecture remains relevant, but this document's remaining-work checklist is superseded.

## Remaining Work

- Add the audited Analyst `write` surface for `record://brief.md?card=<id>&v=next`, gated on stopped-or-paused runtime status and closed latest versions.
- Finish `get_card` read-model parity by adding `effective_updated_at` computed from current card/document record metadata.
- Finish the brief source-of-truth cutover by removing `description`, `acceptance`, and `instructions_file` after all card creation, prompt, and API paths use `brief.md` directly.
- Remove the retired `get_card_output` executable surface once durable record URLs and generic file reads fully cover card-output inspection.
- Update authoritative specs to describe stopped-or-paused Analyst card management and record-backed card documents.

## Decision Summary

Use the same versioned record structure for card state and card-authored documents.

- `card.json` is the **canonical persisted card state**, not a projection, but it is an internal storage format rather than a functional `record://` file exposed to agents.
- The in-memory `CardStore` becomes an index/cache loaded from latest `card.json` records.
- Structured card mutation history is `card.json` version history.
- Related intent text is one record, `record://brief.md`, not separate goal/instructions/acceptance records.
- Keep separate records only when ownership/timing differs: `brief.md`, `status.md`, `review.md`.
- Do not add `result.json` initially. Structured outputs that matter to scheduling, review, or display belong directly in `card.json`; narrative outputs belong in `status.md` or `review.md`.
- All writes use shared commit infrastructure. There is no batch/transaction primitive; multi-card structural changes apply as a sequence of single-card commits. In case of dirty shutdown mid-sequence, recovery is best-effort and partial state is acceptable.
- Analyst card mutations are accepted only while runtime status is `stopped` or `paused`. They are committed while autonomous execution is inactive and announced to affected cards when the runtime resumes or starts.
- There is no broad card edit tool. Card structure changes happen through semantic card operations; document changes happen through scheme-aware `write` on writable record slots.

This is a brave refactor, but it removes duplicate persistence models and makes versioned storage uniform.

## Non-Goals

- Do not keep the existing card-history store as a second source of history after cutover.
- Do not split card intent into separate `goal.md`, `instructions.md`, and `acceptance.md` records.
- Do not add `result.json` until a concrete structured-result need cannot be represented cleanly in `card.json`.
- Do not add record-level read permissions. Any agent can read card records.
- Do not encode lifecycle behavior, propagation policy, append-only policy, or required-at-state rules in record slot metadata.
- Do not expose raw writes into the record namespace.
- Do not keep compatibility aliases after the new card API is cut over.
- Do not attempt crash-proof multi-file transaction recovery. Recovery is best-effort after unexpected write failures.
- Do not add a batch/transaction commit primitive. Structural mutations are a sequence of single-card commits; dirty shutdown mid-sequence may leave partial state and the runtime is expected to recover on its own.
- Do not implement migration/adapters for old on-disk card structures. This project has a zero-backward-compatibility policy; cut over by rewriting/removing the old persistence shape.

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
| `record://brief.md` | markdown | analyst, planner | Goal, instructions, acceptance criteria, and other operator/planner intent. |
| `record://status.md` | markdown | planner, executor | Planner/executor status report or completion narrative. |
| `record://review.md` | markdown | reviewer | Reviewer assessment. |

Slot availability may vary by card type. The commit path rejects unknown slots for the target card type unless the slot registry explicitly allows them. The internal `card.json` storage document follows the same versioned/indexed storage mechanics, but agents do not address it through `record://card.json`; they use card operations and `get_card`.

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
  created_by: CreatedBy;
  created_at: string;
  version_seq: number;
  depends_on?: string[];
  metrics?: Record<string, number | string | boolean | null> | null;
  started_at?: string | null;
  duration_ms?: number | null;
  latest_self_report?: Record<string, unknown> | null;
  retries: number;
}
```

Do not store narrative status text in `card.json`. `status.md` is the source for planner/executor status narrative.

Do not store `updated_at` in `card.json`. `get_card` calculates effective update time dynamically from latest `card.json`, `brief.md`, `status.md`, and `review.md` metadata.

`version_seq` is the logical card version and must match the `card.json` slot version. If `card.json` version 12 is current, its document contains `version_seq: 12`.

Audit the current `CardRecord` fields before freezing the new schema. The target shape above intentionally omits `tags`, `priority`, `urgency`, `related`, `metadata`, and `estimate`; add any of them back only if the audit finds concrete current consumers. Keep fields such as `depends_on` only if scheduling still uses them, and expose changes through narrow semantic operations rather than broad card editing. Runtime-owned fields such as `status`, `lifecycle`, `started_at`, `duration_ms`, `retries`, `metrics`, and `latest_self_report` are not directly editable by the Analyst.

Remove long-form intent fields from `card.json` during cutover:

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
- one `write` call can update the whole intent coherently.

## Record URLs

Use the existing concrete URL shape for agent-visible record files unless a separate URL cleanup is planned:

```text
record://brief.md?card=card-1
record://brief.md?card=card-1&v=2
```

Rules:

- A URL without `v` resolves to the latest closed version.
- A URL with `v` resolves to that concrete version.
- `card` is required for generic file reads.
- Tool responses may show short paths like `record://brief.md`, but generic reads must receive concrete URLs with `card`.

## Read Access

Generic file reads support agent-visible record URLs:

```ts
read({ path: 'record://brief.md?card=card-1' })
read({ path: 'record://review.md?card=card-1&v=3' })
```

Use `read` metadata/read-mode behavior for record metadata:

```ts
read({ path: 'record://brief.md?card=card-1', read_mode: 'metadata' })
```

Metadata reads return:

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

`get_card` is the functional read model for primary card information. It is assembled from latest internal card storage plus record indexes and may include URLs for associated document records:

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

`get_card` should include an `effective_updated_at` field computed as the max committed timestamp across the current internal card version, `brief.md`, `status.md`, and `review.md` records.

Do not expose the primary card document through `read({ path: "record://card.json?..." })`. That storage path is an implementation detail; card state is read through `get_card`.

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
12. Record a control action/audit entry when the caller is an operator-facing tool.
13. Return the committed record descriptor.

No version is committed if authorization, format validation, or schema validation fails.

### Existing Open/Close Terminal Records

Keep the existing `openRecordSlot` / `closeOpenRecordSlot` terminal-tool flow for `status.md?v=next` and `review.md?v=next`, but make close/finalization share validation, metadata, audit, and hook internals with `commitRecord`.

The split is:

- Open phase: allocate a tentative next version and mark it `open` in the slot index.
- Write phase: the terminal actor writes content to the open version file.
- Close phase: validate format/schema, write a complete new index, atomically rename it over the old index, and audit when the caller is an operator-facing tool.
- `commitRecord`: performs open, write, and close in one call.

When a card processor actor changes state, it commits any uncommitted record files it owns. Other lifecycle events may also force commits; for example, activating a child card may commit the child card and all its open records.

Multi-card structural mutations (create card + initial brief, reorder children, cancel/delete subtree, dependency changes) apply as a sequence of single-card `commitRecord` calls under the project/card-store lock. There is no batch primitive. In case of dirty shutdown mid-sequence, recovery is best-effort; partial state is acceptable and the runtime is expected to reconcile on its own.

## Analyst Mutation Rules

Analyst card mutations are intentionally permissive but only while runtime status is `stopped` or `paused`.

Rules:

- If runtime status is `running` or `error`, Analyst `write(record://...)`, `create_card`, `reorder_child`, `cancel_card`, and `delete_card` fail with a runtime-state error.
- Paused runtime means no actor is executing, but cards may still have `running` or other active statuses. Stopped runtime has left autonomous execution.
- The Analyst may write a running card's `brief.md` while paused if the latest version is closed and the new content passes schema checks.
- Structural mutations that would invalidate an active subtree remain denied for `running` cards unless explicitly designed later.
- Analyst record writes fail when the target slot has an open latest version.
- Analyst changes are committed while runtime status is `stopped` or `paused`.
- On resume/start, the runtime queues notifications for affected cards. Prefer one notification per affected card; one notification per edited item is acceptable when that is simpler.
- Notifications tell running/active agents that unexpected card records changed while the runtime was paused.

## Processor Reconciliation

Commit correctness does not depend on notifying live processor instances. Processors reconcile from latest records when they start, resume, or prepare their next model input. Do not add a synchronous `onRecordWritten` hook unless a concrete reconciliation failure proves it is needed.

## Card Store Refactor

The final `CardStore` should be an in-memory index/cache over latest `card.json` records.

Responsibilities:

- load latest closed `card.json` for every active card at startup,
- validate all loaded card schemas,
- build parent/child/dependency indexes,
- serve synchronous reads from memory,
- implement mutations by producing new `card.json` documents and committing them through `commitRecord`,
- invalidate/reload after external record commits when necessary,
- preserve current sync mutation behavior for callers.

The old card persistence and separate card history files should be removed after the store is fully record-backed.

## Record-Aware File Writes

Do not add a broad card-edit tool. Card structure is not a general user-editable document. Primary card state is read through `get_card` and changed through semantic card operations such as `create_card`, `reorder_child`, `cancel_card`, and `delete_card`.

Use the existing `write` tool for document records. When the path uses the `record://` scheme, `write` routes through record storage rather than performing a raw filesystem write.

`write(record://...)` behavior depends on caller context:

| Caller | Behavior |
|---|---|
| Analyst/operator | Requires runtime status `stopped` or `paused`, requires latest version closed, validates writer/schema, writes and commits a new version immediately, queues affected-card notifications for resume/start. |
| Card processor actor | May write an open/uncommitted version owned by that actor/session; commit happens on processor state change or other processor-defined commit points. |
| Runtime/card service | May commit records directly for lifecycle/state transitions. |

Shared rules:

- If latest version is closed, an actor write can open the next version and an Analyst/operator write creates and closes the next version in one operation.
- If latest version is open and owned by the same actor/session, actor writes update that open version.
- If latest version is open and owned by another actor/session, the write fails.
- Schema validation must happen before committed versions close. Cheap validation may also happen on write.
- Analyst writes to open records fail.
- Analyst writes to primary card state are not supported; primary card changes use semantic operations.

## Other Card Tools

Target card-facing tools:

| Tool | Purpose |
|---|---|
| `list_cards` | Query/filter cards from the in-memory card index. |
| `get_tree` | Inspect hierarchy from the in-memory card index. |
| `get_card` | Compact card read model with card state, record URLs, and snippets. |
| `read` | Read `record://` URLs returned by `get_card`, including metadata/read-mode inspection for `brief.md`, `status.md`, and `review.md`. |
| `create_card` | Create `card.json` plus initial `brief.md`. |
| `write` | Write writable `record://` document slots such as `brief.md`. |
| `reorder_child` | Reorder children of a non-running parent by committing changed `card.json` records. |
| `cancel_card` | Cancel obsolete work by committing changed `card.json` while stopped or paused. |
| `delete_card` | Remove cards/subtrees from the active index while moving their full record namespaces to archive storage. |
| `queue_notification` | Steer active/running cards without direct mutation. |

Tools to remove or avoid as Analyst card-specific tools:

- `get_card_output`: replaced by record URLs and generic reads.
- `get_card_record`: unnecessary if generic reads support `record://`.
- Broad card-edit surfaces are unnecessary. Use `write(record://...)` for document records and semantic card operations for structure/lifecycle.
- `move_card`: not needed.
- `restart_card`, `restart_goal`, `restart_card_or_subtree`: not needed for Analyst card steering.
- `archive_card`: use `delete_card`; deletion archives records under the hood instead of removing them.
- `abort_goal_subtree`: use `cancel_card` for dormant work and `queue_notification` for running work.
- `activate_card`: planner/runtime authority.
- Planner report tools: planner authority.

## State Rules

| Card status | Create child | Write brief | Reorder siblings | Cancel | Delete/archive data |
|---|---:|---:|---:|---:|---:|
| `backlog` | yes | yes | yes | yes | yes |
| `changed` | yes | yes | yes | yes | yes |
| `blocked` | yes | yes | yes | yes | yes |
| `done` | yes | yes | yes | no | yes |
| `failed` | yes | yes | yes | no | yes |
| `cancelled` | yes | yes | yes | no | yes |
| `needs_verification` | yes | yes | yes | yes | yes |
| `running` | no | yes while paused | no | notify only | no |

All Analyst mutations require runtime status `stopped` or `paused`. `write(record://brief.md?card=...)` may target running cards while paused if the touched slot is Analyst-writable, closed, and schema-valid. Structural mutations that invalidate running subtrees remain denied unless designed explicitly later.

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
- Refactor existing terminal record close paths to use shared finalization internals.

### Phase 3: Generic Record Reads

- Teach `read` to resolve `record://...` URLs with `card` and optional `v` query params, including metadata/read-mode behavior.
- Ensure containment checks resolve only inside `.saivage/outputs/cards/<card>/<slot>/`.

### Phase 4: Record-Backed CardStore Loader

- Load latest closed `card.json` records at startup.
- Build in-memory parent/child/dependency indexes.
- Validate card schemas and hierarchy invariants.
- Keep current synchronous read API backed by the loaded index.

### Phase 5: Record-Backed Mutations

- Change create/update/status/reorder/delete/cancel paths to produce new `card.json` documents.
- Commit mutations through `commitRecord`; multi-card structural changes apply as a sequence of single-card commits under the project/card-store lock.
- Remove writes to old card persistence once equivalent paths are covered.

### Phase 6: Brief Record Cutover

- Create `brief.md` for new cards.
- Cut over existing development/runtime fixtures by rewriting them into the new shape or deleting/regenerating them. Do not add compatibility migration code.
- Update planner/executor/reviewer prompt assembly to read `brief.md`.
- Remove `description`, `acceptance`, and `instructions_file` from `CardRecord` after all runtime code uses `brief.md`.

### Phase 7: Enriched Reads And Record-Aware File Writes

- Update `get_card` to return record summaries and bounded inline snippets.
- Extend `write` to support schema-aware `record://` writes with actor-specific open/commit behavior.
- Update Analyst prompt/tool descriptions.
- Remove broad card-edit designs.

### Phase 8: Remove Old Persistence/History

- Remove separate card history files after `card.json` version history covers mutation history.
- Remove card-output-specific reads after generic record reads cover status/review inspection.
- Remove compatibility code and old field aliases.

## Validation

Add focused tests for:

- `commitRecord` rejects unauthorized writers.
- `commitRecord` rejects unknown slots for a card type.
- `commitRecord` rejects invalid `card.json` and invalid `brief.md` content without creating a version.
- `commitRecord` rejects Analyst writes when runtime status is neither `stopped` nor `paused`.
- `commitRecord` rejects Analyst writes to an open latest version.
- `read` reads latest and versioned `record://` URLs.
- `read` metadata/read-mode behavior returns slot policy and version metadata.
- `CardStore` loads from latest `card.json` records.
- structural mutations create new `card.json` versions.
- card history/diff can be reconstructed from `card.json` versions.
- effective update time is computed from record metadata instead of stored `updated_at`.
- `get_card` returns card state, record URLs, and bounded snippets.
- card actors reconcile from latest records on activation.
- Analyst `write(record://brief.md?card=...)` commits a new `brief.md` version while stopped or paused and queues resume/start notifications.
- Analyst edits queue affected-card notifications for runtime resume/start.
- `delete_card` moves full record namespaces with all versions to archive storage.
- prompt assembly uses `brief.md` as source of truth.
