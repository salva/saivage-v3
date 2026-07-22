import { z } from 'zod';

import { cardIdSchema, cardStatusValues, cardTypeValues, eventKindValues, positiveSafeIntegerSchema, urgencyValues } from '../schemas/index.js';

export const EVENT_QUERY_MAX_LIMIT = 1000;
export const emptyToolInputSchema = z.object({}).strict();

export const analystCreateCardInputSchema = z.object({
  type: z.enum(cardTypeValues).describe(`The non-project card type. Allowed values: ${cardTypeValues.join(', ')}.`),
  parent: z.string().nullable().optional().describe("The ID of the parent card. Use null only when creating the root project card; use 'project' for top-level goals."),
  title: z.string().describe('A short title.'),
  bootstrap_content: z.string().trim().min(1).describe('Non-empty Markdown content for the child type configured bootstrap record.'),
  tags: z.array(z.string().describe('A tag string')).optional().describe('Optional tags.'),
  priority: z.number().int().optional().describe('Optional priority value (0-100).'),
  urgency: z.enum(urgencyValues).optional().describe('Optional urgency level.'),
  depends_on: z.array(z.string().describe('A card ID')).optional().describe('Optional dependency list.'),
  related: z.array(z.string().describe('A card ID')).optional().describe('Optional related-card list.'),
}).strict();
export const analystReorderChildInputSchema = z.object({ parentId: z.string().describe('Parent whose children to reorder.'), orderedChildIds: z.array(z.string()).describe('New child id order; must be a permutation of the current child set.') }).strict();
export const analystCancelCardInputSchema = z.object({ cardId: z.string().describe('The ID of the card to cancel.'), reason: z.string().optional().describe('Optional cancellation reason.') }).strict();
export const analystDeleteCardInputSchema = z.object({ ids: z.array(z.string()).min(1).describe('Card ids to delete.') }).strict();

export const queueNotificationInputSchema = z.object({ card_id: cardIdSchema.describe('The exact card id.'), kind: z.string().min(1).describe('A short categorical label.'), body: z.string().min(1).describe('The context text to inject.') }).strict();
export const readAgentSessionInputSchema = z.object({ sessionId: z.string(), lastN: z.number().int().optional() }).strict();
export const readRuntimeEventsInputSchema = z.object({ limit: z.number().int().positive().max(EVENT_QUERY_MAX_LIMIT).optional(), kind: z.enum(eventKindValues).optional() }).strict();
export const readRuntimeErrorsInputSchema = z.object({ limit: z.number().int().positive().max(EVENT_QUERY_MAX_LIMIT).optional() }).strict();
export const readControlActionsInputSchema = z.object({ limit: z.number().int().optional(), since: z.string().optional() }).strict();
export const listProcessesInputSchema = z.object({ status: z.string().optional(), cardId: z.string().optional() }).strict();
export const navigateWorkspaceInputSchema = z.object({ target: z.object({ kind: z.enum(['card', 'transcript', 'process', 'process_list', 'agent_session_list', 'config']), id: z.string().optional().describe('Optional target id.'), refinement: z.string().optional().describe('Optional view refinement.') }).strict() }).strict();

export const listCardsInputSchema = z.object({
  status: z.union([z.enum(cardStatusValues), z.array(z.enum(cardStatusValues))]).optional(),
  type: z.union([z.enum(cardTypeValues), z.array(z.enum(cardTypeValues))]).optional(),
  parent: z.string().optional(),
  tag: z.string().optional(),
}).strict();
export const getCardInputSchema = z.object({ id: z.string() }).strict();
export const getTreeInputSchema = z.object({ rootId: z.string().optional() }).strict();
export const listCardHistoryInputSchema = z.object({ cardId: cardIdSchema }).strict();
export const getCardHistoryEntryInputSchema = z.object({ cardId: cardIdSchema, version_seq: positiveSafeIntegerSchema }).strict();
export const diffCardInputSchema = z.object({ cardId: cardIdSchema, fromSeq: positiveSafeIntegerSchema.optional(), toSeq: positiveSafeIntegerSchema.optional() }).strict();

export const readWorkspaceInputSchema = z.object({ path: z.string(), offset: z.number().int().optional(), limit: z.number().int().optional(), read_mode: z.enum(['auto', 'text', 'multimodal']).optional(), metadata_only: z.boolean().optional() }).strict();
export const writeWorkspaceInputSchema = z.object({ path: z.string(), content: z.string() }).strict();
export const globWorkspaceInputSchema = z.object({ directory: z.string(), pattern: z.string(), max_results: z.number().int().optional() }).strict();
export const grepWorkspaceInputSchema = z.object({ pattern: z.string(), path: z.string().optional(), include: z.string().optional(), max_results: z.number().int().optional() }).strict();
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
