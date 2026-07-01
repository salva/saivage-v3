import { z } from 'zod';

import { CardStore, PROJECT_CARD_ID } from '../cards/store-api.js';
import { cardStatusValues, cardTypeValues, type CardRecord, type CardStatus, type CardType } from '../schemas/index.js';
import type { AgentRole } from './tool-catalog.js';
import { defineTool, type ToolProvider, type ToolResult } from './invocation.js';

interface CardInspectionStore {
  read(cardId: string): CardRecord | null;
  list?(): CardRecord[];
  listChildren?(cardId: string): string[];
}

export interface CardInspectionProviderContext {
  readonly projectRoot: string;
  readonly store?: CardInspectionStore;
  readonly agentRole: Extract<AgentRole, 'planner' | 'executor' | 'reviewer' | 'analyst'>;
}

const listCardsSchema = z.object({
  status: z.union([z.enum(cardStatusValues), z.array(z.enum(cardStatusValues))]).optional(),
  type: z.union([z.enum(cardTypeValues), z.array(z.enum(cardTypeValues))]).optional(),
  parent: z.string().optional(),
  tag: z.string().optional(),
}).strict();

const getCardSchema = z.object({ id: z.string() }).strict();
const getTreeSchema = z.object({ rootId: z.string().optional() }).strict();

export function createCardInspectionProvider(ctx: CardInspectionProviderContext): ToolProvider {
  const store = ctx.store ?? new CardStore(ctx.projectRoot);
  return {
    providerName: 'card-inspection',
    tools: [
      defineTool({
        name: 'list_cards',
        description: 'List and filter cards in the project.',
        inputSchema: listCardsSchema,
        executor: async (args) => listCards(store, args),
      }),
      defineTool({
        name: 'get_card',
        description: 'Get full details of a single card.',
        inputSchema: getCardSchema,
        executor: async (args) => getCard(store, args.id),
      }),
      defineTool({
        name: 'get_tree',
        description: 'Show the card tree.',
        inputSchema: getTreeSchema,
        executor: async (args) => getTree(store, args.rootId ?? PROJECT_CARD_ID),
      }),
    ],
  };
}

function listCards(store: CardInspectionStore, params: z.infer<typeof listCardsSchema>): ToolResult {
  let cards = orderedCards(store);
  if (params.status) {
    const statuses: CardStatus[] = Array.isArray(params.status) ? params.status : [params.status];
    cards = cards.filter((card) => statuses.includes(card.status));
  }
  if (params.type) {
    const types: CardType[] = Array.isArray(params.type) ? params.type : [params.type];
    cards = cards.filter((card) => types.includes(card.type));
  }
  if (params.parent !== undefined) {
    const parent = params.parent;
    cards = cards.filter((card) => card.parent === parent);
  }
  if (params.tag) {
    const tag = params.tag;
    cards = cards.filter((card) => card.tags.includes(tag));
  }
  return { success: true, data: cards.map((card) => cardSummary(store, card)) };
}

function getCard(store: CardInspectionStore, cardId: string): ToolResult {
  const card = store.read(cardId);
  if (!card) return { success: false, error: `Card '${cardId}' not found.` };
  const children = childIds(store, cardId)
    .map((id) => store.read(id))
    .filter((child): child is CardRecord => child !== null)
    .map((child) => cardSummary(store, child));
  return { success: true, data: { ...card, display_path: displayPath(store, card), children } };
}

function getTree(store: CardInspectionStore, rootId: string): ToolResult {
  const tree = treeNode(store, rootId);
  if (!tree) return { success: false, error: `Root card '${rootId}' not found.` };
  return { success: true, data: tree };
}

function orderedCards(store: CardInspectionStore): CardRecord[] {
  if (store.list) return store.list().sort((a, b) => a.depth - b.depth || a.position - b.position || a.id.localeCompare(b.id));
  const result: CardRecord[] = [];
  const visit = (cardId: string) => {
    const card = store.read(cardId);
    if (!card) return;
    result.push(card);
    for (const childId of childIds(store, cardId)) visit(childId);
  };
  visit(PROJECT_CARD_ID);
  return result;
}

function childIds(store: CardInspectionStore, cardId: string): string[] {
  return store.listChildren?.(cardId) ?? [];
}

function cardSummary(store: CardInspectionStore, card: CardRecord): Record<string, unknown> {
  return { id: card.id, display_path: displayPath(store, card), type: card.type, title: card.title, status: card.status, priority: card.priority, parent: card.parent, tags: card.tags };
}

function treeNode(store: CardInspectionStore, cardId: string): Record<string, unknown> | null {
  const card = store.read(cardId);
  if (!card) return null;
  return { ...cardSummary(store, card), children: childIds(store, cardId).map((childId) => treeNode(store, childId)).filter((node): node is Record<string, unknown> => node !== null) };
}

function displayPath(store: CardInspectionStore, card: CardRecord): string {
  const segments = [card.title || card.id];
  let parentId = card.parent;
  while (parentId) {
    const parent = store.read(parentId);
    if (!parent) break;
    segments.unshift(parent.title || parent.id);
    parentId = parent.parent;
  }
  return segments.join(' / ');
}
