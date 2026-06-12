# S08 REVIEW - Analyst navigation and chat-panel context

Verdict: APPROVED

Finding counts: BLOCKER 0, MAJOR 0, NIT 0

Single most important issue: No outstanding issues; S08 is ready for publication.

## Findings

No findings.

## S08 Conformance Check

- MAJOR 1 is closed. The expected-breakage forecast no longer targets S08. The forecast default is no entries; the only fallback targets named are S09 for out-of-scope web-vitest failures and S10 for out-of-scope analyst-e2e failures. The forbidden-anchor and host-path bullet is now explicitly an in-stage hygiene failure that blocks publication, is cleaned in the draft, is never appended to the cumulative ledger, and is never assigned a forecast target.
- MAJOR 2 is closed. The model-visible empty-stack flag is gone. The backend shape for `navigate_back` is unconditionally `{ success: true, data: { intent: 'navigate_back' } }`; empty-stack handling is a pure web-side no-op inside the workspace-route store, with tests asserting no `router.push` call and no thrown exception, and nothing beyond that.
- NIT 1 is closed. Plan D.3's `NavigateTarget.kind` parenthetical uses singular `card`, matching the schema and the route-mapping tables.
- NIT 2 is closed. The H.4 prose continuation now starts with `Phase H.9`, so the anchored H-substep count is exactly 13 and the total anchored substep count is 61.
- The already-closed review items remain closed: `## Downstream impact` is present exactly once, `Breakage triage` is present, `useCardStore` is singular, prompt ownership is assigned to `analyst-llm-resolver.ts`, all seven `NavigateTarget.kind` values are mapped, the dispatch plan passes the full flat payload to `workspaceRoute.apply`, H.11 is an H3 plus four-labeled-field ledger schema, and browser-history back navigation is not used.

## Writer Claims

- Accepted: the self-targeted forecast language was removed and replaced with an in-stage hygiene-failure description.
- Accepted: the empty-stack `navigate_back` behavior is web-side only, with no model-visible no-op payload.
- Accepted: D.3 now lists singular `card` in the kind list.
- Accepted: H-substep counting is repaired; anchored substep counts are A:8, B:6, C:6, D:10, E:6, F:8, G:4, H:13, total 61.
- Accepted: the carried non-regression checks still pass across design.md and plan.md.

## Open Question Resolutions

- Open issue 1 remains resolved. The draft gives a complete route mapping for `card`, `transcript`, `process`, `plan_diary`, `process_list`, `agent_session_list`, and `config`, with exactly three new route entries planned: `process-detail`, `card-plan`, and `config`.
- Open issue 2 remains resolved. The durable analyst prompt edit is owned by `src/agents/analyst-llm-resolver.ts` through `getAnalystSystemPrompt()`, while the per-turn `[workspace-context]` note is owned by `src/agents/analyst-handler.ts`.
- Open issue 3 remains acceptable as a paper-plan default. Back-stack depth 16 is documented as tunable without changing the workspace-route store public API.

## Mechanical Checks

All checks were run from `/home/salva/g/ml` and scoped to S08 design.md plus plan.md only.

- Forbidden-anchor guard, file-form: 0 hits.
- Forbidden-anchor guard, inline-form: 0 hits.
- Emoji guard: 0 hits.
- Host-path guard: 0 hits.
- Plural card-store symbol guard: 0 hits.
- Browser-history back-call guard: 0 hits.
- Nested repo working-directory shortcut guard: 0 hits.
- Discriminator-only route-dispatch guard: 0 hits.
- `^## Downstream impact`: exactly 1 hit in design.md.
- `Breakage triage`: 1 hit in plan.md.
- Case-sensitive empty-stack flag token: 0 hits in design.md plus plan.md, so there is no result-shape occurrence to inspect.
- Self-target phrase guard in design.md: 0 hits.
- Anchored substep counts: A 8, B 6, C 6, D 10, E 6, F 8, G 4, H 13, total 61.
- D.3 parenthetical contains `card, transcript, process, plan_diary, process_list, agent_session_list, config`; the plural kind typo is absent.
- Stage-link checker against the draft directory exited 0 with no output.

## Source Spot-Check Matrix

- `web/src/main.ts`: current routes are dashboard, cards, card-detail, agents, agent-detail, files, debug, and not-found. The draft's plan to add only `process-detail`, `card-plan`, and `config` covers the missing schema kinds without inventing extra views.
- `web/src/stores/cards.ts`: exports singular `useCardStore`; `childrenOf(parentId)` returns a copied array sorted by `position` with an id tie-breaker, matching the S08 chat-panel consumption plan.
- `web/src/stores/analystChat.ts`: current `sendMessage` calls `sendChatMessage(sessionId, payload)` without workspace context, and the existing `response.toolInvocations.flatMap` transcript pass is present. D.7 and D.8 identify the correct edit points and keep route dispatch separate from transcript generation.
- `web/src/components/chat/AnalystChatPanel.vue`: current panel has no `childrenOnScreen` block yet, and the file has exactly one `<script setup>` block. Phase E is scoped to the right component.
- `src/agents/analyst-llm-resolver.ts`: owns `ANALYST_SYSTEM_PROMPT` and exports `getAnalystSystemPrompt()`, matching the prompt-snapshot and deictic-resolution plan.
- `src/agents/analyst-handler.ts`: current `handleMessage(sessionId, userContent)` has no workspace-context parameter, matching the planned C.2/C.3 extension.
- `src/agents/analyst-tool-schemas.ts`: `navigate_workspace` exposes exactly seven target kinds: `card`, `transcript`, `process`, `plan_diary`, `process_list`, `agent_session_list`, and `config`.
- `src/agents/analyst-tools.ts`: current nav handlers still return stub payloads, so the B-phase audited-runner rewrite is the right source change and the model-facing schema stays unchanged.
- `src/server/routes/chats-files-debug.ts`: `POST /api/chats/:sessionId` currently validates only `content` and forwards two args to `handler.handleMessage`; D.9 is correctly scoped to this route.

## Ledger State

The cumulative ledger currently contains one open H3 entry:

`analyst-e2e:scenario-analyst-chat-context-child-order:step-1`

It targets S08 and uses the required four labeled fields. The S08 plan's H.4 conditionally removes it after the chat panel consumes `cards.childrenOf` and the gate evidence supports close-out. H.11 preserves the authoritative H3 plus four-labeled-field append schema and permits only S09 or S10 as future targets if a genuinely out-of-scope NEW failure appears. No S08 self-targeted forecast or ledger append remains.