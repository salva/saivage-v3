# Expected breakage ledger

This file is the cumulative expected-breakage record for the analyst-as-control-surface migration. At close time, each stage appends entries for its own NEW failures relative to baseline-gates.json when the legitimate fix belongs to a later stage, and each stage removes entries whose `Target fix stage` is itself when the underlying failure is no longer observed.

## Entry shape

- A markdown heading at H3 level naming the failing artifact, in the exact form `### <failing-id>` where `<failing-id>` is one of the normalized strings from the snapshot.
- `Failure mode`: one sentence describing the symptom.
- `Reason acceptable now`: which SPEC-r7 requirement or earlier-stage decision forces it.
- `Target fix stage`: the id of a strictly later stage from the dependency DAG in the master plan (one of `S01`..`S10`; `S00` is not valid).
- `Recorded by`: the stage id and ISO-date that authored the entry.

## Open entries

### web-vitest:scenario-dashboard-child-order:step-1
Failure mode: vitest mount of `DashboardView.vue` against a shuffled child-of-goal panel fixture renders in client-sorted order (priority then title) instead of backend `position` order.
Reason acceptable now: the dashboard view is owned by S06 per MASTER-PLAN §4.1; S03 ships the backend contract and waits for S06 to flip the consumer.
Target fix stage: S06
Recorded by: S03 / 2026-05-25

### web-vitest:scenario-files-view-child-order:step-1
Failure mode: vitest mount of `FilesView.vue` against a card group whose card has shuffled children renders children in client-sorted order instead of backend `position` order.
Reason acceptable now: the files view is owned by S06 per MASTER-PLAN §4.1; S03 ships the backend contract and waits for S06 to flip the consumer.
Target fix stage: S06
Recorded by: S03 / 2026-05-25

### web-vitest:scenario-debug-view-child-order:step-1
Failure mode: vitest mount of `DebugView.vue` against a card with shuffled children renders in client-sorted order instead of backend `position` order.
Reason acceptable now: the debug view is owned by S06 per MASTER-PLAN §4.1; S03 ships the backend contract and waits for S06 to flip the consumer.
Target fix stage: S06
Recorded by: S03 / 2026-05-25

### analyst-e2e:scenario-analyst-chat-context-child-order:step-1
Failure mode: the analyst chat panel renders the current card's children in client-sorted order; an e2e checker that shuffles the backend order observes a mismatch.
Reason acceptable now: `AnalystChatPanel` and its descendants are owned by S08 per MASTER-PLAN §4.1; S03 ships the backend contract and waits for S08 to flip the consumer.
Target fix stage: S08
Recorded by: S03 / 2026-05-25

### web-vitest:scenario-notifications-panel:step-1
Failure mode: vitest mount of NotificationsPanel.vue calls listNotifications and acknowledgeNotification against routes deleted by S04, so the panel test fails on a mocked-route 404 plus an unmocked client method.
Reason acceptable now: S04 removes the durable notification surface and the operator HTTP routes that exposed it; the operator UI panel and its API client helpers are owned by S06 per MASTER-PLAN §S04 acceptance line "UI-side note-inbox panels are removed by S06/S09".
Target fix stage: S06
Recorded by: S04 / 2026-05-25

### web-vitest:scenario-stale-warning-ribbon:step-1
Failure mode: the stale-warning-ribbon test emits notification_acknowledged ws events to assert ribbon clearance, but S04 removes the notification_acknowledged event kind and its websocket arm, so the emit is silently ignored and the ribbon never clears.
Reason acceptable now: S04 removes the acknowledge surface entirely per SPEC-r7 "no per-notification acknowledge action"; the ribbon's clearance behaviour is owned by S06 along with the UI mutation removal.
Target fix stage: S06
Recorded by: S04 / 2026-05-25

### web-vitest:scenario-operator-dashboard-smoke:step-1
Failure mode: the operator-dashboard smoke test mocks listNotifications and acknowledgeNotification, both of which are no longer exported by the api client wrapper used by the dashboard, so the test setup fails before the dashboard mounts.
Reason acceptable now: S04 removes the operator notification routes and forecasts the web client helper removal to S06 per MASTER-PLAN §S06 web-client mutation pruning.
Target fix stage: S06
Recorded by: S04 / 2026-05-25

### web-vitest:scenario-operator-events-contract:step-1
Failure mode: web vitest suites that import `NotificationAcknowledgedContentSchema` (deleted in S04) or that emit synthetic activity envelopes shaped against the pre-S04 `NotificationAddedContentSchema` (with `id`, `severity`, `related_card_id`, `related_note_id`, `related_process_id`, `related_version_seq`, `created_at`) fail at `parseKnownWsContent` validation because the discriminated union no longer accepts those shapes. Concrete known consumers: `web/src/__tests__/notifications-panel.test.ts`, `web/src/__tests__/stale-warning-ribbon.test.ts`, and the `web/src/stores/{debug,cards,analystChat}.ts` listeners that read `related_card_id`.
Reason acceptable now: S04 thins the typed operator/analyst activity event contract to match the SPEC-r7 "no second notification-reading surface" rule and the narrowed websocket payload; the web stores and tests that still consume the rich payload are owned by S06 along with `NotificationsPanel.vue` and the `notification_acknowledged` ribbon clearance path.
Target fix stage: S06
Recorded by: S04 / 2026-05-25
