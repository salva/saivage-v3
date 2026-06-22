> **Historical/Audit Artifact — Not Current Operator Instructions**  
> This page records an audit or remediation artifact from an earlier stage. It is not authoritative for current Saivage v3 behavior unless a current active doc explicitly revalidates it against current source and tests.

# Second Codebase Review Remediation Cycle


> **Authority status: historical.** This page is retained for provenance only. See `docs/historical/2026-05-remediation-dossiers/historical-artifacts.md` for the provenance index.

This cycle followed the same review-plan-fix-validate loop as the first full remediation pass, with special attention to the live analyst conversation quality and agent context propagation.

## Findings

1. Dashboard chat submitted each user message through both WebSocket and REST. The WebSocket response format was not consumed by the Dashboard, so REST was used for the visible reply while both transports persisted and executed the same analyst turn.
2. The analyst `create_card` tool treated an omitted parent as the literal card ID `undefined`, producing `Parent card 'undefined' does not exist` instead of recovering from the live card tree.
3. The analyst LLM resolver had a generic prompt and did not receive compact project/card context, making it likely to answer simple visibility questions generically or invent missing parent IDs.
4. The regex fallback did not understand natural queries such as “can you see the current cards?” or “what are the project objectives?”.
5. Runtime agent context was goal-local. Planner, executor, reviewer, and continuous-improvement planner calls did not all include the root project card alongside the active goal/card context.
6. `StuckAgentSupervisor.start()` created an untracked startup timeout, and `process-runner` created a cleanup timeout without `unref()`, leaving clean test runs with open handles.
7. Live browser validation found a final analyst intent issue: phrases like “code card under goal-2” could be resolved as type `goal` because the parent ID contained the word `goal`.

## Plan

1. Make chat single-transport: use WebSocket when connected and REST only as an offline fallback; consume the WebSocket analyst response directly in the Dashboard.
2. Add a backend duplicate guard so simultaneous submissions of the same analyst turn do not execute or persist twice.
3. Harden `create_card` parent handling by defaulting top-level goals to `project` and terminal work to the active or only goal when possible.
4. Improve analyst prompt and fallback intents with live project/card context, explicit card-parent rules, and direct handling of cards/objectives questions.
5. Enrich planner, executor, reviewer, and continuous-improvement planner calls with root project context.
6. Clean timer lifecycle issues and verify with `--detectOpenHandles`.
7. Preserve explicit card types in create-card requests even when parent IDs contain another card type word.
8. Rebuild, restart the live service, and hold a browser-driven analyst conversation to verify no duplicated messages and useful project control.

## Implemented Fixes

- Dashboard chat now sends over one transport per user action and renders WebSocket `ChatMessage` responses.
- `AnalystHandler` serializes per-session message handling and returns the existing assistant answer for a duplicate same-content turn received within a short window.
- `create_card` now normalizes missing/blank/null-ish parents and selects safe defaults from the card tree.
- Analyst tool schema and LLM prompt now describe parent rules and require inspection for current cards/objectives.
- Planner, executor, reviewer, and continuous-improvement planner invocations now include the root project card context in their runtime context payloads.
- Supervisor and process-runner timeout handles no longer keep validation processes alive.
- Analyst create-card handling now strips card IDs before fallback type extraction and refines LLM tool parameters from explicit user wording, so `code card under goal-2` remains type `code` with parent `goal-2`.
- WebSocket auth rejection close timers and server-startup fetch sockets are cleaned up so server integration tests exit cleanly under `--detectOpenHandles`.

## Validation

- `npm run typecheck`
- `NODE_OPTIONS=--experimental-vm-modules npx jest tests/analyst.test.ts tests/utils/active-runtime.test.ts --runInBand --detectOpenHandles`
- `npm run web:test -- src/__tests__/dashboard-view.test.ts`
- `NODE_OPTIONS=--experimental-vm-modules npx jest tests/agents/skills-engine.test.ts tests/agents/agent-adapter-load-skill.test.ts tests/utils/active-runtime.test.ts tests/utils/file-tree.test.ts tests/utils/llm-dispatch-e2e.test.ts tests/analyst.test.ts --runInBand --detectOpenHandles`
- `timeout 240s env NODE_OPTIONS=--experimental-vm-modules npx jest tests/server --runInBand --detectOpenHandles`
- Full backend suite: `npm run typecheck && npm test -- --runInBand --detectOpenHandles`
- Web/control-room sweep: `npm run web:test:sweep`
- Docs verification: `npm run docs:verify`
- Production build: `npm run build`

## Live Browser Validation

After rebuilding and restarting `saivage-v3-target.service`, the live Dashboard analyst conversation was exercised through the browser:

1. Asked the analyst to show current cards with a unique marker. The message was persisted once and the analyst returned the live card tree.
2. Asked it to create a new goal under the project. It created `goal-2` under `project` without the previous `Parent card 'undefined'` failure.
3. Asked it to create a code card under `goal-2`. The first live pass exposed the type-confusion issue above, which was fixed and redeployed.
4. Repeated the code-card creation. It created `code-1` under `goal-2` with type `code`.
5. Asked it to delete the validation subtree. The analyst produced a destructive-action preview, accepted confirmation, and deleted `goal-2`, `goal-3`, and `code-1`.

The live runtime remained healthy and idle after cleanup, and the temporary validation cards were removed from the card store.
