import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../../src/events/index.js';
import { CardStore } from '../../src/cards/card-store.js';
import { createMicroActorRuntimeApi } from '../../src/application/micro-actor-runtime-api-factory.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-micro-actor-runtime-factory-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

describe('createMicroActorRuntimeApi', () => {
  it('constructs a RuntimeApi backed by the shared CardStore', async () => withTempProject(async (projectRoot) => {
    initProjectTree(projectRoot);
    const cardStore = new CardStore(projectRoot);
    cardStore.create({ type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'running', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
    const api = createMicroActorRuntimeApi({
      projectRoot,
      eventBus: new EventBus(),
      cardStore,
      now: () => '2026-06-12T00:00:00.000Z',
    });

    const result = await api.startProject('operator');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.intent.status).toBe('running');
      expect(result.run).toMatchObject({ card_id: 'project', phase: 'pending', runtime_status: 'running' });
    }
    expect(api.getStatus()).toMatchObject({ status: 'running', currentCardId: 'project' });
  }));
});
