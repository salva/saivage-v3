import type { CardType } from '../../schemas/index.js';
import type { CompiledProjectWorkflows, ProcessPromptId } from './card-process-config.js';

export interface ProcessPromptRegistry {
  get(cardType: CardType, id: ProcessPromptId): string;
}

export class ProcessPromptRegistryError extends Error {
  constructor(readonly cardType: CardType, readonly promptId: ProcessPromptId, readonly path: string, reason: string) {
    super(`Process prompt error for ${cardType}/${promptId} at ${path}: ${reason}`);
    this.name = 'ProcessPromptRegistryError';
  }
}

function key(cardType: CardType, id: ProcessPromptId): string {
  return `${cardType}/${id}`;
}

function referencedPromptIds(processes: CompiledProjectWorkflows): ReadonlyMap<CardType, ReadonlySet<ProcessPromptId>> {
  const idsByCardType = new Map<CardType, Set<ProcessPromptId>>();
  for (const [cardType, process] of processes.cardTypes) {
    const ids = new Set<ProcessPromptId>();
    for (const promptId of process.transitionPrompts.values()) ids.add(promptId);
    for (const state of process.states.values()) if (state.kind === 'node') {
      ids.add(state.promptId);
      ids.add(state.correctionPromptId);
    }
    idsByCardType.set(cardType, ids);
  }
  return idsByCardType;
}

export function createProcessPromptRegistry(processes: CompiledProjectWorkflows): ProcessPromptRegistry {
  const prompts = new Map<string, string>();
  for (const [cardType, ids] of referencedPromptIds(processes)) {
    for (const id of ids) {
      const prompt=processes.cardTypes.get(cardType)?.processPrompts.get(id);
      if(!prompt)throw new ProcessPromptRegistryError(cardType,id,String(id),'unregistered compiled prompt reference');
      prompts.set(key(cardType,id),prompt.text);
    }
  }
  return Object.freeze({
    get(cardType: CardType, id: ProcessPromptId): string {
      const prompt = prompts.get(key(cardType, id));
      if (prompt === undefined) throw new ProcessPromptRegistryError(cardType, id, String(id), 'unregistered prompt reference');
      return prompt;
    },
  });
}
