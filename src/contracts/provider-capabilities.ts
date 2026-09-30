import type { ProviderCapabilities } from '../schemas/index.js';

export type TransportProtocol = NonNullable<ProviderCapabilities['transportProtocol']>;
type ToolsModeCapability = NonNullable<ProviderCapabilities['toolsMode']>;
type ExclusiveToolChoiceCapability = NonNullable<ProviderCapabilities['exclusiveToolChoiceSupport']>;

export interface EffectiveProviderCapabilities {
  transportProtocol: TransportProtocol;
  toolsMode: ToolsModeCapability;
  exclusiveToolChoiceSupport: ExclusiveToolChoiceCapability;
  responsesReasoning?: { effort?: 'minimal' | 'low' | 'medium' | 'high' };
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  quirks: string[];
}
