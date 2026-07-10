# Agent Conversation UI Redesign Specification

Status: current design specification.

Date: 2026-06-30

## 1. Purpose

Agent conversations are the main observability surface for Saivage. The Analyst panel, Agents conversation detail, and Debug agents conversation detail are the three surfaces that render agent conversations. They must present the same conversation substrate with different density and diagnostic emphasis.

This specification adapts the Saivage v2 conversation UI direction to v3. It copies the feel and information hierarchy, not the old implementation details. V3 keeps its card-centered runtime, versioned conversations, right-rail Analyst panel, and Analyst-owned mutation boundary.

The target experience is:

- conversations read as a narrative first;
- tool calls scan as compact operational milestones, not JSON records;
- one click opens a human-readable detail prepared for operators;
- raw request/response payloads remain reachable through one shared escape hatch;
- file, URL, card, process, artifact, attachment, and child-conversation links are lateral navigation, not row expansion;
- repetitive context gathering may be grouped, while mutations, dispatches, diagnostics, activity-backed pending calls, and errors remain visible.

## 2. Source Material

The v2 source documents remain provenance for the visual direction:

- `saivage/docs/internals/opencode-gui-conversation-visualization-analysis.md`
- `saivage/docs/internals/agent-tool-visualization-design.md`

The relevant v2 principles are compact rows, restrained typography, role-tinted bubbles, round grouping, model chips, pending-call indicators, jump-to-latest behavior, grouped low-value context tools, lazy expanded details, and a universal raw-payload toggle.

V3 must not port v2's old server contracts, old file layout, transcript engine, or direct-chat control assumptions. Current authority remains `docs/spec/operator-ui.md` for UI behavior and `docs/architecture/system-architecture.md` for the versioned active-conversation substrate.

Phase 1 substrate work is landed for the non-compaction conversation path: agent conversations are versioned active transcripts, Debug uses the operator agent API as its conversation source, `system_prompt` entries reach the timeline and collapse by default in `ContextBlock`, and activity status is derived from actor snapshots. Conversation compaction is part of the active-version contract.

> Note on tool names: the compact labels and grouping examples in this document use the v2 tool vocabulary (`read`, `write`, `glob`, `grep`, `edit`, `apply_patch`, `websearch`, `webfetch`, `run_command`, `git_*`, `run_*`, `plan_*`, `rag_*`, `memory` family). V3's actual tool surface differs in places. The display registry must be keyed to the v3 runtime `InvocationSurface`/provider-owned tool definitions when this redesign is implemented; the v2 labels are kept here as the target vocabulary because they read better than the current v3 names. Aligning the v3 tool set to this vocabulary is specified in [Tool Set Reorganization Design](./tool-set-reorganization-design.md) and is the Phase 2 prerequisite for this redesign.

## 3. Shared Conversation Model

All three conversation surfaces render the same conversation model from backend entries. The API is the source of truth for raw entries; grouping and display-model construction are deterministic view-side passes and do not synthesize transcript rows.

```ts
type ConversationTimeline = {
  rounds: ConversationRound[];
  activeRoundId: string | null;
};

type ConversationRound = {
  id: string;
  kind: 'user' | 'assistant' | 'diagnostic' | 'compacted';
  position: number;
  modelSpec: string | null;
  texts: AgentConversationEntry[];
  diagnostics: AgentConversationEntry[];
  items: ConversationItem[];
  /**
   * Live execution state for the active round only.
   * Derived from the actor snapshot read model, not from the transcript itself.
   * Surfaces in-flight provider calls, pending tool deliveries, retry/backoff,
   * and attempt counts. Null for idle or past rounds.
   */
  activityStatus: ActivityStatus | null;
};

type ConversationItem =
  | { kind: 'tool'; pair: ToolPair; display: ToolDisplayModel; detail: ToolDetailModel }
  | { kind: 'tool_group'; id: string; summary: ToolGroupSummary; pairs: ToolPair[] };
```

Server payloads expose stable `id`, `round_id`, `message_index`, `block_index`, `timestamp`, `kind`, `role`, `content`, `tool_name`, `tool_call_id`, `model`, and optional entity links. Conversation row and group IDs must be stable across polling and WebSocket invalidations: `round_id + tool_call_id` for tools and `round_id + contained tool_call_ids` for groups. The UI must not fill missing ordering fields, inspect `.saivage/agents` paths directly, or consume websocket transcript side channels to build the conversation timeline.

### Tool Display Model

Replace the current raw `FormattedContent` detail with a richer display/detail model generated alongside each tool pair.

```ts
type ToolCategory =
  | 'filesystem' | 'web' | 'shell' | 'git' | 'plan' | 'stage_artifact'
  | 'card' | 'dispatch' | 'skill' | 'memory' | 'rag' | 'note'
  | 'artifacts_and_attachments' | 'unknown';

type DisplayTone = 'neutral' | 'ok' | 'warn' | 'error' | 'pending';

type ToolDetailKind =
  | 'file_read' | 'directory_read' | 'file_write' | 'search_results'
  | 'web_results' | 'web_fetch' | 'command' | 'git_status' | 'git_diff'
  | 'git_log' | 'git_mutation' | 'plan_state' | 'plan_mutation'
  | 'stage_artifact' | 'card_mutation' | 'dispatch' | 'skill'
  | 'memory' | 'rag' | 'note' | 'artifact' | 'generic';

interface ToolDisplayModel {
  category: ToolCategory;
  action: string;          // friendly verb or role, Title Case
  target: InlinePart[];
  status: InlinePart[];
  tone: DisplayTone;
  groupable: boolean;
  mutation: boolean;
  important: boolean;      // dispatches, terminal tools, errors, artifacts
  detailKind: ToolDetailKind;
}

interface ToolDetailModel {
  title: string;
  subtitle: InlinePart[];
  facts: DetailFact[];
  sections: DetailSection[];
  links: DetailLink[];
}

interface DetailFact {
  label: string;
  value: InlinePart[];
  tone?: DisplayTone | 'muted';
}
```

`DetailSection` is a closed union; do not invent new section kinds per tool:

```ts
type DetailSection =
  | { kind: 'text'; title?: string; content: string }
  | { kind: 'code'; title?: string; language?: string; content: string; maxHeight?: number; truncated?: boolean }
  | { kind: 'terminal'; title?: string; stdout?: string; stderr?: string; exitCode?: number; maxHeight?: number; truncated?: boolean; logPath?: string }
  | { kind: 'diff'; title?: string; content: string; files?: string[]; maxHeight?: number }
  | { kind: 'table'; title?: string; columns: string[]; rows: InlinePart[][][] }
  | { kind: 'list'; title?: string; items: InlinePart[][] }
  | { kind: 'attachments'; title?: string; attachments: AttachmentSummary[] };

interface AttachmentSummary {
  mime: string;
  filename?: string;
  sizeBytes?: number;
  url?: string;     // record URL or stash path
}
```

Mapping guidance:

| Human concept | Section kind |
| --- | --- |
| File preview, skill body, memory body, note body | `code` or `text` |
| Command stdout/stderr | `terminal` |
| Diffs and patches | `diff` |
| Commit lists, directory entries, grep matches, web results, RAG hits, memory lists, stage reports | `table` |
| Short evidence, issues, outcomes, acceptance criteria | `list` |
| Images or fetched/read media | `attachments` |

### Inline parts and lateral links

```ts
type InlinePart =
  | { kind: 'text'; value: string; tone?: DisplayTone | 'muted' }
  | { kind: 'code'; value: string }
  | { kind: 'file'; path: string; root?: 'project' | 'saivage'; line?: number }
  | { kind: 'url'; url: string }
  | { kind: 'conversation'; agentId?: string; roundId?: string; label: string };

type DetailLink =
  | { kind: 'file'; label: string; path: string; root?: 'project' | 'saivage'; line?: number }
  | { kind: 'url'; label: string; url: string }
  | { kind: 'entity'; label: string; entityType: 'card' | 'process' | 'artifact' | 'attachment'; entityId: string }
  | { kind: 'conversation'; label: string; agentId?: string; roundId?: string };
```

The lateral link set matches v3's `EntityLink` surface (`card` | `process` | `artifact` | `attachment`) plus file paths and URLs. Blocked-content reviews are non-browseable summaries, not entity links. `conversation` links (navigate to a child or peer agent transcript) are **backend-gated**: the runtime does not yet expose stable child-agent or child-conversation references in dispatch results. The UI must render `conversation` links only when the backend provides the id. A child dispatch detail should never show a disabled fake link — show the child outcome summary, evidence, and issues instead, and add the conversation link when the backend wires it (tracked in Phase 1 backend work).

### Group summary

```ts
interface ToolGroupSummary {
  label: string;                 // e.g. 'Gathered context'
  counts: { kind: string; n: number }[];  // e.g. [{kind:'reads', n:5}, {kind:'searches', n:2}]
  tone: DisplayTone;             // neutral unless a member later fails
}
```

## 4. Round Structure

Rounds are retained. They are not replaced by a flat chat feed.

Each round renders in this order:

1. Compact round header.
2. User/system/assistant text blocks and system prompt blocks.
3. Diagnostic rows.
4. Tool rows and tool groups in entry order.
5. Activity footer for the active round.

Round headers show the role and only high-signal metadata:

```text
User round 4
Assistant round 5 via gpt-5.5
Diagnostic round 6
Compacted context · 18 entries
```

Model display uses an ambient rule: the first visible model in a transcript establishes the ambient model; later rounds show `via <model>` only when the model differs. Full model strings remain available in `title` text.

System prompts are rendered as collapsed `System prompt` blocks by default. Operators can expand them in Debug. Analyst hides them by default and reveals only behind a compact diagnostic disclosure because the right rail is narrow.

## 5. Tool Row Design

Tool calls use one shared row grammar on all three conversation surfaces:

```text
[chevron] [icon] [Action] [target........................] [status]
```

The row answers what action happened, what object it targeted, and what outcome matters. Examples:

```text
Read        package.json                         120 lines
Search      "ToolChip" in web/src                4 matches
Shell       npm run web:test:debugview          exit 0
Patch       web/src/components                   3 files changed
Planner     card-12                              created 4 cards
Executor    card-18                              completed
Reviewer    assessment card-18                   accepted
Process     wait dev-server                      still running
Plan        card tree                            updated
```

Rows must use friendly labels, not raw tool names, in the primary visual path. Raw tool names remain in accessible labels, tooltips, and raw payload details. The status chip is muted or omitted for uninteresting success; it is prominent for pending, warning, error, changed state, retries, truncation, generated artifacts, and child-agent outcomes.

Narrow layouts (Analyst rail, mobile) may wrap to two lines:

```text
[chevron] [icon] [Action] [status]
          [target........................]
```

## 6. Tool Details

Clicking a tool row expands a human-readable detail. It does not navigate away. Every tool detail uses the same skeleton:

```text
Header: action, target, status, timestamp
Summary: one or two operator-readable sentences or chips
Body: tool-specific human view (DetailSection[])
Links: files, URLs, cards, processes, artifacts, attachments, child conversations
Raw: shared request/response toggle
```

The detail body is not raw JSON decorated as Markdown. It is a formatter-driven projection into `DetailSection`s:

- file reads show path, range, truncation metadata, and a bounded preview (`code`/`text`);
- directory and search tools show grouped matches with clickable file/line links (`table`);
- shell/process tools show command, cwd when safe, exit code/status, bounded stdout/stderr tails, and log links (`terminal`);
- writes, edits, patches, and git diffs show changed files and diff-oriented summaries (`diff`);
- card mutations show card id, title, state transition, changed record URL, and resulting entity link (`card_mutation`);
- planner/executor/reviewer terminal tools show objective, outcome, summary, evidence, issues, and related cards (`dispatch`);
- Analyst tools show the operator-facing action, affected entity, audit/control-action id when present, and resulting navigation hint (`list`);
- RAG, memory, note, and artifact tools show the collection/key/path, counts, and saved artifacts (`table` + `attachments`);
- content-supervision tools show the reviewed source and review verdict as non-browseable summary metadata;
- unknown external tools show a generic friendly title plus selected scalar arguments, then raw payload access (`generic`).

The shared raw toggle is mandatory for every tool pair:

```text
[Raw request] [Raw response]
```

It is lazy-mounted and renders the original captured request/result/error. It is not the first-click experience.

## 7. Status Rules

Each tool pair resolves to one of five states. The compact row and the detail render each state consistently:

| Pair state | Compact status | Detail behavior |
| --- | --- | --- |
| pending | `running…` or a tool-specific pending phrase, pending tone | Show request facts and pending marker; raw response selector disabled with `No result recorded` |
| ok | tool-specific success outcome, neutral/ok tone | Show human result detail plus raw request/response |
| error | first meaningful error line, error tone | Show error section first, then request facts, then raw request/error |
| missing | `no result`, warn tone | Show request facts, missing-result warning, raw request only |
| unmatched result | `unmatched result`, warn tone | Show result facts if parseable as a diagnostic entry, raw response only |

A `missing` pair is a `tool_call` with no paired `tool_result`/`tool_error` in a completed round. A `tool_result`/`tool_error` whose `tool_call_id` does not match a real call is not promoted into a synthetic call row; if shown, it is a diagnostic transcript entry. Both can occur after compaction or after server restarts; the UI must not crash on either.

## 8. Malformed Payload And Renderer Containment

Tool call arguments and results arrive as strings. Display builders parse defensively:

1. Parse request `content` as JSON when possible.
2. Parse result `content` as an envelope when possible; unwrap `{ content: … }` where appropriate.
3. Keep the original request/result strings for raw display.
4. If parsing fails, fall back to generic display and preserve raw payload access.

| Failure | Compact row | Detail |
| --- | --- | --- |
| Request JSON does not parse | Friendly action from `tool_name` if known; target `unparsed request`; warn tone unless result is an error | Warning fact `Request payload could not be parsed`, then raw request toggle |
| Result JSON does not parse | `returned text` for success or first error line for error | Render result as capped `text`/`code`; raw response toggle remains available |
| Both fail to parse | Generic/external row with raw tool name and `unparsed payload` status | Capped raw text previews plus raw toggles |
| Parsed envelope shape is unexpected | Known tool compact action, generic target/status from available text | Use generic detail sections; do not throw |

Renderer failures must be contained. A formatter exception must never break the conversation view; it falls back to `detailKind: 'generic'` and keeps raw payload access.

## 9. Large And Stashed Results

Tool results can be far larger than the row or detail should render inline. Every projection that receives unbounded content must bound it and report the bound:

- `code`/`text` sections cap content to a display budget (default 8 KiB) and set `truncated: true` with the original size in a fact;
- `terminal` sections cap stdout/stderr tails to a display budget (default 8 KiB each) and link to the full log file when `logPath` is available;
- `diff` sections cap the diff body and list affected files separately;
- `table` sections cap rows (default 200) and show `N more rows truncated`;
- `attachments` sections never inline large media; they show mime, filename, and size with a navigation link.

When the runtime stashes a large raw result to disk, the compact row must surface the stash as a status chip (`stashed · 42 KiB`), not silently omit it. The detail links to the stash file through a `file` DetailLink. The raw payload toggle still renders the original captured payload; the stash is the navigation target, the payload toggle is the raw view.

## 10. Grouping Rules

Grouping is a view-side compression step. It is allowed only for adjacent, successful, read-only, low-value context operations.

Allowed groups:

| Group | Eligible examples | Conditions |
| --- | --- | --- |
| Gathered context | `read`, `glob`, `grep`, read-only card/session/file fetches | adjacent, successful, no error, no mutation |
| Checked git | `git_status`, `git_log`, read-only `git_diff` | adjacent, successful, no generated patch |
| Read plan | read-only card tree, runtime state, history reads | adjacent, successful |
| Web research | `websearch`, `webfetch` | adjacent, successful, no saved file mutation |

Never group:

- planner, executor, reviewer, or child-agent dispatch/terminal rows;
- Analyst-visible tool invocations that mutate or navigate;
- writes, edits, patches, process starts/stops/kills, git mutations, card mutations, record writes, plan mutations, memory mutations, RAG registrations/ingests/drops, and note creation;
- model diagnostics and compaction markers;
- pending, failed, missing, unmatched-result, retried, repaired, or warning rows.

Grouping decisions must consider both the parsed request and result. For example, `webfetch` is groupable only when the request has no `save_as` and the result did not create a saved file. If request parsing fails, default to ungrouped.

Group interactions:

| Interaction | Result |
| --- | --- |
| click group row | expands a list of contained compact rows |
| click contained row | expands that tool's human detail |
| raw payload | available per contained row, not at group level |

If a group later contains an error because of live updates, it must either split the failed member out as its own row or auto-expand with an error count.

## 11. Compaction Display

A compacted round (`kind: 'compacted'`) compresses prior history. The `CompactedCluster` must not dump every member's raw `content` inline. The target behavior:

- the cluster header shows the entry count and a one-line summary when the runtime provides one;
- the default body is collapsed and shows one inline summary line plus a `Show N compacted entries` disclosure;
- expanding reveals a bounded member list where each row is a compact `InlinePart` summary (role + kind + one-line content), not full raw payloads;
- per-member raw payload access is available through a secondary disclosure per row, never at the cluster level;
- if a compacted cluster contains an error or a mutation, surface it in the summary with an error/mutation count so it stays visible without forcing a full expansion.

The current `CompactedCluster.vue` renders every `entry.content` as a `<p>` tag — that is the raw-dump behavior this section replaces.

## 12. Activity Footer

The active round renders an activity footer from `round.activityStatus`. The footer must surface the states `ActivityStatus` already carries, not just a generic `pending`:

| Activity state | Footer rendering |
| --- | --- |
| provider call in flight | `model · thinking…` with an animated indicator |
| tool call in flight, before result | `tool <name> · running…` per pending call |
| transient error, retry scheduled | `retry in Ns · attempt #k` with warn tone |
| throttled / rate-limited, waiting | `rate-limited · retry in Ns` with warn tone |
| backoff with next-retry timestamp | `next retry <relative time>` with warn tone |
| idle / no pending calls | footer hidden |

Footer pills are stable per backend pending-call id so they update in place across refetches rather than re-mounting. These pills are activity status projections, not locally maintained Analyst pending-tool transcript rows.

## 13. Analyst Panel

The Analyst panel is a narrow, always-visible companion. It uses the same timeline primitives but with chat-first density.

Required behavior:

- role-tinted message rows for user, analyst, warnings, errors, system/context notes, and diagnostics;
- compact model chip on assistant/analyst turns using the ambient model rule;
- a pending row while a response is in flight;
- activity-backed in-flight tool state rendered from canonical conversation/activity data, not from websocket pending-tool adapters;
- sticky auto-scroll that only pins when the user is already near the bottom (current `pinToBottom` logic stays);
- a floating `Jump to latest` control with an unseen count when new content arrives while scrolled up;
- resize-to-content composer with Enter to send and Shift+Enter for newline (current composer already does this);
- read-only composer state for non-analyst sessions, with a clear inline explanation;
- inline unauthorized/offline/connection status in the panel context, even when the global shell also shows authentication state;
- collapsed raw payloads and system prompts by default; these are visually secondary in the narrow rail.

The Analyst panel remains the mutation path. Tool details may explain mutations, but they must not add direct mutation buttons outside the Analyst composer.

## 14. Debug Agents View

The Debug agents view is the transcript entry point for autonomous planner, executor, reviewer, and Analyst sessions. It is diagnostic-first, but it must not fork the conversation renderer or discover transcript files directly.

### Layout

The current Debug agents tab scans `.saivage/agents` files and shows a raw-file sidebar plus a raw JSON viewer. This redesign morphs it into a master-detail transcript view:

```text
┌───────────────────────────────────────────────────────────┐
│ Debug agents                                              │
├───────────────┬───────────────────────────────────────────┤
│ session list  │ conversation                              │
│ (by role and  │ ├─ header (role, id, model, status, links) │
│  status)      │ ├─ Expand all · Collapse all · Raw exchange│
│               │ ├─ RoundCard… (shared primitives)          │
│               │ └─ pending footer                         │
├───────────────┴───────────────────────────────────────────┤
│ Optional debug side panels (collapsible):                 │
│ raw segment entries · raw LLM exchange · tool deliveries ·│
│ tool-call statuses · actor snapshots                       │
└───────────────────────────────────────────────────────────┘
```

- the master list is the session list from `/api/agents`, grouped by role and status (not an on-disk directory listing);
- the detail pane renders the same `RoundCard`, `ToolChip`, diagnostics, system prompt blocks, pending footer, grouping, human-readable details, and raw payload disclosures as the Analyst panel, through the shared conversation primitives;
- the conversation header shows role, session id, card/assessment links, status, model, started/updated timestamps, and stale/offline warnings;
- debug-only side panels render raw ledgers (raw segment entries, raw LLM exchanges, tool deliveries, tool-call statuses, actor snapshots) when available; they are clearly labeled as diagnostic ledgers, not the conversation source of truth;
- the view never scans or renders obsolete `.saivage/agents/messages` or `.saivage/agents/sessions` as transcript authorities.

Debug can default to more raw detail than the Analyst panel, but it must preserve the same readable conversation projection so operators do not learn a second transcript UI.

### Cross-navigation with the Analyst panel

- A Debug conversation row may offer an `Open in analyst` affordance that stages a contextual draft in the Analyst composer referencing the active session and round. It does not mutate anything; the composer draft is editable.
- The Analyst panel does not deep-link into Debug. The Analyst remains the mutation surface; Debug is inspection. If an Analyst tool row needs deep inspection, the operator switches to Debug manually, or a follow-up card-driven task provides it. Do not add Analyst→Debug deep links in this redesign.

## 15. Empty, Loading, Error, And Unauthorized States

All three conversation surfaces render explicit states so the conversation area never looks frozen or blank:

| State | Analyst panel | Agents conversation detail | Debug detail pane |
| --- | --- | --- | --- |
| Loading history | `Loading history…` status card | `Loading conversation…` | `Loading conversation…` |
| Loading sessions | `Loading analyst sessions…` status card | `Loading…` over the session list | `Loading…` over the session list |
| Empty | `No messages yet. Ask the analyst something.` | `Select a session to view its conversation.` | `Select a session to view its conversation.` |
| Conversation error | error card with the message | `conv-error` with the message | `conv-error` with the message |
| Unauthorized | inline `Unauthorized. Provide a valid Saivage API token and retry.` + token hint | `Unauthorized. Reload after providing a valid token.` | `Unauthorized. Reload after providing a valid token.` |
| Offline / sync dropped | debounced connection-status indicator; `Attempting to reconnect…` after a short delay | `Reconnecting…` | `Reconnecting…` |
| Stale | `State may be stale.` muted banner after a failed refresh | `State may be stale. Refresh to reconcile.` | `State may be stale. Refresh to reconcile.` |

Connection status must debounce visible changes (v2 debounced by 400 ms) so a brief WebSocket dip does not flash a full offline banner.

## 16. Live-Update Behavior

The conversation timeline is live: polling and WebSocket `invalidate` frames, including the conversation invalidation channel for the Analyst panel, Agents conversation detail, and Debug agents conversation detail, trigger refetches instead of full reloads. Analyst chat subscribes to the canonical Analyst conversation resource; websocket activity/status frames and Analyst tool-invocation activity are not transcript sources and do not trigger transcript refetches. The following invariants make that experience predictable:

- expansion state (which rows and groups are open) must survive refetch; IDs are derived from stable conversation identifiers as specified in section 3;
- each conversation surface scroll position pins to the bottom only while the user is already near the bottom and has not paused auto-scroll; new visible content while scrolled up or paused increments the `Jump to latest` unseen counter instead of forcing scroll;
- visible-content growth means persisted entries, including within-round entry growth, plus activity footer rows;
- each conversation surface exposes a per-surface `Pause auto-scroll` control that suspends auto-scroll without disabling live updates;
- a round in progress (`activityStatus.status !== 'idle'`) must update its activity pill in place by stable backend pending-call id, not remount;
- a tool pair that transitions from `pending` to `ok`/`error` updates the same row in place;
- expanded row detail must not collapse on refetch; the expanded view may swap from pending to resolved content without losing the user's scroll position inside the detail;
- compaction markers and model diagnostics remain visible across refetch and never disappear unless explicitly dismissed, and dismissal is per-session local state.

## 17. Accessibility

- every tool row and group row is a button with `aria-expanded` reflecting open state and an `aria-controls` pointing at the detail region;
- raw tool names remain in `aria-label` (`tool ${toolName} ${status}`) so the friendly labels do not remove machine-readable access;
- lateral links are real links/buttons with accessible names (file path, URL, card id, process id), not click-on-div navigation;
- expand-all/collapse-all controls announce the count they affect;
- keyboard focus must move into an expanded detail and return to the trigger row on collapse;
- the jump-to-latest control is keyboard-reachable and announces the unseen count;
- color is never the only signal for tone: pair error/warn tones with an icon or text label;
- the conversation scroll area preserves a visible focus ring and supports keyboard scrolling.

## 18. Visual Tone

The visual idiom should feel like v2: dense, calm, technical, and readable.

Use:

- small restrained typography for tool rows;
- role-tinted bubbles for human/assistant/chat text;
- muted borders and surface changes rather than large cards for routine tool calls;
- strong error color only for failures;
- monospaced typography for commands, ids, paths, and raw details;
- compact pills for model, status, counts, and timestamps;
- lazy rendering for expanded detail and raw payloads.

Avoid:

- full raw JSON in the default scan path;
- oversized cards for every tool call;
- hiding dispatch or mutation rows inside groups;
- using row click for lateral navigation;
- separate Analyst, Agents, and Debug implementations that drift in labels, status tones, or raw disclosure behavior.

## 19. Backend Responsibilities

The backend remains the source of truth for conversation entries and must expose enough structured fact for the frontend renderer to be reliable. This section lists the display-affecting backend invariants the redesign depends on; the segment-substrate work itself is covered by `tool-repair-and-agent-conversation-unification-plan.md`.

| Area | Required invariant | Why |
| --- | --- | --- |
| Transcript substrate | One active-version conversation format for every role; `/api/agents` and `/api/agents/:id/conversation` return it; `system_prompt` entries are included | A single renderer converges all three conversation surfaces |
| Raw payload preservation | Original tool request/result/error `content` is stored unchanged | The raw escape hatch guarantees no data loss |
| Entry schema stability | `kind`, `role`, `round_id`, `message_index`, `block_index`, `timestamp`, `tool_name`, `tool_call_id`, `model` stay stable or evolve through typed API changes | Pairing, grouping, and expansion-state stability depend on them |
| Structured tool results | Tool results keep structured envelopes, not free text, where the tool already produces structured data | Human detail renderers need parseable facts, not best-effort text |
| Entity links | Tool results include `EntityLink[]` for affected cards, processes, artifacts, and attachments when available | Lateral navigation to cards/processes/records |
| Child dispatch references | Add stable child-agent or child-conversation references to dispatch/terminal results when available | Enables lateral navigation from `run_*`/terminal rows to child transcripts |
| Artifact and record paths | Return persisted paths for record writes, command logs, stash files, and saved fetches when available | Detail links to evidence files |
| Error shape | Keep stable error codes/messages in structured payloads | Compact status showed a meaningful error first line |
| Compaction evidence | Preserve tool call/result entries or stable summarized evidence across compaction | Grouping and auditability survive truncation |

Backend changes explicitly not required for this redesign:

- no server-side display strings as the primary UI API;
- no second overflow/stash system for visualization;
- do not hide raw payloads from the conversation model.
- no assistant transcript rows in chat send responses or Analyst websocket response messages.

## 20. Implementation Phases

Phase 1: shared primitives and API discipline.

- Done: keep all conversation rendering on `/api/agents` and `/api/agents/:id/conversation`.
- Done: make Debug agents use the API-backed conversation source instead of obsolete transcript directories.
- Done: ensure `system_prompt` entries reach the timeline and render collapsed by default.
- Keep raw LLM exchange as a separate Debug disclosure.
- Backend: wire `EntityLink` emission for card/process/artifact/attachment into tool results; document the child-dispatch reference gap.

Phase 2: tool presentation model (requires v3 tool surface alignment).

- Align the v3 runtime tool vocabulary with the target labels used here; track the tool-set improvement separately.
- Introduce `ToolDisplayModel`, `ToolDetailModel`, `ToolGroupSummary`, `DetailSection`, `InlinePart`, `DetailLink`, and one raw payload toggle.
- Replace raw `FormattedContent` details in `ToolChip` with human-readable details plus the raw escape hatch.
- Add friendly labels and typed details for every current v3 tool.

Phase 3: grouping, density, status, and failure containment.

- Add deterministic grouping for adjacent read-only context tools with the no-hide rules.
- Implement the pair states (pending/ok/error/missing plus diagnostic unmatched results) consistently.
- Add malformed-payload containment and bounded/stashed result handling.
- Add tests for grouping stability, no-hide rules, renderer containment, and stashed-result rendering.

Phase 4: Analyst polish and live updates.

- Add role-tinted bubbles, model chips, connection/unauthorized strip, thinking dots, jump-to-latest, and unseen count.
- Implement live-update invariants: expansion-state survival across refetch, pending pill in-place updates, scroll-pinning.
- Add accessibility wiring for rows, links, expand/collapse, jump-to-latest.

## 21. Acceptance Criteria

This redesign is complete when:

- the Analyst panel, Agents conversation detail, and Debug agents conversation detail render agent conversations from the same timeline primitives;
- every tool row has compact action-target-status presentation;
- every tool row expands to a human-readable detail (`DetailSection[]`) before raw payloads;
- raw request/result/error payloads remain reachable for every tool pair through the shared toggle;
- repeated read-only context calls group deterministically without hiding errors or mutations;
- system prompts are available without flooding the default view;
- pending calls render the in-flight/retry/throttled/backoff states from backend activity, not a generic `pending` or websocket side channel;
- missing, unmatched-result, malformed, and stashed-result cases render without breaking the view;
- compaction clusters summarize and bound members instead of dumping raw content;
- Debug is the full transcript entry point, uses API-backed conversations, and treats files/ledgers as secondary diagnostics;
- empty, loading, error, unauthorized, offline, and stale states render explicitly and do not flash offline on brief disconnects;
- expansion state, scroll pinning, and unseen counts survive polling and socket invalidations across all three conversation surfaces; visible-content growth includes entries and activity rows, the per-surface pause control routes new content to the unseen counter, and the Debug agents conversation live-updates via the conversation invalidation channel;
- accessibility: rows announce expand/collapse, raw tool names survive in `aria-label`, lateral links are keyboard-reachable, and tone is never color-only;
- backend invariants in section 19 hold or are explicitly tracked as open backend work;
- `docs/spec/operator-ui.md` acceptance criteria reference this redesign for the conversation-rendering requirement;
- tests cover timeline grouping, system prompt rendering, raw payload access, stashed results, malformed payloads, debug reuse of API-backed conversations, and live-update expansion stability.
