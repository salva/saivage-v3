import { canonicalJson, sha256Hex } from '../schemas/index.js';
import {
  assertProviderConversationSourceRows,
  type Candidate,
  type LlmCompleteOptions,
  type CandidateRequestPlan,
  type LlmProtocolAdapter,
  type ProviderConversationProjection,
  type EffectiveProviderCapabilities,
} from '../contracts/index.js';

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
  systemPrompt: string;
  providerConversation: ProviderConversationProjection;
  options: LlmCompleteOptions;
}): CandidateRequestPlan {
  assertProviderConversationSourceRows(args.providerConversation);
  const body = args.adapter.buildRequestBody({
    candidate: args.candidate,
    capabilities: args.capabilities,
    systemPrompt: args.systemPrompt,
    providerConversation: args.providerConversation,
    options: args.options,
  });
  const serializedBody = canonicalJson(body);
  return {
    candidate: args.candidate,
    capabilities: args.capabilities,
    adapter: args.adapter,
    request: {
      body,
      serializedBody,
      estimatedWireInputTokens: Math.ceil(Buffer.byteLength(serializedBody, 'utf8') / 4),
      requestHash: sha256Hex(serializedBody),
    },
  };
}
