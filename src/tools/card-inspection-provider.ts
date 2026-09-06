import type { z } from 'zod';
import { type CardRecord, type CardStatus, type CardTypeName } from '../schemas/index.js';
import { defineToolBinder, executeToolAction, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, ToolArgumentValidationError, type ToolBinder } from './invocation.js';
import { toolFailed, toolSucceeded, type ToolActionOutcome } from '../contracts/tool-result.js';
import { orderedCardsForTree } from '../application/read-models/card-view.js';
import { AuthoredRecordNotFoundError, type RecordProjection } from '../persistence/authored-record-files.js';
import type { RecordDefinition } from '../records/record-definition.js';
import { cardParentId } from '../schemas/card-id.js';
import { projectCardRecordForOutbound } from '../application/read-models/card-outbound.js';
import { redactTextForOutbound } from '../redaction/index.js';
import { createListCardsInputSchema, getCardInputSchema, getTreeInputSchema, type ListCardsInput } from '../contracts/builtin-tool-inputs.js';
import {
  boundedToolError,
  DISCOVERY_RESPONSE_MAX_BYTES,
  DISCOVERY_TEXT_PREVIEW_MAX_BYTES,
  observationSha256,
  packCollectionData,
  utf8SafePreview,
  type CollectionPage,
  type CollectionPosition,
} from './response-packer.js';
import { projectBoundedCardSummary, projectCardNotificationItems } from './card-section-projection.js';

interface CardInspectionStore {
  read(cardId: string): CardRecord | null;
  list(): CardRecord[];
  listChildren(cardId: string): string[];
  readCurrentRecord(cardId: string, filename: string): RecordProjection;
  recordDefinitions(cardId: string): RecordDefinition[];
}

export interface CardInspectionProviderContext {
  readonly store: CardInspectionStore;
  readonly agentName?: string;
  readonly cardId?: string;
  readonly cardTypeVocabulary: readonly CardTypeName[];
}

const titlePreview = (title: string): string => utf8SafePreview(redactTextForOutbound(title), DISCOVERY_TEXT_PREVIEW_MAX_BYTES);

export const cardInspectionToolBinders: readonly ToolBinder<CardInspectionProviderContext, any>[] = Object.freeze([
  defineToolBinder({ name: 'list_cards', description: 'List and filter cards in canonical order as a byte-bounded paged collection.', resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: (ctx) => createListCardsInputSchema(ctx.cardTypeVocabulary), executor: (ctx, args) => executeToolAction('observational_query', async () => listCards(ctx.store, args)) }),
  defineToolBinder({ name: 'get_card', description: 'Observe exactly one current-card section per call.', resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: () => getCardInputSchema, executor: (ctx, args) => executeToolAction('observational_query', async () => getCard(ctx, args.id, args.section, args.position, args.response_bytes ?? DISCOVERY_RESPONSE_MAX_BYTES)) }),
  defineToolBinder({ name: 'get_tree', description: 'Observe a flat canonical preorder page of one card subtree.', resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: () => getTreeInputSchema, executor: (ctx, args) => executeToolAction('observational_query', async () => getTree(ctx.store, args.rootId, args.depth, args.position, args.response_bytes ?? DISCOVERY_RESPONSE_MAX_BYTES)) }),
]);

function failure(error: string): ToolActionOutcome {
  return toolFailed(boundedToolError(error));
}

function cardNotFound(cardId: string): ToolActionOutcome {
  return failure(`Card '${utf8SafePreview(cardId, DISCOVERY_TEXT_PREVIEW_MAX_BYTES)}' not found.`);
}

function orderedCardViews(store: CardInspectionStore): CardRecord[] {
  return orderedCardsForTree(store);
}

function listCards(store: CardInspectionStore, params: ListCardsInput): ToolActionOutcome {
  let cards = orderedCardViews(store);
  if (params.status) {
    const statuses: CardStatus[] = Array.isArray(params.status) ? params.status : [params.status];
    cards = cards.filter((card) => statuses.includes(card.lifecycle.status));
  }
  if (params.type) {
    const types: CardTypeName[] = Array.isArray(params.type) ? params.type : [params.type];
    cards = cards.filter((card) => types.includes(card.type));
  }
  if (params.parent !== undefined) {
    const parent = params.parent;
    const siblings = parent === null ? null : store.listChildren(parent);
    cards = cards.filter((card) => (siblings === null ? cardParentId(card.id) === null : siblings.includes(card.id)));
  }
  if (params.tag) {
    const tag = params.tag;
    cards = cards.filter((card) => card.tags.includes(tag));
  }
  const observation = observationSha256({
    surface: 'list_cards',
    filters: { status: params.status ?? null, type: params.type ?? null, parent: params.parent ?? null, tag: params.tag ?? null },
    cards: cards.map((card) => ({ id: card.id, version_seq: card.version_seq, status: card.lifecycle.status })),
  });
  const { data } = packCollectionData({
    cap: params.response_bytes ?? DISCOVERY_RESPONSE_MAX_BYTES,
    total: cards.length,
    position: params.position ?? { item_index: 0, item_byte_offset: 0 },
    item: (index) => {
      const card = cards[index]!;
      return { id: card.id, type: card.type, status: card.lifecycle.status, title: titlePreview(card.title), children_count: store.listChildren(card.id).length };
    },
    render: (page: CollectionPage) => ({ observation_sha256: observation, cards: page }),
  });
  return toolSucceeded(data);
}

function getTree(store: CardInspectionStore, rootId: string, depth: number, position: CollectionPosition | undefined, responseBytes: number): ToolActionOutcome {
  const root = store.read(rootId);
  if (!root) return cardNotFound(rootId);
  const nodes: Array<{ id: string; parent: string | null; depth: number; type: string; status: CardStatus; title: string; children_count: number; descendants: number; depth_omitted: boolean; version_seq: number }> = [];
  const countDescendants = (id: string): number => {
    let total = 0;
    for (const childId of store.listChildren(id)) total += 1 + countDescendants(childId);
    return total;
  };
  const visit = (cardId: string, relativeDepth: number): number => {
    const card = store.read(cardId);
    if (!card) throw new Error(`Linked child '${cardId}' disappeared during tree observation.`);
    const children = store.listChildren(cardId);
    const expand = relativeDepth < depth;
    const node = {
      id: cardId,
      parent: cardParentId(cardId),
      depth: relativeDepth,
      type: card.type,
      status: card.lifecycle.status,
      title: titlePreview(card.title),
      children_count: children.length,
      descendants: 0,
      depth_omitted: !expand && children.length > 0,
      version_seq: card.version_seq,
    };
    nodes.push(node);
    if (expand) {
      let descendants = 0;
      for (const childId of children) descendants += 1 + visit(childId, relativeDepth + 1);
      node.descendants = descendants;
    } else {
      let descendants = 0;
      for (const childId of children) descendants += 1 + countDescendants(childId);
      node.descendants = descendants;
    }
    return node.descendants;
  };
  visit(rootId, 0);
  const observation = observationSha256({ surface: 'get_tree', root_id: rootId, depth, nodes: nodes.map((node) => ({ id: node.id, version_seq: node.version_seq })) });
  const { data } = packCollectionData({
    cap: responseBytes,
    total: nodes.length,
    position: position ?? { item_index: 0, item_byte_offset: 0 },
    item: (index) => {
      const { version_seq: _version_seq, ...node } = nodes[index]!;
      return node;
    },
    render: (page: CollectionPage) => ({ root_id: rootId, depth, observation_sha256: observation, nodes: page }),
  });
  return toolSucceeded(data);
}

type CardSection = z.infer<typeof getCardInputSchema>['section'];

function getCard(ctx: CardInspectionProviderContext, cardId: string, section: CardSection, position: CollectionPosition | undefined, responseBytes: number): ToolActionOutcome {
  const store = ctx.store;
  const card = store.read(cardId);
  if (!card) return cardNotFound(cardId);
  const projected = projectCardRecordForOutbound(card);
  const base = { card_id: card.id, version_seq: card.version_seq, section };
  if (section === 'summary') {
    if (position !== undefined) throw new ToolArgumentValidationError("Section 'summary' is a bounded scalar section and accepts no position.");
    const data = projectBoundedCardSummary({ base, card, responseBytes });
    return toolSucceeded(data);
  }
  let items: () => readonly unknown[];
  if (section === 'tags') items = () => projected.tags.map((tag) => utf8SafePreview(redactTextForOutbound(tag), DISCOVERY_TEXT_PREVIEW_MAX_BYTES));
  else if (section === 'dependencies') items = () => [...projected.depends_on];
  else if (section === 'related') items = () => [...projected.related];
  else if (section === 'notifications') items = () => projectCardNotificationItems(projected);
  else if (section === 'children') items = () => store.listChildren(cardId).map((childId) => {
    const child = store.read(childId);
    if (!child) throw new Error(`Linked child '${childId}' disappeared during card observation.`);
    const childProjected = projectCardRecordForOutbound(child);
    return { id: childProjected.id, type: childProjected.type, status: childProjected.lifecycle.status, title: titlePreview(child.title) };
  });
  else items = () => recordMetadataItems(store, cardId);
  const complete = items();
  const observation = observationSha256({ surface: 'get_card', card_id: card.id, version_seq: card.version_seq, section, items: complete });
  const { data } = packCollectionData({
    cap: responseBytes,
    total: complete.length,
    position: position ?? { item_index: 0, item_byte_offset: 0 },
    item: (index) => complete[index]!,
    render: (page: CollectionPage) => ({ ...base, observation_sha256: observation, content: page }),
  });
  return toolSucceeded(data);
}

export function recordMetadataItems(store: Pick<CardInspectionStore, 'readCurrentRecord' | 'recordDefinitions'>, cardId: string): Array<Record<string, unknown>> {
  return store.recordDefinitions(cardId).map((definition) => {
    try {
      const record = store.readCurrentRecord(cardId, definition.filename);
      return { name: definition.filename, format: definition.format, state: record.artifact.state, head_version: record.headVersion, head_entry_id: record.artifact.entry_id, version_url: record.versionUrl };
    } catch (error) {
      if (error instanceof AuthoredRecordNotFoundError) return { name: definition.filename, format: definition.format, state: 'absent' as const, head_version: null, head_entry_id: null, version_url: null };
      throw error;
    }
  });
}
