# F03 — Agent conversation lacks round / diagnostic / pairing structure

## Summary

v3's [AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue) shows messages as a **flat sequence of `step` objects** the store produces. There is no grouping into LLM rounds; tool calls and tool results are shown as independent rows with `+/-` expanders; there is no concept of `model_issue` / `model_repair` / `model_recovered` diagnostics; there is no "compacted cluster" view; there is no live pending-call footer.

v2's [AgentsView.vue](../../../../saivage/web/src/components/AgentsView.vue) carries a much richer model in the **view layer** (the server returns flat `ConversationEntry[]` in both repos — grouping is purely a UI concern):

- Entries are bucketed by `roundId` (`r-pre`, `r-msg:N`, `r{k}`, `r-compacted-{n}`) — see `roundsToTimeline()` in AgentsView.vue.
- Each round has four sub-streams: `reasoning`, `toolPairs` (matched by `toolUseId` with status `pending|ok|error|orphan|missing`), `context` (user/system text without assistant reply), and `diagnostics`.
- Standalone diagnostics, standalone context, and compacted clusters all appear as distinct `TimelineItem` kinds.
- A footer renders `activity_status.pending_call` (in_flight / backoff, attempt #, throttled vs transient error, retry countdown).
- The thread has an **ambient model spec**: only rounds whose model differs from the first round's print a `via <modelSpec>` annotation. This is a small but high-signal piece of UX.

Functionally porting this requires:

1. A view-side `roundsToTimeline()` (deterministic, tested) in v3.
2. A `ToolPair` type and a `<ToolChip>` primitive showing icon + name + headline + result tone — collapsible into full input/result JSON via `<FormattedContent>` (see F05).
3. A `<DiagnosticRow>` primitive for `model_*` entries.
4. A `<CompactedCluster>` primitive for `r-pre` / `r-compacted-*`.
5. A `<PendingCallFooter>` primitive for the live status indicator.
6. The agent store must surface `entries` (raw `ConversationEntry[]`), `activity_status`, and per-round `modelSpec`. **Verify the API already returns these** — the v2 server contract did; the v3 contract must be inspected before implementation.

Server contract notes (to be confirmed in the analysis round, not assumed): if v3's `/api/agents/:id/conversation` does not yet emit the same `kind` values (`tool_call`, `tool_result`, `tool_error`, `model_issue`, `model_repair`, `model_recovered`, `activity`, `text`) and the same `roundId` scheme, port is blocked on a small backend addition. Writer must address this in the analysis.

## Evidence

- v3 today (flat / minimal):
  - [web/src/components/agents/AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue#L34-L110) — `steps` rendered linearly; only one `expandedToolCalls` set; no round wrapping; no diagnostic kinds.
  - [web/src/stores/agents.ts](../../../web/src/stores/agents.ts) — provides flat `steps` but raw entries may not be exposed.
- v2 timeline algorithm to port:
  - [saivage/web/src/components/AgentsView.vue](../../../../saivage/web/src/components/AgentsView.vue#L427-L560) — `roundsToTimeline()`.
  - [saivage/web/src/components/AgentsView.vue](../../../../saivage/web/src/components/AgentsView.vue#L640-L820) — render template for rounds, diagnostics, compacted clusters, footer.
- Tool formatter:
  - [saivage/web/src/utils/toolFormatters.ts](../../../../saivage/web/src/utils/toolFormatters.ts).

## Category

Half-implemented / short-sighted.

## Severity

High — this is the primary observability surface for the operator.

## Transversality

Cross-cutting within the agents surface; may require a small backend touch.
