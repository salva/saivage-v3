# Record-Backed Card Storage Plan

Status: proposal. Scope: card storage, record access, record commit infrastructure, and card-facing tools. This plan does not change non-card Analyst tools.

## Goal

Store every card-facing document as a durable record and expose card state through the same record access model. Reads should be broad and file-like. Writes should be narrow, role-checked, schema-aware, audited, and routed through one commit primitive.

Target properties:

- Every card has a readable `record://card.json` document.
- Every durable card artifact is reachable through a `record://` URL.
- Any agent can read any card record through generic file read/metadata APIs.
- Writes are allowed only through specialized code paths that validate the writer role and optional record schema.
- Planner goals and instructions are records, not only fields embedded in card JSON.
- Actor/runtime code uses the same commit infrastructure as Analyst-facing write tools.

## Non-Goals

- Do not add record-level read permissions. Records are visible to all agents.
- Do not encode lifecycle behavior in record slot metadata.
- Do not add append-only policy, lifecycle-effect policy, or propagation policy to record slot definitions.
- Do not expose raw writes into the record namespace.
- Do not preserve compatibility aliases for old card-output/history tools once the record API replaces them.

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

- `path`: symbolic record path within a card context, such as `record://card.json` or `record://goal.md`.
- `format`: basic parser/serializer expectation.
- `writers`: roles allowed to commit this record directly.
- `schema`: optional validator name for slots that require structure beyond basic format.

Required-at-state rules, renewed-record requirements, propagation, and lifecycle effects belong in card processor/runtime code.

## Core Records

Initial target slots:

| Record | Format | Writers | Purpose |
|---|---|---|---|
| `record://card.json` | json | runtime | Canonical card state document: id, type, status, parent, children, dependency metadata, record index, lifecycle summary. |
| `record://goal.md` | markdown | analyst, planner | Goal/objective text for project and goal cards. |
| `record://instructions.md` | markdown | analyst, planner | Operational instructions for the card. |
| `record://acceptance.md` | markdown | analyst, planner, reviewer | Acceptance criteria or review expectations. |
| `record://status.md` | markdown | planner, executor | Current role-owned status report. |
| `record://review.md` | markdown | reviewer | Reviewer assessment. |
| `record://result.json` | json | executor, planner, reviewer | Structured result when a role needs machine-readable output. |

The exact slot set can be refined by card type. The infrastructure should not require every slot to exist on every card.

## Read Access

Generic file tools should understand `record://` URLs in a card context.

Required capabilities:

- `read_file("record://card.json")`: read the current card document.
- `read_file("record://goal.md")`: read current record content.
- `read_file("record://review.md?v=3")`: read a specific record version.
- `read_file_metadata("record://review.md")`: read current version metadata and history summary.
- Equivalent metadata access via `read_file("record://review.md?metadata=true")` is acceptable if that is simpler for the existing file API.

`get_card` remains useful as the compact card read model. It should return:

- current card state and metadata,
- child summaries,
- dependency summaries,
- `record://card.json`,
- record index entries with URL, format, current version, size, modified time, writer, and optional schema,
- bounded inline snippets for main records such as `goal.md`, `instructions.md`, `status.md`, or `review.md`.

Card-specific record/history tools should become unnecessary once generic file read/metadata works for `record://` URLs.

## Commit Infrastructure

Create one shared commit primitive:

```ts
interface CommitRecordInput {
  cardId: string;
  path: `record://${string}`;
  writer: AgentRole;
  content: string;
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

1. Resolve the card and record slot.
2. Check `writer` is listed in the slot's `writers`.
3. Validate basic `format`.
4. Validate `schema` if configured.
5. Allocate the next version.
6. Write the content durably.
7. Update record index/metadata.
8. Audit the commit.
9. Call the active card processor hook synchronously if one exists.
10. Return the committed record descriptor.

No record version is committed if validation fails.

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
- Processors must reconcile from current records when they start or resume.
- The hook is for live refresh/notification only.

## Card JSON

`record://card.json` should be generated/committed by runtime-owned card storage, not manually edited by the Analyst.

It should include enough data for generic reads:

```json
{
  "id": "card-1",
  "type": "goal",
  "status": "changed",
  "parent": "project",
  "children": ["card-2", "card-3"],
  "depends_on": [],
  "related": [],
  "metadata": {
    "title": "...",
    "tags": [],
    "priority": 0,
    "urgency": "normal"
  },
  "records": [
    {
      "path": "record://goal.md",
      "url": "record://goal.md?v=4",
      "format": "markdown",
      "version": 4,
      "size": 1234,
      "modified_at": "2026-06-29T00:00:00.000Z",
      "writer": "planner",
      "schema": "goal_markdown_v1"
    }
  ],
  "lifecycle": {
    "started_at": null,
    "completed_at": null,
    "summary": null
  }
}
```

The exact JSON shape can be adjusted, but it should remain a readable card document rather than a hidden internal store detail.

## Analyst Card Tool Surface

Target card-facing tools:

| Tool | Purpose |
|---|---|
| `list_cards` | Query/filter cards. |
| `get_tree` | Inspect hierarchy. |
| `get_card` | Compact card read model with record URLs and snippets. |
| Generic `read_file` | Read `record://card.json` and record URLs returned by `get_card`. |
| Generic file metadata/history | Inspect record versions and metadata. |
| `create_card` | Create a card with initial metadata and required initial records. |
| `write_card_record` | Commit an approved record slot through `commitRecord`. |
| `edit_card_metadata` | Update structured metadata only. |
| `reorder_child` | Reorder children of a non-running parent. |
| `cancel_card` | Cancel non-running obsolete work. |
| `archive_card` | Archive/remove non-running cards/subtrees from the active tree. |
| `queue_notification` | Steer active/running cards without direct mutation. |

Tools to remove or avoid as card-specific tools:

- `get_card_output`: replaced by record URLs and generic reads.
- `get_card_record`: unnecessary if generic reads support `record://`.
- `list_card_history`, `get_card_history_entry`, `diff_card`: replaced by generic file metadata/history over `record://card.json` and record URLs.
- `edit_card`: too broad; split into `write_card_record` and `edit_card_metadata`.
- `move_card`: not needed.
- `restart_card`, `restart_goal`, `restart_card_or_subtree`: not needed for Analyst card steering.
- `delete_card`: use `archive_card`.
- `abort_goal_subtree`: use `cancel_card` for dormant work and `queue_notification` for running work.
- `activate_card`: planner/runtime authority.
- Planner report tools: planner authority.

## State Rules

| Card status | Create child | Write records/metadata | Reorder siblings | Cancel | Archive |
|---|---:|---:|---:|---:|---:|
| `backlog` | yes | yes | yes | yes | yes |
| `changed` | yes | yes | yes | yes | yes |
| `blocked` | yes | yes | yes | yes | yes |
| `done` | yes | yes | yes | no | yes |
| `failed` | yes | yes | yes | no | yes |
| `cancelled` | yes | yes | yes | no | yes |
| `needs_verification` | yes | yes | yes | yes | yes |
| `running` | no | notify only | no | notify only | no |

If a subtree contains a running card, direct subtree archive, reorder, and cancel are denied. Record writes to a non-running ancestor that contains running work may commit only through the normal record write path; the active processor is notified synchronously if present, and the processor/runtime reconciles from records.

## Migration Plan

1. Add record slot definitions and validators.
2. Add `commitRecord` and use it for existing planner/executor/reviewer record writes.
3. Add generic `record://` read support for `read_file`.
4. Add generic record metadata/history support.
5. Make `get_card` return `record://card.json`, record index entries, and bounded snippets.
6. Move planner goals/instructions/acceptance into records for new commits.
7. Add `write_card_record` and `edit_card_metadata`.
8. Replace Analyst card prompt/docs to prefer record reads/writes.
9. Remove card-specific output/history tools after generic record reads cover their use cases.

## Validation

Add focused tests for:

- `commitRecord` rejects unauthorized writers.
- `commitRecord` rejects invalid schema content without creating a version.
- `commitRecord` writes a durable new version and updates metadata.
- `read_file` can read current and versioned `record://` URLs.
- file metadata/history works for `record://card.json` and other records.
- `get_card` returns record URLs and bounded snippets.
- active processor `onRecordWritten` is called synchronously after commit.
- no active processor is required for a successful commit.
- card actors reconcile from records on activation.
