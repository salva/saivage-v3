# Future Capabilities Plan

Status: deferred planning document.

Last reviewed: 2026-07-02.

This document parks capabilities that are not part of the current cleanup backlog in [Remaining Work Consolidated Plan](./remaining-work-consolidated-plan.md). Do not implement these capabilities opportunistically while doing cleanup or simplification work. Each item needs a separate design update, validation profile, and operator priority decision before implementation.

## Principles

- Do not add model-facing tool names without a real subsystem behind them.
- Do not add mutating tools without explicit authorization, auditing, and operator-confirmation policy.
- Prefer the current card-centered architecture: card records, card history, conversations, and notifications are the default durable coordination surfaces.
- Keep cleanup work separate from new capability work.

## Capability Decisions

### Read-Only Git Tools

Decision: deferred, potentially useful later.

Candidate tools:

- `git_status`
- `git_diff`
- `git_log`

Rationale:

- Structured read-only Git inspection could be safer and easier to render than shelling out through `run_command`.
- Software-development workflows commonly need dirty-worktree and recent-history inspection.
- The operator UI conversation renderer already anticipates Git-like tool presentation categories.

Constraints before implementation:

- Read-only only in the first slice.
- No branch, commit, merge, checkout, reset, force, or delete operations.
- Results must be structured enough for models and UI rendering.
- Secret/path redaction policy must match existing workspace safety rules.
- Role composition must be explicit; likely Analyst and executor first, not planner/reviewer by default.

Validation if activated:

- Provider tests using temporary Git repositories.
- Surface tests proving Git mutation tools are absent.
- Operator UI/tool-presenter tests if rendered specially.
- `npm run validate:routine`.

### Git Mutation Tools

Decision: deferred beyond read-only Git inspection.

Candidate tools that remain out of scope:

- `git_create_branch`
- `git_checkout`
- `git_commit`
- `git_merge`
- `git_delete_branch`
- any reset, force, amend, or push operation

Rationale:

- Git mutations need explicit operator intent, dirty-worktree policy, commit-message policy, staged-file policy, and audit semantics.
- The current agent can already use `run_command` when the operator explicitly requests Git operations in a coding session; a model-facing Git mutation API would need stronger safeguards.

Activation requirements:

- Separate design doc.
- Confirmation and authorization model.
- Audit records for staged files, commit contents, and command outcomes.
- Clear policy for concurrent user/agent worktree changes.

### Conversation Compaction

Decision: resolved and implemented for card processor sessions. Current authority is [System Architecture — Conversation Compaction](./system-architecture.md#conversation-compaction).

Resolved decisions:

- Planner, executor, and reviewer sessions use a card-lifetime persisted conversation thread loaded back at idle-path activation start.
- Compacted summaries are provider-visible `context_compaction` rows with `role: 'user'` and a framing marker.
- The active conversation layout is versioned, and `conversationMessagesForModel()` includes the active version's compacted summaries exactly once.
- The single compaction hook is `LLMActor.onBeforeProviderCall`, reached from the base provider-call entry path; active reconstruction is refreshed after compaction.
- Backend read models expose transient `compacting` activity status while the summarizer window is active.
- Summarizer routing and compaction thresholds are configuration knobs.

Analyst auto-compaction remains out of scope for the implemented subsystem; Analyst sessions still use active-version load-back without an automatic compactor.

Implemented validation coverage:

- Conversation reconstruction tests.
- Provider request serialization tests showing compacted summaries are included exactly once.
- Active-reconstruction tests across compaction boundaries.
- UI transcript tests for compaction rows.

### RAG

Decision: deferred until Saivage v3 has a native RAG subsystem.

Rationale:

- RAG is not just a tool vocabulary. It needs strict config, embeddings/provider routing, vector storage lifecycle, ingestion, secret filtering, operator diagnostics, and tests.
- Current product specs do not require semantic retrieval.
- Exposing `rag_*` tools before the subsystem exists would mislead models and operators.

Activation requirements:

- Native v3 RAG architecture plan.
- Storage and lifecycle ownership.
- Secret filtering and access policy.
- Operator UI diagnostics.
- End-to-end ingestion/query tests.

### Durable Memory

Decision: deferred until product semantics exist.

Rationale:

- Current durable knowledge surfaces are card records, card history, and conversation transcripts.
- A memory subsystem needs lifecycle, visibility, ACLs, retention, edit/supersession semantics, search, and compaction interactions.
- Adding `create_memory` / `search_memories` without those semantics would conflict with the card-centered model.

Activation requirements:

- Product-level memory semantics.
- Operator visibility and deletion controls.
- Persistence schema and retention policy.
- Clear distinction from card records and project documentation.

### Notes

Decision: dropped as a model-facing object class; use records and notifications instead.

Rationale:

- The system spec rejects a user-managed note object class and notification inbox/list/get/edit/delete/ack operations.
- Durable context belongs in `brief.md`, `status.md`, `review.md`, card history, or project files.
- Transient coordination belongs in `queue_notification`.

Allowed future reconsideration:

- Only revisit if the product spec changes to require a first-class note object with lifecycle, visibility, and operator controls.

## Relationship To Current Cleanup Plan

[Remaining Work Consolidated Plan](./remaining-work-consolidated-plan.md) owns current-code improvements: simplification, dead-code removal, test hardening, and documentation cleanup. This future-capabilities plan owns deferred feature ideas. Work should not move from this document into implementation without an explicit operator decision.
