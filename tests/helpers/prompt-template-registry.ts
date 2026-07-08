import { createPromptTemplateRegistry, type PromptTemplateRegistry } from '../../src/utils/prompt-api.js';
import type { SaivageConfig } from '../../src/agents/config-schema.js';

export function createTestPromptTemplateRegistry(prompts?: SaivageConfig['prompts']): PromptTemplateRegistry {
  return createPromptTemplateRegistry({ promptsConfig: prompts });
}
