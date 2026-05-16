# Saivage v3 — Troubleshooting

Use this guide for current source-verified failure modes and operator-visible states.

## Unauthorized API or WebSocket access

### Symptoms

- `401 Unauthorized` from `/api/*`
- UI shows unauthorized or no-token state
- WebSocket does not connect

### What to check

1. Confirm the server token is configured:
   ```bash
   echo "$SAIVAGE_API_TOKEN"
   ```
2. Confirm the client is sending either:
   - `Authorization: Bearer <token>`
   - `?token=<token>`
3. Confirm `/health` works without auth.
4. Confirm `/docs/` is still reachable publicly.

### Notes

Docs and health are public surfaces. Unauthorized API access does not imply the server is fully down.

If the Debug **Operator Control** tab shows `Unauthorized. Provide a valid Saivage API token and refresh the page.`, re-enter the token before retrying note or runtime-control actions.

## Runtime shows `frozen`

### Symptoms

- `/health` returns `runtime: "frozen"`
- runtime status remains frozen after maintenance
- `POST /api/runtime/resume` returns `400 Runtime is frozen`
- Debug Operator Control disables generic Resume and shows resume-from-freeze guidance

### Recovery

Inspect current status:

```bash
curl http://localhost:8080/health
curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" http://localhost:8080/api/runtime/status
```

Resume from freeze:

```bash
curl -X POST http://localhost:8080/api/runtime/resume-from-freeze \
  -H "Authorization: Bearer $SAIVAGE_API_TOKEN"
```

If no freeze manifest exists, the server returns a client error rather than guessing a restore path.

## Runtime control says unavailable

### Symptoms

- Debug Operator Control shows `Runtime state is unavailable...`
- pause or resume returns `503`
- runtime summary is missing even though the server is up

### What it means

Runtime control does not synthesize runtime state. The runtime has not been initialized, or persisted runtime state is missing.

### What to do

1. Start the runtime normally, or restore the expected runtime state if you are recovering from a controlled stop.
2. Refresh the Debug Operator Control panel.
3. If runtime state should exist but does not, inspect server/runtime startup logs before editing state files.

## Notes queue returns errors or missing rows

### Symptoms

- `GET /api/notes` returns `500 Failed to list notes`
- operators previously saw stale note rows disappear after refresh
- Debug Operator Control shows stale-note action feedback such as `That note is no longer in the unhandled queue. Refreshing notes.`

### What it means

Saivage now validates `.saivage/notes/queue.json` as a persisted record.

- malformed queue entries are rejected with a controlled `500`;
- stale queue entries pointing at missing or handled notes are reconciled away on read instead of returning `note: undefined`;
- note IDs are allocated from the queue-owned monotonic `next_note_sequence`, so an old stale note ID cannot later target a newly created note.

### What to do

1. Retry `GET /api/notes` once in case stale queue entries were auto-reconciled.
2. Use the Operator Control **Refresh** action if the stale note message came from a concurrent acknowledge/delete.
3. If the endpoint still returns `500`, inspect `.saivage/notes/queue.json` for schema damage only after pausing or freezing if runtime state is still changing.
4. Preserve card note files under `.saivage/notes/by-card/` before manual repair.

## Runtime is degraded or in `error`

### Symptoms

- `/health` reports `error`
- Dashboard shows degraded runtime messaging
- work stops advancing

### What to do

1. Open Debug or query:
   ```bash
   curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" http://localhost:8080/api/debug/errors
   curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" http://localhost:8080/api/debug/timeline
   curl -H "Authorization: Bearer $SAIVAGE_API_TOKEN" http://localhost:8080/api/debug/doctor
   ```
2. Check current card and queue state.
3. Inspect affected card detail evidence and failed agent sessions.
4. Pause or freeze before manual repair if state is still changing.

## UI is stale, reconnecting, or offline

### Symptoms

- stale banner or stale status
- reconnecting indicator
- live updates stop
- Debug Operator Control shows `This panel may be stale...` or a partial refresh warning

### What to know

REST fetches are authoritative after reload or reconnect. WebSocket events are an acceleration path, not the only truth source.

### What to do

1. Refresh the current view.
2. Recheck `/health`.
3. Verify the API token if the state became unauthorized.
4. Use Debug to inspect recent events or process state.
5. If Operator Control still shows a partial refresh warning, treat the successfully refreshed section as current and retry only after reconciling the failed side.

## Generated file preview is blocked or redacted

### Symptoms

- card detail says preview blocked
- Files view returns 403
- preview shows `[REDACTED]`

### Expected causes

- blocked sensitive file such as `.saivage/auth-profiles.json`
- redacted-only file such as `.saivage/saivage.json`
- containment violation
- oversized file
- binary file

### What to do

- treat blocked/redacted states as expected safety behavior first;
- inspect file metadata in card detail or Files view;
- avoid bypassing the API unless you are in a controlled maintenance or forensic workflow.

## File preview says file not found

A file may have been recorded as evidence but later removed from the workspace.

Check the card detail evidence list first, then verify whether the file still exists inside the project tree.

## Process details look incomplete

### Symptoms

- `cwd` is `null`
- log refs are `null`
- command text is redacted

### Explanation

Process APIs intentionally expose safe `ProcessView` data only. Absolute paths outside containment and secret-bearing command strings are suppressed or redacted.

This is expected behavior, not necessarily a process registry failure.

## Docs do not load under `/docs/`

### Symptoms

- `/docs/` returns 404 with a docs-not-built message

### What to do

Build or verify docs:

```bash
npm run docs:verify
```

If you only want the VitePress build itself:

```bash
npm run docs:build
```

## Jest test run warns after success

### Symptoms

- tests pass, then Jest prints `Jest did not exit one second after the test run has completed`
- or npm prints `A worker process has failed to exit gracefully and has been force exited`

### What to know

Stage-19 comparison evidence distinguishes two cases:

- direct Jest (`npm run test:direct`) and `npx jest` still reproduce the focused `tests/api.test.ts` + `tests/server/active-runtime-server.test.ts` warning, but the instrumented child Jest worker reaches `beforeExit` with only stdio sockets and a closed Jest watchman probe;
- `npm test` adds a separate parent-process npm shell wrapper `ChildProcess` handle (`sh -c ... jest ...`) that remains in the npm wrapper process even after that child reports `exit` and `close`.

That means `npm test` can show a wrapper-owned warning that is not evidence of a new Saivage teardown regression by itself.

### What to do

1. Use the direct validation path first:
   ```bash
   npm run test:direct
   ```
2. If you need to compare npm wrapper behavior, run:
   ```bash
   npm test
   ```
3. Treat wrapper-only npm warnings separately from app-owned handle evidence.
4. If the direct path starts showing new open handles beyond stdio sockets and the closed watchman probe, capture fresh diagnostics before changing teardown code.

## Control-room regression checks

When a UI problem is suspected, use the scoped web verification commands first:

```bash
npm run web:typecheck
npm run web:test:sweep
```

Focused suites:

```bash
npm run web:test:dashboardview
npm run web:test:cardsview
npm run web:test:agentsview
npm run web:test:filesview
npm run web:test:debugview
```

## Server starts without auth but is not reachable remotely

If `SAIVAGE_API_TOKEN` is unset, Saivage only permits tokenless startup on localhost-style bindings. Bind to localhost for development or configure a token for non-localhost use.

## When direct file edits are justified

Direct edits to `.saivage/` should be a controlled last resort. Prefer:

1. API status checks
2. Debug routes
3. UI evidence and process inspection
4. pause/freeze before mutation

Only edit state files directly after you have stabilized the runtime and identified a concrete repair need.
