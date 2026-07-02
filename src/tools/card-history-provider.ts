import { z } from 'zod';

import { CardStore } from '../cards/card-store.js';
import type { AgentRole } from './tool-catalog.js';
import type { ToolContext } from './analyst-tool-types.js';
import { defineTool, type ToolProvider, type ToolResult } from './invocation.js';

export interface CardHistoryProviderContext {
  readonly projectRoot: string;
  readonly store?: ToolContext['store'];
  readonly sessionId?: string;
  readonly agentRole: Extract<AgentRole, 'planner' | 'executor' | 'reviewer' | 'analyst'>;
}

const listCardHistorySchema = z.object({ cardId: z.string() }).strict();
const getCardHistoryEntrySchema = z.object({ cardId: z.string(), version_seq: z.number().int() }).strict();
const diffCardSchema = z.object({ cardId: z.string(), fromSeq: z.number().int().optional(), toSeq: z.number().int().optional() }).strict();

function getStore(ctx: CardHistoryProviderContext): ToolContext['store'] {
  return ctx.store ?? new CardStore(ctx.projectRoot);
}

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
  const store = getStore(ctx);
  if (!store.read(params.cardId)) return { success: false, error: `Card '${params.cardId}' not found.` };
  const entries = store.listCardHistory(params.cardId).map((entry) => ({
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
  const entry = getStore(ctx).listCardHistory(params.cardId).find((candidate) => candidate.version_seq === params.version_seq);
  if (!entry) return { success: false, error: `Card '${params.cardId}' has no history entry for version ${params.version_seq}.` };
  return { success: true, data: entry };
}

async function diffCard(ctx: CardHistoryProviderContext, params: z.infer<typeof diffCardSchema>): Promise<ToolResult> {
  const store = getStore(ctx);
  const card = store.read(params.cardId);
  if (!card) return { success: false, error: `Card '${params.cardId}' not found.` };
  const toSeq = params.toSeq ?? card.version_seq;
  const fromSeq = params.fromSeq ?? Math.max(1, toSeq - 1);
  return { success: true, data: { card_id: params.cardId, from_version_seq: fromSeq, to_version_seq: toSeq, diff: store.diffCard(params.cardId, fromSeq, toSeq) } };
}
