import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { createRuntimeCoreContainer } from '../../src/runtime/core-composition.js';
import { createRuntimeCoreTestContainer } from '../../src/runtime/core-composition.js';

describe('runtime core composition', () => {
  it('keeps production core composition limited to production ports', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'runtime-core-production-'));
    try {
      initProjectTree(projectRoot);
      const core = createRuntimeCoreContainer({ config: { projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' }, autoDispatchBacklog: false } });
      expect(Object.keys(core).sort()).toEqual(['api', 'projectRoot']);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('creates a narrow runtime API plus test-only internals', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'runtime-core-composition-'));
    try {
      initProjectTree(projectRoot);
      const harness = createRuntimeCoreTestContainer({ config: { projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' }, autoDispatchBacklog: false } });
      expect(Object.keys(harness.api).sort()).toEqual(['getActivityStatus', 'getStatus', 'pause', 'resume', 'shutdown', 'start', 'startProject', 'stopProject', 'subscribe']);
      expect(harness.projectRoot).toBe(projectRoot);
      expect(harness.agentEventBus).toBeDefined();
      expect(harness.runtimeLedgerEvents).toBeDefined();
      expect(typeof harness.eventTestTools.on).toBe('function');
      expect(typeof harness.dispatchTestTools.dispatchGoal).toBe('function');
      expect(typeof harness.eventTestTools.emitAgentEvent).toBe('function');
      expect(typeof harness.lifecycleTestTools.performCrashRecovery).toBe('function');
      expect(typeof harness.lifecycleTestTools.requestImmediateTick).toBe('function');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('forwards agent event bus emissions through runtime events', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'runtime-core-composition-events-'));
    try {
      initProjectTree(projectRoot);
      const harness = createRuntimeCoreTestContainer({ config: { projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' }, autoDispatchBacklog: false } });
      const received: unknown[] = [];
      harness.eventTestTools.on('session_started', (event) => received.push(event));

      harness.agentEventBus.emit('session_started', { session_id: 's1', role: 'planner', goal_id: 'project', card_id: 'project' });

      expect(received).toEqual([expect.objectContaining({ session_id: 's1', role: 'planner', goal_id: 'project', card_id: 'project' })]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
