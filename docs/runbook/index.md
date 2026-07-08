# Saivage Operator Runbook

Status: current operator procedures for runtime maintenance.

## Conversation Compaction

`compacting` in an agent activity row means the runtime is inside the pre-provider-call summarizer window for that session. It is transient: the actor has crossed the configured context threshold, is writing a new active conversation version, and will clear the status before the provider call proceeds.

If compaction fails, treat it as a loud provider-turn failure rather than silent truncation. To restore pre-compaction behavior for future turns, disable `compaction.enabled` in `.saivage/saivage.yaml` and restart the service; this keeps card-lifetime load-back and transcript encapsulation but stops automatic summarization. If the session itself is unusable, start a fresh card/session instead of manually deleting conversation rows.

Audit compacted history under `.saivage/agents/conversations/<encoded-session-id>/`. `index.json` names the active version and frozen versions; numbered `<N>.jsonl` files contain immutable raw or compacted versions; `summaries.jsonl` contains cached per-round summaries used to rebuild merged summaries. Frozen versions are audit evidence and should not be edited during normal operation.

Do not manually delete stash files or process logs referenced by live conversation versions. Compacted summaries include `Recoverable evidence` pointers to `work:///tmp/stash/...` and `work:///processes/...` URLs, and cleanup preserves those files while the pointers remain referenced. Manual deletion can strand a compacted summary and prevent the model or operator from recovering dropped evidence.

Per-session rollback to raw is available when version 1 still contains the desired raw transcript: stop the service, back up the session directory, edit that session's `index.json` so `active_version` points to `1`, then start the service. This rollback affects only that session and does not remove frozen compacted versions or summary cache entries.
