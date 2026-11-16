import { resolveSystemTemplate } from '../../src/config/system-templates/registry.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { bindRuntimeWorkflows, compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { ModelRouter } from '../../src/agents/model-router.js';
import { createPromptTemplateRegistry } from '../../src/utils/prompt-api.js';
import { CardService as DefaultCardService, initProjectTree as initDefaultProjectTree } from './canonical-project.js';
import { TEST_SAIVAGE_CONFIG } from './test-saivage-config.js';
import { testAutonomousCompaction as defaultCompaction } from './llm-test-helpers.js';

// Explicit classic fixture for scripts whose one-node leaf outcomes are part of
// the scenario. Default-oriented fixtures continue to use canonical-project.
const classic = resolveSystemTemplate('classic');
export const CLASSIC_TEST_CONFIG = effectiveSaivageConfigSchema.parse({
  ...structuredClone(classic.config),
  models: structuredClone(TEST_SAIVAGE_CONFIG.models),
  providers: structuredClone(TEST_SAIVAGE_CONFIG.providers),
  compaction: structuredClone(TEST_SAIVAGE_CONFIG.compaction),
});
for (const agent of Object.values(CLASSIC_TEST_CONFIG.agents)) {
  agent.capabilities.grants = agent.capabilities.grants.map(grant => ({
    ...grant, tools: grant.tools.filter(tool => tool !== 'view_image'),
  })).filter(grant => grant.tools.length > 0);
}
export const TEST_WORKFLOWS = compileProjectWorkflows(CLASSIC_TEST_CONFIG, { defaultPromptRoot: classic.promptRoot });
const registry = new ProviderRegistry(CLASSIC_TEST_CONFIG);
export const TEST_RUNTIME_WORKFLOWS = bindRuntimeWorkflows(TEST_WORKFLOWS, new ModelRouter(registry), registry,
  CLASSIC_TEST_CONFIG.compaction.context_utilization_fraction, { internalAnalystEnabled: true });
export const testAutonomousCompaction = {
  ...defaultCompaction,
  workflows: TEST_RUNTIME_WORKFLOWS,
};
export function initProjectTree(root: string) { return initDefaultProjectTree(root, TEST_WORKFLOWS); }
export class CardService extends DefaultCardService {
  constructor(root: string, freshness?: ConstructorParameters<typeof DefaultCardService>[1], io?: ConstructorParameters<typeof DefaultCardService>[2]) {
    super(root, freshness, io, TEST_WORKFLOWS);
  }
}
export function createTestPromptTemplateRegistry() { return createPromptTemplateRegistry(TEST_WORKFLOWS); }
