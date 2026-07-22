import { saivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { DEFAULT_CARD_PROCESSES } from '../../src/agents/default-card-processes.js';

export const TEST_SAIVAGE_CONFIG = saivageConfigSchema.parse({
  models: { default: ['test-model'], max_tokens: { analyst: 200 } },
  providers: { test: { models: ['test-model'] } },
  compaction: {
    enabled: true,
    input_budget_tokens: 1000,
    summarizer_candidate: { provider: 'test', account: null, model: 'test-model' },
  },
  card_processes: DEFAULT_CARD_PROCESSES,
});
