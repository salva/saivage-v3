# Saivage v3 — Troubleshooting

Use this guide for current source-verified failure modes and operator-visible states.

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

### Meaning

A websocket `card-updated` event arrived after the last successful detail fetch, or the last refresh failed after a previously successful load.

### What to do

1. Use **Refresh card**.
2. Re-check evidence, review, and dispatch summaries before treating the card as complete.

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
3. Do not accept completion based on status alone when evidence is incomplete.

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
