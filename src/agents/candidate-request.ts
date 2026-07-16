import { createHash } from 'node:crypto';
import type { AgentMessage } from '../schemas/index.js';
import { canonicalJson } from '../schemas/index.js';
import type { Candidate } from '../contracts/provider-candidate.js';
import type { BuiltCandidateRequest, LlmCompleteOptions, ResponsesReplayProjection } from './llm-contracts.js';
import type { EffectiveProviderCapabilities } from './provider-capabilities.js';
import { buildOpenAIChatRequest } from './llm-openai-chat-gateway.js';
import { buildOpenAICodexRequest } from './llm-openai-codex-gateway.js';
import { buildOpenAIResponsesRequest } from './llm-openai-responses-gateway.js';

export function buildCandidateRequest(args: { candidate: Candidate; capabilities: EffectiveProviderCapabilities; systemPrompt: string; messages: AgentMessage[]; replay: ResponsesReplayProjection; options: LlmCompleteOptions }): BuiltCandidateRequest {
  const body = args.capabilities.transportProtocol === 'openai-codex-backend'
    ? buildOpenAICodexRequest(args.candidate, args.systemPrompt, args.messages, args.options)
    : args.capabilities.transportProtocol === 'openai-responses'
      ? buildOpenAIResponsesRequest(args.candidate, args.systemPrompt, args.replay, args.options, args.capabilities) as unknown as Record<string, unknown>
      : buildOpenAIChatRequest(args.candidate, args.systemPrompt, args.messages, args.options) as unknown as Record<string, unknown>;
  const serializedBody = canonicalJson(body);
  return { body, serializedBody, estimatedWireInputTokens: Math.ceil(Buffer.byteLength(serializedBody, 'utf8') / 4), requestHash: createHash('sha256').update(serializedBody, 'utf8').digest('hex') };
}
