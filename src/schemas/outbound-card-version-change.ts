import { z } from 'zod';

import { agentNameSchema } from './agent-name.js';
import { externalActorSchema } from './operation-author.js';

const ordinaryCardChangeFieldSchema = z.enum([
  'git',
  'title',
  'priority',
  'urgency',
  'lifecycle',
  'status_text',
  'status_text_updated_at',
  'child_membership',
  'active_child_order',
  'deleted',
]);

export const outboundCardVersionChangeSchema = z
  .object({
    summary: z.string().min(1),
    changed_fields: z.array(ordinaryCardChangeFieldSchema).min(1),
    actor: z.union([agentNameSchema, externalActorSchema]).nullable(),
  })
  .strict();

export type OrdinaryCardChangeField = z.infer<typeof ordinaryCardChangeFieldSchema>;
export type OutboundCardVersionChange = z.infer<typeof outboundCardVersionChangeSchema>;
