import { z } from 'zod';

import { canonicalJson } from './context-compaction.js';
import type { ConversationSessionId } from './conversation-session-id.js';

export const CONTENT_POLICY_RETRY_TEXT = 'Saivage authorizes only assistance that the provider can give within its applicable safety requirements. This automated message is not an operator attestation about the request\'s purpose, locality, or benignity. If compliant assistance is possible, continue within those requirements; otherwise refuse.';

export const contentPolicyRefusalContentSchema = z.object({
  version: z.literal(1),
  type: z.literal('content_policy_refusal'),
  source_input_id: z.string().uuid(),
  candidate: z.object({
    provider: z.string().min(1),
    account: z.string().min(1).nullable(),
    model: z.string().min(1),
  }).strict(),
  provider_response: z.string(),
}).strict();

export type ContentPolicyRefusalContent = z.infer<typeof contentPolicyRefusalContentSchema>;

export function parseCanonicalContentPolicyRefusal(content: string): ContentPolicyRefusalContent {
  const parsed = contentPolicyRefusalContentSchema.parse(JSON.parse(content));
  if (content !== canonicalJson(parsed)) throw new Error('content_policy_refusal content must be canonical JSON.');
  return parsed;
}

export function contentPolicyEvidenceUrl(sessionId: ConversationSessionId, markerId: string): string {
  return `/agents/${encodeURIComponent(sessionId)}?entry=${encodeURIComponent(markerId)}`;
}

export function contentPolicyRefusalProjectionText(sessionId: ConversationSessionId, markerId: string): string {
  return `A prior activation ended after repeated provider content-policy refusal. Reassess the task decomposition and use only assistance the provider can give within its safety requirements. Operator evidence: ${contentPolicyEvidenceUrl(sessionId, markerId)}.`;
}
