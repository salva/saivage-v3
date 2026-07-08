import { createPromptTemplateRegistry, type PromptTemplateRegistry } from '../../src/utils/prompt-api.js';
import type { SaivageConfig } from '../../src/agents/config-schema.js';

export function createTestPromptTemplateRegistry(projectRoot: string, prompts?: SaivageConfig['prompts']): PromptTemplateRegistry {
  return createPromptTemplateRegistry({ projectRoot, promptsConfig: prompts });
}
