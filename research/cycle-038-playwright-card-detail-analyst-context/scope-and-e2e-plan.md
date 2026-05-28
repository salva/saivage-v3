# Research Summary — Cycle 038 Card Detail Analyst Context

This research artifact mirrors the actionable findings written to the cycle audit directory:

- `architecture-audit/cycle-038-playwright-card-detail-analyst-context/scope-check.md`
- `architecture-audit/cycle-038-playwright-card-detail-analyst-context/e2e-plan.md`

## Key findings

- Mailbox pre-check found only `README.md`, `done/`, and `rejected/`; no mailbox preemption.
- `CardDetailView` exposes `Discuss with analyst`, calls `analystChat.seedCardContext(currentCard.value)`, fetches messages, and dispatches `saivage:focus-chat`.
- `analystChat` stores seeded card context as a one-shot hidden `syntheticHint`, prefixes it only during `sendMessage`, and sends the current `workspaceRoute.current` as the third API argument.
- `workspaceRoute` maps `card-detail` to `{ view: 'cards', entityId: <card id>, refinement }`, so `/cards/card-smoke` should POST `{ view: 'cards', entityId: 'card-smoke', refinement: null }`.
- Existing Playwright deep coverage tests dashboard chat send and token non-leak behavior, but not card-detail seeded context.
- Existing synthetic REST fixtures already provide `card-smoke` and record chat POST bodies, making them suitable for deterministic browser-level coverage.

## Cited source evidence

See the cycle files above for detailed `path:line` citations.
