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

Observed source baseline: `fb0152e99e423f5e5e2db5e28d7e38bb3166b759`, including the
ordered-tool-content source change described below (conversation format 6).
Introduction commits below establish source boundaries, not deployment dates or
installed-state facts. Compare the selected releases' actual owning schemas and
semantic consumers, including later changes; equal versions and successful startup
do not certify whole-project or historical compatibility. Maintain affected
baseline/change entries with implementation, recording evidence and honest unknowns.

## Current source baseline

### Durable-preserving MCP discovery settlement (F-07, 2026-10-09)

Source evidence: examined `f8d05e75`, implementation parent `6cb23dd2`, and
the existing lifecycle baseline `422b315f`; deployment/release applicability is
unknown. `mcp/stdio-transport.ts` and `mcp/streamable-http-transport.ts` classify
known external discovery rejection; `mcp/server-runtime.ts` retains containment
and stop joins, and `tools/mcp-provider.ts` retains its narrow typed conversion.
Future known rejected starts now produce the existing failed executed ToolResult
with evidence `none`. Retained failed results, attribution, unmatched calls and
uncertainty mates keep their existing interpretation and are never rewritten.
Synthetic production-composition coverage strictly consumes the new call/result
pairs, including a distinct corrective new start, through the current reader.

Conversation index/genesis `format_version:6` and segment `version:6` /
`type:conversation-segment` remain unchanged; selected images, card/record
selectors, app-log/provider-evidence shared envelope **1**, and configuration
are unaffected. No new family, bump or shared unreleased cutover is claimed.
This change alone requires no migration/reset; earlier 5→6 adoption remains
independent. Source approval grants no deployment, reset or migration consent,
and equal versions do not certify installed-state compatibility.

### Protocol-owned failed-provider diagnostic privacy (F-01, 2026-10-09)

Existing diagnostic family **`format_version:1 → 2`**, unchanged
`kind:failed-provider-request-diagnostic`; `privacy_policy` changes from
`failed-provider-request-privacy-1` to `failed-provider-request-privacy-2`.
The policy tag does not replace the owning family bump. The source contract was
introduced by `f8d05e75a7918cd74f7c24ec6f4a020fe4a3ce49` (historical introduction
below); this implementation's source parent is `d2092d63`. Installed/released
applicability is **unknown**: this is a fresh bump, not a shared unreleased cutover
or invented deployment date.

Evidence: strict v2 producer in `agents/failed-provider-request-diagnostics.ts`
and adjacent pure `failed-provider-request-projection.ts`; synthetic privacy and
pipeline regressions exercise actual Responses parsing/private-row publication/
same-account replay and actual prepared Codex system strings. Native positions now
use positive visible-field projection, omitting annotations, unknown items/content
and extensions without echoing unknown keys; a fixed aggregate extension marker
and precise subtree counts change retained diagnostic interpretation. Ordinary
application JSON retains type/ID-shaped data subject to structured/text privacy.
Raw submitted serialization/hash, transport and canonical replay remain unchanged.

New activations publish only v2; there is no retained reader/index. V1 files remain
untouched and must not be claimed to satisfy v2 privacy. Reused activation UUIDs
remain disabled. No scan, conversion, automatic disposal, application-state reset
or migration is needed or authorized for this isolated observational family.
Conversation **6**, card/record families, shared app-log/provider-evidence envelope
**1**, lifecycle lock and configuration remain unchanged. External migration/disposal
and deployment require separate operator scope.

### Historical introduction: private failed-provider diagnostic family (2026-10-09)

New family initial **`format_version:1`**, strict
`kind:failed-provider-request-diagnostic`, owned by
`src/agents/failed-provider-request-diagnostics.ts` (schema, privacy projection and
direct publisher). Exact path:
`.saivage/diagnostics/failed-provider-requests/<activation-UUID>/<diagnostic-UUID>.json`.
There is no selector/index or normal retained-document consumption. An exclusively
claimed activation directory and self-ignoring `.gitignore` precede publication;
reuse disables capture without retained reads. Later incompatible diagnostic shape
or interpretation requires this family's bump, not silent normalization.

Source applicability: reviewed baseline
`b818acddaf8194ec6c7a2964f2eaa4251dd9ec48`, freshness-checked introduction parent
`615ae32ce028ca32047cb4d31dad30e613a77144`. These are source boundaries only;
deployment/release applicability is **unknown**, not evidence of an unreleased
shared cutover. Evidence: the owner above, `agents/llm-provider-attempt.ts`,
`agents/invocation-service.ts`, `contracts/provider-request.ts`, actor/application
pinned-offset plumbing, CLI/start-input composition and
`workspace/file-access-security.ts`; synthetic pipeline/privacy/publication and
Files/startup tests cover these source contracts, not installed-state adoption.

The document records actual submitted-string raw hash/UTF-8 size, separately hashed
decoded stored body, exact/redacted/omitted fidelity, reencoding and counted privacy/
size omissions, canonical source versus actual invocation, purpose/input/final
attempt index and observed versus embedded statuses. Sensitive projected text is
not a secret-free export, replay fixture or provider receipt. CLI-only explicit
`start --failed-provider-diagnostics <UUID>` adoption is finite (16 failure slots,
one hour, 8 MiB per publication; metadata-only at most 16 KiB), not persistent YAML
or a canonical evidence field. Files excludes the new private subtree and aliases.

Existing card/head/history/mailbox/record discriminators remain **1**; conversation
index/genesis/envelopes remain **6**; app-log/provider-evidence retain their **shared
envelope 1**; lifecycle lock remains **1**. Ephemeral error code/attempt context is
not persisted there; unversioned configuration inputs are unchanged, not retrofitted.
This feature alone needs no reset/migration of already-valid canonical state.
Diagnostics accumulate separately from reset's four roots with no scan/cleanup.
Older Files lacks the exclusion: rollback must remove the opt-in argument and
separately avoid exposing retained diagnostics through old releases, or remain on
patched source. Deployment, reset and explicit external migration consent remain
separate; no converter or old-format reader is introduced. See the
[runbook](../runbook/index.md#private-failed-provider-request-diagnostics).

### Durable-preserving Markdown dependency refresh (2026-10-08)

Source applicability: implementation parent
`7a9a6415752eb71bdbbe3c8169892cbb82992f02`, not an installed-release claim.
`web/package.json` and its lock select Marked **18.1.0** (from 18.0.4) and
DOMPurify **3.4.16** (from 3.4.15). The unchanged
`web/src/components/content/MarkdownText.vue` transforms card references, parses
synchronously and sanitizes an HTML string for shared conversation/record/Files
presentation. Upstream rendering changes affect ephemeral HTML, not retained
source, reference/provenance interpretation, selections or layout; no data is rewritten.

Card/head/history/mailbox/record discriminators remain **1**, conversation
index/genesis/envelopes **6**, app-log/provider-evidence shared envelope **1**,
and lifecycle lock **1**. No affected family, bump or unreleased-cutover exception.
This change alone requires no migration/reset; adoption uses a matching built UI
over already-valid current data, with deployment authorization separate. Existing
old/mixed-state blockers and external-migration consent boundaries remain unchanged;
equal discriminators do not certify whole-installation compatibility.

### Durable-preserving operator image inspection (2026-10-08)

Source applicability: format-6 baseline `7a899887ec7b7d5972b2483fb72c219351e29139`,
including the recorded ordered-content cutover; this asserts no installed format.
Authenticated exact conversation-image and ordinary Files raster reads add binary
API success and a shared caller-local Fit/1:1 viewer, not durable shapes or changed
selection meaning. Evidence: `contracts/operator-api-{agents,core,files-debug}.ts`,
`application/read-models/{agent-operator,workspace-file}-read-model.ts` and the common
descriptor byte reader in `persistence/conversation-image.ts`. Conversation
index/genesis/envelope remain **6**, raw PNGs remain governed by that descriptor
contract, and card/record/provider-evidence families are untouched. No bump,
new image family or accumulated incompatible cutover is claimed. Adoption is
matching API/UI source over already-valid current state, not migration/reset
permission; old/mixed state remains unsupported.

Owner paths below are relative to repository `src/` at the observed revision;
[that exact source tree](https://github.com/salva/saivage-v3/tree/fb0152e99e423f5e5e2db5e28d7e38bb3166b759/src)
contains the schemas and direct publication/consumption owners.

| Durable family | Exact path/owner | Actual discriminator and essential semantics |
| --- | --- | --- |
| Card current head | Card namespace `card-head.json`; `persistence/canonical-card-artifacts.ts`, `card-files.ts` | `format_version:1`, `kind:card-head`; required `head_id`, ordinary selection and ordered current-only pending mailbox UUIDs. |
| Immutable card history | `card-history/<UUID>.json`; same schema/publication owners | `format_version:1`, `card-version` / `card-tombstone`; predecessor-linked ordinary/final payload, sparse ordinary revisions, no historical queue. |
| Mailbox documents | `mailbox/<UUID>.json`; same owners | `format_version:1`, `kind:card-message`; exact message identity selected only by current head, not a queue log. |
| Record head / accepted history | `records/record-<stem>.json`, `records/accepted/<UUID>.json`; `persistence/canonical-record-artifacts.ts`, `authored-record-files.ts` | `format_version:1`, `record-head` / `accepted-record`; required head identity, sole current draft, accepted predecessor and ordinary card provenance. |
| Conversation index and ordinary/compacted genesis | Session `index.json`, selected `versions/<ordinal>-<UUID>.jsonl`; `persistence/canonical-conversation-artifacts.ts`, `conversation-file.ts` | `format_version:6`; exact catalog/current selection, predecessor source/cutoff and explicit continuation, distinct from segment ordinal. |
| Conversation segment envelope / selected images | Same session versions and `images/<UUID>.png`; above owners, `contracts/{tool-result,image,view-image,conversation-validation}.ts`, `persistence/conversation-image.ts`, `layout.ts` | `version:6`, `type:conversation-segment`; strict nested message/tool-result/private-context and semantic contracts. Optional nonempty successful-result `content` selects ordered text/image blocks; each typed image descriptor selects a raw PNG governed by this conversation contract, with no independent image envelope/catalog version. |
| App log and session provider evidence | `.saivage/logs/app.jsonl`, session `provider-exchange.jsonl`; `contracts/{app-log,provider-exchange-log}.ts`, `persistence/{app-log,provider-exchange-log,growing-file}.ts` | Both use the **shared** `version:1`, `type:rows` envelope, with distinct strict row schemas and owners; these are not independently numbered envelopes. |
| Lifecycle lock | `.saivage/locks/runtime.lock`; `runtime/lock.ts` | `format_version:1`; separate lifecycle-exclusion boundary, not generated-root migration state. |

Boundary notes: `persistence/project-identity.ts` strictly consumes
`projectConfigSchema` without a dedicated format discriminator. Configuration and
operator inputs, raw work/process artifacts and layout/directory requirements are
not certified compatible or assigned invented versions by this table. Files
`card-current` and historical response wrappers are projections, not durable
families. `.prev.json` slots retain their selector contract's bytes, not a separate
family. Existing unversioned inputs are documented, not retrofitted here.

For the ordered-tool-content change, provider evidence retains its existing
shape and interpretation. Evidence: `agents/provider-exchange-recorder.ts`,
`provider-exchange-projection.ts`, `provider-exchange-outbound.ts` and the
Responses/Codex adapters retain the same request-parameter metadata (endpoint,
method, stream, tool count and existing protocol options), outcome/usage and
output identities. Native request `input`/pixels are not stored in those
parameters. App-log owners likewise retain their existing rows; the changed
provider wire serialization alone does not bump their shared envelope `1`.

## Durable-preserving MCP cancellation, native results and lifecycle (source baseline `422b315f`)

The combined implementation changes live invocation cancellation and transport
deadlines/admission, native CallToolResult validation and ordered text/image
production, and configured server lifecycle/control/discovery. Source evidence:
`mcp/{server-runtime,stdio-transport,streamable-http-transport,mcp-manager,native-result}.ts`
and `tools/{mcp-provider,mcp-native-result}.ts`, the producer-neutral decoder and
authenticated operator routes. Exact caller-reason propagation, provider error
classification, application joins and the single start deadline change live
ownership only; exact-entry configuration reads leave the configuration shape unchanged.

No additional durable impact or discriminator change is introduced. Conversation
index/genesis/envelope remain **6**, owned by `canonical-conversation-artifacts.ts`
and `conversation-file.ts`; descriptor fields, raw PNG selection/provenance, exact
session layout and generic tool rows retain their existing contracts. Native
envelope/structured metadata and indexed capture/discovery facts are ordinary
unconstrained tool data, not strict producer-specific retained contracts. Historical
MCP data is not reinterpreted or normalized. The 48 MiB wire, 32 MiB aggregate decoded
source and 1 MiB projected non-image bounds concern current input/production only.
Lifecycle tools and the pinned browser recipe use the same generic rows; no install
registry, durable topology or enable-state is introduced. App-log/provider-evidence
row shapes, interpretation and shared envelope **1** are unchanged, as are unrelated
durable families. Official integration E2E is separate validation evidence.

Source-release deployment applicability remains unknown; this is not a shared
unreleased cutover or a format-reuse claim. The existing 5→6 adoption decision
remains separate: adopting earlier-format retained state requires separately
consented reset or explicitly requested external offline migration to a matching
release. No deployment, reset or migration is authorized by this source work.

## Durable-preserving conversation API/UI change

The shared UI timeline now matches tool exchanges using the existing canonical
session/source-input/call identity rather than provider call ID alone. This is an
ephemeral association correction only: no payload, selection, layout interpretation
or discriminator changes; conversation index/genesis/envelope remain **6**. Adoption
is matching-source UI delivery, with no retained-state transformation or cutover.

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

## Durable-preserving MCP schema-language fix

Against `fb0152e99e423f5e5e2db5e28d7e38bb3166b759`,
`src/mcp/mcp-argument-validator.ts` dispatches current external discovery schemas
by declared/default language, and `src/mcp/protocol.ts` retains complete schema
typing. These change current external argument interpretation, not retained state.
Conversation index/genesis/envelope remain **6**, owned by
`canonical-conversation-artifacts.ts` and `conversation-file.ts`; typed result,
descriptor, PNG selection/provenance and unconstrained producer data are unchanged.
No other family/discriminator changes. The baseline link and current enclosing
version wording are accuracy corrections, not retrospective bumps.
This unit adds no native MCP producer or lifecycle surface and certifies no browser
containment or installed-state compatibility. Existing format-6 adoption warnings
remain; no deployment, reset or migration is authorized.

## Durable-preserving card-inspection ID admission

Against source baseline `cadf0f2144e9ae8fe56a2b3027e16e59d449e44e`,
`src/contracts/builtin-tool-inputs.ts` adopts the existing `cardIdSchema` for
`get_card.id`, `get_tree.rootId` and optional `list_cards.parent`. Real inspection
binders and `llmToolDefinition` derive future runtime/provider argument admission
from these inputs. Generic persisted call arguments and failed results keep their
original identities and pairing semantics; historical arguments are not revalidated
against current tool-input schemas. `conversation-file.ts` and the canonical
conversation/result consumers remain unchanged: index/genesis **format 6** and
segment envelope **version 6**. Card/record heads/history/mailbox **format 1**,
app-log/provider evidence shared envelope **version 1** and lifecycle lock
**format 1** are unchanged. No nested retained payload, provenance, selection,
layout or discriminator changes.

This note applies to this source change; installation applicability beyond the
reported incident pin `4df03ba88114bff605d3fab46c3c5074fe92f1c5` is unknown.
There is no shared unreleased cutover or version-reuse claim. This change itself
needs no migration/reset, but unrelated release differences still require full
source-contract comparison; it neither certifies adoption of current HEAD by
that older installation nor authorizes deployment or any instance action.

## Known incompatible changes

These source boundaries are directly evidenced, not an exhaustive timeline.
Historical unchanged discriminators are **pre-policy incompatibilities**, not
permission for future reuse or retrospective renumbering. The adoption consequence
for each incompatible boundary is a matching release plus separately consented
complete reset (losing generated history) or explicitly owner-requested external
offline migration under the runbook gates, never automatic conversion/deployment.

| Affected family / discriminator change | Source boundary and evidence | Change and adoption consequence |
| --- | --- | --- |
| Conversation index/genesis/envelope `5→6` | Ordered tool-content implementation against `d3cb2f4a2112ce08fe4f61f09d9904726d005cae`; `canonical-conversation-artifacts.ts`, `conversation-file.ts`, `contracts/{tool-result,conversation-validation,provider-conversation}.ts` and image/context/provider consumers | Replaces singular successful `image` with strict ordered nonempty optional `content` text/image blocks. All selected image occurrences retain exact source-session attribution and order, including retained rows and private-context conversation consumption. PNG bodies remain raw under the owning conversation descriptor contract. Format-5 deployment applicability is unknown, so this is a fresh bump, not reuse of the earlier cutover. Old/mixed state fails; adoption needs a separately consented complete reset or explicitly requested external offline migration to a matching release. Neither is authorized by source implementation; binary-only rollback over format 6 is unsupported. |
| Card/record representation replacement: card stream artifact `format_version:4` → owner heads/history/mailbox initial `1`; record stream `1` → replacement representation `1` | [`7405fa217df739bea481e93a99e1194a3df7ce1e`](https://github.com/salva/saivage-v3/commit/7405fa217df739bea481e93a99e1194a3df7ce1e), parent `8874026fbc765fe56828c87bee9a809943a7fef3`; diffs in `canonical-card-artifacts.ts`, `canonical-record-artifacts.ts`, `layout.ts` and direct file owners | Replaced `card.jsonl` and `authored-record-version` streams with `card-head` / predecessor-linked `card-version` / `card-tombstone` / `card-message` and `record-head` / `accepted-record` documents. Sparse ordinary/accepted history, current-only queues/drafts and ordinary card provenance replace full mutation streams. Old/mixed layouts fail; this historical representation replacement is **not** a prospective precedent for resetting an existing counter. |
| Card/record heads `format_version:1→1` — historical unchanged discriminator | [`71ad32847325a29c348799235fb95d81b22b652e`](https://github.com/salva/saivage-v3/commit/71ad32847325a29c348799235fb95d81b22b652e); head schemas and `publish-head.ts` | Required fresh `head_id` and exact previous-selector hardlinks; missing identities fail. Previous slots do not guarantee a usable recovery selection. No invented 1→2; [head adoption](../runbook/index.md#previous-selectors-and-head-identity-adoption) remains separately authorized. |
| Conversation index/genesis/envelope `3→4` | [`2f70b3db51529905ea96e2828957f27b1c1efabc`](https://github.com/salva/saivage-v3/commit/2f70b3db51529905ea96e2828957f27b1c1efabc); `canonical-conversation-artifacts.ts`, `conversation-validation.ts` and compaction owners | Removed compaction checksums, retained-row metadata and accumulated accounting while keeping source/cutoff/continuation semantics strict. Older schemas are rejected; unrelated families did not advance. Later 4→5 applies below. |
| App log / provider evidence shared envelope `version:1→1` — historical unchanged discriminator | [`251c93badf43f747dd93c2f99e6f2382fa0716e7`](https://github.com/salva/saivage-v3/commit/251c93badf43f747dd93c2f99e6f2382fa0716e7), parent `93ed39fff82a196ff1252d46547128e125202503`; `contracts/app-log.ts`, `provider-exchange-log.ts`, persistence owner/layout and unchanged `growing-file.ts` | Provider rows moved from app log to session-owned evidence, including owner-specific internal-summary identities. New app log rejects old provider rows; split ownership is not a same-format upgrade. Complete adoption covers all four generated roots, not selective logs. |
| Provider-usage payload, shared envelope `version:1→1` — historical unchanged discriminator | [`a45a1a6323b17bbc98ae1adb90395b66ea931351`](https://github.com/salva/saivage-v3/commit/a45a1a6323b17bbc98ae1adb90395b66ea931351); `contracts/llm-usage.ts`, `provider-exchange.ts` | Added optional cached-input/reasoning-output counters to strict usage. Old readers reject populated new keys; absence does not prove every old file incompatible, certify compatibility or authorize backfill. Preserve omission as unknown; no invented usage. See [payload adoption](../runbook/index.md#provider-usage-payload-adoption). |
| Responses private producer identity and inline process-result payload — earlier source/discriminator boundaries unestablished here | [Runbook storage/adoption warnings](../runbook/index.md#storage-and-interruption); current `contracts/responses-conversation.ts`, `conversation-validation.ts`, `operator-api-processes.ts` and `tools/process-tool-result.ts` | Independent cumulative incompatibilities: required private `producer_account_id` and strict bounded inline stdout/stderr heads/completeness/counts/fallback URLs. Current enclosing conversation version is 6, **not evidence of the earlier enclosing versions or a historical 4→4/5→5 change**. External migration must evidence producer/stream facts, not fabricate them. |

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
