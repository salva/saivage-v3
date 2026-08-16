import { describe, expect, it } from '@jest/globals';

import { ModelRouter } from '../../src/agents/model-router.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import type { SaivageConfig } from '../../src/schemas/saivage-config.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

describe('ModelRouter', () => {
  it('orders the base model before its equivalent and failover candidates', () => {
    const config: SaivageConfig = structuredClone(TEST_SAIVAGE_CONFIG);
    config.models.routes.analyst = { candidates: ['base-model'], temperature: 0.2, max_tokens: 200 };
    config.models.equivalents = [['base-model', 'equivalent-model']];
    config.models.failover = { 'base-model': ['failover-model'] };
    config.providers = { test: { models: ['test-model', 'base-model', 'equivalent-model', 'failover-model'] } };

    const router = new ModelRouter(new ProviderRegistry(config));

    expect(router.resolveModels(['base-model', 'equivalent-model', 'failover-model'], { requiresTools: true, requiresExclusiveToolChoice: true })).toEqual([
      { provider: 'test', account: null, model: 'base-model' },
      { provider: 'test', account: null, model: 'equivalent-model' },
      { provider: 'test', account: null, model: 'failover-model' },
    ]);
  });
});
