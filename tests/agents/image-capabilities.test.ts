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

it.each(['gpt-6.2-sol', 'gpt-6.2-astra'])('defaults exact %s to images only on Responses/Codex and keeps ordinary tools', (model) => {
  const nearMiss = `${model}-custom`;
  for (const transportProtocol of ['openai-responses', 'openai-codex-backend', 'openai-chat-completions'] as const) {
    const provider = new Provider('fixture', { models: [model, nearMiss], capabilities: { transportProtocol } });
    const effective = provider.getEffectiveCapabilities(model, null);
    const compatible = transportProtocol !== 'openai-chat-completions';
    expect(effective.imageInput).toBe(compatible);
    expect(supportsCapabilityRequest(effective, { requiresImages: true }).supported).toBe(compatible);
    expect(supportsCapabilityRequest(effective, { requiresTools: true }).supported).toBe(true);
    expect(provider.getEffectiveCapabilities(nearMiss, null).imageInput).toBe(false);
  }
});

it('uses the winning transport, including the built-in when no transport is declared', () => {
  const sol = 'gpt-6.2-sol';
  const astra = 'gpt-6.2-astra';
  const provider = new Provider('openai-codex', {
    models: [sol, astra],
    accounts: {
      inherited: {},
      chat: { capabilities: { transportProtocol: 'openai-chat-completions' } },
    },
    modelCapabilities: { [astra]: { transportProtocol: 'openai-responses' } },
  });
  expect(provider.getEffectiveCapabilities(sol, 'inherited')).toMatchObject({ transportProtocol: 'openai-codex-backend', imageInput: true });
  expect(provider.getEffectiveCapabilities(sol, 'chat')).toMatchObject({ transportProtocol: 'openai-chat-completions', imageInput: false });
  expect(provider.getEffectiveCapabilities(astra, 'chat')).toMatchObject({ transportProtocol: 'openai-responses', imageInput: true });
});

it('keeps winning explicit image overrides separate from the winning transport', () => {
  const sol = 'gpt-6.2-sol';
  const astra = 'gpt-6.2-astra';
  const provider = new Provider('fixture', {
    models: [sol, astra],
    capabilities: { transportProtocol: 'openai-chat-completions', imageInput: false },
    accounts: {
      inherited: { capabilities: { transportProtocol: 'openai-responses' } },
      enabled: { capabilities: { transportProtocol: 'openai-responses', imageInput: true } },
      chat: { capabilities: { imageInput: true } },
    },
    modelCapabilities: { [astra]: { imageInput: false } },
  });
  expect(provider.getEffectiveCapabilities(sol, 'inherited').imageInput).toBe(false);
  expect(provider.getEffectiveCapabilities(sol, 'enabled').imageInput).toBe(true);
  expect(provider.getEffectiveCapabilities(astra, 'enabled').imageInput).toBe(false);
  const chat = provider.getEffectiveCapabilities(sol, 'chat');
  expect(chat.imageInput).toBe(true);
  expect(supportsCapabilityRequest(chat, { requiresImages: true }).supported).toBe(false);
});

it('lets an explicit model image capability override an account denial', () => {
  const provider = new Provider('fixture', {
    models: ['gpt-6.2-sol', 'gpt-6.2-astra'],
    capabilities: { transportProtocol: 'openai-responses' },
    accounts: { restricted: { capabilities: { imageInput: false } } },
    modelCapabilities: { 'gpt-6.2-sol': { imageInput: true } },
  });
  expect(provider.getEffectiveCapabilities('gpt-6.2-astra', 'restricted').imageInput).toBe(false);
  expect(provider.getEffectiveCapabilities('gpt-6.2-sol', 'restricted').imageInput).toBe(true);
});

it('respects explicit provider/account/model capability declarations and derives selected image tools', () => {
  const provider = new Provider('fixture', { models: ['custom'], capabilities: { transportProtocol: 'openai-responses', imageInput: true }, accounts: { restricted: { capabilities: { imageInput: false } } }, modelCapabilities: { override: { imageInput: true } } });
  expect(provider.getEffectiveCapabilities('custom', 'restricted').imageInput).toBe(false);
  expect(provider.getEffectiveCapabilities('override', 'restricted').imageInput).toBe(true);
  expect(capabilityRequestForTools([{ name: 'view_image' }]).requiresImages).toBe(true);
  expect(capabilityRequestForTools(['view_image']).requiresImages).toBe(true);
  expect(capabilityRequestForTools([{ name: 'read' }]).requiresImages).toBe(false);
});
