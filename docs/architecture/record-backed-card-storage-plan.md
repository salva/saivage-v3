# Record-Backed Card Storage Plan

Status: proposal. Scope: card storage, authored card records, record access, record commit infrastructure, and card-facing tools. This plan does not change non-card Analyst tools.

## Decision Summary

The design is sound if the card store and the record store keep distinct responsibilities:

- The **card store remains the source of truth** for card identity, hierarchy, status, lifecycle state, ordering, dependencies, and mutation history.
- **Authored card content becomes records**: goal text, instructions, acceptance criteria, status reports, reviews, and structured results.
- `get_card` is the bridge: it returns the card projection plus authored record URLs and bounded snippets.
- There is **no committed `record://card.json`**. A card JSON document is a projection returned by `get_card`, not a versioned record.
- Card mutation history remains card-store history. Record metadata/history covers authored record versions only.
- Writes use a shared `commitRecord` primitive and a unified card write tool shape: `patch_card({ metadata, records })`.
- Goal/instruction/acceptance records become the source of truth, while legacy `description`/`acceptance` card fields act as temporary projection caches during migration and are deleted later.

This is a large refactor, but it avoids a worse architecture where the system rebuilds the card store as a file-backed database or maintains two competing histories for card state.

## Non-Goals

- Do not make `card.json` a committed record.
- Do not add record-level read permissions. Any agent can read authored card records.
- Do not encode lifecycle behavior, propagation policy, append-only policy, or required-at-state rules in record slot metadata.
- Do not expose raw writes into the record namespace.
- Do not merge card mutation history and record version history into one storage mechanism.
- Do not keep compatibility aliases after the new card API is fully migrated.

## Architecture

### Card Store Responsibility

The card store owns structured card state:

- `id`, `type`, `parent`, `depth`, `position`, `children`
- `status`, `lifecycle`, runtime lifecycle fields
- `depends_on`, `related`
- metadata such as `title`, `tags`, `priority`, `urgency`
- card mutation history and diffs
- archive/delete operations
- structural operations such as child reordering

The card store should not become file-backed record storage. It can reference authored records, expose record summaries in read models, and keep temporary projection fields during migration, but it remains the transactional owner of card structure and lifecycle.

### Authored Record Responsibility

The record store owns role-authored content attached to a card:

- goal/objective text
- operating instructions
- acceptance criteria
- planner/executor status reports
- reviewer assessments
- structured role results when needed

Records are immutable versions within a slot. A new commit creates a new closed version for the slot.

### History Responsibility

Keep two explicit history axes:

| History | Owns | API |
|---|---|---|
| Card mutation history | structured card changes: status, metadata, hierarchy, lifecycle | existing card history/diff API, possibly renamed but not merged into record metadata |
| Record version history | authored content versions per record slot | `read_record_metadata(record://...)` |

This separation prevents fake `card.json` versions and avoids duplicating every card mutation into record storage.

## Record Slot Definition

Keep slot policy minimal:

```ts
interface RecordSlotDefinition {
  path: `record://${string}`;
  format: 'json' | 'markdown' | 'text';
  writers: readonly AgentRole[];
  schema?: string;
}
```

Meaning:

- `path`: symbolic record path within a card context, such as `record://goal.md`.
- `format`: basic parser expectation.
- `writers`: roles allowed to commit this record directly.
- `schema`: optional validator name for slots that require structure beyond basic format.

Card processor/runtime code owns required-at-state checks, renewed-record requirements, propagation, and lifecycle effects.

## Initial Slots

| Record | Format | Writers | Purpose |
|---|---|---|---|
| `record://goal.md` | markdown | analyst, planner | Goal/objective text for project and goal cards. Source of truth for migrated goal text. |
| `record://instructions.md` | markdown | analyst, planner | Operating instructions for the card. |
| `record://acceptance.md` | markdown | analyst, planner, reviewer | Acceptance criteria or review expectations. Source of truth for migrated acceptance text. |
| `record://status.md` | markdown | planner, executor | Current role-owned status report. |
| `record://review.md` | markdown | reviewer | Reviewer assessment. |
| `record://result.json` | json | executor | Structured executor result when machine-readable output is needed. |

Slot availability may vary by card type. The commit path should reject unknown slots for the target card type unless the slot registry explicitly allows them.

## Record URLs

Use the existing concrete URL shape unless a separate URL cleanup is planned:

```text
record://goal.md?card=card-1
record://goal.md?card=card-1&v=4
```

Rules:

- A URL without `v` resolves to the latest closed version.
- A URL with `v` resolves to that concrete version.
- `card` is required for generic file reads, because generic tools do not otherwise know the card context.
- Tool results may also return relative display paths like `record://goal.md`, but generic reads must receive a resolvable URL that includes the card id.

## Read Access

Generic file reads should support record URLs:

```ts
read_file({ path: 'record://goal.md?card=card-1' })
read_file({ path: 'record://review.md?card=card-1&v=3' })
```

Add a distinct metadata API instead of overloading content reads:

```ts
read_record_metadata({ path: 'record://goal.md?card=card-1' })
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
    url: string;
  }>;
  format: 'json' | 'markdown' | 'text';
  schema?: string;
  writers: readonly AgentRole[];
}
```

Open versions are an implementation detail for terminal-tool flows and should not be exposed as writable user targets.

## `get_card` Read Model

`get_card` remains the primary compact card read. It should return card state plus record summaries:

```ts
interface CardRecordSummary {
  path: `record://${string}`;
  url: string; // includes card and latest version when available
  latest: number | null;
  format: 'json' | 'markdown' | 'text';
  schema?: string;
  writers: readonly AgentRole[];
  size: number | null;
  modifiedAt: string | null;
  writer: AgentRole | null;
  inline?: {
    content: string;
    truncated: boolean;
  };
}

interface GetCardView {
  card: CardRecord;
  children: CardRefView[];
  dependencies: CardRefView[];
  records: CardRecordSummary[];
}
```

Inline snippets should be bounded. Good initial inline candidates are `goal.md`, `instructions.md`, `acceptance.md`, latest `status.md`, and latest `review.md`.

## Commit Infrastructure

Create one shared commit primitive for closed record versions:

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

1. Verify the card exists.
2. Resolve the record slot for the card type.
3. Check `writer` is listed in the slot's `writers`.
4. Validate basic `format`.
5. Validate `schema` if configured.
6. Allocate the next version from the slot index.
7. Write content durably.
8. Mark the version closed in the slot index.
9. Store writer/committed-at metadata in the slot index.
10. Record a control action/audit entry.
11. Refresh any temporary card projection fields for source records such as `goal.md` or `acceptance.md`.
12. Call active card processor `onRecordWritten` synchronously if one exists.
13. Return the committed record descriptor.

No version is committed if authorization, format validation, or schema validation fails.

### Existing Open/Close Terminal Records

The existing `openRecordSlot` / `closeOpenRecordSlot` path is useful for terminal-tool flows that require the model to write `record://status.md?v=next` or `record://review.md?v=next`. Keep that path, but make `closeOpenRecordSlot` call the same validation/index/audit/finalization internals as `commitRecord`.

The target implementation should have one internal finalization routine used by both:

- direct closed commits from `commitRecord`,
- open/close commits from terminal-tool recovery/runtime flows.

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
- The commit does not depend on the hook for correctness.
- If no active processor exists, nothing special happens.
- Processors must reconcile from current card state and records when they start or resume.
- The hook is for live refresh/notification only.

## Projection Fields During Migration

Goal/instruction/acceptance records become the source of truth. During migration, keep existing card fields as projections so current readers continue to work:

| Card field | Source record | Migration behavior |
|---|---|---|
| `description` | `record://goal.md` | Refreshed after successful `goal.md` commit. Eventually removed. |
| `acceptance` | `record://acceptance.md` | Refreshed after successful `acceptance.md` commit. Eventually removed. |
| `instructions_file` | `record://instructions.md` or removed | Replace with record URL exposure through `get_card`. |

Projection refresh must be deterministic and audited as part of the same high-level operation. It should not create a second user-visible record version.

## Unified Card Patch Tool

Replace broad `edit_card` and separate write-vs-metadata decisions with one cohesive card patch tool:

```ts
interface PatchCardInput {
  id: string;
  metadata?: {
    title?: string;
    tags?: string[];
    priority?: number;
    urgency?: Urgency;
    depends_on?: string[];
    related?: string[];
  };
  records?: Record<string, string>; // key is slot filename, e.g. "goal.md"
}
```

`patch_card` behavior:

1. Load target card.
2. Reject running target cards. Use `queue_notification` for running work.
3. Validate metadata patch with existing card store rules.
4. Validate every requested record slot through the slot registry.
5. Apply metadata mutation through `CardStore.mutateCard` if present.
6. Commit each record through `commitRecord`.
7. Propagate once after all successful changes.
8. Return updated `get_card` view plus commit descriptors.

Atomicity rule:

- Preflight all metadata and record validations before writing anything.
- If any validation fails, no metadata patch and no record commit occurs.
- Once durable writes begin, failures should throw loudly and leave audit/recovery breadcrumbs rather than silently pretending the patch was atomic across files.

This gives the Analyst one clear tool while preserving narrow, schema-aware write paths internally.

## Other Card Tools

Target card-facing tools:

| Tool | Purpose |
|---|---|
| `list_cards` | Query/filter cards. |
| `get_tree` | Inspect hierarchy. |
| `get_card` | Compact card read model with record URLs and snippets. |
| `read_file` | Read `record://` URLs returned by `get_card`. |
| `read_record_metadata` | Inspect record versions and metadata. |
| card history/diff tools | Inspect structured card mutation history. Keep separate from record metadata. |
| `create_card` | Create a card with initial metadata and required initial records. |
| `patch_card` | Apply metadata changes and/or commit authored records. |
| `reorder_child` | Reorder children of a non-running parent. |
| `cancel_card` | Cancel non-running obsolete work. |
| `archive_card` | Archive/remove non-running cards/subtrees from the active tree. |
| `queue_notification` | Steer active/running cards without direct mutation. |

Tools to remove or avoid as Analyst card-specific tools:

- `get_card_output`: replaced by record URLs and generic reads.
- `get_card_record`: unnecessary if generic reads support `record://`.
- `edit_card`: replaced by `patch_card`.
- `write_card_record`: internalized by `patch_card` and runtime callers through `commitRecord`.
- `move_card`: not needed.
- `restart_card`, `restart_goal`, `restart_card_or_subtree`: not needed for Analyst card steering.
- `delete_card`: use `archive_card`.
- `abort_goal_subtree`: use `cancel_card` for dormant work and `queue_notification` for running work.
- `activate_card`: planner/runtime authority.
- Planner report tools: planner authority.

## State Rules

| Card status | Create child | Patch metadata/records | Reorder siblings | Cancel | Archive |
|---|---:|---:|---:|---:|---:|
| `backlog` | yes | yes | yes | yes | yes |
| `changed` | yes | yes | yes | yes | yes |
| `blocked` | yes | yes | yes | yes | yes |
| `done` | yes | yes | yes | no | yes |
| `failed` | yes | yes | yes | no | yes |
| `cancelled` | yes | yes | yes | no | yes |
| `needs_verification` | yes | yes | yes | yes | yes |
| `running` | no | notify only | no | notify only | no |

If a subtree contains a running card, direct subtree archive, reorder, and cancel are denied. Patches to a non-running ancestor that contains running work may commit through the normal patch path; the active processor is notified synchronously if present, and the processor/runtime reconciles from records.

## Implementation Phases

### Phase 1: Slot Registry And Validation

- Add `RecordSlotDefinition` registry keyed by card type and slot path.
- Add validators for `markdown`, `json`, and `text` formats.
- Add schema validator dispatch by `schema` name.
- Extend record slot index entries to persist writer, committed timestamp, size, and schema/format metadata for closed versions.

### Phase 2: Shared Commit Primitive

- Implement `commitRecord`.
- Refactor existing terminal record close paths to use the same finalization internals.
- Add audit/control-action records for commits.
- Add synchronous active-processor callback dispatch.

### Phase 3: Generic Record Reads

- Teach `read_file` to resolve `record://...` URLs with `card` and optional `v` query params.
- Add `read_record_metadata`.
- Ensure containment checks resolve only inside `.saivage/outputs/cards/<card>/<slot>/`.

### Phase 4: Enriched `get_card`

- Add record summaries and bounded inline snippets to `get_card`.
- Include concrete readable URLs with `card` and latest `v` where available.
- Keep child/dependency summaries.

### Phase 5: Source Records And Projection Caches

- Create initial `goal.md`, `instructions.md`, and `acceptance.md` records for newly created cards.
- Make planner prompt assembly read goal/instruction/acceptance records first.
- Refresh `description` and `acceptance` projection fields after source-record commits.
- Add tests proving records are source of truth when projections differ.

### Phase 6: Analyst Patch Tool

- Add `patch_card` with preflight validation for metadata and records.
- Route metadata to `CardStore.mutateCard`.
- Route records to `commitRecord`.
- Run propagation once after all changes.
- Update Analyst prompt/tool descriptions.

### Phase 7: Remove Superseded Card Tools

- Remove `get_card_output` once record URLs cover status/review/result inspection.
- Remove broad `edit_card` after `patch_card` covers metadata and record writes.
- Remove any card-specific record reader once `read_file(record://...)` is stable.
- Keep card history/diff unless a separate card-history redesign is approved.

### Phase 8: Delete Projection Fields

- After all runtime code reads records for goal/instruction/acceptance, remove `description`, `acceptance`, and `instructions_file` from `CardRecord`.
- Update schemas, tests, docs, and card history projections accordingly.

## Validation

Add focused tests for:

- `commitRecord` rejects unauthorized writers.
- `commitRecord` rejects unknown slots for a card type.
- `commitRecord` rejects invalid format/schema content without creating a version.
- `commitRecord` writes a durable new version and updates metadata.
- existing terminal record close paths use the same validation/finalization as direct commits.
- `read_file` can read latest and versioned `record://` URLs.
- `read_record_metadata` returns slot policy and version metadata.
- `get_card` returns record URLs and bounded snippets.
- active processor `onRecordWritten` is called synchronously after commit.
- no active processor is required for a successful commit.
- card actors reconcile from current records on activation.
- `patch_card` preflights all changes before writing.
- `patch_card` commits metadata and records, then propagates once.
- planner prompt assembly uses records as source of truth.
- temporary projection fields refresh after source-record commits.
