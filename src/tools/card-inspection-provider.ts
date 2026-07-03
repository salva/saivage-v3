import { z } from 'zod';

import { existsSync, readFileSync, statSync } from 'node:fs';
import { CardStore, PROJECT_CARD_ID } from '../cards/store-api.js';
import { cardStatusValues, cardTypeValues, type CardRecord, type CardStatus, type CardType } from '../schemas/index.js';
import type { AgentRole } from './tool-definition.js';
import { defineTool, type ToolProvider, type ToolResult } from './invocation.js';
import { computeCardDisplayPath, orderedCardsForTree, toCardView } from '../application/read-models/card-view.js';
import { readRecordSlotIndex, recordPath, recordSlotDefinitions } from '../runtime/records/record-slots.js';

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
  if (!isFullStore(store)) return { success: true, data: { ...card, display_path: displayPath(store, card), children } };
  const records = cardRecordSummaries(projectRoot, cardId);
  return { success: true, data: { ...toCardView(store, card), effective_updated_at: effectiveUpdatedAt(projectRoot, cardId), children, records, records_by_filename: Object.fromEntries(records.map((record) => [record.filename, record])) } };
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
  return { id: card.id, display_path: displayPath(store, card), type: card.type, title: card.title, status: card.status, priority: card.priority, parent: card.parent, tags: card.tags };
}

function treeNode(store: CardInspectionStore, cardId: string): Record<string, unknown> | null {
  const card = store.read(cardId);
  if (!card) return null;
  return { ...cardSummary(store, card), children: childIds(store, cardId).map((childId) => treeNode(store, childId)).filter((node): node is Record<string, unknown> => node !== null) };
}

function displayPath(store: CardInspectionStore, card: CardRecord): string | null {
  if (isFullStore(store)) return computeCardDisplayPath(store, card);
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

function isFullStore(store: CardInspectionStore): store is CardStore {
  return typeof store.list === 'function' && typeof store.listChildren === 'function';
}

function effectiveUpdatedAt(projectRoot: string, cardId: string): string | null {
  const committedTimes: string[] = [];
  for (const slot of ['card', ...recordSlotDefinitions().filter((definition) => definition.exposed).map((definition) => definition.slot)]) {
    const index = readRecordSlotIndex(projectRoot, cardId, slot);
    if (index.latest === null) continue;
    const committedAt = index.versions[String(index.latest)]?.committed_at;
    if (committedAt) committedTimes.push(committedAt);
  }
  if (committedTimes.length === 0) return null;
  return committedTimes.sort((a, b) => Date.parse(b) - Date.parse(a))[0]!;
}

function cardRecordSummaries(projectRoot: string, cardId: string): Array<Record<string, unknown>> {
  return recordSlotDefinitions()
    .filter((definition) => definition.exposed)
    .map((definition) => {
      const index = readRecordSlotIndex(projectRoot, cardId, definition.slot);
      if (index.latest === null) return { filename: definition.filename, path: `record://${definition.filename}`, url: `record://${definition.filename}?card=${encodeURIComponent(cardId)}`, latest: null, format: definition.format, schema: definition.schema, writers: definition.writers, size: null, modifiedAt: null, writer: null };
      const entry = index.versions[String(index.latest)];
      const url = entry?.url ?? `record://${definition.filename}?card=${encodeURIComponent(cardId)}&v=${index.latest}`;
      const summary: Record<string, unknown> = { filename: definition.filename, path: `record://${definition.filename}`, url, latest: index.latest, format: definition.format, schema: definition.schema, writers: definition.writers, size: entry?.size ?? null, modifiedAt: entry?.committed_at ?? null, writer: entry?.writer ?? null };
      const path = recordPath(projectRoot, cardId, definition.slot, index.latest, definition.filename).absolutePath;
      if (existsSync(path)) {
        const max = 4000;
        const content = readFileSync(path, 'utf-8');
        summary.inline = { content: content.slice(0, max), truncated: statSync(path).size > Buffer.byteLength(content.slice(0, max), 'utf-8') };
      }
      return summary;
    });
}
