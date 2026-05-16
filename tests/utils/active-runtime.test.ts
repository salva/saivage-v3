/**
 * Stage 18 — ActiveRuntime Unit Tests
 *
 * Tests for the ActiveRuntime class covering:
 *   1. Construction with in-memory config (no config file needed)
 *   2. start/stop lifecycle and lock management
 *   3. dispatchGoal delegation to Runtime
 *   4. pause/resume and state changes
 *   5. getStatus after various lifecycle stages
 *   6. Accessors (runtime, eventLogger, agentAdapter)
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { rmSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { CardStore } from '../../src/utils/card-store.js';
import { releaseLock, isLocked } from '../../src/utils/runtime-lock.js';
import { ActiveRuntime } from '../../src/utils/active-runtime.js';
import type { CardRecord } from '../../src/schemas/types.js';

// ── Helpers ───────────────────────────────────────────────────

function setupProjectWithConfig(projectRoot: string): void {
  initProjectTree(projectRoot);

  const sd = join(projectRoot, '.saivage');
  const now = new Date().toISOString();

  // Write minimal saivage.json
  writeFileSync(
    join(sd, 'saivage.json'),
    JSON.stringify({
      server: { port: 8080, host: '127.0.0.1' },
      models: { default: ['test-model'] },
      providers: {
        test: {
          priority: 10,
          models: ['test-model'],
          apiKey: 'test-api-key',
        },
      },
    }, null, 2),
  );

  // Write runtime state
  writeFileSync(
    join(sd, 'runtime', 'state.json'),
    JSON.stringify({
      status: 'idle',
      project_id: 'project',
      pid: process.pid,
      started_at: now,
      current_card_id: null,
      current_agent_session_id: null,
      paused: false,
      paused_at: null,
      queue: [],
      running_processes: [],
      updated_at: now,
    }, null, 2),
  );
}

function makeGoalCard(store: CardStore, id: string, title: string): CardRecord {
  return store.create({
    id,
    type: 'goal',
    parent: 'project',
    depth: 0,
    title,
    description: `Goal: ${title}`,
    status: 'backlog',
    tags: [],
    priority: 1,
    urgency: 'normal',
    created_by: 'analyst',
    depends_on: [],
    blocks: [],
    related: [],
    acceptance: `Acceptance for ${title}`,
    artifacts: [],
    attachments: [],
    retries: 0,
  });
}

// ═══════════════════════════════════════════════════════════════
// Test Suite: ActiveRuntime
// ═══════════════════════════════════════════════════════════════

describe('ActiveRuntime', () => {
  let tmpDir: string;
  let activeRuntime: ActiveRuntime;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-ar-'));
    setupProjectWithConfig(tmpDir);
  });

  afterEach(() => {
    // Release any leftover lock
    try {
      releaseLock(tmpDir);
    } catch {
      // ignore
    }

    // Clean up temp dir
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('Construction and accessors', () => {
    it('creates an ActiveRuntime with a temp project root', () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      expect(activeRuntime).toBeDefined();
      expect(activeRuntime.runtime).toBeDefined();
      expect(activeRuntime.eventLogger).toBeDefined();
      expect(activeRuntime.agentAdapter).toBeDefined();
    });

    it('getStatus returns expected defaults before start', () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      const status = activeRuntime.getStatus();
      expect(status.status).toBe('idle');
      expect(status.paused).toBe(false);
      expect(status.currentCardId).toBeNull();
      expect(typeof status.goalCount).toBe('number');
    });

    it('runtime cardStore is accessible and functional', () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      const store = activeRuntime.runtime.cardStore;
      expect(store).toBeDefined();
      const project = store.read('project');
      expect(project).not.toBeNull();
      expect(project!.type).toBe('project');
    });

    it('shares one SkillsEngine with the AgentAdapter for load_skill calls', () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      expect(activeRuntime.skillsEngine).toBeDefined();
      expect(activeRuntime.agentAdapter.getSkillsEngine()).toBe(activeRuntime.skillsEngine);
    });
  });

  describe('start/stop lifecycle', () => {
    it('start() acquires the runtime lock', async () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      await activeRuntime.start();
      expect(isLocked(tmpDir)).toBe(true);
      await activeRuntime.stop();
    });

    it('stop() releases the runtime lock', async () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      await activeRuntime.start();
      expect(isLocked(tmpDir)).toBe(true);

      await activeRuntime.stop();
      expect(isLocked(tmpDir)).toBe(false);
    });

    it('getStatus after start shows idle status', async () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      await activeRuntime.start();

      const status = activeRuntime.getStatus();
      expect(status.status).toBe('idle');
      expect(status.paused).toBe(false);

      await activeRuntime.stop();
    });

    it('stop() is idempotent — calling multiple times does not throw', async () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      await activeRuntime.start();
      await activeRuntime.stop();
      await activeRuntime.stop();
    });

    it('stop() after freeze clears frozen state and releases the lock', async () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      await activeRuntime.start();
      activeRuntime.freeze('unit test freeze');

      const statePath = join(tmpDir, '.saivage', 'runtime', 'state.json');
      expect(JSON.parse(readFileSync(statePath, 'utf-8')).status).toBe('frozen');
      expect(isLocked(tmpDir)).toBe(true);

      await activeRuntime.stop();

      expect(isLocked(tmpDir)).toBe(false);
      expect(JSON.parse(readFileSync(statePath, 'utf-8')).status).toBe('frozen');
      expect(activeRuntime.getStatus().status).toBe('idle');
    });
  });

  describe('pause / resume', () => {
    beforeEach(async () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      await activeRuntime.start();
    });

    afterEach(async () => {
      await activeRuntime.stop();
    });

    it('pause() sets paused to true', () => {
      activeRuntime.pause();
      const status = activeRuntime.getStatus();
      expect(status.paused).toBe(true);
    });

    it('resume() sets paused to false', () => {
      activeRuntime.pause();
      activeRuntime.resume();
      const status = activeRuntime.getStatus();
      expect(status.paused).toBe(false);
    });

    it('pause and resume are idempotent', () => {
      activeRuntime.pause();
      activeRuntime.pause();
      expect(activeRuntime.getStatus().paused).toBe(true);

      activeRuntime.resume();
      activeRuntime.resume();
      expect(activeRuntime.getStatus().paused).toBe(false);
    });
  });

  describe('dispatchGoal', () => {
    beforeEach(async () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      await activeRuntime.start();
    });

    afterEach(async () => {
      await activeRuntime.stop();
    });

    it('dispatchGoal exists and is callable (method presence)', () => {
      expect(typeof activeRuntime.dispatchGoal).toBe('function');
    });

    it('dispatchGoal while paused blocks the dispatch', async () => {
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-test-paused', 'Paused Dispatch Goal');

      activeRuntime.pause();
      expect(activeRuntime.getStatus().paused).toBe(true);

      await activeRuntime.dispatchGoal('goal-test-paused');

      const goal = store.read('goal-test-paused');
      expect(goal!.status).toBe('backlog');

      activeRuntime.resume();
    });
  });

  describe('getStatus', () => {
    it('getStatus reports goalCount correctly', () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      const store = new CardStore(tmpDir);

      expect(activeRuntime.getStatus().goalCount).toBe(0);

      makeGoalCard(store, 'goal-status-1', 'Status Test Goal 1');
      const ar2 = new ActiveRuntime(tmpDir);
      expect(ar2.getStatus().goalCount).toBe(1);

      makeGoalCard(store, 'goal-status-2', 'Status Test Goal 2');
      const ar3 = new ActiveRuntime(tmpDir);
      expect(ar3.getStatus().goalCount).toBe(2);
    });

    it('getStatus reflects pause state via the paused flag', () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      expect(activeRuntime.getStatus().paused).toBe(false);

      activeRuntime.pause();
      expect(activeRuntime.getStatus().paused).toBe(true);

      activeRuntime.resume();
      expect(activeRuntime.getStatus().paused).toBe(false);
    });
  });
});
