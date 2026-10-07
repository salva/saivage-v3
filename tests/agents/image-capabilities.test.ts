import { expect, it } from '@jest/globals';
import { Provider } from '../../src/agents/provider.js';
import { supportsCapabilityRequest } from '../../src/agents/provider-capabilities.js';
import { capabilityRequestForTools } from '../../src/contracts/index.js';

it.each(['gpt-6.1-sol', 'gpt-6-astra'])('supports exact %s images on Responses/Codex, not Chat or a guessed model identity', (model) => {
  for (const transportProtocol of ['openai-responses', 'openai-codex-backend', 'openai-chat-completions'] as const) {
    const provider = new Provider('fixture', { models: [model], capabilities: { transportProtocol } });
    expect(supportsCapabilityRequest(provider.getEffectiveCapabilities(model, null), { requiresImages: true }).supported).toBe(transportProtocol !== 'openai-chat-completions');
    expect(supportsCapabilityRequest(provider.getEffectiveCapabilities('guessed-model', null), { requiresImages: true }).supported).toBe(false);
    if (transportProtocol !== 'openai-chat-completions')
      expect(supportsCapabilityRequest(provider.getEffectiveCapabilities(model, null), { requiresTools: true }).supported).toBe(true);
    else {
      expect(supportsCapabilityRequest(provider.getEffectiveCapabilities(model, null), { requiresTools: true }).supported).toBe(false);
      expect(supportsCapabilityRequest(provider.getEffectiveCapabilities(model, null), { requiresTools: false }).supported).toBe(true);
    }
  }
});

it('respects explicit provider/account/model capability declarations and derives selected image tools', () => {
  const provider = new Provider('fixture', { models: ['custom'], capabilities: { transportProtocol: 'openai-responses', imageInput: true }, accounts: { restricted: { capabilities: { imageInput: false } } }, modelCapabilities: { override: { imageInput: true } } });
  expect(provider.getEffectiveCapabilities('custom', 'restricted').imageInput).toBe(false);
  expect(provider.getEffectiveCapabilities('override', 'restricted').imageInput).toBe(true);
  expect(capabilityRequestForTools([{ name: 'view_image' }]).requiresImages).toBe(true);
  expect(capabilityRequestForTools(['view_image']).requiresImages).toBe(true);
  expect(capabilityRequestForTools([{ name: 'read' }]).requiresImages).toBe(false);
});
