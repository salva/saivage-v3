# Agent Conversation UI Redesign Specification

Status: current design specification.

Date: 2026-06-30

## 1. Purpose

Agent conversations are the main observability surface for Saivage. The Analyst panel and Debug agents view must present the same conversation substrate with different density and diagnostic emphasis.

This specification adapts the Saivage v2 conversation UI direction to v3. It copies the feel and information hierarchy, not the old implementation details. V3 keeps its card-centered runtime, segment-backed conversations, right-rail Analyst panel, and Analyst-owned mutation boundary.

The target experience is:

- conversations read as a narrative first;
- tool calls scan as compact operational milestones, not JSON records;
- one click opens a human-readable detail prepared for operators;
- raw request/response payloads remain reachable through one shared escape hatch;
- file, URL, card, process, artifact, and child-agent links are lateral navigation, not row expansion;
- repetitive context gathering may be grouped, while mutations, dispatches, diagnostics, pending calls, and errors remain visible.

## 2. Source Material

The v2 source documents remain provenance for the visual direction:

- `saivage/docs/internals/opencode-gui-conversation-visualization-analysis.md`
- `saivage/docs/internals/agent-tool-visualization-design.md`

The relevant v2 principles are compact rows, restrained typography, role-tinted bubbles, round grouping, model chips, pending-call indicators, jump-to-latest behavior, grouped low-value context tools, lazy expanded details, and a universal raw-payload toggle.

V3 must not port v2's old server contracts, old file layout, legacy tool names, or legacy direct-chat control assumptions. Current authority remains `docs/spec/operator-ui.md` for UI behavior and `docs/architecture/tool-repair-and-agent-conversation-unification-plan.md` for the segment-backed conversation substrate.

## 3. Shared Conversation Model

All three surfaces render the same normalized conversation model:

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
  activityStatus: ActivityStatus | null;
};

type ConversationItem =
  | { kind: 'tool'; pair: ToolPair; display: ToolDisplayModel; detail: ToolDetailModel }
  | { kind: 'tool_group'; id: string; summary: ToolGroupSummary; pairs: ToolPair[] };
```

The API remains the source of truth for raw entries. The UI grouping pass is deterministic and view-side. Server payloads should expose stable `id`, `round_id`, `message_index`, `block_index`, `timestamp`, `kind`, `role`, `content`, `tool_name`, `tool_call_id`, `model`, and optional entity links. The UI must not inspect `.saivage/agents` paths directly to build the conversation timeline.

Conversation row and group IDs must be stable across polling and WebSocket invalidations. Use `round_id + tool_call_id` for tools and `round_id + contained tool_call_ids` for groups.

## 4. Round Structure

Rounds are retained. They are not replaced by a flat chat feed.

Each round renders in this order:

1. Compact round header.
2. User/system/assistant text blocks and system prompt blocks.
3. Diagnostic rows.
4. Tool rows and tool groups in entry order.
5. Pending-call footer for the active round.

Round headers show the role and only high-signal metadata:

```text
User round 4
Assistant round 5 via gpt-5.5
Diagnostic round 6
Compacted context · 18 entries
```

Model display uses an ambient rule: the first visible model in a transcript establishes the ambient model; later rounds show `via <model>` only when the model differs. Full model strings remain available in `title` text.

System prompts are rendered as collapsed `System prompt` blocks by default. Operators can expand them in Debug. Analyst should hide them by default and reveal them only behind a compact diagnostic disclosure because the right rail is narrow.

## 5. Tool Row Design

Tool calls use one shared row grammar on all surfaces:

```text
[chevron] [icon] [Action] [target........................] [status]
```

The row answers:

- what action happened;
- what object it targeted;
- what outcome matters.

Examples:

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

Rows must use friendly labels, not raw tool names, in the primary visual path. Raw tool names remain in accessible labels, tooltips, and raw payload details.

The status chip is muted or omitted for uninteresting success. It is prominent for pending, warning, error, changed state, retries, truncation, generated artifacts, and child-agent outcomes.

Mobile and narrow rail layout may wrap to two lines:

```text
[chevron] [icon] [Action] [status]
          [target........................]
```

## 6. Tool Details

Clicking a tool row expands human-readable detail. It does not navigate away.

Every tool detail uses the same skeleton:

```text
Header: action, target, status, timestamp
Summary: one or two operator-readable sentences or chips
Body: tool-specific human view
Links: files, URLs, cards, processes, artifacts, child conversations
Raw: shared request/response toggle
```

The detail body is not raw JSON decorated as Markdown. It is a formatter-driven projection:

- file reads show path, range, truncation metadata, and a bounded preview;
- directory and search tools show grouped matches with clickable file/line links;
- shell/process tools show command, cwd when safe, exit code/status, bounded stdout/stderr tails, and log links;
- writes, edits, patches, and git diffs show changed files and diff-oriented summaries;
- card tools show card id, title, state transition, changed record URL, and resulting entity link;
- planner/executor/reviewer terminal tools show objective, outcome, summary, evidence, issues, and related cards;
- Analyst tools show the operator-facing action, affected entity, audit/control-action id when present, and resulting navigation hint;
- RAG, memory, note, and artifact tools show the collection/key/path, counts, and saved artifacts;
- unknown external tools show a generic friendly title plus selected scalar arguments, then raw payload access.

The shared raw toggle is mandatory for every tool pair:

```text
[Raw request] [Raw response]
```

It is lazy-mounted and renders the original captured request/result/error. It is not the first-click experience.

## 7. Grouping Rules

Grouping is a view-side compression step. It is allowed only for adjacent, successful, read-only, low-value context operations.

Allowed groups:

| Group | Eligible examples | Conditions |
| --- | --- | --- |
| Gathered context | `read`, `glob`, `grep`, read-only card/session/file fetches | adjacent, successful, no error, no mutation |
| Checked git | `git_status`, `git_log`, read-only `git_diff` | adjacent, successful, no generated patch |
| Read plan | read-only card tree, runtime state, history reads | adjacent, successful |
| Web research | `websearch`, `webfetch` | adjacent, successful, no artifact write |

Never group:

- planner, executor, reviewer, or child-agent dispatch/terminal rows;
- Analyst-visible tool invocations that mutate or navigate;
- writes, edits, patches, process starts/stops/kills, git mutations, card mutations, record writes, plan mutations, memory mutations, RAG registrations/ingests/drops, and note creation;
- model diagnostics and compaction markers;
- pending, failed, missing, orphaned, retried, repaired, or warning rows.

If a group later contains an error because of live updates, it must either split the failed member out or auto-expand with an error count.

## 8. Analyst Panel

The Analyst panel is a narrow, always-visible companion. It uses the same timeline primitives but with chat-first density.

Required behavior:

- role-tinted message bubbles for user, analyst, warnings, errors, system/context notes, and diagnostics;
- compact model chip on assistant/analyst turns using the ambient model rule;
- thinking dots or a pending row while a response is in flight;
- pending Analyst tool invocations rendered as Tool rows, not as free text;
- sticky auto-scroll that only pins when the user is already near the bottom;
- a floating `Jump to latest` control with unseen count when new content arrives while scrolled up;
- resize-to-content composer with Enter to send and Shift+Enter for newline;
- read-only composer state for non-analyst sessions, with a clear inline explanation;
- inline unauthorized/offline/connection status in the panel context, even if the global shell also shows authentication state.

The Analyst panel should not show heavyweight debug affordances by default. It may expose raw payloads and system prompts, but those disclosures must be visually secondary and collapsed.

The Analyst panel remains the mutation path. Tool details may explain mutations, but they must not add direct mutation buttons outside the Analyst composer.

## 9. Debug Agents View

The Debug agents view is the transcript entry point for autonomous planner, executor, reviewer, and Analyst sessions. It is diagnostic-first, but it must not fork the conversation renderer or discover transcript files directly.

Required behavior:

- list sessions through `/api/agents`;
- read transcript through `/api/agents/:id/conversation`;
- provide the session list, grouped by role and status, inside the Debug agents tab rather than a standalone Agents page;
- show a conversation header with role, session id, card/assessment links, status, model, started/updated timestamps, and stale/offline warnings;
- include expand all/collapse all controls for details;
- include visible collapsed system prompt disclosure;
- render `RoundCard`, `ToolChip`, diagnostics, pending-call footer, grouping, human-readable details, and raw payload disclosures through the shared conversation primitives;
- include lateral links to cards, files, processes, artifacts, and related sessions;
- add debug-only side panels for raw segment entries, raw LLM exchanges, tool-delivery ledgers, and actor snapshots when available;
- clearly label raw files and ledgers as diagnostic ledgers, not the conversation source of truth;
- never scan or render obsolete `.saivage/agents/messages` or `.saivage/agents/sessions` as transcript authorities.

Debug can default to more raw detail than the Analyst panel, but it must preserve the same readable conversation projection so operators do not learn a second transcript UI.

## 10. Visual Tone

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
- separate Analyst and Debug implementations that drift in labels, status tones, or raw disclosure behavior.

## 11. Implementation Phases

Phase 1: shared primitives and API discipline.

- Keep all conversation rendering on `/api/agents` and `/api/agents/:id/conversation`.
- Make Debug agents the only full transcript entry point and move it away from raw transcript file discovery.
- Ensure `system_prompt` entries reach the timeline and render collapsed.
- Keep raw LLM exchange as a separate Debug disclosure.

Phase 2: tool presentation model.

- Introduce `ToolDisplayModel`, `ToolDetailModel`, `ToolGroupSummary`, and one raw payload toggle.
- Replace raw `FormattedContent` details in `ToolChip` with human-readable details plus raw escape hatch.
- Add friendly labels and typed details for current v3 tools.

Phase 3: grouping and density.

- Add deterministic grouping for adjacent read-only context tools.
- Preserve mutation, dispatch, diagnostic, pending, warning, and error visibility.
- Add tests for grouping stability and no-hide rules.

Phase 4: Analyst polish.

- Add role-tinted bubbles, model chips, connection/unauthorized strip, thinking dots, jump-to-latest, and unseen count.
- Keep raw/system/debug disclosures collapsed in the narrow panel.

## 12. Acceptance Criteria

This redesign is complete when:

- Analyst and Debug render agent conversations from the same timeline primitives;
- every tool row has compact action-target-status presentation;
- every tool row expands to a human-readable detail before raw payloads;
- raw request/result/error payloads remain reachable for every tool pair;
- repeated read-only context calls group deterministically without hiding errors or mutations;
- system prompts are available without flooding the default view;
- pending calls, model repairs, compactions, and diagnostics stay visible;
- Debug is the full transcript entry point, uses API-backed conversations, and treats files/ledgers as secondary diagnostics;
- tests cover timeline grouping, system prompt rendering, raw payload access, and debug reuse of API-backed conversations.
