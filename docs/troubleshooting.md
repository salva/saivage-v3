# Saivage v3 — Troubleshooting

Use this guide for current source-verified failure modes and operator-visible states.

For analyst-specific behavior such as chat-panel entry points, shell-command safety classes, the secret-path denylist, card-context seeding, live attribution signals, and focused web validation cadence, see [Analyst Operator Guide](/analyst).

## Unauthorized API or WebSocket access

### Symptoms

- `401 Unauthorized` from `/api/*`
- UI shows unauthorized or no-token state
- WebSocket does not connect
- card detail shows `Unauthorized`

### What to check

1. Confirm the server token is configured.
2. Confirm the client is sending either:
   - `Authorization: Bearer <token>`
   - `?token=<token>`
3. Confirm `/health` works without auth.
4. Confirm `/docs/` is still reachable publicly.

## Preview-only or denied control action

### Symptoms

- chat or REST mutation returns a preview instead of applying
- response says confirmation or `preview_hash` is required
- response says the action is denied by authorization policy
- `PendingConfirmationsPanel` shows a rejected preview-only action

### Meaning

The static authz table classified the action as either:

- `preview_only` — safe to preview, not safe to commit without a matching confirmation hash
- `deny` — not allowed for the current actor/surface/safety-class combination

### What to do

1. Confirm the action is being attempted from the intended surface (`web-chat`, `web-ui`, `rest`, `cli`, or `telegram`).
2. Re-submit with `confirmed: true` and the matching preview hash if the action is preview-only.
3. If the action should be allowed by policy, inspect the authz table customization in `src/agents/authz.ts` rather than adding a one-off bypass.
4. Check `.saivage/runtime/control-actions.jsonl` or `/api/control-actions` to confirm whether the request was rejected or denied.

## Card detail says card not found

### Symptoms

- card detail shows `Card not found`
- `GET /api/cards/:id` returns `404`

### Meaning

The card ID is wrong, the card was deleted, or the browser route is stale.

### What to do

1. Return to the Cards list and confirm the card still exists.
2. Refresh the Cards route.
3. If the card should exist, inspect recent delete/update activity in Debug.

## Card detail says stale

### Symptoms

- card detail banner says `This card detail may be stale`
- active card view shows a stale warning ribbon
- analyst-triggered card updates or note changes appear after the current card view loaded

### Meaning

A relevant WebSocket event or operator notification arrived after the last successful detail fetch or acknowledgement.

Common causes:

- tracked card edit created a `card_changed` notification
- directive or escalation note was added
- runtime pause/freeze/process changes affected the viewed work
- a live analyst mutation arrived with attribution or an analyst-action toaster

### What to do

1. Use **Refresh card**.
2. Re-check evidence, review, dispatch summaries, and card history before treating the card as complete.
3. Review notifications to see whether a blocking change is still pending.
4. If the change came from an analyst chat turn, inspect the current transcript chips and card history attribution for confirmation.

## Running agent ignored a change or cannot finish

### Symptoms

- operator changed a card or added a directive/escalation note
- agent later appears stale or continues old work
- executor/reviewer cannot finalize and dispatch is held
- logs mention blocking notifications or acknowledgement requirements

### Meaning

The runtime delivers operator changes at the next safe point through session notifications. `block` severity changes must be acknowledged before executor/reviewer terminal results are accepted.

Typical blocking triggers:

- card `acceptance`, `description`, `instructions_file`, or `depends_on` edits
- escalation notes
- runtime pause/freeze

### What to do

1. Inspect card history or notes to confirm the exact change.
2. Inspect the session conversation for the synthetic operator-update message.
3. Ensure the agent used `diff_card`, `get_card_history_entry`, `get_note`, or similar read tools as needed.
4. Ensure the session acknowledged the blocking notification.
5. If the dispatch is still held after reinvocation, treat it as an agent/tooling issue rather than forcing completion.

## Resume failed from frozen or error state

### Symptoms

- `/api/runtime/resume` returns an actionable error
- analyst/CLI resume says to use `resume-from-freeze`
- runtime stays frozen

### Meaning

Generic resume is intentionally rejected for `frozen` and `error` states. This is a safety rule, not a drift bug.

### What to do

1. If the runtime is `frozen`, use `POST /api/runtime/resume-from-freeze`.
2. If the runtime is `error`, fix the underlying failure and follow the freeze/recovery path rather than forcing generic resume.
3. Confirm the freeze manifest exists when using resume-from-freeze.

## Generated file preview is blocked or redacted

### Symptoms

- card detail says preview blocked
- card detail shows a blocked reason
- Files view returns `403`
- preview shows `[REDACTED]`

### Expected causes

- blocked sensitive file such as `.saivage/auth-profiles.json`
- redacted-only file such as `.saivage/saivage.json`
- containment violation
- oversized file
- binary file
- symlink that resolves outside the project root

### What to do

- treat blocked/redacted states as expected safety behavior first;
- use the blocked reason shown in card detail to distinguish containment vs sensitivity problems;
- avoid bypassing the API unless you are in a controlled maintenance or forensic workflow.
- if the question is specifically about analyst inspection boundaries, confirm the request against the [Analyst Operator Guide](/analyst).

## Focused analyst web validation command confusion

### Symptoms

- an operator tries to validate analyst web UI regressions with root `npm test`
- Jest reports no matching suites for Vue analyst files under `web/src/__tests__`
- validation evidence does not clearly show whether analyst chat/card live-update suites actually ran

### Meaning

Root `npm test` is a Jest runner scoped to the backend `tests/` tree. The shipped analyst web UI suites run under **Vitest from `/work/saivage-v3/web`**.

### What to do

1. Run the focused analyst web suites from `/work/saivage-v3/web`:

```bash
npm test -- src/__tests__/analyst-chat-panel.test.ts src/__tests__/analyst-chat-store.test.ts src/__tests__/app-shell-analyst-drawer.test.ts src/__tests__/analyst-toaster.test.ts src/__tests__/card-detail-view.test.ts src/__tests__/card-history-panel-analyst-filter.test.ts src/__tests__/ws-store.test.ts
```

2. Or use the root delegating wrapper:

```bash
npm run web:test:analyst-ui
```

3. If validation notes mention root Jest for these suites, correct the record and rerun with Vitest before accepting the result.

## Card detail shows missing or incomplete evidence

### Symptoms

- `No operator-facing evidence is recorded yet`
- `This terminal or blocked card has no operator-facing evidence recorded`
- `recorded evidence file is missing from the workspace`

### Meaning

These states are different:

- `none recorded yet` — active/running work has not produced operator-facing evidence yet
- `incomplete` — a blocked/done/failed card lacks usable operator-facing evidence
- `missing files` — evidence references were recorded, but the file is gone now

### What to do

1. Check verification commands, review result, and dispatch summary on the same card.
2. Inspect child/evidence-card links from the detail view.
3. Inspect card history to see whether the acceptance criteria changed after the evidence was produced.
4. Do not accept completion based on status alone when evidence is incomplete.

## Review result shows failed or not reviewed

### Symptoms

- card detail shows `Review failed`
- card detail shows `Not reviewed`

### Meaning

A card marked `done` is not automatically operator-accepted. Use review status plus evidence/dispatch state.

### What to do

- review `achieved`, `missing`, and `evidence cards` in the detail view;
- inspect cited evidence cards through the card-detail navigation links;
- if review is missing for a done card, treat completion as unverified.
