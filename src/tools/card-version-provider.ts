import type { z } from 'zod';

import type { ToolContext } from './analyst-tool-types.js';
import { CANONICAL_LOCATOR_RESULT_POLICY_TEMPLATE, defineToolBinder, executeCanonicalLocatorToolAction, executeToolAction, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, ToolArgumentValidationError, type ToolBinder } from './invocation.js';
import { toolFailed, toolSucceeded, type ToolActionOutcome } from '../contracts/tool-result.js';
import { redactForOutbound, redactTextForOutbound } from '../redaction/index.js';
import { diffCardVersionsInputSchema, getCardVersionInputSchema, listCardVersionsInputSchema, readRecordVersionInputSchema } from '../contracts/builtin-tool-inputs.js';
import { projectCardRecordForOutbound, projectCardVersionChangeForOutbound } from '../application/read-models/card-outbound.js';
import type { CardArtifact } from '../persistence/canonical-card-artifacts.js';
import { recordContentSha256 } from '../persistence/canonical-record-artifacts.js';
import {
  boundedToolError,
  DISCOVERY_RESPONSE_MAX_BYTES,
  DISCOVERY_TEXT_PREVIEW_MAX_BYTES,
  observationSha256,
  packCollectionData,
  packTextSliceData,
  utf8ByteLength,
  utf8SafePreview,
  type CollectionPage,
  type TextSlice,
} from './response-packer.js';
import { projectBoundedCardSummary, projectCardNotificationItems } from './card-section-projection.js';

export interface CardVersionProviderContext {
  readonly store: ToolContext['store'];
}

const COLLECTION_HELP = 'Collection pages expose total, position, returned, next, and items. Copy a non-null page next position unchanged to continue over stable input. An oversized item is a JsonSlice with lowercase-hex content_hex of its complete outbound-projected canonical JSON plus decoded-byte utf8_bytes, offset_bytes, next_offset_bytes, and total_bytes; hex-decode content_hex and concatenate slices by decoded-byte position, then UTF-8 decode and JSON-parse the complete item.';

export const cardVersionToolBinders: readonly ToolBinder<CardVersionProviderContext, any>[] = Object.freeze([
  defineToolBinder({ name: 'list_card_versions', description: `List the committed card version catalog as a byte-bounded paged collection. ${COLLECTION_HELP}`, resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: () => listCardVersionsInputSchema, executor: (ctx, args) => executeToolAction('observational_query', () => listCardVersions(ctx, args)) }),
  defineToolBinder({ name: 'get_card_version', description: `Read exactly one committed immutable card version section. The 'children' section is that row's complete active_child_order carrier and may include retained tombstoned links. Non-summary sections are byte-bounded collections. ${COLLECTION_HELP}`, resultPolicyTemplate: CANONICAL_LOCATOR_RESULT_POLICY_TEMPLATE, inputSchema: () => getCardVersionInputSchema, executor: (ctx, args) => executeCanonicalLocatorToolAction(() => getCardVersion(ctx, args)) }),
  defineToolBinder({ name: 'diff_card_versions', description: 'Compare two exact committed card versions through a plaintext TextSlice of the outbound-projected canonical JSON diff; offsets count UTF-8 bytes and this content is not hex encoded.', resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: () => diffCardVersionsInputSchema, executor: (ctx, args) => executeToolAction('observational_query', () => diffCardVersions(ctx, args)) }),
  defineToolBinder({ name: 'read_record_version', description: 'Read exactly one immutable authored-record version row by exact version. Record content uses a plaintext TextSlice with UTF-8 byte offsets and is not hex encoded.', resultPolicyTemplate: CANONICAL_LOCATOR_RESULT_POLICY_TEMPLATE, inputSchema: () => readRecordVersionInputSchema, executor: (ctx, args) => executeCanonicalLocatorToolAction(() => readRecordVersion(ctx, args)) }),
]);

function failure(error: string, data?: unknown): ToolActionOutcome {
  return toolFailed(boundedToolError(error), data);
}

function listCardVersions(ctx: CardVersionProviderContext, params: z.infer<typeof listCardVersionsInputSchema>): Promise<ToolActionOutcome> {
  const result = ctx.store.listCardVersions(params.card_id);
  if (result.kind === 'card-not-found') return Promise.resolve(failure('Card not found.', { code: 'card_not_found', card_id: params.card_id }));
  const versions = result.value;
  const observation = observationSha256({ surface: 'list_card_versions', card_id: params.card_id, versions: versions.map((entry) => ({ version: entry.version, entry_id: entry.entry_id })) });
  const { data } = packCollectionData({
    cap: params.response_bytes ?? DISCOVERY_RESPONSE_MAX_BYTES,
    total: versions.length,
    position: params.position ?? { item_index: 0, item_byte_offset: 0 },
    item: (index) => {
      const entry = versions[index]!;
      return {
        entry_id: entry.entry_id,
        version: entry.version,
        published_at: entry.committed_at,
        artifact_kind: entry.artifact_kind,
        change: projectCardVersionChangeForOutbound(entry.change),
      };
    },
    render: (page: CollectionPage) => ({ card_id: params.card_id, observation_sha256: observation, versions: page }),
  });
  return Promise.resolve(toolSucceeded(data));
}

function cardArtifactProjection(value: CardArtifact): unknown {
  return value.kind === 'card-version'
    ? { kind: value.kind, card: projectCardRecordForOutbound(value.card), change: projectCardVersionChangeForOutbound(value.change) }
    : { kind: value.kind, final_card: projectCardRecordForOutbound(value.final_card), change: projectCardVersionChangeForOutbound(value.change)! };
}

function artifactIdentity(value: CardArtifact): { entry_id: string; committed_at: string; artifact_kind: string } {
  return { entry_id: value.entry_id, committed_at: value.committed_at, artifact_kind: value.kind };
}

function getCardVersion(ctx: CardVersionProviderContext, params: z.infer<typeof getCardVersionInputSchema>): Promise<{ outcome: ToolActionOutcome; locator: string; sha256: string }> {
  const result = ctx.store.readCardVersion(params.card_id, params.version);
  if (result.kind === 'card-not-found') return Promise.resolve({ outcome: failure('Card not found.', { code: 'card_not_found', card_id: params.card_id }), locator: '', sha256: '' });
  if (result.kind === 'version-not-found') return Promise.resolve({ outcome: failure('Card version not found.', { code: 'card_version_not_found', card_id: params.card_id, version: params.version }), locator: '', sha256: '' });
  const value = result.value;
  const card = value.kind === 'card-version' ? value.card : value.final_card;
  const identity = artifactIdentity(value);
  const locator = `card:///${params.card_id}?v=${params.version}#entry=${identity.entry_id}`;
  const sha256 = observationSha256(cardArtifactProjection(value));
  const base = {
    card_id: params.card_id,
    version: params.version,
    entry_id: identity.entry_id,
    published_at: identity.committed_at,
    artifact_kind: identity.artifact_kind,
    artifact_sha256: sha256,
    section: params.section,
  };
  if (params.section === 'summary') {
    if (params.position !== undefined) throw new ToolArgumentValidationError("Section 'summary' is a bounded scalar section and accepts no position.");
    return Promise.resolve({
      outcome: toolSucceeded(projectBoundedCardSummary({ base, card, responseBytes: params.response_bytes ?? DISCOVERY_RESPONSE_MAX_BYTES })),
      locator,
      sha256,
    });
  }
  const projected = projectCardRecordForOutbound(card);
  let items: readonly unknown[];
  if (params.section === 'tags') items = projected.tags.map((tag) => utf8SafePreview(redactTextForOutbound(tag), DISCOVERY_TEXT_PREVIEW_MAX_BYTES));
  else if (params.section === 'dependencies') items = [...projected.depends_on];
  else if (params.section === 'related') items = [...projected.related];
  else if (params.section === 'notifications') items = projectCardNotificationItems(projected);
  else items = [...projected.active_child_order];
  const { data } = packCollectionData({
    cap: params.response_bytes ?? DISCOVERY_RESPONSE_MAX_BYTES,
    total: items.length,
    position: params.position ?? { item_index: 0, item_byte_offset: 0 },
    item: (index) => items[index]!,
    render: (page: CollectionPage) => ({ ...base, content: page }),
  });
  return Promise.resolve({ outcome: toolSucceeded(data), locator, sha256 });
}

function diffCardVersions(ctx: CardVersionProviderContext, params: z.infer<typeof diffCardVersionsInputSchema>): Promise<ToolActionOutcome> {
  if (params.from_version > params.to_version) return Promise.resolve(failure('Invalid card version pivots.', { code: 'invalid_card_version_pivots', card_id: params.card_id, from_version: params.from_version, to_version: params.to_version }));
  const result = ctx.store.diffCardVersions(params.card_id, { fromVersion: params.from_version, toVersion: params.to_version });
  if (result.kind === 'card-not-found') return Promise.resolve(failure('Card not found.', { code: 'card_not_found', card_id: params.card_id }));
  if (result.kind === 'invalid-pivots') return Promise.resolve(failure('Invalid card version pivots.', { code: 'invalid_card_version_pivots', card_id: params.card_id, from_version: result.from, to_version: result.to }));
  if (result.kind === 'version-not-found') return Promise.resolve(failure('Card version not found.', { code: 'card_version_not_found', card_id: params.card_id, version: result.version, side: result.side }));
  const fromIdentity={entry_id:result.fromArtifact.entry_id,artifact_sha256:observationSha256(cardArtifactProjection(result.fromArtifact))};
  const toIdentity={entry_id:result.toArtifact.entry_id,artifact_sha256:observationSha256(cardArtifactProjection(result.toArtifact))};
  const projectedDiff = redactForOutbound({ source: 'card-diff', value: result.diff });
  const observation = observationSha256({ surface: 'diff_card_versions', card_id: params.card_id, from_version: params.from_version, to_version: params.to_version, from_sha256: fromIdentity.artifact_sha256, to_sha256: toIdentity.artifact_sha256, diff: projectedDiff });
  const diffJson = JSON.stringify(projectedDiff);
  const totalBytes = utf8ByteLength(diffJson);
  const { data } = packTextSliceData({
    text: diffJson,
    byteOffset: params.byte_offset ?? 0,
    cap: params.response_bytes ?? DISCOVERY_RESPONSE_MAX_BYTES,
    render: (slice: TextSlice) => ({
      card_id: params.card_id,
      from_version: params.from_version,
      to_version: params.to_version,
      from_artifact: fromIdentity,
      to_artifact: toIdentity,
      observation_sha256: observation,
      diff: { ...slice, total_bytes: totalBytes },
    }),
  });
  return Promise.resolve(toolSucceeded(data));
}

function readRecordVersion(ctx: CardVersionProviderContext, params: z.infer<typeof readRecordVersionInputSchema>): Promise<{ outcome: ToolActionOutcome; locator: string; sha256: string }> {
  const result=ctx.store.readRecordVersion(params.card_id,params.record_name,params.version);
  if(result.kind!=='found')return Promise.resolve({outcome:failure('Record version not found.',{code:'record_version_not_found',card_id:params.card_id,record_name:params.record_name,version:params.version}),locator:'',sha256:''});
  const projection=result.value.projection;
  const artifact = projection.artifact;
  const selected = (() => {
    if (artifact.state === 'open') return { content: artifact.draft!.content, content_source: 'draft' as const, content_sha256: artifact.draft!.content_sha256 };
    if (artifact.state === 'closed') return { content: artifact.accepted!.content, content_source: 'accepted' as const, content_sha256: artifact.accepted!.content_sha256 };
    return artifact.accepted !== null
      ? { content: artifact.accepted.content, content_source: 'accepted' as const, content_sha256: artifact.accepted.content_sha256 }
      : { content: '', content_source: 'none' as const, content_sha256: null };
  })();
  const totalBytes = utf8ByteLength(selected.content);
  const evidenceSha256 = selected.content_sha256 ?? recordContentSha256('');
  const locator = `${projection.versionUrl}#entry=${artifact.entry_id}`;
  const { data } = packTextSliceData({
    text: selected.content,
    byteOffset: params.byte_offset ?? 0,
    cap: params.response_bytes ?? DISCOVERY_RESPONSE_MAX_BYTES,
    render: (slice: TextSlice) => ({
      card_id: params.card_id,
      record_name: params.record_name,
      version: artifact.version,
      entry_id: artifact.entry_id,
      version_url: projection.versionUrl,
      state: artifact.state,
      content_source: selected.content_source,
      content_sha256: selected.content_sha256,
      total_bytes: totalBytes,
      content: slice,
    }),
  });
  return Promise.resolve({ outcome: toolSucceeded(data), locator, sha256: evidenceSha256 });
}
