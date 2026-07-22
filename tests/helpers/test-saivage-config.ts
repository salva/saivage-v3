import { saivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { DEFAULT_SAIVAGE_CONFIG } from '../../src/agents/default-workflow-config.js';

export const TEST_SAIVAGE_CONFIG = saivageConfigSchema.parse({
  ...structuredClone(DEFAULT_SAIVAGE_CONFIG),
  models: { routes:Object.fromEntries(Object.keys(DEFAULT_SAIVAGE_CONFIG.models.routes).map((name)=>[name,{candidates:['test-model'],temperature:0.2,max_tokens:200}])),profiles:{},equivalents:[],failover:{} },
  providers: { test: { models: ['test-model'] } },
  compaction: {
    enabled: true,
    input_budget_tokens: 1000,
    summarizer_candidate: { provider: 'test', account: null, model: 'test-model' },
  },
});
