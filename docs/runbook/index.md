# Saivage Operator Runbook

Status: current operator procedures for runtime maintenance.

## Runtime Lock Blockers

`saivage status` classifies an existing `.saivage/locks/runtime.lock` as live,
dead/stale, or malformed/unreadable. Every existing lock blocks Init, reset, and
start; Saivage never deletes, takes over, or retries around one. Stop and inspect
the exact service, process list, bind mount, and canonical target path. For a
dead/stale or malformed/unreadable blocker, follow the reported instruction
exactly: `Verify that no Saivage process owns '<canonical-project-root>', then
remove the abandoned lock manually with: rm -- '<absolute-runtime-lock-path>';
rerun the command.` Never remove a lock merely because it looks old or malformed.

## Server Restart

Server restart is available only on deployments with API-token HTTP/WebSocket operator authentication enabled. Request it through the shared Analyst and, after the confirmation-required response, send the exact next message `RESTART SERVER`. The initial request only records confirmation-required state; the exact confirmation schedules shutdown.

The application waits until the REST response has finished writing or the WebSocket terminal acknowledgement frame has been sent before it disposes and exits with status 75. The deployment supervisor must handle status 75 using its existing supervision policy; this procedure adds no deployment configuration. Status 75 and the scheduled acknowledgement establish only that this process is shutting down, not that any replacement is available or ready.

## Conversation Compaction

`compacting` in an agent activity row means the runtime is inside the pre-provider-call summarizer window for that session. It is transient: the actor has crossed the configured context threshold, is writing a new active conversation version, and will clear the status before the provider call proceeds.

If compaction fails, treat it as a loud provider-turn failure rather than silent truncation. To restore pre-compaction behavior for future turns, disable `compaction.enabled` in `.saivage/saivage.yaml` and restart the service; this keeps card-lifetime load-back and transcript encapsulation but stops automatic summarization. If the session itself is unusable, start a fresh card/session instead of manually deleting conversation rows.

Audit compacted history under the session's owner root: Analyst sessions use `.saivage/agents/conversations/<encoded-session-id>/`, while planner/executor/reviewer card sessions use `.saivage/cards/<cardId>/conversations/<encoded-session-id>/`. Numbered `<N>.jsonl` files form one exact gap-free `1..N` inventory; `N` is active after every version validates. Optional `summaries.jsonl` contains cached per-round summaries. Unknown entries, aliases, gaps, symlinks, and malformed complete versions require operator repair rather than recovery or normalization.

The app log, provider availability, every conversation version, and every summary cache contain newline-terminated strict `{ "version": 1, "type": "rows", "rows": [...] }` envelopes, not bare JSONL rows. The first envelope is atomically published and later writes append only. Startup may remove exact owned replacement temporaries and an exactly empty unpublished conversation session directory, and may truncate only an unterminated final physical suffix. A zero-byte canonical file, empty complete line, malformed complete envelope/row, unknown field, foreign temporary, or non-gap-free version inventory is operator-repair failure and is never deleted or normalized.

Provider exchange auditing is backed by sanitized `provider_exchange` metadata entries in `.saivage/logs/app.jsonl`, surfaced through the Raw LLM Exchange UI and `GET /api/agents/:id/llm-exchange`. Conversation JSONL contains no `provider_exchange` rows, there is no `.saivage/agents/llm-exchanges` side-file tree, and raw HTTP request/response bodies are not persisted.

Stash files and process logs under `.saivage/work` are disposable operational output, even when a live conversation or compacted `Recoverable evidence` section contains a `work:///` pointer. Stopped-runtime cleanup/reset may remove them; stale pointers may then stop resolving. There is no reference-based retention or recovery protocol for oversized webfetch stashes.

There is no per-session index rollback. Durable-format cutovers are reset-only: stop the service, preserve configuration, credentials, operator inputs, source, and documentation, reset generated persistence, and start the current binary. Do not rename or remove individual numeric versions to select an older transcript.

Do not start the current binary against bare-row or mixed-version growing files. Rollback after current-format writes also requires stop/reset; there is no migration, compatibility reader, format probing, or mixed-version support. A clean reset leaves `.saivage/logs/app.jsonl` absent until the first app-log entry atomically publishes it.

Card namespaces are classified tombstone-first. A valid `.saivage/cards/<card-id>/tombstone.json` reserves the id and excludes all retained content beneath that namespace from active cards, conversations, snapshots, recovery, records, history, and file browsing. Retained evidence is opaque; malformed tombstones or unknown immediate namespace entries fail startup.

An uncertain durable write makes the serving application mutation-unhealthy until restart. Read-only inspection remains available, while `GET /health/ready` returns HTTP 503/`not_ready`, the persistence component in server availability reports unavailable, and `/api/debug/state` exposes the same bounded redacted diagnostic even when `.saivage/logs/app.jsonl` is the uncertain target. Later durable mutations fail before filesystem access; do not expect a recursive error row in the app log. Restart performs deterministic restabilization and strict loading; complete malformed state remains for operator repair.

Current `start_project`, Pause, and Resume requests retain their existing names and response timing. One internal runtime-control service owns each request's runtime-state write and one lifecycle audit. An offline `saivage pause` or `saivage resume` holds the lifecycle lock across both effects; when a live owner exists, the CLI retains its current REST delegation and never falls back to a direct write.
