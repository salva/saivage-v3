import { z } from 'zod';

import { CardStore } from '../cards/card-store.js';
import type { AgentRole } from './tool-catalog.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { diff_card, get_card_history_entry, list_card_history } from './analyst-card-tools.js';
import { defineTool, type ToolProvider, type ToolResult as InvocationToolResult } from './invocation.js';

export interface CardHistoryProviderContext {
  readonly projectRoot: string;
  readonly store?: ToolContext['store'];
  readonly sessionId?: string;
  readonly agentRole: Extract<AgentRole, 'planner' | 'executor' | 'reviewer' | 'analyst'>;
}

const listCardHistorySchema = z.object({ cardId: z.string() }).strict();
const getCardHistoryEntrySchema = z.object({ cardId: z.string(), version_seq: z.number().int() }).strict();
const diffCardSchema = z.object({ cardId: z.string(), fromSeq: z.number().int().optional(), toSeq: z.number().int().optional() }).strict();

function toolContext(ctx: CardHistoryProviderContext): ToolContext {
  return { projectRoot: ctx.projectRoot, store: ctx.store ?? new CardStore(ctx.projectRoot), sessionId: ctx.sessionId, actor: ctx.agentRole, surface: ctx.agentRole === 'analyst' ? 'web-chat' : 'runtime' };
}

function invocationResult(result: ToolResult): InvocationToolResult {
  if (result.success) return { success: true, data: result.data };
  return { success: false, error: result.error ?? result.errorEnvelope?.message ?? 'Tool failed.' };
}

export function createCardHistoryProvider(ctx: CardHistoryProviderContext): ToolProvider {
  return {
    providerName: 'card-history',
    tools: [
      defineTool({
        name: 'list_card_history',
        description: 'List card history headers for a card.',
        inputSchema: listCardHistorySchema,
        executor: async (args) => invocationResult(await list_card_history(toolContext(ctx), args)),
      }),
      defineTool({
        name: 'get_card_history_entry',
        description: 'Get a specific card history entry snapshot.',
        inputSchema: getCardHistoryEntrySchema,
        executor: async (args) => invocationResult(await get_card_history_entry(toolContext(ctx), args)),
      }),
      defineTool({
        name: 'diff_card',
        description: 'Get a field-level diff between two card versions.',
        inputSchema: diffCardSchema,
        executor: async (args) => invocationResult(await diff_card(toolContext(ctx), args)),
      }),
    ],
  };
}
