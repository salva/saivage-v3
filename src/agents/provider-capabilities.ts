import type { Candidate } from '../contracts/provider-candidate.js';
import type { ProviderCapabilities } from '../schemas/saivage-config.js';

export type TransportProtocol = NonNullable<ProviderCapabilities['transportProtocol']>;
export type ToolsModeCapability = NonNullable<ProviderCapabilities['toolsMode']>;
export type ExclusiveToolChoiceCapability = NonNullable<ProviderCapabilities['exclusiveToolChoiceSupport']>;

export interface EffectiveProviderCapabilities {
  transportProtocol: TransportProtocol;
  toolsMode: ToolsModeCapability;
  exclusiveToolChoiceSupport: ExclusiveToolChoiceCapability;
  streaming: boolean;
  responsesReasoning?: { effort?: 'minimal' | 'low' | 'medium' | 'high' };
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  quirks: string[];
}

export interface CapabilityRequest {
  transportProtocol?: TransportProtocol;
  requiresTools?: boolean;
  requiresExclusiveToolChoice?: boolean;
  streaming?: boolean;
}

export type CapabilitySkipReason =
  | 'unsupported_transport_protocol'
  | 'unsupported_tools_mode'
  | 'unsupported_exclusive_tool_choice'
  | 'unsupported_streaming';

export type CapabilityMatch =
  | { supported: true }
  | { supported: false; reasons: CapabilitySkipReason[] };

export interface CapabilitySkipDiagnostic {
  candidate: Candidate;
  reasons: CapabilitySkipReason[];
}

export const GLOBAL_DEFAULT_CAPABILITIES: EffectiveProviderCapabilities = {
  transportProtocol: 'openai-chat-completions',
  toolsMode: 'native',
  exclusiveToolChoiceSupport: 'native',
  streaming: false,
  quirks: [],
};

export const BUILT_IN_PROVIDER_CAPABILITIES: Record<string, EffectiveProviderCapabilities> = {
  'github-copilot': {
    ...GLOBAL_DEFAULT_CAPABILITIES,
    quirks: ['github-copilot-auth-profile'],
  },
  'openai-codex': {
    ...GLOBAL_DEFAULT_CAPABILITIES,
    transportProtocol: 'openai-codex-backend',
    exclusiveToolChoiceSupport: 'parallel_off',
    quirks: ['openai-codex-backend'],
  },
  opencode: { ...GLOBAL_DEFAULT_CAPABILITIES },
  'opencode-go': { ...GLOBAL_DEFAULT_CAPABILITIES },
  'nvidia-nim': { ...GLOBAL_DEFAULT_CAPABILITIES },
};

export function mergeCapabilities(
  base: EffectiveProviderCapabilities,
  override?: ProviderCapabilities,
): EffectiveProviderCapabilities {
  if (!override) return { ...base, quirks: [...base.quirks] };
  return {
    transportProtocol: override.transportProtocol ?? base.transportProtocol,
    toolsMode: override.toolsMode ?? base.toolsMode,
    exclusiveToolChoiceSupport: override.exclusiveToolChoiceSupport ?? base.exclusiveToolChoiceSupport,
    streaming: override.streaming ?? base.streaming,
    responsesReasoning: override.responsesReasoning ?? base.responsesReasoning,
    contextWindowTokens: override.contextWindowTokens ?? base.contextWindowTokens,
    maxOutputTokens: override.maxOutputTokens ?? base.maxOutputTokens,
    quirks: override.quirks ?? [...base.quirks],
  };
}

export function builtInCapabilitiesForProvider(providerName: string): EffectiveProviderCapabilities {
  return mergeCapabilities(
    BUILT_IN_PROVIDER_CAPABILITIES[providerName] ?? GLOBAL_DEFAULT_CAPABILITIES,
  );
}

export function supportsCapabilityRequest(
  capabilities: EffectiveProviderCapabilities,
  request?: CapabilityRequest,
): CapabilityMatch {
  if (!request) return { supported: true };
  const reasons: CapabilitySkipReason[] = [];
  if (request.transportProtocol && capabilities.transportProtocol !== request.transportProtocol) {
    reasons.push('unsupported_transport_protocol');
  }
  if (request.requiresTools && capabilities.toolsMode === 'unsupported') {
    reasons.push('unsupported_tools_mode');
  }
  if (request.requiresExclusiveToolChoice && capabilities.exclusiveToolChoiceSupport === 'unsupported') {
    reasons.push('unsupported_exclusive_tool_choice');
  }
  if (request.streaming === true && capabilities.streaming !== true) {
    reasons.push('unsupported_streaming');
  }
  return reasons.length === 0 ? { supported: true } : { supported: false, reasons };
}

export function capabilityRequestForLlmOptions(opts?: {
  tools?: unknown[];
  stream?: boolean;
}): CapabilityRequest {
  return {
    requiresTools: Boolean(opts?.tools && opts.tools.length > 0),
    requiresExclusiveToolChoice: true,
    streaming: opts?.stream === true,
  };
}
