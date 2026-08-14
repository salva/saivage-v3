import type { CardType } from '../../schemas/index.js';
import type { CompiledProjectWorkflows, ProcessPromptId } from './card-process-config.js';

export interface ProcessPromptRegistry {
  get(cardType: CardType, id: ProcessPromptId): string;
}

export class ProcessPromptRegistryError extends Error {
  constructor(
    readonly cardType: CardType,
    readonly promptId: ProcessPromptId,
    reason: string,
  ) {
    super(`Process prompt error for ${cardType}/${promptId}: ${reason}`);
    this.name = 'ProcessPromptRegistryError';
  }
}

export function createProcessPromptRegistry(
  processes: CompiledProjectWorkflows,
): ProcessPromptRegistry {
  return Object.freeze({
    get(cardType: CardType, id: ProcessPromptId): string {
      const prompt = processes.cardTypes.get(cardType)?.processPrompts.get(id);
      if (!prompt)
        throw new ProcessPromptRegistryError(
          cardType,
          id,
          'unregistered prompt reference',
        );
      return prompt.text;
    },
  });
}
