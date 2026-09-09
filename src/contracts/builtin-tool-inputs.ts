import { z } from 'zod';

import { cardIdSchema, cardStatusValues, ConversationSessionIdSchema, eventKindValues, positiveSafeIntegerSchema, recordNameSchema, urgencyValues, type CardStatus, type CardTypeName } from '../schemas/index.js';
import { workspaceNavigationTargetSchema } from './workspace-navigation.js';

export const EVENT_QUERY_MAX_LIMIT = 1000;
export const emptyToolInputSchema = z.object({}).strict();

export const DISCOVERY_RESPONSE_MAX_BYTES = 32768;
export const DISCOVERY_RESPONSE_MIN_BYTES = 512;
const responseBytesSchema = z.number().int().min(DISCOVERY_RESPONSE_MIN_BYTES).max(DISCOVERY_RESPONSE_MAX_BYTES)
  .describe(`Exact UTF-8 byte budget for the complete canonical provider-visible ToolResult envelope; minimum ${DISCOVERY_RESPONSE_MIN_BYTES}, maximum ${DISCOVERY_RESPONSE_MAX_BYTES}.`);
const discoveryCollectionPositionSchema = z.object({
  item_index: z.number().int().min(0).describe('Zero-based canonical-order item index from the previously emitted next position; omit for the first page.'),
  item_byte_offset: z.number().int().min(0).describe('Decoded UTF-8 byte offset copied exactly from the previously emitted page next position; zero starts an item, while a nonzero value must be a valid boundary strictly inside its complete outbound-projected canonical JSON.'),
}).strict().describe('Stateless continuation position for a byte-packed collection page. Copy the complete page next position; do not use a slice end as a position independently.');
const discoveryReadPositionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('collection'), item_index: z.number().int().min(0), item_byte_offset: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal('text'), byte_offset: z.number().int().min(0) }).strict(),
]);
const cardSectionSchema = z.enum(['summary', 'tags', 'dependencies', 'related', 'notifications', 'children', 'records'])
  .describe('Exactly one current-card section per call.');
const cardVersionSectionSchema = z.enum(['summary', 'tags', 'dependencies', 'related', 'notifications', 'children'])
  .describe("Exactly one card-artifact-owned section per call. The children section is the selected immutable row's complete active_child_order carrier and may include retained tombstoned links.");

const cardTypeEnum = (cardTypeVocabulary: readonly CardTypeName[]) => z.enum(cardTypeVocabulary as [CardTypeName, ...CardTypeName[]]);

export const createAnalystCreateCardInputSchema = (cardTypeVocabulary: readonly CardTypeName[]) => z.object({
  type: cardTypeEnum(cardTypeVocabulary).describe(`The non-project card type. Allowed values: ${cardTypeVocabulary.join(', ')}.`),
  parent: cardIdSchema.describe('The exact existing parent card ID for the new child.'),
  title: z.string().describe('A short title.'),
  bootstrap_content: z.string().trim().min(1).describe('Non-empty Markdown content for the child type configured bootstrap record.'),
  tags: z.array(z.string().describe('A tag string')).optional().describe('Optional tags.'),
  priority: z.number().int().optional().describe('Optional priority value (0-100).'),
  urgency: z.enum(urgencyValues).optional().describe('Optional urgency level.'),
  depends_on: z.array(z.string().describe('A card ID')).optional().describe('Optional dependency list.'),
  related: z.array(z.string().describe('A card ID')).optional().describe('Optional related-card list.'),
}).strict();
export type AnalystCreateCardInput = z.infer<ReturnType<typeof createAnalystCreateCardInputSchema>>;
export const analystReorderChildInputSchema = z.object({ parentId: z.string().describe('Parent whose children to reorder.'), orderedChildIds: z.array(z.string()).describe('New child id order; must be a permutation of the current child set.') }).strict();
export const analystReopenCardInputSchema = z.object({ cardId: cardIdSchema.describe('The exact card id to reopen.') }).strict();
export const analystCancelCardInputSchema = z.object({ cardId: z.string().describe('The ID of the card to cancel.'), reason: z.string().optional().describe('Optional cancellation reason.') }).strict();
export const analystDeleteCardInputSchema = z.object({ ids: z.array(z.string()).min(1).describe('Card ids to delete.') }).strict();

export const queueNotificationInputSchema = z.object({ card_id: cardIdSchema.describe('The exact card id.'), kind: z.string().min(1).describe('A short categorical label.'), body: z.string().min(1).describe('The context text to inject.') }).strict();
export const readAgentSessionInputSchema = z.object({ session_id: ConversationSessionIdSchema, last_n: z.number().int().min(1).max(1000).optional() }).strict();
export const readRuntimeEventsInputSchema = z.object({ limit: z.number().int().positive().max(EVENT_QUERY_MAX_LIMIT).optional(), kind: z.enum(eventKindValues).optional() }).strict();
export const readRuntimeErrorsInputSchema = z.object({ limit: z.number().int().positive().max(EVENT_QUERY_MAX_LIMIT).optional() }).strict();
export const readControlActionsInputSchema = z.object({ limit: z.number().int().optional(), since: z.string().optional() }).strict();
export const listProcessesInputSchema = z.object({ status: z.string().optional(), cardId: z.string().optional() }).strict();
export const navigateWorkspaceInputSchema = z.object({ target: workspaceNavigationTargetSchema }).strict();
export type NavigateWorkspaceInput = z.infer<typeof navigateWorkspaceInputSchema>;

export interface ListCardsInput {
  status?: CardStatus | CardStatus[];
  type?: CardTypeName | CardTypeName[];
  parent?: string;
  tag?: string;
  position?: z.infer<typeof discoveryCollectionPositionSchema>;
  response_bytes?: number;
}
export const createListCardsInputSchema = (cardTypeVocabulary: readonly CardTypeName[]): z.ZodType<ListCardsInput> => z.object({
  status: z.union([z.enum(cardStatusValues), z.array(z.enum(cardStatusValues))]).optional(),
  type: z.union([cardTypeEnum(cardTypeVocabulary), z.array(cardTypeEnum(cardTypeVocabulary))]).optional(),
  parent: z.string().optional(),
  tag: z.string().optional(),
  position: discoveryCollectionPositionSchema.optional(),
  response_bytes: responseBytesSchema.optional(),
}).strict();
export const getCardInputSchema = z.object({
  id: z.string().describe('The exact card id.'),
  section: cardSectionSchema,
  position: discoveryCollectionPositionSchema.optional(),
  response_bytes: responseBytesSchema.optional(),
}).strict();
export const getTreeInputSchema = z.object({
  rootId: z.string().describe('The exact card id whose subtree is observed.'),
  depth: z.number().int().min(1).max(12).default(3).describe('Maximum observed subtree depth below the root.'),
  position: discoveryCollectionPositionSchema.optional(),
  response_bytes: responseBytesSchema.optional(),
}).strict();
export const listCardVersionsInputSchema = z.object({
  card_id: cardIdSchema,
  position: discoveryCollectionPositionSchema.optional(),
  response_bytes: responseBytesSchema.optional(),
}).strict();
export const getCardVersionInputSchema = z.object({
  card_id: cardIdSchema,
  version: positiveSafeIntegerSchema,
  section: cardVersionSectionSchema,
  position: discoveryCollectionPositionSchema.optional(),
  response_bytes: responseBytesSchema.optional(),
}).strict();
export const diffCardVersionsInputSchema = z.object({
  card_id: cardIdSchema,
  from_version: positiveSafeIntegerSchema,
  to_version: positiveSafeIntegerSchema.describe('Exact committed target version; there is no current pivot.'),
  byte_offset: z.number().int().min(0).optional(),
  response_bytes: responseBytesSchema.optional(),
}).strict();
export const readRecordVersionInputSchema = z.object({
  card_id: cardIdSchema,
  record_name: recordNameSchema.describe('The exact record name.'),
  version: positiveSafeIntegerSchema.describe('The exact AuthoredRecordVersionArtifact.version; accepted source_version is never an alias.'),
  byte_offset: z.number().int().min(0).optional(),
  response_bytes: responseBytesSchema.optional(),
}).strict();

export const readWorkspaceInputSchema = z.object({
  path: z.string(),
  position: discoveryReadPositionSchema.optional(),
  read_mode: z.enum(['auto', 'text']).optional(),
  metadata_only: z.boolean().optional(),
  response_bytes: responseBytesSchema.optional(),
}).strict();
export const writeWorkspaceInputSchema = z.object({ path: z.string(), content: z.string() }).strict();
const searchMaxResultsSchema = z.number().int().min(1).max(1000)
  .describe('Maximum candidate items considered for this response; minimum 1, maximum 1000, default 200.');
export const globWorkspaceInputSchema = z.object({
  directory: z.string(),
  pattern: z.string(),
  max_results: searchMaxResultsSchema.default(200),
  position: discoveryCollectionPositionSchema.default({ item_index: 0, item_byte_offset: 0 }),
  response_bytes: responseBytesSchema.default(DISCOVERY_RESPONSE_MAX_BYTES),
}).strict();
export const grepWorkspaceInputSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  include: z.string().optional(),
  max_results: searchMaxResultsSchema.default(200),
  position: discoveryCollectionPositionSchema.default({ item_index: 0, item_byte_offset: 0 }),
  response_bytes: responseBytesSchema.default(DISCOVERY_RESPONSE_MAX_BYTES),
}).strict();
export const editWorkspaceInputSchema = z.object({ path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }).strict();
export const applyPatchInputSchema = z.object({ patch: z.string() }).strict();

export const runCommandInputSchema = z.object({ command: z.string().min(1), cwd: z.string().optional(), timeout_ms: z.number().int().optional(), wait: z.boolean().optional() }).strict();
export const waitProcessInputSchema = z.object({ process_id: z.string().min(1), timeout_ms: z.number().int().optional() }).strict();
export const killProcessInputSchema = z.object({ process_id: z.string().min(1) }).strict();
export const websearchInputSchema = z.object({ query: z.string(), max_results: z.number().int().optional() }).strict();
export const skillInputSchema = z.object({ name: z.string().optional() }).strict();

export const plannerCreateCardInputSchema = z.object({ type: z.string(), title: z.string(), bootstrap_content: z.string().trim().min(1), tags: z.array(z.string()).optional(), priority: z.number().int().optional(), urgency: z.string().optional(), depends_on: z.array(z.string()).optional(), related: z.array(z.string()).optional() }).strict();
export const plannerEditCardInputSchema = z.object({ card_id: cardIdSchema, title: z.string().optional(), tags: z.array(z.string()).optional(), priority: z.number().int().optional(), urgency: z.string().optional(), related: z.array(z.string()).optional() }).strict();
export const plannerCancelCardInputSchema = z.object({ card_id: cardIdSchema, reason: z.string().optional() }).strict();
export const plannerReorderChildInputSchema = z.object({ orderedChildIds: z.array(z.string()) }).strict();
export const plannerQueueNotificationInputSchema = z.object({ card_id: cardIdSchema, kind: z.string().min(1), body: z.string().min(1) }).strict();
