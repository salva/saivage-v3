import { describe, expect, it } from '@jest/globals';

import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { buildProviderRoutingReadModel } from '../../src/agents/provider-routing-read-model.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

describe('provider routing read model', () => {
  it('projects ordered effective capabilities and exact recorded availability variants without transport URLs', () => {
    const config = structuredClone(TEST_SAIVAGE_CONFIG);
    config.providers = {
      routed: {
        priority: 7,
        models: ['model-alpha', 'model-beta'],
        baseUrl: 'https://provider.example/v1',
        capabilities: {
          transportProtocol: 'openai-responses',
          contextWindowTokens: 100000,
          quirks: ['provider-override'],
        },
        modelCapabilities: {
          'model-alpha': { toolsMode: 'unsupported', maxOutputTokens: 4096 },
        },
        accounts: {
          blocked: {
            priority: 10,
            models: ['model-alpha'],
            capabilities: {
              contextWindowTokens: 32000,
              quirks: ['explicit-account-override'],
            },
          },
          cooling: { priority: 20, models: ['model-alpha'] },
          healthy: { priority: 30, models: ['model-beta'] },
        },
      },
    };
    const registry = new ProviderRegistry(config);
    const availability = new MemoryCandidateAvailability();
    const blocked = { provider: 'routed', account: 'blocked', model: 'model-alpha' };
    const cooling = { provider: 'routed', account: 'cooling', model: 'model-alpha' };
    const healthy = { provider: 'routed', account: 'healthy', model: 'model-beta' };
    const now = Date.now();
    availability.markFailed(blocked, { state: 'BLOCKED_UNTIL', untilMs: now - 1000, reason: '' });
    availability.markFailed(cooling, { state: 'COOLING', untilMs: now + 60000, reason: 'transient' });
    availability.markSucceeded(healthy);

    const readModel = buildProviderRoutingReadModel({ registry, availability });
    const provider = registry.get('routed');
    if (!provider) throw new Error('Expected routed provider.');
    const implicitCapabilities = provider.getEffectiveCapabilities('model-alpha', null);
    const explicitCapabilities = provider.getEffectiveCapabilities('model-alpha', 'blocked');

    expect(readModel).toEqual({
      availabilityScope: 'process_local_reset_on_restart',
      providers: {
        routed: {
          priority: 7,
          models: ['model-alpha', 'model-beta'],
          candidateCount: 3,
          availableCandidateCount: 2,
          capabilitiesByModel: {
            'model-alpha': {
              transportProtocol: 'openai-responses',
              toolsMode: 'unsupported',
              exclusiveToolChoiceSupport: 'native',
              contextWindowTokens: 100000,
              maxOutputTokens: 4096,
              quirks: ['provider-override'],
            },
            'model-beta': {
              transportProtocol: 'openai-responses',
              toolsMode: 'native',
              exclusiveToolChoiceSupport: 'native',
              contextWindowTokens: 100000,
              quirks: ['provider-override'],
            },
          },
          availability: [
            { candidate: blocked, state: 'BLOCKED_UNTIL', untilMs: now - 1000, reason: '' },
            { candidate: cooling, state: 'COOLING', untilMs: now + 60000, reason: 'transient' },
            { candidate: healthy, state: 'HEALTHY' },
          ],
        },
      },
    });
    expect(explicitCapabilities).toMatchObject({
      contextWindowTokens: 32000,
      quirks: ['explicit-account-override'],
    });
    expect(explicitCapabilities).not.toEqual(implicitCapabilities);
    expect(readModel.providers.routed?.capabilitiesByModel['model-alpha']).toEqual(implicitCapabilities);
    expect(readModel.providers.routed?.availability.map((entry) => entry.candidate.account)).toEqual([
      'blocked',
      'cooling',
      'healthy',
    ]);
    expect(readModel.providers.routed).not.toHaveProperty('baseUrl');
    expect(readModel.providers.routed?.availability[2]).not.toHaveProperty('untilMs');
  });
});
