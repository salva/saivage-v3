# F03 — Conversation rounds / diagnostics / pairing — Design review (r1)

Reviewer round 1. Reviewed:

- [F03 design r1](02-design-r1.md)
- [F03 approved analysis r2](01-analysis-r2.md)
- Cross-issue contracts: [F01 r2](../F01-design-tokens/01-analysis-r2.md), [F02 r2](../F02-component-hierarchy/01-analysis-r2.md), [F04 r3](../F04-chat-surface-style/01-analysis-r3.md), [F05 r2](../F05-tool-detail-rendering/01-analysis-r2.md)
- Backend spot-checks: [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts#L376), [src/agents/session-persistence.ts](../../../src/agents/session-persistence.ts#L209), [src/schemas/types.ts](../../../src/schemas/types.ts#L77), [src/schemas/validators.ts](../../../src/schemas/validators.ts#L44), plus the current route/store response shape at [src/server/routes/runtime-config-notes.ts](../../../src/server/routes/runtime-config-notes.ts#L115), [web/src/stores/agents.ts](../../../web/src/stores/agents.ts#L30), and [web/src/api/types.ts](../../../web/src/api/types.ts#L752).

## Summary

The design is close and the recommended Proposal A is the right architectural choice. It gives the producer authority over round stamps, keeps the wire shape canonical, ports the v2 timeline algorithm into a pure utility, deletes the legacy `messages`/`steps`/`groupIntoSteps` path, and correctly brings the AnalystChatPanel chip swap into the F03 batch.

I am requesting changes for one blocking contract problem: the `ToolChip.vue` skeleton and the F03/F04/F05 chip-detail contract do not currently line up. If implemented as written, the shared chip would not typecheck against F05's `InlinePart` shape and would violate F05's no-nested-interactive markup rule. Since `ToolChip` is the shared renderer required by F03 and F04, this is genuinely blocking.

## Required change

1. Reconcile the shared `ToolChip` template and prop contract with F05/F04 before approval.

   The design correctly names the F03 chip props as `call`, `result`, `status`, `expanded`, `detailsId`, and `timestamp`, and F04 r3 consumes exactly that prop bag. The problem is inside the template/details contract:

   - [02-design-r1.md](02-design-r1.md#L773) through [02-design-r1.md](02-design-r1.md#L776) renders F05 `InlinePart` values as `part.text`, `part.to`, and `part.href`. F05 r2 defines `InlinePart` as `{ kind: 'text'; value }`, `{ kind: 'file'; path; root }`, `{ kind: 'url'; url }`, and `{ kind: 'code'; value }` in [F05 r2](../F05-tool-detail-rendering/01-analysis-r2.md#L61-L77). The skeleton should use F05's `InlineParts.vue` renderer or the exact F05 fields.
   - The current `<button class="tool-chip-toggle">` wraps router links and anchors in the headline. F05 r2 explicitly chose a non-button `<div role="group">` with one dedicated expand `<button>` and sibling inline links to avoid nested interactive elements ([F05 r2](../F05-tool-detail-rendering/01-analysis-r2.md#L189-L224)). The F03 shared `ToolChip` must follow that DOM shape because both RoundCard and AnalystChatPanel will use it.
   - [02-design-r1.md](02-design-r1.md#L783) and [02-design-r1.md](02-design-r1.md#L784) call `<FormattedContent :parts="...">`, but F05's `FormattedContent` contract is content-string based, while `InlinePart[]` rendering belongs to `InlineParts.vue`. Later, F04 r3 says the chip body renders `FormattedContent` for `call.content` and `result.content`, but the F03 prop bag does not carry raw `callContent`/`resultContent`. R2 needs to pick one contract and make all three docs agree:
     - either extend `ToolChip` props and F04 adapters with raw `callContent` / `resultContent` so expanded bodies can use `<FormattedContent :content="...">`, or
     - keep the existing six-prop F03 bag and render `call.headline` / `call.detail` / `result.detail` strictly through `InlineParts`, with no raw `FormattedContent` body.

   My preference is the first option because it preserves F05's JSON/prose auto-detection for full payload bodies while keeping the headline/detail summaries structured. Concretely, add `callContent: string` and `resultContent?: string | null` (or nest them in a small `raw` prop), update RoundCard's `toolPairView` and F04's `ToolChipProps` adapters, and keep the render sites as `<ToolChip v-bind="..." />`. If the team wants the six-prop bag to remain final, then F05/F04 must stop promising raw `FormattedContent` bodies.

## Axis review

- **Two proposals:** Proposal A and Proposal B are both real. B is sufficiently developed with backend deltas, `inferRounds()`, additional tests, and rejection rationale. The recommendation for A is justified by producer authority, schema canaries, compaction, and cross-surface stability.
- **Types and grammar:** The entry, round-id, activity-status, and timeline types are complete enough for implementation. Minor r2 cleanup: the stated `Number.MAX_SAFE_INTEGER` grammar should be enforced in the schema with a refinement, not only in the parser, or the grammar text should say the regex enforces only digit shape.
- **Pure utilities:** `parseRoundId()` and `entriesToTimeline()` are correctly separated from Vue and broadly match the approved analysis. Minor r2 cleanup: clarify the leading-zero test wording so it does not imply that `r007` and `r7` are bucketed together; they sort with equivalent numeric keys but remain distinct raw ids.
- **Components:** RoundCard, DiagnosticRow, PendingCallFooter, CompactedCluster, and ContextBlock are well placed under `conversation/` and mostly satisfy F02 layering. `ToolChip` is the exception and is the blocking item above.
- **Backend changes:** The design covers `ActiveRuntime` counters, append-path stamping, diagnostic/context/compaction stamping, schema deltas, persistence, and the `tool_call_id` scalar fix. The spot-check confirms the current code really has the cited gaps: [agent-adapter.ts](../../../src/agents/agent-adapter.ts#L376) omits the scalar on tool calls, [session-persistence.ts](../../../src/agents/session-persistence.ts#L209) has the old append signature, and [validators.ts](../../../src/schemas/validators.ts#L44) has no round/activity validation yet.
- **Wire and WS:** `{ session, entries, activity_status }` is the right canonical response and the no-new-event WS envelope widening is correct. The design correctly deletes `content.message` instead of aliasing it.
- **Tests:** The named test inventory is exhaustive across `parseRoundId`, `entriesToTimeline`, `useAgentTimeline`, store/composable behavior, `ToolChip`, `PendingCallFooter`, backend round ids, persistence, activity status, and the route contract. Add the chip contract cases implied above: no nested interactive controls, F05 `InlinePart` fields render correctly, and expanded bodies follow the chosen raw-content vs InlineParts contract.
- **AnalystChatPanel swap:** Correct. The F03 batch must include the analyst chip swap so HEAD never has two chip renderers. This matches F04 r3.
- **No backward compatibility:** Correct. The design deletes `groupIntoSteps`, `MessageStep`, `steps`, `messages`, legacy `content.message`, legacy append arity, and `.tool-call`/`.tool-result` selectors rather than keeping shims.

## Recommendation

Adopt Proposal A after the `ToolChip`/F05/F04 contract is reconciled. I would approve the backend stamping, pure timeline utility, wire shape, store deletion, and test strategy as written. The only thing preventing approval is that the shared chip is the central cross-issue component, and the current skeleton cannot be treated as an implementable contract.

VERDICT: CHANGES_REQUESTED