import type { Candidate } from './provider.js';
import type { ProviderCapabilities } from './config-schema.js';

export type TransportProtocol = NonNullable<ProviderCapabilities['transportProtocol']>;
export type ToolCallsCapability = NonNullable<ProviderCapabilities['toolCalls']>;
export type ToolChoiceCapability = NonNullable<ProviderCapabilities['toolChoice']>;
export type ResponseShapeCapability = NonNullable<ProviderCapabilities['responseShape']>;

export interface EffectiveProviderCapabilities {
  transportProtocol: TransportProtocol;
  toolCalls: ToolCallsCapability;
  toolChoice: ToolChoiceCapability;
  responseShape: ResponseShapeCapability;
  streaming: boolean;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  quirks: string[];
}

export interface CapabilityRequest {
  transportProtocol?: TransportProtocol;
  toolCalls?: boolean;
  toolChoice?: boolean;
  responseShape?: ResponseShapeCapability;
  streaming?: boolean;
}

export type CapabilitySkipReason =
  | 'unsupported_transport_protocol'
  | 'unsupported_tool_calls'
  | 'unsupported_tool_choice'
  | 'unsupported_response_shape'
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
  toolCalls: 'native',
  toolChoice: 'auto',
  responseShape: 'openai-chat-choice',
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
    responseShape: 'codex-backend',
    quirks: ['openai-codex-backend'],
  },
  opencode: {
    ...GLOBAL_DEFAULT_CAPABILITIES,
  },
  'opencode-go': {
    ...GLOBAL_DEFAULT_CAPABILITIES,
  },
};

export function mergeCapabilities(
  base: EffectiveProviderCapabilities,
  override?: ProviderCapabilities,
): EffectiveProviderCapabilities {
  if (!override) return { ...base, quirks: [...base.quirks] };
  return {
    transportProtocol: override.transportProtocol ?? base.transportProtocol,
    toolCalls: override.toolCalls ?? base.toolCalls,
    toolChoice: override.toolChoice ?? base.toolChoice,
    responseShape: override.responseShape ?? base.responseShape,
    streaming: override.streaming ?? base.streaming,
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
  if (request.toolCalls && capabilities.toolCalls === 'none') {
    reasons.push('unsupported_tool_calls');
  }
  if (request.toolChoice && capabilities.toolChoice === 'none') {
    reasons.push('unsupported_tool_choice');
  }
  if (request.responseShape && capabilities.responseShape !== request.responseShape) {
    reasons.push('unsupported_response_shape');
  }
  if (request.streaming === true && capabilities.streaming !== true) {
    reasons.push('unsupported_streaming');
  }
  return reasons.length === 0 ? { supported: true } : { supported: false, reasons };
}

export function capabilityRequestForLlmOptions(opts?: {
  tools?: unknown[];
  tool_choice?: unknown;
  stream?: boolean;
  responseShape?: ResponseShapeCapability;
}): CapabilityRequest {
  return {
    toolCalls: Boolean(opts?.tools && opts.tools.length > 0),
    toolChoice: opts?.tool_choice !== undefined,
    responseShape: opts?.responseShape,
    streaming: opts?.stream === true,
  };
}
