import type { z } from 'zod';

import type { ToolContext } from './analyst-tool-types.js';
import { CANONICAL_LOCATOR_RESULT_POLICY_TEMPLATE, defineToolBinder, executeCanonicalLocatorToolAction, executeToolAction, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, ToolArgumentValidationError, type ToolBinder, type ToolResult } from './invocation.js';
import { redactForOutbound, redactTextForOutbound } from '../redaction/index.js';
import { diffCardVersionsInputSchema, getCardVersionInputSchema, listCardVersionsInputSchema, readRecordVersionInputSchema } from '../contracts/builtin-tool-inputs.js';
import { projectCardRecordForOutbound, projectCardVersionChangeForOutbound } from '../application/read-models/card-outbound.js';
import type { CardArtifact } from '../persistence/canonical-card-artifacts.js';
import { cardParentId } from '../schemas/card-id.js';
import { recordContentSha256 } from '../persistence/canonical-record-artifacts.js';
import { AuthoredRecordDefinitionNotFoundError, AuthoredRecordNotFoundError } from '../persistence/authored-record-files.js';
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

export interface CardVersionProviderContext {
  readonly store: ToolContext['store'];
}

export const cardVersionToolBinders: readonly ToolBinder<CardVersionProviderContext, any>[] = Object.freeze([
  defineToolBinder({ name: 'list_card_versions', description: 'List the committed card version catalog as a byte-bounded paged collection.', resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: () => listCardVersionsInputSchema, executor: (ctx, args) => executeToolAction('observational_query', () => listCardVersions(ctx, args)) }),
  defineToolBinder({ name: 'get_card_version', description: 'Read exactly one committed immutable card version section.', resultPolicyTemplate: CANONICAL_LOCATOR_RESULT_POLICY_TEMPLATE, inputSchema: () => getCardVersionInputSchema, executor: (ctx, args) => executeCanonicalLocatorToolAction(() => getCardVersion(ctx, args)) }),
  defineToolBinder({ name: 'diff_card_versions', description: 'Compare two exact committed card versions through a byte-sliced canonical JSON diff.', resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: () => diffCardVersionsInputSchema, executor: (ctx, args) => executeToolAction('observational_query', () => diffCardVersions(ctx, args)) }),
  defineToolBinder({ name: 'read_record_version', description: 'Read exactly one immutable authored-record artifact by exact version.', resultPolicyTemplate: CANONICAL_LOCATOR_RESULT_POLICY_TEMPLATE, inputSchema: () => readRecordVersionInputSchema, executor: (ctx, args) => executeCanonicalLocatorToolAction(() => readRecordVersion(ctx, args)) }),
]);

function failure(error: string, data?: unknown): ToolResult {
  return data === undefined ? { success: false, error: boundedToolError(error) } : { success: false, error: boundedToolError(error), data };
}

function listCardVersions(ctx: CardVersionProviderContext, params: z.infer<typeof listCardVersionsInputSchema>): Promise<ToolResult> {
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
  return Promise.resolve({ success: true, data });
}

function cardArtifactProjection(value: CardArtifact): unknown {
  return value.kind === 'card-version'
    ? { kind: value.kind, card: projectCardRecordForOutbound(value.card), change: projectCardVersionChangeForOutbound(value.change) }
    : { kind: value.kind, final_card: projectCardRecordForOutbound(value.final_card), change: projectCardVersionChangeForOutbound(value.change)! };
}

function artifactIdentity(value: CardArtifact): { entry_id: string; committed_at: string; artifact_kind: string } {
  return { entry_id: value.entry_id, committed_at: value.committed_at, artifact_kind: value.kind };
}

function getCardVersion(ctx: CardVersionProviderContext, params: z.infer<typeof getCardVersionInputSchema>): Promise<{ result: ToolResult; locator: string; sha256: string }> {
  const result = ctx.store.readCardVersion(params.card_id, params.version);
  if (result.kind === 'card-not-found') return Promise.resolve({ result: failure('Card not found.', { code: 'card_not_found', card_id: params.card_id }), locator: '', sha256: '' });
  if (result.kind === 'version-not-found') return Promise.resolve({ result: failure('Card version not found.', { code: 'card_version_not_found', card_id: params.card_id, version: params.version }), locator: '', sha256: '' });
  if (result.kind === 'historical-unavailable') return Promise.resolve({ result: failure('Historical card version content unavailable.', { code: 'historical_version_content_unavailable', resource: 'card', owner_id: params.card_id, version: params.version, reason: result.reason }), locator: '', sha256: '' });
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
    const projected = projectCardRecordForOutbound(card);
    return Promise.resolve({
      result: {
        success: true,
        data: {
          ...base,
          card: {
            id: projected.id,
            type: projected.type,
            status: projected.lifecycle.status,
            title: utf8SafePreview(redactTextForOutbound(card.title), DISCOVERY_TEXT_PREVIEW_MAX_BYTES),
            priority: projected.priority,
            urgency: projected.urgency,
            parent: cardParentId(projected.id),
            created_at: projected.created_at,
            updated_at: projected.updated_at,
            status_text: projected.status_text === null ? null : utf8SafePreview(projected.status_text, DISCOVERY_TEXT_PREVIEW_MAX_BYTES),
          },
        },
      },
      locator,
      sha256,
    });
  }
  const projected = projectCardRecordForOutbound(card);
  let items: readonly unknown[];
  if (params.section === 'tags') items = projected.tags.map((tag) => utf8SafePreview(redactTextForOutbound(tag), DISCOVERY_TEXT_PREVIEW_MAX_BYTES));
  else if (params.section === 'dependencies') items = [...projected.depends_on];
  else if (params.section === 'related') items = [...projected.related];
  else if (params.section === 'notifications') items = projected.pending_notifications.map((notification) => ({
    id: notification.id,
    content: utf8SafePreview(notification.content, DISCOVERY_TEXT_PREVIEW_MAX_BYTES),
    content_bytes: utf8ByteLength(notification.content),
    content_truncated: utf8ByteLength(notification.content) > DISCOVERY_TEXT_PREVIEW_MAX_BYTES,
    created_at: notification.created_at,
    ...('source' in notification ? { source: notification.source } : {}),
  }));
  else items = [...projected.children];
  const { data } = packCollectionData({
    cap: params.response_bytes ?? DISCOVERY_RESPONSE_MAX_BYTES,
    total: items.length,
    position: params.position ?? { item_index: 0, item_byte_offset: 0 },
    item: (index) => items[index]!,
    render: (page: CollectionPage) => ({ ...base, content: page }),
  });
  return Promise.resolve({ result: { success: true, data }, locator, sha256 });
}

function diffCardVersions(ctx: CardVersionProviderContext, params: z.infer<typeof diffCardVersionsInputSchema>): Promise<ToolResult> {
  if (params.from_version > params.to_version) return Promise.resolve(failure('Invalid card version pivots.', { code: 'invalid_card_version_pivots', card_id: params.card_id, from_version: params.from_version, to_version: params.to_version }));
  const result = ctx.store.diffCardVersions(params.card_id, { fromVersion: params.from_version, toVersion: params.to_version });
  if (result.kind === 'card-not-found') return Promise.resolve(failure('Card not found.', { code: 'card_not_found', card_id: params.card_id }));
  if (result.kind === 'invalid-pivots') return Promise.resolve(failure('Invalid card version pivots.', { code: 'invalid_card_version_pivots', card_id: params.card_id, from_version: result.from, to_version: result.to }));
  if (result.kind === 'version-not-found') return Promise.resolve(failure('Card version not found.', { code: 'card_version_not_found', card_id: params.card_id, version: result.version, side: result.side }));
  if (result.kind === 'historical-unavailable') return Promise.resolve(failure('Historical card diff side unavailable.', { code: 'historical_diff_side_unavailable', resource: 'card', owner_id: params.card_id, version: result.version, side: result.side, reason: result.reason }));
  const identityOf = (version: number): { entry_id: string; artifact_sha256: string } | null => {
    const side = ctx.store.readCardVersion(params.card_id, version);
    return side.kind === 'found' ? { entry_id: side.value.entry_id, artifact_sha256: observationSha256(cardArtifactProjection(side.value)) } : null;
  };
  const fromIdentity = identityOf(params.from_version);
  const toIdentity = identityOf(params.to_version);
  if (!fromIdentity || !toIdentity) throw new Error('Compared card versions disappeared between the diff and identity reads.');
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
  return Promise.resolve({ success: true, data });
}

function readRecordVersion(ctx: CardVersionProviderContext, params: z.infer<typeof readRecordVersionInputSchema>): Promise<{ result: ToolResult; locator: string; sha256: string }> {
  const reader = ctx.store.recordReader;
  let projection: ReturnType<typeof reader.historical>;
  try {
    reader.definition(params.card_id, params.record_name);
    projection = reader.historical(params.card_id, params.record_name, params.version);
  } catch (error) {
    if (error instanceof AuthoredRecordNotFoundError || error instanceof AuthoredRecordDefinitionNotFoundError)
      return Promise.resolve({ result: failure('Record version not found.', { code: 'record_version_not_found', card_id: params.card_id, record_name: params.record_name, version: params.version }), locator: '', sha256: '' });
    throw error;
  }
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
  return Promise.resolve({ result: { success: true, data }, locator, sha256: evidenceSha256 });
}
