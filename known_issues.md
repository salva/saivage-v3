# Known Issues

## Push validation currently fails

**Status:** Confirmed on 2026-07-20 in GitHub Actions run [#61](https://github.com/salva/saivage-v3/actions/runs/29784545286) for commit `adc36c0e`.

The push-only trigger is working on the repository's `master` branch, but three validation jobs fail independently:

1. `backend-jest-build` runs the root `npm ci` followed by `npm run build`. The root build also enters `web/` and invokes `vue-tsc`, but this job never installs `web/node_modules`. A clean reproduction from the pushed source exits with code 127:

   ```text
   Browser import guard passed (118 source files checked).
   sh: 1: vue-tsc: not found
   ```

2. `dependency-hygiene` fails the production dependency security gate. The root audit reports high-severity `ws` advisories. The web audit also currently reports high-severity `undici` and `vite` advisories, so it would remain failing after the root advisory is addressed.

3. `browser-smoke` runs for 10 minutes 15 seconds and exits with code 1. The unauthenticated GitHub job view does not expose its step logs, so the failing Playwright scenario and root cause have not yet been identified.

The aggregate `validation-required` job consequently fails. The successful jobs in the same run include `classify-changes`, `routine-docs`, and `ui-vitest`. GitHub also warns that `actions/checkout@v4` and `actions/setup-node@v4` target the deprecated Node.js 20 action runtime and are being forced onto Node.js 24. Those warnings are not the cause of the validation failures.

## Parallel hierarchy UI work does not currently build

**Status:** Confirmed on 2026-07-18 in the uncommitted worktree above `f263102a`.

Two attempts to build the stabilized current worktree failed during `web` TypeScript validation. `web/src/__tests__/card-store.test.ts` still constructs `ApiError` with two arguments at lines 173-175, 184, 191, and 198, while the current constructor requires three arguments. Backend TypeScript and documentation builds complete, but `web/dist` is not produced, so deploying that result would mix a new backend with an older UI bundle.

The managed instances must not be restarted on this partial build. Use the latest coherent committed build until the parallel API/UI changes typecheck and produce one complete backend-and-web artifact set.

## Retained instances do not match the latest card stream schema

**Status:** Resolved operationally on 2026-07-18.

The current build contains the relevant recovery fix (`fix(runtime): settle reconstructed child tools`), but neither retained instance can start far enough to exercise it. Both stores were produced by the earlier hierarchical migration and persist `position` in card snapshots. The current strict card schema rejects that field:

```text
Growing file '<project>/.saivage/cards/project/card.jsonl' envelope 1 is malformed
Unrecognized key(s) in object: 'position'
```

Pueblicos repeatedly failed this validation immediately after service restart. jsqlite was still owned by an older manually launched process; after that process was terminated cleanly, its managed current-build service was left stopped because the same retained format is present.

Both managed units are currently inactive to avoid restart loops. Their lifecycle locks are absent. Agent reconstruction and interrupted-tool settlement have therefore not been retested against these retained stores.

Both current generated stores were discarded at operator request, regenerated from their immutable flat-layout backups, and validated against current HEAD. The managed services now start successfully on the latest strict schema.

## Card bootstrap is blocked by slow inventory projections

**Status:** Confirmed on 2026-07-18 with coherent build `f263102a`.

The lazy hierarchy endpoint is working and responds promptly when requested directly. `GET /api/cards/project/children` returned 12 jsqlite root children in approximately 558 ms and one Pueblicos root child in approximately 288 ms, including client overhead.

The browser still displays `Loading cards` for a long interval because application bootstrap also starts agent and chat inventory reads. Those projections occupy the server before it services the hierarchy request. In headless Chromium, the first tree node appeared after approximately 35.3 seconds for jsqlite and 19.3 seconds for Pueblicos. No tree node, page error, or hierarchy request failure was visible during the preceding loading state.

The hierarchy-scoped API therefore fixes the cost of loading every card, but does not make the Cards view responsive while other synchronous inventory projections monopolize request handling. Profile agent and chat projection reads and avoid allowing either inventory to block independent card-child requests.

**Operational impact:** The Cards view appears broken for 19-35 seconds on the retained instances, even though the root hierarchy response itself is valid and fast once serviced.

## Live conversation sync fails on HTTP origins

**Status:** Confirmed on 2026-07-18 with coherent build `f263102a`; **still present in HEAD (2026-07-20)** after the f263→HEAD data migration and `web/dist` rebuild — this is a code defect in the web bundle, not a data issue.

Both retained instances are served from plain HTTP addresses. The websocket connects and the UI changes to `Live updates connected`, but its open handler then throws while resubscribing conversations:

```text
[ws] WS open handler error TypeError: crypto.randomUUID is not a function
    at Object.subscribeConversation
    at Object.resubscribeConversations
```

`crypto.randomUUID()` is restricted to secure contexts in this browser and is unavailable on these non-localhost HTTP origins. The failed open handler leaves conversation subscriptions incomplete even though the connection indicator says connected. Request IDs need a runtime-supported generator or the product must enforce and clearly report an HTTPS requirement before opening live sync.

## Pueblicos has a durable running chain while its runtime is stopped

**Status:** Resolved on 2026-07-18 by current HEAD agent reconstruction and explicit project start.

Pueblicos reports process-local runtime state `stopped`, `currentCardId: null`, `activeWork: none`, and no live card or agent actors. Its durable card state nevertheless contains this contiguous running chain:

1. `project`
2. `card-a` — Phase 1 repository assessment
3. `card-a-b` — implementation roadmap hierarchy
4. `card-a-b-c` — source, territorial hierarchy, route, and license strategy
5. `card-a-b-c-c` — complementary enrichment source contracts

The matching executor session for `card-a-b-c-c` is `inactive`; there are no active agent sessions. The two ancestor status reports already state that they intentionally remained running because actionable follow-on descendants were retained instead of cancelled.

This is not a live actor that is currently making progress. It is durable resumable work left running after project containment/restart, while the process-local runtime remains stopped. In the UI it can look like a stuck running card, especially because card and agent projections are also delayed by the bootstrap issue above.

The leaf conversation confirms an interrupted call rather than live work. `executor:card-a-b-c-c` ends with a `glob` tool call (`call_YCSXca5Jr84g8yUCRGOUdgsf`) timestamped `2026-07-17T14:55:48.473Z` and has no matching tool-result row. However, its canonical conversation projection reports `activity_status: idle`, `pending_calls: []`, and the same `updated_at` timestamp. The runtime owns no actor or process for it. The Agents UI can therefore misleadingly render the unmatched historical call as having been running for many hours even though it is not currently executing.

After regeneration and normal `start_project`, current HEAD reconstructed the complete running chain and appended a canonical failed tool result for the interrupted `glob` call at `2026-07-18T07:38:09.276Z`: `Runtime activation was interrupted before completion. External or domain effects may or may not have happened.` The executor then continued through new provider turns and settled new tool calls. Runtime status reports `card-a-b-c-c` actively running in `calling_provider` with no diagnostics. The stale multi-hour call is no longer pending.

## Pre-migration card links return 404

**Status:** Confirmed on 2026-07-18; expected consequence of the ID cutover, but currently confusing in the UI.

Browser traffic still requested pre-counter URLs such as `/cards/card-aorpc...-bhvx...` and corresponding `GET /api/cards/<old-id>` calls. The API correctly returned `404` because the card now has a compact ID; for example, the same jsqlite card is now `card-a-f-e-g-c` and its exact API request returns `200`.

Old bookmarks, open tabs, copied links, and retained browser route state are not redirected through migration receipts. Opening the Cards root and selecting the card again uses the current ID, but the bootstrap delay above can prevent that recovery from appearing to work promptly.

## Pueblicos first-start noise during migration

**Status:** Historical diagnostic; current service is healthy.

Pueblicos systemd attempted restarts while its store was being exchanged. One attempt saw the old `telegram` configuration and another saw the migration lifecycle lock. After migration completed, systemd started the current counter-aware build successfully. The current runtime-status, cards, chats, agents, and providers endpoints return `200`; this is not the cause of the current bootstrap delay.
