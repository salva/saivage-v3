import type { ProviderCapabilities } from '../schemas/index.js';

export type TransportProtocol = NonNullable<ProviderCapabilities['transportProtocol']>;
type ToolsModeCapability = NonNullable<ProviderCapabilities['toolsMode']>;
type ExclusiveToolChoiceCapability = NonNullable<
  ProviderCapabilities['exclusiveToolChoiceSupport']
>;

export interface EffectiveProviderCapabilities {
  transportProtocol: TransportProtocol;
  toolsMode: ToolsModeCapability;
  imageInput: boolean;
  exclusiveToolChoiceSupport: ExclusiveToolChoiceCapability;
  responsesReasoning?: { effort?: 'minimal' | 'low' | 'medium' | 'high' };
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  quirks: string[];
}

export interface CapabilityRequest {
  transportProtocol?: TransportProtocol;
  requiresTools?: boolean;
  requiresImages?: boolean;
  requiresExclusiveToolChoice?: boolean;
}

export type CapabilitySkipReason =
  | 'unsupported_transport_protocol'
  | 'unsupported_tools_mode'
  | 'unsupported_image_input'
  | 'unsupported_exclusive_tool_choice';

export type CapabilityMatch =
  | { supported: true }
  | { supported: false; reasons: CapabilitySkipReason[] };

export function capabilityRequestForTools(tools: readonly unknown[]): CapabilityRequest {
  return {
    requiresTools: tools.length > 0,
    requiresImages: tools.some(
      (tool) =>
        tool === 'view_image' ||
        (typeof tool === 'object' && tool !== null && 'name' in tool && tool.name === 'view_image'),
    ),
    requiresExclusiveToolChoice: true,
  };
}
