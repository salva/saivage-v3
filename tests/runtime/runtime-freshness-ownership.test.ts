import { initProjectTree } from '../helpers/canonical-project.js';
import { describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReadModelChangeBroadcaster } from '../../src/application/read-model-changes.js';
import { RuntimeStateStore } from '../../src/runtime/state.js';
import { createMutationLane } from '../../src/application/mutation-lane.js';
import { RootCurrentness } from '../../src/application/mutation-authority.js';
import { readRuntimeState } from '../../src/runtime/state-api.js';

describe('serving runtime-state freshness owner', () => {
  it('publishes exactly once after a successful write and not for a no-write mutation', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-runtime-freshness-'));
    try {
      initProjectTree(root);
      const changes = new ReadModelChangeBroadcaster();
      const runtimeChanged = jest.fn();
      changes.subscribe({ runtimeChanged, cardStateChanged() {}, agentsChanged() {}, conversationChanged() {} });
      const composition = createMutationLane();
      const mutations = new RuntimeStateStore(root, composition.lane, changes);
      mutations.initialize(composition.authority);

      mutations.patch(composition.authority, { status: 'paused' });
      expect(runtimeChanged).toHaveBeenCalledTimes(1);
      expect(readRuntimeState(root)?.status).toBe('paused');

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
      const composition = createMutationLane();
      const store = new RuntimeStateStore(invalidRoot, composition.lane, changes);
      expect(() => store.initialize(composition.authority)).toThrow();
      expect(runtimeChanged).not.toHaveBeenCalled();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects stale authority before runtime-state mutation', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-runtime-currentness-'));
    try {
      initProjectTree(root);
      const composition = createMutationLane();
      const store = new RuntimeStateStore(root, composition.lane);
      store.initialize(composition.authority);
      const currentness = new RootCurrentness();
      const rootAuthority = currentness.installRoot();
      const stale = currentness.installLeaf(rootAuthority);
      currentness.clearRoot();
      expect(() => store.patch(stale, { status: 'paused' })).toThrow(/stale/);
      expect(store.read()?.status).toBe('stopped');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('removes owned interrupted-replacement temporaries during restabilization', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-runtime-temp-'));
    try {
      initProjectTree(root);
      const composition = createMutationLane();
      const store = new RuntimeStateStore(root, composition.lane);
      store.initialize(composition.authority);
      const temporary = join(root, '.saivage', 'state', '.runtime.json.saivage-write-00000000-0000-0000-0000-000000000000.tmp');
      writeFileSync(temporary, 'incomplete');
      store.restabilize(composition.authority);
      expect(existsSync(temporary)).toBe(false);
      expect(store.read()?.status).toBe('stopped');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
