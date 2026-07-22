import { z } from 'zod';

import type { ToolContext } from './analyst-tool-types.js';
import { defineTool, type ToolProvider, type ToolResult } from './invocation.js';
import { redactForOutbound } from '../redaction/index.js';
import { diffCardInputSchema, getCardHistoryEntryInputSchema, listCardHistoryInputSchema } from '../contracts/builtin-tool-inputs.js';
import { cardHistoryHeaderSchema } from '../schemas/index.js';

export interface CardHistoryProviderContext {
  readonly store: ToolContext['store'];
}

export function createCardHistoryProvider(ctx: CardHistoryProviderContext): ToolProvider {
  return {
    providerName: 'card-history',
    tools: [
      defineTool({
        name: 'list_card_history',
        description: 'List card history headers for a card.',
        inputSchema: listCardHistoryInputSchema,
        executor: async (args) => listCardHistory(ctx, args),
      }),
      defineTool({
        name: 'get_card_history_entry',
        description: 'Get a specific card history entry snapshot.',
        inputSchema: getCardHistoryEntryInputSchema,
        executor: async (args) => getCardHistoryEntry(ctx, args),
      }),
      defineTool({
        name: 'diff_card',
        description: 'Get a field-level diff between two card versions.',
        inputSchema: diffCardInputSchema,
        executor: async (args) => diffCard(ctx, args),
      }),
    ],
  };
}

async function listCardHistory(ctx: CardHistoryProviderContext, params: z.infer<typeof listCardHistoryInputSchema>): Promise<ToolResult> {
  const result = ctx.store.listCardHistory(params.cardId);
  if (result.kind === 'card-not-found') return { success: false, error: `Card '${params.cardId}' not found.` };
  const entries = result.value.map((entry) => redactForOutbound({ source: 'card-history', value: cardHistoryHeaderSchema.parse({
    entry_id: entry.entry_id,
    kind: entry.kind,
    card_id: entry.card_id,
    version_seq: entry.version_seq,
    changed_at: entry.changed_at,
    changed_by_actor: entry.changed_by_actor,
    changed_by_surface: entry.changed_by_surface,
    change_reason: entry.change_reason,
    changed_fields: entry.changed_fields,
    change_summary: entry.change_summary,
  }) }));
  return { success: true, data: entries };
}

async function getCardHistoryEntry(ctx: CardHistoryProviderContext, params: z.infer<typeof getCardHistoryEntryInputSchema>): Promise<ToolResult> {
  const result = ctx.store.getCardHistoryEntry(params.cardId, params.version_seq);
  if (result.kind === 'card-not-found') return { success: false, error: `Card '${params.cardId}' not found.` };
  if (result.kind === 'history-entry-not-found') return { success: false, error: `Card '${params.cardId}' has no history entry for version ${params.version_seq}.` };
  return { success: true, data: redactForOutbound({ source: 'card-history', value: result.value }) };
}

async function diffCard(ctx: CardHistoryProviderContext, params: z.infer<typeof diffCardInputSchema>): Promise<ToolResult> {
  const result = ctx.store.diffCardHistory(params.cardId, { fromSeq: params.fromSeq, toSeq: params.toSeq });
  if (result.kind === 'card-not-found') return { success: false, error: `Card '${params.cardId}' not found.` };
  if (result.kind === 'invalid-pivots') return { success: false, error: `Invalid diff pivots ${result.from}..${result.to}.` };
  if (result.kind === 'diff-source-not-found') return { success: false, error: `Card '${params.cardId}' has no version ${result.missingVersionSeq}.` };
  return { success: true, data: { card_id: params.cardId, from_version_seq: result.from, to_version_seq: result.to, diff: redactForOutbound({ source: 'card-diff', value: result.diff }) } };
}
