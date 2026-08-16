import { describe, it, expect } from '@jest/globals';
import {
  BUILT_IN_PROVIDER_CAPABILITIES,
  capabilityRequestForTools,
  type EffectiveProviderCapabilities,
} from '../../src/agents/provider-capabilities.js';
import { providerCapabilitySchema } from '../../src/schemas/saivage-config.js';

describe('provider capability axes', () => {
  it('built-in providers expose only the current capability axes', () => {
    const removedKeys = new Set(['toolCalls', 'toolChoice', 'responseShape', 'envelopeMode', 'responseFormat', 'streaming']);
    for (const [providerId, capsRaw] of Object.entries(BUILT_IN_PROVIDER_CAPABILITIES)) {
      const caps = capsRaw as EffectiveProviderCapabilities;
      const keys = Object.keys(caps);
      for (const key of keys) {
        expect(removedKeys.has(key)).toBe(false);
      }
      expect(caps).toHaveProperty('toolsMode');
      expect(caps).toHaveProperty('exclusiveToolChoiceSupport');
      expect(['native', 'unsupported']).toContain(caps.toolsMode);
      expect(['native', 'parallel_off', 'unsupported']).toContain(caps.exclusiveToolChoiceSupport);
      // sanity: providerId is non-empty
      expect(providerId.length).toBeGreaterThan(0);
    }
  });

  it('builtins have correct toolsMode and exclusiveToolChoiceSupport', () => {
    expect(BUILT_IN_PROVIDER_CAPABILITIES['github-copilot']).toMatchObject({
      toolsMode: 'native',
      exclusiveToolChoiceSupport: 'native',
    });
    expect(BUILT_IN_PROVIDER_CAPABILITIES['openai-codex']).toMatchObject({
      toolsMode: 'native',
      exclusiveToolChoiceSupport: 'parallel_off',
    });
    expect(BUILT_IN_PROVIDER_CAPABILITIES['opencode']).toMatchObject({
      toolsMode: 'native',
      exclusiveToolChoiceSupport: 'native',
    });
    expect(BUILT_IN_PROVIDER_CAPABILITIES['opencode-go']).toMatchObject({
      toolsMode: 'native',
      exclusiveToolChoiceSupport: 'native',
    });
    expect(BUILT_IN_PROVIDER_CAPABILITIES['nvidia-nim']).toMatchObject({
      toolsMode: 'native',
      exclusiveToolChoiceSupport: 'native',
    });
  });

  it('capabilityRequestForTools derives only tool requirements', () => {
    expect(capabilityRequestForTools([])).toEqual({
      requiresTools: false,
      requiresExclusiveToolChoice: true,
    });
    expect(capabilityRequestForTools([
      { type: 'function', function: { name: 'f', description: 'd', parameters: {} } },
    ])).toEqual({
      requiresTools: true,
      requiresExclusiveToolChoice: true,
    });
  });

  it('rejects streaming as an unknown source capability', () => {
    expect(providerCapabilitySchema.safeParse({ streaming: false }).success).toBe(false);
  });
});
