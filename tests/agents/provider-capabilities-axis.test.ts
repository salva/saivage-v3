import { describe, it, expect } from '@jest/globals';
import {
  BUILT_IN_PROVIDER_CAPABILITIES,
  capabilityRequestForLlmOptions,
  type EffectiveProviderCapabilities,
} from '../../src/agents/provider-capabilities.js';

describe('provider capability axes', () => {
  it('built-in providers expose only the new tool-related axes', () => {
    const legacyKeys = new Set(['toolCalls', 'toolChoice', 'responseShape', 'envelopeMode', 'responseFormat']);
    for (const [providerId, capsRaw] of Object.entries(BUILT_IN_PROVIDER_CAPABILITIES)) {
      const caps = capsRaw as EffectiveProviderCapabilities;
      const keys = Object.keys(caps);
      for (const key of keys) {
        expect(legacyKeys.has(key)).toBe(false);
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

  it('capabilityRequestForLlmOptions always requires exclusive tool choice', () => {
    const empty = capabilityRequestForLlmOptions({});
    expect(empty.requiresExclusiveToolChoice).toBe(true);

    const withTools = capabilityRequestForLlmOptions({
      tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: {} } }],
      stream: false,
    });
    expect(withTools.requiresExclusiveToolChoice).toBe(true);
    expect(withTools.requiresTools).toBe(true);

    const streaming = capabilityRequestForLlmOptions({ stream: true });
    expect(streaming.requiresExclusiveToolChoice).toBe(true);
    expect(streaming.streaming).toBe(true);
  });
});
