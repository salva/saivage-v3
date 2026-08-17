import { createHash } from 'node:crypto';
import { canonicalJson } from '../schemas/index.js';
import type { Candidate } from '../contracts/provider-candidate.js';
import {
  assertProviderConversationSourceRows,
  type BuiltCandidateRequest,
  type LlmCompleteOptions,
  type ProviderConversationProjection,
} from './llm-contracts.js';
import type { EffectiveProviderCapabilities } from './provider-capabilities.js';
import type { LlmProtocolAdapter } from './llm-protocol-adapter.js';
import type { ContextBlock } from '../runtime/actors/context/index.js';

export interface CandidateRequestPlan {
  candidate: Candidate;
  capabilities: EffectiveProviderCapabilities;
  adapter: LlmProtocolAdapter;
  request: BuiltCandidateRequest;
}

export class CandidateRequestPlanIntegrityError extends Error {
  readonly candidate: Candidate;
  readonly expectedHash: string;
  readonly actualHash: string;
  constructor(candidate: Candidate, expectedHash: string, actualHash: string) {
    super(
      `Canonical candidate request plan integrity check failed for ${candidate.provider}/${candidate.account ?? '_implicit'}/${candidate.model}: expected ${expectedHash}, got ${actualHash}.`,
    );
    this.name = 'CandidateRequestPlanIntegrityError';
    this.candidate = candidate;
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

export function buildCandidateRequest(args: {
  candidate: Candidate;
  capabilities: EffectiveProviderCapabilities;
  adapter: LlmProtocolAdapter;
  instructionText: string;
  dynamicBlocks: readonly ContextBlock[];
  providerConversation: ProviderConversationProjection;
  options: LlmCompleteOptions;
}): CandidateRequestPlan {
  assertProviderConversationSourceRows(args.providerConversation);
  const body = args.adapter.buildRequestBody({
    candidate: args.candidate,
    capabilities: args.capabilities,
    instructionText: args.instructionText,
    dynamicBlocks: args.dynamicBlocks,
    providerConversation: args.providerConversation,
    options: args.options,
  });
  const serializedBody = canonicalJson(body);
  const request = Object.freeze({
    body: deepFreeze(body),
    serializedBody,
    estimatedWireInputTokens: Math.ceil(Buffer.byteLength(serializedBody, 'utf8') / 4),
    requestHash: createHash('sha256').update(serializedBody, 'utf8').digest('hex'),
  });
  return Object.freeze({
    candidate: args.candidate,
    capabilities: args.capabilities,
    adapter: args.adapter,
    request,
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const member of Object.values(value as Record<string, unknown>)) deepFreeze(member);
  return Object.freeze(value);
}
