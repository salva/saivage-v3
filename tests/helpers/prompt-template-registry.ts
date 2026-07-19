import { createPromptTemplateRegistry, type PromptTemplateRegistry } from '../../src/utils/prompt-api.js';
import { resolve } from 'node:path';

export function createTestPromptTemplateRegistry(): PromptTemplateRegistry {
  return createPromptTemplateRegistry({ defaultRoot: resolve('src/prompts') });
}
