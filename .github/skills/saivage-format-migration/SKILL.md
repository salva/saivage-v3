---
name: saivage-format-migration
description: 'Use ONLY for a project-owner-authorized, one-off manual offline reconstruction across a Saivage durable-format cutover under the AGENTS.md exception. Requires exact scoped overrides and confirmed consequences; best-effort semantic preservation only, not lossless migration, routine deployment, reset, or permission to operate.'
---

# Exceptional Offline Generated-State Reconstruction

The retained skill ID is a discovery name, not a supported migration capability.
`AGENTS.md` Project Owner Overrides and Storage Policy are authoritative. Ordinary
incompatible adoption remains reset-only; same-format deployment follows the
runbook. This exception is outside Saivage product/runtime and normal operations.
Loading this skill, plan approval, deployment permission or possession of a backup
grants no reconstruction authority.

## Ordered gates

### 1. Establish and confirm the exact exception

Identify the project, exact service, host/container, work/instance, deployed and
intended release identities, intended operation, rules overridden and complete
generated-state boundary. The applicable boundary is all four roots together:
`.saivage/cards`, `.saivage/agents`, `.saivage/logs`, `.saivage/work`; alternatively,
explicitly authorize a complete replacement workspace. Locks are not generated
roots. Identify separately authorized release or outside-boundary input changes.

State the concrete irreversible, data-loss, weakened-validation, unsupported-state
and audit/evidentiary consequences and receive explicit owner confirmation before
acting. Obsolete or malformed canonical source may be interpreted only within that
override; current-candidate validation is never weakened. The result is **new
reconstructed state with no byte-for-byte, historical, forensic, audit or evidentiary
equivalence**. Recoverable semantic preservation is best effort, not a promise of
matching counts or continued execution. Unsupported fidelity requires a decision,
not invented evidence or an automatic reset substitute.

### 2. Stop, prove owner absence, then back up the whole target

Stop the exact service and positively verify no live owner/process for the exact
project before beginning a full stopped target-project backup under workspace
`tmp/`. Service inactivity alone is insufficient. Live, indeterminate or malformed
ownership observations block. Never take over or remove a lock; an exact abandoned
lock requires the runbook's separate verification and authorization.

Back up the whole target opaquely, not selected generated files. Do not inventory
archive members or inspect generated descendants to choose backup contents. The
backup must succeed before content inspection or reconstruction and remain
unchanged; it is neither authority nor a candidate workspace. Maintain established
owner absence or positively reconfirm it before backup inspection, candidate
mutation and cutover. Loss of this prerequisite blocks the relevant phase.

### 3. Derive bounded recoverable semantics

Determine current contracts from the identified release source and canonical docs,
not format probing or guessed compatibility. Inspect only exact canonical generated
state in the preserved backup. Begin at known canonical roots/heads/configured
identities and follow committed links, selected references and indexed history
under their contracts. Stop traversal at tombstoned child boundaries as specified.

Never enumerate siblings to find cards, records, versions, sessions, segments, work
files or alternate sources. Noncanonical orphans, publication temporaries,
incomplete/unlinked namespaces and uncertain-publication artifacts remain ignored:
no discovery, classification, inspection, interpretation, adoption, evidence use,
cleanup or repair. Missing or malformed canonical references are limitations, not
permission to search for replacements. No inventories, source registries, generic
forensic facilities or reusable discovery machinery.

### 4. Author a separate complete current-format candidate

Use a fresh separate location outside the installation and backup. Derive new state
from authorized canonical semantics; do not copy retained generated roots or
`.saivage` and patch that copy. Never edit the installation or backup in place, or
patch, truncate, append to, normalize, rewrite, merge or selectively replace retained
generated roots, streams, files or rows. Cover the complete four-root boundary or
the explicitly authorized complete replacement workspace.

Preserve configuration, credentials, identity, operator inputs, source and docs
outside that boundary unless an exact separate change is authorized. Do not invent
producer-account provenance, tool results/effects, prompt protection, acceptance,
historical identities or commitments attesting absent facts merely to satisfy a
schema. New structural commitments describe the candidate, not equivalence to old
evidence. Unsupported required facts block for a scoped representability/omission
decision, never relaxed validation. Necessary one-off manual tooling stays external
under workspace `tmp/`, untracked and narrowly task-specific; this skill supplies no
generic utility, helper replication recipe or reusable transformation framework.

### 5. Validate the complete candidate strictly

Use the intended release's actual contracts, validators and semantic consumers,
not mirrored validators, compatibility interpretations or weakened checks. Validate
all canonical selections and linked history: card/record lifecycle and relationships,
configured session indexes and current/indexed historical segments, selected global
conversations, app-log/provider evidence, commitments and required canonical work
references. All referenced work means exact consumed references, never a directory
inventory or hunt for missing outputs.

Include provider-composition and consumed tool-result payloads, not startup alone.
Validate configuration, compiled workflows and prompt closure; passing does not
prove live provider availability. Establish safe offline validation without provider
or tool execution or mutation of the backup/installation. Do not assume init or
startup is an innocuous validator.

Any failure blocks cutover: no relaxation, readable-prefix retention, selective
merge or promotion of a partly valid candidate. If another construction attempt is
authorized, author a new complete candidate rather than repairing retained state.
Publication uncertainty authorizes no inspection, retry or reconciliation.

### 6. Cut over only the authorized complete boundary

Reconfirm positive owner/process absence, unchanged successful backup and complete
current-contract validation. Replace the entire four-root boundary within the
authorized stopped procedure, or the complete workspace; never combine old/new
roots or selectively merge retained state. This promises neither atomic multi-root
publication nor recovery from an interrupted swap.

Interruption, failure or outcome uncertainty stops the procedure without artifact
inspection, retry, rollback, adoption or selective repair. The backup remains
unchanged, not a merge/restoration workspace. Release/service/input actions need
specific authorization; no automatic start, reset, lock repair or binary rollback.

### 7. Separate start and execution decisions; report honestly

An authorized start uses the identified matching tested release and deliberate,
validated model routes, selected prompts and tool payload contracts. Old successful
runs, equal outer format versions or structural validation alone do not establish
those facts. Health/readiness do not prove successful project continuation.
Run/resume needs explicit owner authorization and grounded route/prompt/tool checks;
never issue it automatically or promise the same active chain.

Preserve authentication and outbound secret non-disclosure. Record source, scope,
validation, omissions, uncertainties, known transformations and exact actions in an
external non-authoritative operator report outside both backup and generated state.
No prescribed schema, canonical-history entry, generic ledger or generated-state
manifest. Do not print credentials, transcript contents or private provenance in
chat/logs. Leave blocked work stopped; do not substitute reset or binary downgrade.

## Related authority

- The canonical runbook governs ordinary deployment, lifecycle and reset procedures.
- `saivage-project-reset` is a separately authorized destructive reset, not fallback
  permission supplied by this exception.
- `saivage-lxc-operations` supplies lifecycle procedures, not operational authority.
