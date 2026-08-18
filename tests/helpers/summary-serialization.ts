import { createHash } from 'node:crypto';

import { canonicalJson } from '../../src/schemas/index.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import type { SummaryRequestSerialization } from '../../src/runtime/actors/compaction/summarizer.js';

export function deterministicSummarySerialization(input: LlmInvocationInput): SummaryRequestSerialization {
  const serializedRequest = canonicalJson({
    system: input.systemPrompt,
    messages: input.providerConversation.messages.map((message) => ({ id: message.id, role: message.role, content: message.content })),
  });
  return {
    serializedRequest,
    requestSha256: createHash('sha256').update(serializedRequest, 'utf8').digest('hex'),
    estimatedInputTokens: Math.ceil(Buffer.byteLength(serializedRequest, 'utf8') / 4),
  };
}

export function neverSummarizerSerialization(): SummaryRequestSerialization {
  throw new Error('Unexpected summarizer request serialization in test.');
}
