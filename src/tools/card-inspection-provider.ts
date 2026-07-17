import { z } from 'zod';

import { PROJECT_CARD_ID, type CardService } from '../cards/card-api.js';
import { cardStatusValues, cardTypeValues, type AgentRole, type CardRecord, type CardStatus, type CardType } from '../schemas/index.js';
import { defineTool, type ToolProvider, type ToolResult } from './invocation.js';
import { computeCardLogicalPath, orderedCardsForTree, toCardView } from '../application/read-models/card-view.js';
import { recordSlotDefinitions } from '../runtime/records/record-slots.js';

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
  if (!ctx.store) throw new Error('Card inspection requires an injected card read model.');
  const store = ctx.store;
  return {
    providerName: 'card-inspection',
    tools: [
      defineTool({
        name: 'list_cards',
        description: 'List and filter cards in the project.',
        inputSchema: listCardsSchema,
        executor: async (args) => listCards(ctx.projectRoot, store, args),
      }),
      defineTool({
        name: 'get_card',
        description: 'Get full details of a single card.',
        inputSchema: getCardSchema,
        executor: async (args) => getCard(ctx.projectRoot, store, args.id),
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

function listCards(projectRoot: string, store: CardInspectionStore, params: z.infer<typeof listCardsSchema>): ToolResult {
  let cards = orderedCardViews(store);
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
    cards = cards.filter((card) => parent === null ? card.parent === null : childIds(store, parent).includes(card.id));
  }
  if (params.tag) {
    const tag = params.tag;
    cards = cards.filter((card) => card.tags.includes(tag));
  }
  void projectRoot;
  return { success: true, data: cards.map((card) => cardSummary(store, card)) };
}

function getCard(projectRoot: string, store: CardInspectionStore, cardId: string): ToolResult {
  const card = store.read(cardId);
  if (!card) return { success: false, error: `Card '${cardId}' not found.` };
  const children = childIds(store, cardId)
    .map((id) => store.read(id))
    .filter((child): child is CardRecord => child !== null)
    .map((child) => cardSummary(store, child));
  if (!isFullStore(store)) return { success: true, data: { ...card, logical_path: logicalPath(store, card), children } };
  const records = cardRecordSummaries(store, cardId);
  return { success: true, data: { ...toCardView(store, card), effective_updated_at: effectiveUpdatedAt(store, cardId), children, records, records_by_filename: Object.fromEntries(records.map((record) => [record.filename, record])) } };
}

function getTree(store: CardInspectionStore, rootId: string): ToolResult {
  const tree = treeNode(store, rootId);
  if (!tree) return { success: false, error: `Root card '${rootId}' not found.` };
  return { success: true, data: tree };
}

function orderedCardViews(store: CardInspectionStore): CardRecord[] {
  if (isFullStore(store)) return orderedCardsForTree(store);
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
  return { id: card.id, logical_path: logicalPath(store, card), type: card.type, title: card.title, status: card.status, priority: card.priority, parent: card.parent, tags: card.tags };
}

function treeNode(store: CardInspectionStore, cardId: string): Record<string, unknown> | null {
  const card = store.read(cardId);
  if (!card) return null;
  return { ...cardSummary(store, card), children: childIds(store, cardId).map((childId) => treeNode(store, childId)).filter((node): node is Record<string, unknown> => node !== null) };
}

function logicalPath(store: CardInspectionStore, card: CardRecord): string | null {
  if (isFullStore(store)) return computeCardLogicalPath(store, card);
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

function isFullStore(store: CardInspectionStore): store is CardService {
  return typeof store.list === 'function' && typeof store.listChildren === 'function';
}

function effectiveUpdatedAt(store: CardService, cardId: string): string | null {
  const committedTimes = [store.recordReader.cardArtifacts(cardId).current.committed_at, ...recordSlotDefinitions().filter((definition) => definition.exposed).map((definition) => { try { return store.readRecord(cardId, definition.filename).artifact.committed_at; } catch { return null; } })].filter((value): value is string => Boolean(value));
  if (committedTimes.length === 0) return null;
  return committedTimes.sort((a, b) => Date.parse(b) - Date.parse(a))[0]!;
}

function cardRecordSummaries(store: CardService, cardId: string): Array<Record<string, unknown>> {
  return recordSlotDefinitions()
    .filter((definition) => definition.exposed)
    .map((definition) => {
      try { const record = store.readRecord(cardId, definition.filename); const content = record.artifact.content; const max = 4000; return { filename: definition.filename, path: `record:///${definition.filename}`, url: record.recordUrl, latest: record.version, format: definition.format, schema: definition.schema, writers: definition.writers, size: Buffer.byteLength(content), modifiedAt: record.artifact.committed_at, writer: record.artifact.writer, inline: { content: content.slice(0, max), truncated: content.length > max } }; }
      catch { return { filename: definition.filename, path: `record:///${definition.filename}`, url: `record:///${definition.filename}?card=${encodeURIComponent(cardId)}`, latest: null, format: definition.format, schema: definition.schema, writers: definition.writers, size: null, modifiedAt: null, writer: null }; }
    });
}
