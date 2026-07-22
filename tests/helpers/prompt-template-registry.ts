import { createPromptTemplateRegistry, type PromptTemplateRegistry } from '../../src/utils/prompt-api.js';
import { TEST_WORKFLOWS } from './canonical-project.js';

export function createTestPromptTemplateRegistry(): PromptTemplateRegistry {
  return createPromptTemplateRegistry(TEST_WORKFLOWS);
}
