import { z } from 'zod';
import { agentNameSchema } from './agent-name.js';
import { cardIdSchema } from './card-id.js';
import {
  conversationSessionIdentity,
  type ConversationSessionId,
} from './conversation-session-id.js';

const activationInstructionsSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('prepared'),
      role_text: z.string(),
      node: z
        .object({ node_id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u), text: z.string() })
        .strict()
        .nullable(),
    })
    .strict(),
  z.object({ kind: z.literal('unavailable'), reason: z.literal('not_recorded') }).strict(),
  z.object({ kind: z.literal('not_applicable'), reason: z.literal('non_model_ingress') }).strict(),
]);
export type ActivationInstructions = z.infer<typeof activationInstructionsSchema>;

const markerShape = {
  event: z.literal('activation_open'),
  agent_name: agentNameSchema,
  input_id: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  timestamp: z.string().datetime(),
  instructions: activationInstructionsSchema,
};
const activationOpenPayloadSchema = z.union([
  z.object({ ...markerShape, card_id: cardIdSchema }).strict(),
  z.object(markerShape).strict(),
]);
export type ActivationOpenPayload = z.infer<typeof activationOpenPayloadSchema>;

export function parseActivationOpenPayload(
  content: string,
  sessionId: ConversationSessionId,
  timestamp: string,
): ActivationOpenPayload | null {
  const value: unknown = JSON.parse(content);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('event' in value) ||
    value.event !== 'activation_open'
  )
    return null;
  const payload = activationOpenPayloadSchema.parse(value);
  const identity = conversationSessionIdentity(sessionId);
  const cardId = 'card_id' in payload ? payload.card_id : null;
  if (
    payload.agent_name !== identity.agentName ||
    cardId !== identity.cardId ||
    payload.timestamp !== timestamp
  )
    throw new Error(`Conversation '${sessionId}' has a malformed activation_open marker identity.`);
  if (
    payload.instructions.kind === 'prepared' &&
    (payload.instructions.node === null) !== (cardId === null)
  )
    throw new Error(
      `Conversation '${sessionId}' has a malformed activation instruction node identity.`,
    );
  if (cardId !== null && payload.instructions.kind === 'not_applicable')
    throw new Error(`Card conversation '${sessionId}' requires model activation instructions.`);
  return payload;
}
