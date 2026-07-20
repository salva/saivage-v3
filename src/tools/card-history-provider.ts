import { z } from 'zod';
import { cardIdSchema, positiveSafeIntegerSchema } from '../schemas/index.js';

import type { ToolContext } from './analyst-tool-types.js';
import { defineTool, type ToolProvider, type ToolResult } from './invocation.js';

export interface CardHistoryProviderContext {
  readonly store: ToolContext['store'];
}

const listCardHistorySchema = z.object({ cardId: cardIdSchema }).strict();
const getCardHistoryEntrySchema = z.object({ cardId: cardIdSchema, version_seq: positiveSafeIntegerSchema }).strict();
const diffCardSchema = z.object({ cardId: cardIdSchema, fromSeq: positiveSafeIntegerSchema.optional(), toSeq: positiveSafeIntegerSchema.optional() }).strict();

export function createCardHistoryProvider(ctx: CardHistoryProviderContext): ToolProvider {
  return {
    providerName: 'card-history',
    tools: [
      defineTool({
        name: 'list_card_history',
        description: 'List card history headers for a card.',
        inputSchema: listCardHistorySchema,
        executor: async (args) => listCardHistory(ctx, args),
      }),
      defineTool({
        name: 'get_card_history_entry',
        description: 'Get a specific card history entry snapshot.',
        inputSchema: getCardHistoryEntrySchema,
        executor: async (args) => getCardHistoryEntry(ctx, args),
      }),
      defineTool({
        name: 'diff_card',
        description: 'Get a field-level diff between two card versions.',
        inputSchema: diffCardSchema,
        executor: async (args) => diffCard(ctx, args),
      }),
    ],
  };
}

async function listCardHistory(ctx: CardHistoryProviderContext, params: z.infer<typeof listCardHistorySchema>): Promise<ToolResult> {
  const result = ctx.store.listCardHistory(params.cardId);
  if (result.kind === 'card-not-found') return { success: false, error: `Card '${params.cardId}' not found.` };
  const entries = result.value.map((entry) => ({
    card_id: entry.card_id,
    version_seq: entry.version_seq,
    changed_at: entry.changed_at,
    changed_by_actor: entry.changed_by_actor,
    changed_by_surface: entry.changed_by_surface,
    change_reason: entry.change_reason,
    changed_fields: entry.changed_fields,
    change_summary: entry.change_summary,
  }));
  return { success: true, data: entries };
}

async function getCardHistoryEntry(ctx: CardHistoryProviderContext, params: z.infer<typeof getCardHistoryEntrySchema>): Promise<ToolResult> {
  const result = ctx.store.getCardHistoryEntry(params.cardId, params.version_seq);
  if (result.kind === 'card-not-found') return { success: false, error: `Card '${params.cardId}' not found.` };
  if (result.kind === 'history-entry-not-found') return { success: false, error: `Card '${params.cardId}' has no history entry for version ${params.version_seq}.` };
  return { success: true, data: result.value };
}

async function diffCard(ctx: CardHistoryProviderContext, params: z.infer<typeof diffCardSchema>): Promise<ToolResult> {
  const result = ctx.store.diffCardHistory(params.cardId, { fromSeq: params.fromSeq, toSeq: params.toSeq });
  if (result.kind === 'card-not-found') return { success: false, error: `Card '${params.cardId}' not found.` };
  if (result.kind === 'invalid-pivots') return { success: false, error: `Invalid diff pivots ${result.from}..${result.to}.` };
  if (result.kind === 'diff-source-not-found') return { success: false, error: `Card '${params.cardId}' has no version ${result.missingVersionSeq}.` };
  return { success: true, data: { card_id: params.cardId, from_version_seq: result.from, to_version_seq: result.to, diff: result.diff } };
}
