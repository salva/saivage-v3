import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import { CardStore } from '../../../src/cards/card-store.js';
import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { CardActor, type CardActorDeps, type LLMProviderPort } from '../../../src/runtime/actors/index.js';
import { ProcessRunner } from '../../../src/runtime/process-runner.js';
import { createTestPromptTemplateRegistry } from '../../helpers/prompt-template-registry.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-card-actor-ownership-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

function deps(projectRoot: string, store: CardStore, lookup = new Map<string, CardActor>()): CardActorDeps {
  const provider: LLMProviderPort = { completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: 'unused' })) };
  return {
    projectRoot,
    store,
    provider,
    promptTemplates: createTestPromptTemplateRegistry(),
    processRunner: new ProcessRunner(projectRoot),
    notifyCard: () => ({ ok: true }),
    lookup,
  };
}

describe('CardActor ownership construction', () => {
  it('constructs only direct child actors and registers a multi-level tree in the shared lookup', () => withTempProject((projectRoot) => {
    initProjectTree(projectRoot);
    const store = new CardStore(projectRoot);
    const project = store.read('project') ?? store.create({ type: 'project', parent: null, depth: 0, title: 'project', brief: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
    const goal = store.create({ type: 'goal', parent: project.id, depth: 1, title: 'goal', brief: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
    const terminal = store.create({ type: 'code', parent: goal.id, depth: 2, title: 'code', brief: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
    const lookup = new Map<string, CardActor>();
    const root = CardActor.fromCard({ card: project, deps: deps(projectRoot, store, lookup) });

    const goalActor = root.childCardActor(goal.id);
    const terminalFromRoot = root.childCardActor(terminal.id);
    const terminalActor = goalActor?.childCardActor(terminal.id);

    expect(goalActor).toBeInstanceOf(CardActor);
    expect(terminalFromRoot).toBeNull();
    expect(terminalActor).toBeInstanceOf(CardActor);
    expect(lookup.get(project.id)).toBe(root);
    expect(lookup.get(goal.id)).toBe(goalActor);
    expect(lookup.get(terminal.id)).toBe(terminalActor);
  }));
});
