import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SupervisorRuntimeApi } from '../../../src/runtime/actors/supervisor-runtime-api.js';
import { CardService, initProjectTree } from '../../helpers/canonical-project.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function projectCard() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-initialization-'));
  roots.push(projectRoot);
  initProjectTree(projectRoot);
  return new CardService(projectRoot).read('project')!;
}

function supervisor(read: () => unknown): SupervisorRuntimeApi {
  return new SupervisorRuntimeApi({
    actorStore: { read },
    processIdentity: { pid: 42, startedAt: '2026-08-10T00:00:00.000Z' },
    runtimeGate: new RuntimeGate(),
  } as never);
}

const interventionError = 'Analyst mutation requires an intervention-ready stopped or settled paused runtime.';

describe('Supervisor initialization lifecycle', () => {
  it('rejects intervention and public status before successful initialization', () => {
    const runtime = supervisor(() => projectCard());

    expect(() => runtime.assertInterventionReady()).toThrow(interventionError);
    expect(() => runtime.getStatus()).toThrow('Runtime has not been initialized.');
    expect(runtime.getRuntimeState()).toBeNull();
  });

  it('retains uninitialized admission after a missing root and permits a strict retry', async () => {
    const root = projectCard();
    const read = jest.fn<() => unknown>().mockReturnValueOnce(null).mockReturnValue(root);
    const runtime = supervisor(read);

    await expect(runtime.start()).rejects.toThrow("Root card record 'project' is missing.");
    expect(() => runtime.getStatus()).toThrow('Runtime has not been initialized.');
    expect(() => runtime.assertInterventionReady()).toThrow(interventionError);

    await expect(runtime.start()).resolves.toBeUndefined();
    expect(runtime.getStatus()).toMatchObject({ status: 'stopped', currentCardId: null });
    expect(() => runtime.assertInterventionReady()).not.toThrow();
  });

  it('retains uninitialized admission after malformed root validation', async () => {
    const runtime = supervisor(() => ({}));

    await expect(runtime.start()).rejects.toThrow();
    expect(() => runtime.getStatus()).toThrow('Runtime has not been initialized.');
    expect(() => runtime.assertInterventionReady()).toThrow(interventionError);
  });
});
