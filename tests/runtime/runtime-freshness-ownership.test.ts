import { initProjectTree } from '../helpers/canonical-project.js';
import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReadModelChangeBroadcaster } from '../../src/application/read-model-changes.js';
import { createServingRuntimeStateMutationPort } from '../../src/runtime/mutations.js';
import { readRuntimeState } from '../../src/runtime/state-api.js';

describe('serving runtime-state freshness owner', () => {
  it('publishes exactly once after a successful write and not for a no-write mutation', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-runtime-freshness-'));
    try {
      initProjectTree(root);
      const changes = new ReadModelChangeBroadcaster();
      const runtimeChanged = jest.fn();
      changes.subscribe({ runtimeChanged, cardStateChanged() {}, agentsChanged() {}, conversationChanged() {} });
      const mutations = createServingRuntimeStateMutationPort(root, changes);

      mutations.apply({ kind: 'patchRuntimeState', patch: { status: 'paused' } });
      expect(runtimeChanged).toHaveBeenCalledTimes(1);
      expect(readRuntimeState(root)?.status).toBe('paused');

      mutations.apply({ kind: 'completeActivation', childCardId: 'goal-1' });
      expect(runtimeChanged).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not publish when persistence fails', () => {
    const parent = mkdtempSync(join(tmpdir(), 'saivage-runtime-failure-'));
    const invalidRoot = join(parent, 'not-a-directory');
    writeFileSync(invalidRoot, 'file');
    const changes = new ReadModelChangeBroadcaster();
    const runtimeChanged = jest.fn();
    changes.subscribe({ runtimeChanged, cardStateChanged() {}, agentsChanged() {}, conversationChanged() {} });

    try {
      expect(() => createServingRuntimeStateMutationPort(invalidRoot, changes).apply({ kind: 'patchRuntimeState', patch: { status: 'paused' } })).toThrow();
      expect(runtimeChanged).not.toHaveBeenCalled();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
