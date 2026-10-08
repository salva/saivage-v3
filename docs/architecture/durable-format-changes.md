# Durable format changes

## Purpose and evidence limits

This is the maintained source-contract baseline and bounded change record under
[AGENTS Storage Policy](https://github.com/salva/saivage-v3/blob/HEAD/AGENTS.md#durable-format-versioning).
It is not a supported-version matrix, exhaustive retrospective changelog,
deployment inventory, runtime registry, compatibility checker, converter or
operational consent. Current contracts remain owned by the
[specification](../spec/system-specification.md) and
[architecture](./system-architecture.md); procedures remain owned by the
[runbook](../runbook/index.md#external-migrations).

Observed source baseline: `9d4f16e5c51feed64de8efccdd35bd1a8388ac95`.
Introduction commits below establish source boundaries, not deployment dates or
installed-state facts. Compare the selected releases' actual owning schemas and
semantic consumers, including later changes; equal versions and successful startup
do not certify whole-project or historical compatibility. Maintain affected
baseline/change entries with implementation, recording evidence and honest unknowns.

## Current source baseline

Owner paths below are relative to repository `src/` at the observed revision;
[that exact source tree](https://github.com/salva/saivage-v3/tree/9d4f16e5c51feed64de8efccdd35bd1a8388ac95/src)
contains the schemas and direct publication/consumption owners.

| Durable family | Exact path/owner | Actual discriminator and essential semantics |
| --- | --- | --- |
| Card current head | Card namespace `card-head.json`; `persistence/canonical-card-artifacts.ts`, `card-files.ts` | `format_version:1`, `kind:card-head`; required `head_id`, ordinary selection and ordered current-only pending mailbox UUIDs. |
| Immutable card history | `card-history/<UUID>.json`; same schema/publication owners | `format_version:1`, `card-version` / `card-tombstone`; predecessor-linked ordinary/final payload, sparse ordinary revisions, no historical queue. |
| Mailbox documents | `mailbox/<UUID>.json`; same owners | `format_version:1`, `kind:card-message`; exact message identity selected only by current head, not a queue log. |
| Record head / accepted history | `records/record-<stem>.json`, `records/accepted/<UUID>.json`; `persistence/canonical-record-artifacts.ts`, `authored-record-files.ts` | `format_version:1`, `record-head` / `accepted-record`; required head identity, sole current draft, accepted predecessor and ordinary card provenance. |
| Conversation index and ordinary/compacted genesis | Session `index.json`, selected `versions/<ordinal>-<UUID>.jsonl`; `persistence/canonical-conversation-artifacts.ts`, `conversation-file.ts` | `format_version:5`; exact catalog/current selection, predecessor source/cutoff and explicit continuation, distinct from segment ordinal. |
| Conversation segment envelope / selected images | Same session versions and `images/<UUID>.png`; above owners, `contracts/{tool-result,image,view-image,conversation-validation}.ts`, `persistence/conversation-image.ts`, `layout.ts` | `version:5`, `type:conversation-segment`; strict nested message/tool-result/private-context and semantic contracts. Optional successful-result descriptors select raw PNG bodies governed by the format-5 conversation contract, with no independent envelope/catalog version. |
| App log and session provider evidence | `.saivage/logs/app.jsonl`, session `provider-exchange.jsonl`; `contracts/{app-log,provider-exchange-log}.ts`, `persistence/{app-log,provider-exchange-log,growing-file}.ts` | Both use the **shared** `version:1`, `type:rows` envelope, with distinct strict row schemas and owners; these are not independently numbered envelopes. |
| Lifecycle lock | `.saivage/locks/runtime.lock`; `runtime/lock.ts` | `format_version:1`; separate lifecycle-exclusion boundary, not generated-root migration state. |

Boundary notes: `persistence/project-identity.ts` strictly consumes
`projectConfigSchema` without a dedicated format discriminator. Configuration and
operator inputs, raw work/process artifacts and layout/directory requirements are
not certified compatible or assigned invented versions by this table. Files
`card-current` and historical response wrappers are projections, not durable
families. `.prev.json` slots retain their selector contract's bytes, not a separate
family. Existing unversioned inputs are documented, not retrofitted here.

## Durable-preserving conversation API/UI change

Source evidence: `agents.currentInstructions` in `src/contracts/operator-api-agents.ts`,
`src/application/read-models/agent-operator-read-model.ts` and its operator handler;
`web/src/utils/agent-timeline/timeline.ts` and the shared conversation/disclosure renderers.
The new read composes loaded static configuration without publishing snapshots. Combined
call-position tool exchanges and diagnostic disclosures change visual presentation only;
canonical rows, nested payloads, identities, selection/provenance and layout are untouched.
No durable family or discriminator changes. The `c527da662ef3d2c6db616983643bfbe7aeab1055` /
`9d4f16e5c51feed64de8efccdd35bd1a8388ac95` image baseline remains strict conversation
index/genesis/envelope **5**, with selected PNGs governed by that same descriptor contract.
Unrelated families are unaffected. This note proves no installed-state compatibility and
grants no adoption/deployment/migration/reset action; prior format-5 warnings remain in force.

The compact-summary refinement against source baseline
`95bf404720d6d2b76a81b8710cc8576eff38ac4e` is likewise durable-preserving. Source evidence:
`web/src/utils/tool-presenters/{helpers,present,presenters}.ts` selects meaningful abbreviated
targets and separates essential outcomes from short optional reasons;
`web/src/utils/tool-friendly.ts` bounds combined display excerpts, and
`web/src/components/conversation/ToolChip.vue` keeps targets on one line with narrow-pane
stacking. Full semantic sections, safe-original strings/copy and exact link destinations
remain separate from those display labels. This changes no canonical JSON, nested payload,
selection/provenance, persistence layout or discriminator, including the unchanged format-5
image contract above; it establishes no deployment or retained-state compatibility claim.

## Known incompatible changes

These source boundaries are directly evidenced, not an exhaustive timeline.
Historical unchanged discriminators are **pre-policy incompatibilities**, not
permission for future reuse or retrospective renumbering. The adoption consequence
for each incompatible boundary is a matching release plus separately consented
complete reset (losing generated history) or explicitly owner-requested external
offline migration under the runbook gates, never automatic conversion/deployment.

| Affected family / discriminator change | Source boundary and evidence | Change and adoption consequence |
| --- | --- | --- |
| Card/record representation replacement: card stream artifact `format_version:4` → owner heads/history/mailbox initial `1`; record stream `1` → replacement representation `1` | [`7405fa217df739bea481e93a99e1194a3df7ce1e`](https://github.com/salva/saivage-v3/commit/7405fa217df739bea481e93a99e1194a3df7ce1e), parent `8874026fbc765fe56828c87bee9a809943a7fef3`; diffs in `canonical-card-artifacts.ts`, `canonical-record-artifacts.ts`, `layout.ts` and direct file owners | Replaced `card.jsonl` and `authored-record-version` streams with `card-head` / predecessor-linked `card-version` / `card-tombstone` / `card-message` and `record-head` / `accepted-record` documents. Sparse ordinary/accepted history, current-only queues/drafts and ordinary card provenance replace full mutation streams. Old/mixed layouts fail; this historical representation replacement is **not** a prospective precedent for resetting an existing counter. |
| Card/record heads `format_version:1→1` — historical unchanged discriminator | [`71ad32847325a29c348799235fb95d81b22b652e`](https://github.com/salva/saivage-v3/commit/71ad32847325a29c348799235fb95d81b22b652e); head schemas and `publish-head.ts` | Required fresh `head_id` and exact previous-selector hardlinks; missing identities fail. Previous slots do not guarantee a usable recovery selection. No invented 1→2; [head adoption](../runbook/index.md#previous-selectors-and-head-identity-adoption) remains separately authorized. |
| Conversation index/genesis/envelope `3→4` | [`2f70b3db51529905ea96e2828957f27b1c1efabc`](https://github.com/salva/saivage-v3/commit/2f70b3db51529905ea96e2828957f27b1c1efabc); `canonical-conversation-artifacts.ts`, `conversation-validation.ts` and compaction owners | Removed compaction checksums, retained-row metadata and accumulated accounting while keeping source/cutoff/continuation semantics strict. Older schemas are rejected; unrelated families did not advance. Later 4→5 applies below. |
| App log / provider evidence shared envelope `version:1→1` — historical unchanged discriminator | [`251c93badf43f747dd93c2f99e6f2382fa0716e7`](https://github.com/salva/saivage-v3/commit/251c93badf43f747dd93c2f99e6f2382fa0716e7), parent `93ed39fff82a196ff1252d46547128e125202503`; `contracts/app-log.ts`, `provider-exchange-log.ts`, persistence owner/layout and unchanged `growing-file.ts` | Provider rows moved from app log to session-owned evidence, including owner-specific internal-summary identities. New app log rejects old provider rows; split ownership is not a same-format upgrade. Complete adoption covers all four generated roots, not selective logs. |
| Provider-usage payload, shared envelope `version:1→1` — historical unchanged discriminator | [`a45a1a6323b17bbc98ae1adb90395b66ea931351`](https://github.com/salva/saivage-v3/commit/a45a1a6323b17bbc98ae1adb90395b66ea931351); `contracts/llm-usage.ts`, `provider-exchange.ts` | Added optional cached-input/reasoning-output counters to strict usage. Old readers reject populated new keys; absence does not prove every old file incompatible, certify compatibility or authorize backfill. Preserve omission as unknown; no invented usage. See [payload adoption](../runbook/index.md#provider-usage-payload-adoption). |
| Responses private producer identity and inline process-result payload — earlier source/discriminator boundaries unestablished here | [Runbook storage/adoption warnings](../runbook/index.md#storage-and-interruption); current `contracts/responses-conversation.ts`, `conversation-validation.ts`, `operator-api-processes.ts` and `tools/process-tool-result.ts` | Independent cumulative incompatibilities: required private `producer_account_id` and strict bounded inline stdout/stderr heads/completeness/counts/fallback URLs. Current enclosing conversation version is 5, **not evidence of the earlier enclosing versions or a historical 4→4/5→5 change**. External migration must evidence producer/stream facts, not fabricate them. |

Earlier workflow/configuration/card-order milestones remain bounded runbook
provenance, not a fabricated release timeline. The text-only transient recovery
reason rename introduced no supported format and is not another cutover. Multiple
changes in one complete operational adoption do not grant permission to reuse a
deployed discriminator.

## Conversation image results — 2026-10-07, conversation format 4→5

Introducing source commit:
`c527da662ef3d2c6db616983643bfbe7aeab1055` (`feat(agents): support immutable image inspection`).
The producer-neutral result follow-up
`9d4f16e5c51feed64de8efccdd35bd1a8388ac95`
(`refactor(agents): decouple typed image results from workspace metadata`)
belongs to this **same undeployed cutover**,
not a format-6 change. No installed instance was deployed or migrated by this
source issue; source completion/push is not deployment, reset or migration permission.

Exact discriminators advance together from **4 to 5**:

- Conversation index `format_version`.
- Ordinary and compacted conversation genesis `format_version`.
- Conversation-segment envelope `version`.

These discriminators are defined together in
`src/persistence/canonical-conversation-artifacts.ts`
(`conversationVersionIndexSchema`, shared `genesisBase`, and
`conversationSegmentEnvelopeSchema`), not inferred from PNG files or release names.

Unrelated card, record and provider-evidence versions do not change. Selected image
bodies are ordinary PNG files, not a separate versioned catalog.

The durable successful result may explicitly select one strict image descriptor
`{id,mime_type:'image/png',width,height,byte_length,sha256}` only with an executed
settlement and matching canonical call/result, policy, evidence and hash commitments.
Pixels live in the exact owning session's `images/<UUID>.png`, outside JSONL.
Consumption validates selected bytes/hash/dimensions; metadata inspection does not
inventory binary bodies. Unselected artifacts remain ignored forever.

`view_image` is the only implemented authorized producer. Its workspace metadata
is strict at production and canonical consumption, including sent-dimension
consistency. The lower typed result/constructor is producer-neutral: a future
explicitly implemented producer could supply its own data without pretending to be
`view_image`. This installs no MCP image ingress; arbitrary nested `data.image`,
`image_url` or base64 objects remain ordinary data, never attachments.

### Adoption and limits

Earlier-format and mixed state is rejected by strict current consumers. Equal
outer versions alone do not prove release compatibility. Adoption requires a
matching release and separately authorized operational actions:

- A separately consented whole-generated-state reset loses generated history.
- An explicitly owner-requested external offline migration follows the runbook's
  stopped/excluded, successful fresh complete preserved backup, independent
  complete candidate and strict full-validation gates, outside Saivage core.
  Never fabricate prior images/provenance or ship format converters.

This reference has bounded baseline and known-change coverage, not an exhaustive historical catalog.
Absent entries do not establish compatibility. The entry records durable format
meaning and source status; it certifies no installed state, migration fidelity,
provider perception, or lossless recovery.
