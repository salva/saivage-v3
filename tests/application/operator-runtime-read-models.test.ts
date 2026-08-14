import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardsReadModelService } from '../../src/application/read-models/cards-read-model.js';
import { buildRuntimeStatusReadModel, type RuntimeStatusInputs } from '../../src/application/read-models/runtime-status-read-model.js';
import type { ServerAvailability } from '../../src/contracts/index.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

const serverAvailability: ServerAvailability = {
  generatedAt: '2026-08-14T00:00:00.000Z',
  components: {
    api: { state: 'available', source: 'health-check', checkedAt: '2026-08-14T00:00:00.000Z' },
    runtime: { state: 'unavailable', source: 'runtime-application', checkedAt: '2026-08-14T00:00:00.000Z', diagnostic: { code: 'runtime-unavailable', summary: 'Runtime is unavailable.' } },
    mcp: { state: 'idle', source: 'mcp-manager', checkedAt: '2026-08-14T00:00:00.000Z' },
  },
};

describe('operator runtime availability read models', () => {
  it('requires and projects the exact availability value without changing null/stopped runtime states', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'operator-runtime-read-model-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardsReadModelService(projectRoot, new CardService(projectRoot), { getRuntimeState: () => null });
    if (false) {
      // @ts-expect-error Runtime state projection requires concrete server availability.
      cards.getRuntimeState();
    }
    const state = cards.getRuntimeState(serverAvailability);
    if (!('runtime' in state.body)) throw new Error('Expected runtime state success fixture.');
    expect(state.body.runtime).toBeNull();
    expect(state.body.serverAvailability).toBe(serverAvailability);

    const runtimeApi = {
      getStatus: () => ({ status: 'stopped' as const, currentCardId: null, startedAt: '2026-08-14T00:00:00.000Z', pid: 123 }),
      getActorRuntimeReadModel: () => ({ pauseMode: 'idle' as const, cards: [] }),
    };
    // @ts-expect-error Runtime status projection requires concrete server availability.
    const missingAvailability: RuntimeStatusInputs = { runtimeApi };
    const complete: RuntimeStatusInputs = { runtimeApi, serverAvailability };
    expect(missingAvailability).toBeDefined();
    const status = buildRuntimeStatusReadModel(complete);
    expect(status.runtime).toBe('stopped');
    expect(status.serverAvailability).toBe(serverAvailability);
  });
});
