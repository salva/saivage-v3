---
name: saivage-format-migration
description: 'Use ONLY when the project owner explicitly requests an external offline migration of an identified Saivage project to a matching release. Choose manual transformation or task-scoped scripting under workspace tmp; require stopped exclusion, a successful complete preserved backup, evidence-based fidelity and strict complete candidate validation. Deployment, reset or repair permission alone is not migration consent.'
---

# Explicitly Requested External Offline Migration

`AGENTS.md` owns the core/external distinction. An explicit owner migration request
is sufficient for this supported workflow; no per-rule extraordinary override or
separate request for scripting is needed. Choose manual work or narrow task-specific
automation under `/home/salva/g/ml/tmp/`. Never ship/track reusable migration tooling,
old-format readers or compatibility paths in Saivage core or packaged utilities.
Loading this skill, deployment/update/reset/repair permission, plan approval, source
completion or a backup alone authorizes no migration. Failed startup is no trigger
for automatic migration or reset. Reset remains a separately consented destructive
alternative; exact-target current-format repair remains independent.

## Ordered workflow

### 1. Request and identify

Establish the explicit request and exact project, service, container/workspace,
source release/known source contracts, intended pinned release, complete generated
boundary and intended input/release/service actions. Resolve unclear scope before
acting. Determine differences from release source/docs, not speculative startup or
equal envelope versions. Already explicit in-scope deployment/start actions need no
ceremonial reconfirmation; Run/resume and unrelated actions need actual authorization.

### 2. Stop and exclude

Stop the exact service, prevent automatic restart and positively establish no project
owner/process. Maintain exclusion through cutover. Service inactivity alone is not
proof. Live, malformed, indeterminate or ambiguous observations block. Never remove
or take over a lock automatically; an exact abandoned lock requires the runbook's
separate verification/authorization. Add no product lock or exclusion registry.

### 3. Complete and preserve the stopped backup

Before generated-content inspection or transformation, successfully finish a full
stopped target-project backup under workspace `tmp/`, preserved unchanged. Existence
does not prove completion. Back up opaquely; do not inspect generated descendants
to select a partial backup. Reconfirm owner absence before source inspection,
candidate mutation and cutover unless continuously established. The backup is source
evidence, never the mutable candidate or authorization to act.

### 4. Construct an independent complete candidate; establish fidelity

Use a separate complete candidate or replacement workspace outside the original and
backup. Copying canonical source state and transforming that copy, including
historical rows/documents, is allowed; rebuilding a current-format candidate is also
allowed. No writable aliases/hardlinks back to original/backup or in-place edits.
Cover `.saivage/cards`, `.saivage/agents`, `.saivage/logs`, `.saivage/work` together for
cutover, or the explicitly selected complete workspace. Never selectively merge
converted files into retained installation roots. Locks are not generated roots.
Preserve config/credentials/identity/operator inputs/prompts/skills/instructions/
source/docs unless an actual required change is within the request.

Follow known source canonical identities, committed references and indexed history.
Old-format interpretation belongs only in this external task. Missing facts or
corrupt references are blockers/limitations, never permission to invent history or
search for orphan substitutes. Opaque copying grants no discovery, interpretation,
promotion, evidence use or cleanup of noncanonical temporaries, incomplete/unlinked
namespaces, attic or uncertain-publication artifacts. No generic forensic inventory,
source registry or recovery facility.

Preserve established empty directories or derive them from actual intended-release
bootstrap/layout requirements, not regular files alone. An established conversation
requires its session root and `versions/` even without segments; cards require their
initially empty `mailbox/`. See [established directories](../../../docs/spec/system-specification.md#established-conversation-and-card-owner-directories).
Required Analyst/card sessions and established Oversight retain their distinction
from genuinely lazy state. The four-root boundary does not require every lazy root.

Preserve representable facts/history: known identities, ordering, attribution,
content and references. New selectors/IDs, renamed paths, envelope re-encoding and
derived commitments are structural transformations, not automatically historical
loss. Describe them accurately; never present constructed structure as old observed
tool effects, acceptance, producer provenance or runtime events. Missing required
facts cannot be fabricated to pass validation.

Do not promise losslessness before evidence or categorically deny equivalence.
Record byte-identical, semantically/history-faithful, structurally transformed,
omitted and uncertain parts with evidence/limits. Disclose unavoidable concrete
data/history loss and obtain explicit owner confirmation before effecting that loss
or cutover. A migration request is not blanket loss acceptance. Unresolved required
provenance or unsupported representability blocks, without weakened validation or
silent reset.

### 5. Strictly validate the whole candidate

Pin the matching intended release; use its actual schemas and semantic consumers,
not mirrored/weakened validators. Validate all canonical selections and linked/indexed
history, card/record relationships/lifecycle/provenance, configured card/global
sessions, conversation segments/context/tool-result contracts, provider/app-log
evidence and exact referenced work. Validate configuration, workflow/prompt closure
and required established directories. Never scan/certify noncanonical orphans.
Startup/readiness alone is insufficient: it does not consume every historical
predecessor or empty publication directory. See [Storage and interruption](../../../docs/runbook/index.md#storage-and-interruption).

Offline validation must call no providers/tools and mutate neither original nor
backup; do not assume init/startup is pure validation. Failure blocks cutover.
Known candidate-construction mistakes can be corrected externally, then the whole
candidate revalidated, without new per-rule overrides. No partial promotion,
validation relaxation or selective merge.

### 6. Complete cutover; stop on uncertainty

With exclusion, successful preserved backup and strict validation established,
perform only the authorized complete-boundary/workspace cutover to the pinned
matching release. No mixed roots or binary-only downgrade. Invent no multi-root
atomicity or recovery guarantee. First failure stops. Outcome uncertainty permits
no artifact inspection, retry, rollback, reconciliation or automatic continuation.
Distinguish known successful effects from uncertain effects and escalate for a
separately scoped next operation. Never use the backup as a selective restoration
workspace or silently substitute reset.

### 7. Authorized start/execution and honest reporting

Start only if actually authorized, with the matching tested release; verify
separately. Health is not proof of continuation, fidelity or an unchanged active
chain. Never Run/resume automatically. Preserve authentication and outbound
confidentiality; do not print credentials, transcript contents or private provenance.

Keep a task-local external report under workspace `tmp/`, outside backup/generated
state: request/scope, source/target releases, preserved evidence, method, factual/
historical fidelity, structural transformations/provenance, omissions/loss
confirmations, uncertainty, validation coverage/results and known actions. No
required generic ledger/schema or synthetic canonical migration event.

## Related authority

- [Runbook](../../../docs/runbook/index.md#external-migrations): operator choices and gates.
- `saivage-project-reset`: separately consented destructive reset, not migration.
- `saivage-lxc-operations`: lifecycle procedures, not authorization.
