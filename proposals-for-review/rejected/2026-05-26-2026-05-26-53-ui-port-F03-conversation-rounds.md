# Design: F03 — conversation rounds (backend stamping + frontend timeline)

Fourth of five linked proposals. Requires F01 + F02 + F05 merged.

The canonical documents live under `SPEC/2026-05/review-ui-port-from-v2/F03-conversation-rounds/`. This file is the mailbox entry.

This is the largest batch: it adds backend round/message/block stamping, widens the wire response, ports v2's pure timeline algorithm, introduces conversation composites, and swaps `AnalystChatPanel` to the shared `ToolChip`.

## Problem

v3 returns a flat `messages[]` from the conversation route. The UI runs an ad-hoc `groupIntoSteps()` that loses round identity, doesn't pair tool calls to results, and has no notion of compacted clusters, diagnostic kinds, ambient model spec, or pending-call footer. v2 has all of this via stamped `round_id`/`message_index`/`block_index` + an `activity_status` envelope + a pure `entriesToTimeline()` algorithm. Without the v3 backend stamping, the timeline can't be reconstructed deterministically.

## Decision

Implement [F03 02-design-r3.md](../SPEC/2026-05/review-ui-port-from-v2/F03-conversation-rounds/02-design-r3.md). Read [01-analysis-r2.md](../SPEC/2026-05/review-ui-port-from-v2/F03-conversation-rounds/01-analysis-r2.md) for the full v3 producer audit and gap analysis. Read [03-plan-r2.md](../SPEC/2026-05/review-ui-port-from-v2/F03-conversation-rounds/03-plan-r2.md) for the commit sequence, including the §2.5 producer audit (27-row binding inventory) and §2.6 compaction stamping policy.

Binding contract:

- Backend: `ActiveRuntime` owns per-session counters. Every producer in §2.5 of the plan (agent-adapter all callsites, analyst-handler, fake-agent, session-persistence stale/activate-card paths, compaction, runtime resume-context, …) calls the shared `stampForKind(...)` helper. The duplicate `function appendMessage` in `analyst-handler.ts` is deleted; all 12 callsites route through the shared persistence writer.
- Schemas: `src/schemas/types.ts` and `src/schemas/validators.ts` add `round_id`, `message_index`, `block_index`, `model_spec`, `requested_model_spec` to the message shape, and a top-level `activity_status` envelope on the conversation response. `replaceSessionMessages` parses every line through `agentMessageSchema` before write (canary).
- `tool_call_id` becomes a scalar field on every `tool_call`, `tool_result`, `tool_error` record (not only via JSON payload).
- Wire response migrates to one canonical shape in a single commit: `{ session, entries, activity_status }`. WS envelope widens the existing `thinking`/`activity` events; no new event type.
- Frontend pure utility `web/src/utils/agent-timeline/{entriesToTimeline,parseRoundId,types}.ts` with the exhaustive named test cases listed in §10 of the analysis.
- Conversation composites in `components/conversation/` (per F02): `RoundCard`, `ToolChip` (the canonical 8-prop bag from design §7.2), `DiagnosticRow`, `PendingCallFooter`, `CompactedCluster`.
- `AnalystChatPanel` ToolChip swap lands inside this batch, NOT in F04. F04 owns chat-surface decomposition only.
- Old `groupIntoSteps()`, `steps`, and `messages` machinery deleted in the same batch as the new code lands. No `messages -> entries` fallback in the store.

## Files to change

Plan is authoritative. High-level: backend (`src/agent-adapter.ts`, `src/analyst-handler.ts`, `src/session-persistence.ts`, `src/schemas/*`, `src/runtime/active-runtime.ts`, `src/fake-agent.ts`, `src/compaction.ts`, plus any other producer in the §2.5 audit), API types (`web/src/api/types.ts`), store (`web/src/stores/agents.ts`), view (`web/src/components/agents/AgentConversationView.vue`), new utility + composable, new conversation composites, AnalystChatPanel chip render swap, ~12 new backend/frontend test files.

## Files / tests / docs to delete

- The local `appendMessage` helper in `src/analyst-handler.ts`.
- `groupIntoSteps()` and the flat `steps` state from `web/src/stores/agents.ts`.
- Tests that assert against the flat steps surface (rewritten to assert against the timeline).

## Validation gate

1. Backend: `pnpm typecheck && pnpm test` (root package).
2. Frontend: `pnpm -C web typecheck && pnpm -C web test && pnpm -C web build`.
3. Producer-audit grep: `rg "appendMessage|writeMessage" src` matches only the shared writer's definition and authorized callers.
4. `rg "groupIntoSteps|\\bsteps\\b" web/src/stores/agents.ts` returns no matches.
5. Playwright MCP smoke against `http://127.0.0.1:8090`: open an agent conversation that exercises multiple rounds, tool pairs, a compacted cluster, and a pending call — verify rounds render with ids, pairs link, footer appears for pending state, model chip lifts to round.
6. Visit `AnalystChatPanel` and verify the shared `ToolChip` renders tool messages identically to the agent view.

## Risks / accepted residuals

- Largest backend touch. Producer audit in §2.5 is the binding completeness gate.
- Wire-shape migration is single-commit; an in-flight WS connection at deploy time will receive the new shape. Operator has accepted this.
- Activity status backoff/retry plumbing uses existing recovery/policy events; no new event-bus types. If a producer is missing, fix it in this batch rather than aliasing.

## Out of scope

- Chat surface decomposition (F04).
- Tool presenter registry (already shipped in F05).
- Streaming protocol redesign.

## Architecture rule

`ARCHITECTURE-FIRST, NO BACKWARD COMPATIBILITY`. Duplicate writers are deleted, not adapted. Constructors widen to require the stamper (no defaults). Manual `AgentMessage` literals are removed in favor of the single shared writer. `activity_status` is non-optional on the response envelope (its `pending_call` may be `null`).
