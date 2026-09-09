import type { z } from 'zod';
import { type CardRecord, type CardStatus, type CardTypeName } from '../schemas/index.js';
import { defineToolBinder, executeToolAction, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, ToolArgumentValidationError, type ToolBinder } from './invocation.js';
import { toolFailed, toolSucceeded, type ToolActionOutcome } from '../contracts/tool-result.js';
import type { CardDeclaredRecordMetadataResult,CardService } from '../cards/card-api.js';
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

type CardInspectionStore=Pick<CardService,'listCardInspectionRows'|'readCardInspectionTree'|'getCardDetail'|'getCardChildren'|'listDeclaredRecordMetadata'>;

export interface CardInspectionProviderContext {
  readonly store: CardInspectionStore;
  readonly agentName?: string;
  readonly cardId?: string;
  readonly cardTypeVocabulary: readonly CardTypeName[];
}

const titlePreview = (title: string): string => utf8SafePreview(redactTextForOutbound(title), DISCOVERY_TEXT_PREVIEW_MAX_BYTES);
const COLLECTION_HELP = 'Collection pages expose total, position, returned, next, and items. Copy a non-null page next position unchanged to continue over stable input. An oversized item is a JsonSlice with lowercase-hex content_hex of its complete outbound-projected canonical JSON plus decoded-byte utf8_bytes, offset_bytes, next_offset_bytes, and total_bytes; hex-decode content_hex and concatenate slices by decoded-byte position, then UTF-8 decode and JSON-parse the complete item.';

export const cardInspectionToolBinders: readonly ToolBinder<CardInspectionProviderContext, any>[] = Object.freeze([
  defineToolBinder({ name: 'list_cards', description: `List and filter cards in canonical order as a byte-bounded paged collection. ${COLLECTION_HELP}`, resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: (ctx) => createListCardsInputSchema(ctx.cardTypeVocabulary), executor: (ctx, args) => executeToolAction('observational_query', async () => listCards(ctx.store, args)) }),
  defineToolBinder({ name: 'get_card', description: `Observe exactly one current-card section per call. Non-summary sections are byte-bounded collections. ${COLLECTION_HELP}`, resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: () => getCardInputSchema, executor: (ctx, args) => executeToolAction('observational_query', async () => getCard(ctx, args.id, args.section, args.position, args.response_bytes ?? DISCOVERY_RESPONSE_MAX_BYTES)) }),
  defineToolBinder({ name: 'get_tree', description: `Observe a flat canonical preorder page of one card subtree. ${COLLECTION_HELP}`, resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: () => getTreeInputSchema, executor: (ctx, args) => executeToolAction('observational_query', async () => getTree(ctx.store, args.rootId, args.depth, args.position, args.response_bytes ?? DISCOVERY_RESPONSE_MAX_BYTES)) }),
]);

function failure(error: string): ToolActionOutcome {
  return toolFailed(boundedToolError(error));
}

function cardNotFound(cardId: string): ToolActionOutcome {
  return failure(`Card '${utf8SafePreview(cardId, DISCOVERY_TEXT_PREVIEW_MAX_BYTES)}' not found.`);
}

function listCards(store: CardInspectionStore, params: ListCardsInput): ToolActionOutcome {
  const all=store.listCardInspectionRows();let rows=[...all];
  if (params.status) {
    const statuses: CardStatus[] = Array.isArray(params.status) ? params.status : [params.status];
    rows = rows.filter(({card}) => statuses.includes(card.lifecycle.status));
  }
  if (params.type) {
    const types: CardTypeName[] = Array.isArray(params.type) ? params.type : [params.type];
    rows = rows.filter(({card}) => types.includes(card.type));
  }
  if (params.parent !== undefined) {
    const parent = params.parent;
    if(parent!==null&&!all.some(({card})=>card.id===parent))return cardNotFound(parent);
    rows=rows.filter(({parentId})=>parentId===parent);
  }
  if (params.tag) {
    const tag = params.tag;
    rows = rows.filter(({card}) => card.tags.includes(tag));
  }
  const observation = observationSha256({
    surface: 'list_cards',
    filters: { status: params.status ?? null, type: params.type ?? null, parent: params.parent ?? null, tag: params.tag ?? null },
    cards: rows.map(({card}) => ({ id: card.id, version_seq: card.version_seq, status: card.lifecycle.status })),
  });
  const { data } = packCollectionData({
    cap: params.response_bytes ?? DISCOVERY_RESPONSE_MAX_BYTES,
    total: rows.length,
    position: params.position ?? { item_index: 0, item_byte_offset: 0 },
    item: (index) => {
      const {card,activeChildrenCount} = rows[index]!;
      return { id: card.id, type: card.type, status: card.lifecycle.status, title: titlePreview(card.title), children_count:activeChildrenCount };
    },
    render: (page: CollectionPage) => ({ observation_sha256: observation, cards: page }),
  });
  return toolSucceeded(data);
}

function getTree(store: CardInspectionStore, rootId: string, depth: number, position: CollectionPosition | undefined, responseBytes: number): ToolActionOutcome {
  const result=store.readCardInspectionTree(rootId,depth);if(result.kind==='card-not-found')return cardNotFound(rootId);
  const nodes=result.value.map(({card,parentId,relativeDepth,activeChildrenCount,activeDescendantCount})=>({
      id: card.id,
      parent: parentId,
      depth: relativeDepth,
      type: card.type,
      status: card.lifecycle.status,
      title: titlePreview(card.title),
      children_count: activeChildrenCount,
      descendants: activeDescendantCount,
      depth_omitted: relativeDepth===depth&&activeChildrenCount>0,
      version_seq: card.version_seq,
    }));
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
  let card:CardRecord;let sectionItems:readonly unknown[]|undefined;
  if(section==='children'){const result=store.getCardChildren(cardId);if(result.kind==='card-not-found')return cardNotFound(cardId);card=result.value.parent;sectionItems=result.value.activeChildren.map((child)=>{const projected=projectCardRecordForOutbound(child);return{id:projected.id,type:projected.type,status:projected.lifecycle.status,title:titlePreview(child.title)};});}
  else if(section==='records'){const result=store.listDeclaredRecordMetadata(cardId);if(result.kind==='card-not-found')return cardNotFound(cardId);card=result.value.card;sectionItems=recordMetadataItems(result.value.definitions);}
  else{const result=store.getCardDetail(cardId);if(result.kind==='card-not-found')return cardNotFound(cardId);card=result.value;}
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
  else items = () => sectionItems!;
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

function recordMetadataItems(entries:Extract<CardDeclaredRecordMetadataResult,{kind:'found'}>['value']['definitions']): Array<Record<string, unknown>> {
  return [...entries].map(({definition,classification}) => {
      const record=classification.kind==='present'?classification.projection:null;
      if(record)
      return { name: definition.filename, format: definition.format, state: record.artifact.state, head_version: record.headVersion, head_entry_id: record.artifact.entry_id, version_url: record.versionUrl };
      return { name: definition.filename, format: definition.format, state: 'absent' as const, head_version: null, head_entry_id: null, version_url: null };
  });
}
