import { z } from 'zod';

import type { ToolContext } from './analyst-tool-types.js';
import { canonicalToolExecution, defineToolBinder, observationalToolExecution, type ToolBinder, type ToolResult } from './invocation.js';
import { redactForOutbound } from '../redaction/index.js';
import { diffCardVersionsInputSchema, getCardVersionInputSchema, listCardVersionsInputSchema } from '../contracts/builtin-tool-inputs.js';
import { CardDiffResponseSchema, CardHistoryEntryResponseSchema, CardHistoryListResponseSchema } from '../contracts/index.js';
import { projectCardRecordForOutbound, projectCardVersionChangeForOutbound } from '../application/read-models/card-outbound.js';
import { CANONICAL_TOOL_RESULT_POLICY_TEMPLATE, OBSERVATIONAL_TOOL_RESULT_POLICY_TEMPLATE } from '../runtime/actors/llm-invocation.js';
import { canonicalJson } from '../schemas/index.js';
import { createHash } from 'node:crypto';

export interface CardVersionProviderContext {
  readonly store: ToolContext['store'];
}

export const cardVersionToolBinders: readonly ToolBinder<CardVersionProviderContext, any>[] = Object.freeze([
  defineToolBinder({ name: 'list_card_versions', description: 'List committed card versions without opening version content.', inputSchema: () => listCardVersionsInputSchema, resultPolicyTemplate: OBSERVATIONAL_TOOL_RESULT_POLICY_TEMPLATE, executor: async (ctx, args) => observationalToolExecution(await listCardVersions(ctx, args)) }),
  defineToolBinder({ name: 'get_card_version', description: 'Read one exact committed card version.', inputSchema: () => getCardVersionInputSchema, resultPolicyTemplate: CANONICAL_TOOL_RESULT_POLICY_TEMPLATE, executor: async (ctx, args) => getCardVersion(ctx, args) }),
  defineToolBinder({ name: 'diff_card_versions', description: 'Get a field-level diff between two card versions.', inputSchema: () => diffCardVersionsInputSchema, resultPolicyTemplate: OBSERVATIONAL_TOOL_RESULT_POLICY_TEMPLATE, executor: async (ctx, args) => observationalToolExecution(await diffCardVersions(ctx, args)) }),
]);

async function listCardVersions(ctx: CardVersionProviderContext, params: z.infer<typeof listCardVersionsInputSchema>): Promise<ToolResult> {
  const result = ctx.store.listCardVersions(params.card_id);
  if (result.kind === 'card-not-found') return { success: false, error: 'Card not found.', data: { code: 'card_not_found', card_id: params.card_id } };
  const versions = result.value.map((entry) => ({ entry_id: entry.entry_id, version: entry.version, published_at: entry.committed_at, content_availability: 'unchecked' as const, artifact_kind: entry.artifact_kind, change: projectCardVersionChangeForOutbound(entry.change) }));
  return { success: true, data: CardHistoryListResponseSchema.parse({ card_id: params.card_id, versions, total: versions.length }) };
}

async function getCardVersion(ctx: CardVersionProviderContext, params: z.infer<typeof getCardVersionInputSchema>) {
  const result = ctx.store.readCardVersion(params.card_id, params.version);
  if (result.kind === 'card-not-found') return canonicalToolExecution({ success: false, error: 'Card not found.', data: { code: 'card_not_found', card_id: params.card_id } }, { locator: '', sha256: '' });
  if (result.kind === 'version-not-found') return canonicalToolExecution({ success: false, error: 'Card version not found.', data: { code: 'card_version_not_found', card_id: params.card_id, version: params.version, side: 'selected' } }, { locator: '', sha256: '' });
  if (result.kind === 'historical-unavailable') return canonicalToolExecution({ success: false, error: 'Historical card version content unavailable.', data: { code: 'historical_version_content_unavailable', resource: 'card', owner_id: params.card_id, version: params.version, reason: result.reason } }, { locator: '', sha256: '' });
  const value = result.value; const artifact = value.kind === 'card-version' ? { kind: value.kind, card: projectCardRecordForOutbound(value.card), change: projectCardVersionChangeForOutbound(value.change) } : { kind: value.kind, final_card: projectCardRecordForOutbound(value.final_card), change: projectCardVersionChangeForOutbound(value.change)! };
  const providerResult = { success: true as const, data: CardHistoryEntryResponseSchema.parse({ card_id: params.card_id, version: params.version, entry_id: value.entry_id, published_at: value.committed_at, artifact }) };
  return canonicalToolExecution(providerResult, { locator: `card:///${encodeURIComponent(params.card_id)}?v=${params.version}#entry=${value.entry_id}`, sha256: createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex') });
}

async function diffCardVersions(ctx: CardVersionProviderContext, params: z.infer<typeof diffCardVersionsInputSchema>): Promise<ToolResult> {
  const result = ctx.store.diffCardVersions(params.card_id, { fromVersion: params.from_version, toVersion: params.to_version });
  if (result.kind === 'card-not-found') return { success: false, error: 'Card not found.', data: { code: 'card_not_found', card_id: params.card_id } };
  if (result.kind === 'invalid-pivots') return { success: false, error: 'Invalid card version pivots.', data: { code: 'invalid_card_version_pivots', card_id: params.card_id, from_version: result.from, to_version: result.to } };
  if (result.kind === 'version-not-found') return { success: false, error: 'Card version not found.', data: { code: 'card_version_not_found', card_id: params.card_id, version: result.version, side: result.side } };
  if (result.kind === 'historical-unavailable') return { success: false, error: 'Historical card diff side unavailable.', data: { code: 'historical_diff_side_unavailable', resource: 'card', owner_id: params.card_id, version: result.version, side: result.side, reason: result.reason } };
  return { success: true, data: CardDiffResponseSchema.parse({ card_id: params.card_id, from: result.from, to: result.to, diff: redactForOutbound({ source: 'card-diff', value: result.diff }) }) };
}
