import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CardType } from '../../schemas/index.js';
import { cardTypesForProcess, type CompiledCardProcesses, type ProcessPromptId } from './card-process-config.js';

export interface ProcessPromptRegistry {
  get(cardType: CardType, id: ProcessPromptId): string;
}

export interface ProcessPromptRegistryOptions {
  readonly defaultRoot: string;
  readonly overrideRoot?: string;
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

function artifactPath(root: string, cardType: CardType, id: ProcessPromptId): string {
  return join(root, cardType, 'process', `${id}.md`);
}

function referencedPromptIds(processes: CompiledCardProcesses): ReadonlyMap<CardType, ReadonlySet<ProcessPromptId>> {
  const idsByCardType = new Map<CardType, Set<ProcessPromptId>>();
  for (const process of [processes.planning, processes.terminal]) {
    const ids = new Set<ProcessPromptId>();
    for (const promptId of process.transitionPrompts.values()) ids.add(promptId);
    for (const state of process.states.values()) if (state.kind === 'node') {
      ids.add(state.promptId);
      ids.add(state.correctionPromptId);
    }
    for (const cardType of cardTypesForProcess(process)) idsByCardType.set(cardType, new Set(ids));
  }
  return idsByCardType;
}

function readStrictUtf8(path: string, cardType: CardType, id: ProcessPromptId): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch (error) {
    throw new ProcessPromptRegistryError(cardType, id, path, error instanceof Error ? error.message : String(error));
  }
  if (text.trim().length === 0) throw new ProcessPromptRegistryError(cardType, id, path, 'artifact must contain non-whitespace UTF-8 text');
  return text;
}

export function createProcessPromptRegistry(processes: CompiledCardProcesses, options: ProcessPromptRegistryOptions): ProcessPromptRegistry {
  const prompts = new Map<string, string>();
  for (const [cardType, ids] of referencedPromptIds(processes)) {
    for (const id of ids) {
      const overridePath = options.overrideRoot === undefined ? undefined : artifactPath(options.overrideRoot, cardType, id);
      const path = overridePath !== undefined && existsSync(overridePath) ? overridePath : artifactPath(options.defaultRoot, cardType, id);
      if (!existsSync(path)) throw new ProcessPromptRegistryError(cardType, id, path, 'missing effective artifact');
      prompts.set(key(cardType, id), readStrictUtf8(path, cardType, id));
    }
  }
  return Object.freeze({
    get(cardType: CardType, id: ProcessPromptId): string {
      const prompt = prompts.get(key(cardType, id));
      if (prompt === undefined) throw new ProcessPromptRegistryError(cardType, id, artifactPath(options.defaultRoot, cardType, id), 'unregistered prompt reference');
      return prompt;
    },
  });
}
