import { z } from 'zod';

import { PROJECT_CARD_ID, type CardService } from '../cards/card-api.js';
import { type CardRecord, type CardStatus, type CardType } from '../schemas/index.js';
import { defineTool, type ToolProvider, type ToolResult } from './invocation.js';
import { computeCardLogicalPath, orderedCardsForTree, toCardView } from '../application/read-models/card-view.js';
import { AuthoredRecordNotFoundError } from '../persistence/authored-record-files.js';
import { cardParentId } from '../schemas/card-id.js';
import { projectCardRecordForOutbound } from '../application/read-models/card-outbound.js';
import { redactSnippetForOutbound, redactTextForOutbound } from '../redaction/index.js';
import { getCardInputSchema, getTreeInputSchema, listCardsInputSchema } from '../contracts/builtin-tool-inputs.js';

interface CardInspectionStore {
  read(cardId: string): CardRecord | null;
  list?(): CardRecord[];
  listChildren?(cardId: string): string[];
}

export interface CardInspectionProviderContext {
  readonly store: CardInspectionStore;
}

export function createCardInspectionProvider(ctx: CardInspectionProviderContext): ToolProvider {
  const store = ctx.store;
  return {
    providerName: 'card-inspection',
    tools: [
      defineTool({
        name: 'list_cards',
        description: 'List and filter cards in the project.',
        inputSchema: listCardsInputSchema,
        executor: async (args) => listCards(store, args),
      }),
      defineTool({
        name: 'get_card',
        description: 'Get full details of a single card.',
        inputSchema: getCardInputSchema,
        executor: async (args) => getCard(store, args.id),
      }),
      defineTool({
        name: 'get_tree',
        description: 'Show the card tree.',
        inputSchema: getTreeInputSchema,
        executor: async (args) => getTree(store, args.rootId ?? PROJECT_CARD_ID),
      }),
    ],
  };
}

function listCards(store: CardInspectionStore, params: z.infer<typeof listCardsInputSchema>): ToolResult {
  let cards = orderedCardViews(store);
  if (params.status) {
    const statuses: CardStatus[] = Array.isArray(params.status) ? params.status : [params.status];
    cards = cards.filter((card) => statuses.includes(card.lifecycle.status));
  }
  if (params.type) {
    const types: CardType[] = Array.isArray(params.type) ? params.type : [params.type];
    cards = cards.filter((card) => types.includes(card.type));
  }
  if (params.parent !== undefined) {
    const parent = params.parent;
    cards = cards.filter((card) => parent === null ? cardParentId(card.id) === null : childIds(store, parent).includes(card.id));
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
  const projectedCard = projectCardRecordForOutbound(card);
  if (!isFullStore(store)) return { success: true, data: { card: projectedCard, status: card.lifecycle.status, parent: cardParentId(card.id), logical_path: projectedLogicalPath(store, card), children } };
  const records = cardRecordSummaries(store, cardId);
  const view = toCardView(store, card);
  const operatorSummary = { ...view.operator_summary, error: view.operator_summary.error === null ? null : redactTextForOutbound(view.operator_summary.error) };
  return { success: true, data: { ...view, card: projectedCard, operator_summary: operatorSummary, effective_updated_at: effectiveUpdatedAt(store, cardId), children, records, records_by_filename: Object.fromEntries(records.map((record) => [record.filename, record])) } };
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
  return { id: card.id, logical_path: projectedLogicalPath(store, card), type: card.type, title: redactTextForOutbound(card.title), status: card.lifecycle.status, priority: card.priority, parent: cardParentId(card.id), tags: card.tags };
}

function projectedLogicalPath(store: CardInspectionStore, card: CardRecord): string | null {
  const path = logicalPath(store, card);
  return path === null ? null : redactTextForOutbound(path);
}

function treeNode(store: CardInspectionStore, cardId: string): Record<string, unknown> | null {
  const card = store.read(cardId);
  if (!card) return null;
  return { ...cardSummary(store, card), children: childIds(store, cardId).map((childId) => treeNode(store, childId)).filter((node): node is Record<string, unknown> => node !== null) };
}

function logicalPath(store: CardInspectionStore, card: CardRecord): string | null {
  if (isFullStore(store)) return computeCardLogicalPath(store, card);
  const segments = [card.title || card.id];
  let parentId = cardParentId(card.id);
  while (parentId) {
    const parent = store.read(parentId);
    if (!parent) break;
    segments.unshift(parent.title || parent.id);
    parentId = cardParentId(parent.id);
  }
  return segments.join(' / ');
}

function isFullStore(store: CardInspectionStore): store is CardService {
  return typeof store.list === 'function' && typeof store.listChildren === 'function';
}

function effectiveUpdatedAt(store: CardService, cardId: string): string | null {
  const committedTimes = [store.recordReader.cardArtifacts(cardId).current.committed_at, ...store.recordReader.definitions(cardId).map((definition) => { try { return store.readRecord(cardId, definition.filename).artifact.committed_at; } catch (error) { if (error instanceof AuthoredRecordNotFoundError) return null; throw error; } })].filter((value): value is string => Boolean(value));
  if (committedTimes.length === 0) return null;
  return committedTimes.sort((a, b) => Date.parse(b) - Date.parse(a))[0]!;
}

function cardRecordSummaries(store: CardService, cardId: string): Array<Record<string, unknown>> {
  return store.recordReader.definitions(cardId)
    .map((definition) => {
      try { const record = store.readRecord(cardId, definition.filename); const content = record.artifact.content; const max = 4000; return { filename: definition.filename, path: `record:///${definition.filename}`, url: record.recordUrl, latest: record.version, format: definition.format, schema: definition.schema, writers: definition.writers, size: Buffer.byteLength(content), modifiedAt: record.artifact.committed_at, writer: record.artifact.writer_agent, inline: { content: redactSnippetForOutbound(content, max), truncated: content.length > max } }; }
      catch (error) { if (!(error instanceof AuthoredRecordNotFoundError)) throw error; return { filename: definition.filename, path: `record:///${definition.filename}`, url: `record:///${definition.filename}?card=${encodeURIComponent(cardId)}`, latest: null, format: definition.format, schema: definition.schema, writers: definition.writers, size: null, modifiedAt: null, writer: null }; }
    });
}
