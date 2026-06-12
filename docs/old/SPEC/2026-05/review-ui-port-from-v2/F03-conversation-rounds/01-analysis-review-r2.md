# F03 - Conversation rounds analysis r2 review

Reviewed against [01-analysis-r2.md](01-analysis-r2.md), the binding r1 critique [01-analysis-review-r1.md](01-analysis-review-r1.md), the previous draft [01-analysis-r1.md](01-analysis-r1.md), issue [F03-conversation-rounds.md](../F03-conversation-rounds.md), approved [F02 r2](../F02-component-hierarchy/01-analysis-r2.md), and approved [F05 r2](../F05-tool-detail-rendering/01-analysis-r2.md).

## Assessment

r2 addresses all 11 required changes from r1. The draft now treats F03 as an architecture-first replacement rather than a compatibility layer: one canonical `{ session, entries, activity_status }` wire shape, no `messages`/`steps` adapter, no `groupIntoSteps()` survivor, no v2 `formatToolPair` port, and no schema-level optional round metadata kept as a temporary bridge.

The important cross-issue corrections are present. Shared renderers are placed under the F02-approved `conversation/` and `content/` layers, the tool-pair renderer composes F05's independent `presentToolCall` / `presentToolResult` contract, and the AnalystChatPanel chip contradiction is resolved by making the shared `ToolChip` swap part of the F03 landing path instead of leaving two chip renderers at HEAD.

## Required-item verification

1. F02 layering: addressed in r2 §3 with `ui/`, `content/`, `conversation/`, a thin existing agent surface container, and pure logic under `utils/agent-timeline/`.
2. F05 presenter contract: addressed in r2 §7. `formatToolPair`, v2 `InlinePart` roots, and the 692-line formatter port are explicitly rejected.
3. Canonical wire shape: addressed in r2 §4. The route/API/store shape is `{ session, entries, activity_status }`, and `messages` / `steps` are deleted rather than shimmed.
4. `tool_call_id` scalar on calls: addressed in r2 §5.5, including schema/test coverage and the concrete `agent-adapter` append-site fix.
5. Backend round-stamping: addressed in r2 §5 with counter ownership, append-path stamping, round grammar, diagnostic/context/compaction bucketing, schema validation, and persistence updates.
6. Non-optional `activity_status`: addressed in r2 §6. The response requires `activity_status`; only `pending_call` may be null. `ActiveRuntime` is selected as authoritative owner.
7. WS vs polling: addressed in r2 §6.4. Existing `thinking` / `activity` envelopes are widened, REST polling fully refreshes the server truth, and a new `agent-activity-status` event is explicitly rejected.
8. Explicit test plan: addressed in r2 §10 with named unit, composable, store, component, backend, and deletion cases.
9. AnalystChatPanel contradiction: addressed in r2 §8.2 with a strict shared-chip landing decision.
10. Backend-driven rounds alternative: addressed in r2 §9 with a concrete rejection of server-bucketed timelines and selection of flat entries plus view-side bucketing.
11. Scope around F05 content/tool detail work: addressed in r2 §7 and §11. F03 consumes `FormattedContent`, `JsonView`, `InlinePart`, and presenters without redefining them.

No required r1 item remains missing.

## Backend citation spot checks

I spot-checked more than the required three cited backend claims:

- [src/server/routes/runtime-config-notes.ts](../../../src/server/routes/runtime-config-notes.ts#L115): the conversation route currently reads `readAgentMessages(...)` and returns `{ session, messages }`, matching r2's route-gap claim.
- [src/schemas/types.ts](../../../src/schemas/types.ts#L77-L80): `AgentMessage` currently has `tool_call_id?` but no `round_id`, `message_index`, `block_index`, `model_spec`, or `requested_model_spec`, matching r2's schema-gap claim.
- [src/schemas/validators.ts](../../../src/schemas/validators.ts#L44): `agentMessageSchema` mirrors the old shape and has no round metadata or tool-kind `tool_call_id` refinement, matching r2's validation-gap claim.
- [src/agents/session-persistence.ts](../../../src/agents/session-persistence.ts#L209-L246): `appendMessage()` accepts only role/kind/content/tool/tool_call_id/links and stamps id/session/timestamp itself, matching r2's persistence-gap claim.
- [src/agents/agent-adapter.ts](../../../src/agents/agent-adapter.ts#L376-L386): assistant `tool_call` records are appended without scalar `tool_call_id`, while result/error records pass `msg.tool_call_id`, matching r2's scalar-gap claim.
- [src/agents/invocation-recovery-policy.ts](../../../src/agents/invocation-recovery-policy.ts#L18-L24): the actual retry action enum is `retry_same_after_delay`; see the non-blocking note below.

## Non-blocking notes

- r2 §6.2 uses the shorthand `recoveryAction === 'retry'` in one transition description and one backend test name. The current enum uses `retry_same_after_delay`. This is a wording cleanup, not a design blocker, because the draft otherwise anchors activity state on the right existing events and includes `retry_attempted` with `retryDelayMs`.
- r2 §10.2 says `r007` and `r7` are treated as the same round. The algorithm description correctly says entries are bucketed by raw `round_id`; leading zeros should parse/sort as index 7, but `r007` and `r7` should not be asserted as merged buckets. Rename that test during implementation.
- r2 §3.1 briefly sketches `AgentConversationView.vue` under `web/src/views/` before clarifying that F03 keeps the existing [web/src/components/agents/AgentConversationView.vue](../../../web/src/components/agents/AgentConversationView.vue) surface path. The clarification is sufficient; cleaning the sketch would reduce reader friction.

VERDICT: APPROVED