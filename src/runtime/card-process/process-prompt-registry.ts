import type { CardType } from '../../schemas/index.js';
import type { CompiledProjectWorkflows, ProcessPromptId } from './card-process-config.js';

export interface ProcessPromptRegistry {
  get(cardType: CardType, id: ProcessPromptId): string;
}

export class ProcessPromptRegistryError extends Error {
  constructor(
    readonly cardType: CardType,
    readonly promptId: ProcessPromptId,
    readonly path: string,
    reason: string,
  ) {
    super(`Process prompt error for ${cardType}/${promptId} at ${path}: ${reason}`);
    this.name = 'ProcessPromptRegistryError';
  }
}

function referencedPromptIds(
  processes: CompiledProjectWorkflows,
): ReadonlyMap<CardType, ReadonlySet<ProcessPromptId>> {
  const idsByCardType = new Map<CardType, Set<ProcessPromptId>>();
  for (const [cardType, process] of processes.cardTypes) {
    const ids = new Set<ProcessPromptId>();
    for (const state of process.states.values()) {
      if (state.kind === 'node') {
        ids.add(state.promptId);
        ids.add(state.correctionPromptId);
      }
      for (const route of state.on.values())
        if (
          (route.semantic.kind === 'entry-route' || route.semantic.kind === 'configured-outcome') &&
          route.semantic.promptId !== null
        )
          ids.add(route.semantic.promptId);
    }
    idsByCardType.set(cardType, ids);
  }
  return idsByCardType;
}

export function createProcessPromptRegistry(
  processes: CompiledProjectWorkflows,
): ProcessPromptRegistry {
  for (const [cardType, ids] of referencedPromptIds(processes)) {
    for (const id of ids) {
      const prompt = processes.cardTypes.get(cardType)?.processPrompts.get(id);
      if (!prompt)
        throw new ProcessPromptRegistryError(
          cardType,
          id,
          String(id),
          'unregistered compiled prompt reference',
        );
    }
  }
  return Object.freeze({
    get(cardType: CardType, id: ProcessPromptId): string {
      const prompt = processes.cardTypes.get(cardType)?.processPrompts.get(id);
      if (!prompt)
        throw new ProcessPromptRegistryError(
          cardType,
          id,
          String(id),
          'unregistered prompt reference',
        );
      return prompt.text;
    },
  });
}
