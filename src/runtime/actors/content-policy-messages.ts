import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { Candidate } from '../../contracts/provider-candidate.js';
import { canonicalJson, CONTENT_POLICY_RETRY_TEXT, contentPolicyRefusalContentSchema, type AgentMessage, type ContentPolicyRefusalContent, type ConversationSessionId } from '../../schemas/index.js';
import { deterministicRoundId } from '../../schemas/round-id-server.js';
import { durableContentPolicy, structuralContextPolicy } from './context/index.js';

export function buildContentPolicyRetryMessage(sessionId: ConversationSessionId, sourceInputId: string): AgentMessage {
  z.string().uuid().parse(sourceInputId);
  return { id: randomUUID(), session_id: sessionId, role: 'user', kind: 'content_policy_retry', content: CONTENT_POLICY_RETRY_TEXT, context_policy: durableContentPolicy(), round_id: deterministicRoundId('user', sourceInputId), message_index: 2, block_index: 0, timestamp: new Date().toISOString() };
}

export function buildContentPolicyRefusalMessage(args: { sessionId: ConversationSessionId; sourceInputId: string; candidate: Candidate; providerResponse: string }): AgentMessage {
  const content: ContentPolicyRefusalContent = { version: 1, type: 'content_policy_refusal', source_input_id: z.string().uuid().parse(args.sourceInputId), candidate: { provider: args.candidate.provider, account: args.candidate.account, model: args.candidate.model }, provider_response: args.providerResponse };
  return { id: randomUUID(), session_id: args.sessionId, role: 'system', kind: 'content_policy_refusal', content: canonicalJson(contentPolicyRefusalContentSchema.parse(content)), context_policy: structuralContextPolicy('content_policy_refusal'), round_id: deterministicRoundId('assistant', args.sourceInputId), message_index: 3, block_index: 0, timestamp: new Date().toISOString() };
}
