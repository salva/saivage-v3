/**
 * Stage 38 — Freeze/Resume Tests
 *
 * Tests for Runtime.freeze() and Runtime.resumeFromFreeze() covering:
 *   1. Freeze idempotency — freeze() on frozen returns existing manifest
 *   2. Resume from freeze — restores queue, card, processes
 *   3. Resume without manifest throws
 *   4. Resume with incompatible schema version throws
 *   5. Freeze while idle — saves manifest with empty state
 *   6. Freeze while paused — upgrades pause to freeze
 *   7. Freeze with running processes — processes classified with action
 *   8. Deferred process reconciliation remains absent
 *   9. Handoff summary format validation
 *   10. Freeze collects handoff summaries from sessions
 *   11. No active sessions produces empty handoff_summaries
 *   12. Resume injects handoff context
 *   13. Manifest schema validation errors
 *   14. Freeze while already frozen and manifest missing
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import { FakeAgentAdapter, type FakeAgentFixture } from '../../src/agents/fake-agent.js';
import {
  readFreezeManifest,
  saveFreezeManifest,
  clearFreezeManifest,
} from '../../src/runtime/freeze-manifest.js';
import {
  readRuntimeState,
  initRuntimeState,
  updateRuntimeState,
} from '../../src/runtime/state.js';
import { releaseLock } from '../../src/runtime/lock.js';
import type { CardRecord, FreezeManifest, HandoffSummary } from '../../src/schemas/types.js';
import { createRuntimeCoreTestContainer, type RuntimeCoreTestContainer } from '../../src/runtime/core-composition.js';

// ── Test Harness ────────────────────────────────────────────────

function makeFixtureDir(tmpDir: string): string {
  const dir = join(tmpDir, 'fixtures');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFixture(dir: string, name: string, fixture: FakeAgentFixture): void {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(fixture, null, 2), 'utf-8');
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

function createHappyFixture(): FakeAgentFixture {
  return {
    name: 'happy',
    planner: [
      { created_cards: [], status: 'done' },
    ],
    executor: {},
    reviewer: [
      {
        assessment: {
          id: 'rev-1', goal_card_id: 'goal-1',
          reviewer_session_id: 'rev-session', result: 'pass',
          assessment_id: 'assessment-test',
          at: '2025-01-01T00:00:00.000Z',
          summary: 'ok', achieved: [], issues: [], evidence_card_ids: [],
          created_at: new Date().toISOString(),
        },
      },
    ],
  };
}

describe('Freeze / Resume', () => {
  let tmpDir: string;
  let fixtureDir: string;
  let harness: RuntimeCoreTestContainer;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-fr-'));
    fixtureDir = makeFixtureDir(tmpDir);
    initProjectTree(tmpDir);
  });

  afterEach(() => {
    try {
      if (harness) harness.api.shutdown();
    } catch { /* ignore */ }
    try { releaseLock(tmpDir); } catch { /* ignore */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig() {
    writeFixture(fixtureDir, 'happy', createHappyFixture());
    return {
      projectRoot: tmpDir,
      fakeAgentConfig: { mapping: { '*': 'happy' }, fixtureDir },
    };
  }

  function makeRuntime(agentRuntime?: FakeAgentAdapter): void {
    harness = createRuntimeCoreTestContainer({
      config: makeConfig(),
      ...(agentRuntime ? { agentRuntime } : {}),
    });
  }

  function freeze(reason?: string) { return harness.lifecycleTestTools.freeze(reason); }
  function resumeFromFreeze() { return harness.lifecycleTestTools.resumeFromFreeze(); }
  function status() { return harness.api.getStatus().status; }
  function paused() { return harness.api.getStatus().paused; }

  // ═══════════════════════════════════════════════════════════════
  // Freeze Idempotency
  // ═══════════════════════════════════════════════════════════════

  describe('Freeze idempotency', () => {
    it('freeze() on frozen runtime returns existing manifest', async () => {
      makeRuntime();
      await harness.api.start();

      const firstManifest = freeze('first freeze');
      expect(firstManifest.freeze_id).toBeDefined();
      expect(firstManifest.reason).toBe('first freeze');

      const secondManifest = freeze('second freeze');
      expect(secondManifest.freeze_id).toBe(firstManifest.freeze_id);
      expect(secondManifest.reason).toBe('first freeze'); // unchanged
    });

    it('freeze() when already frozen does not change manifest', async () => {
      makeRuntime();
      await harness.api.start();

      const m1 = freeze('original');
      const now = new Date();
      const m2 = freeze('should be ignored');

      expect(m2.created_at).toBe(m1.created_at); // timestamp unchanged
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Resume from Freeze
  // ═══════════════════════════════════════════════════════════════

  describe('Resume from freeze', () => {
    it('resumeFromFreeze() restores queue and card but not deferred processes', async () => {
      makeRuntime();
      await harness.api.start();

      // Set up runtime state with a queue and current_card_id
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-resume', 'Resume Goal');

      updateRuntimeState(tmpDir, {
        status: 'idle' as const,
        project_id: 'project' as const,
        started_at: new Date().toISOString(),
        current_card_id: 'goal-resume',
        current_agent_session_id: null,
        paused: false,
        paused_at: null,
        updated_at: new Date().toISOString(),
      });

      // Freeze and verify manifest
      const manifest = freeze('test resume');
      expect(manifest.freeze_id).toBeDefined();
      expect(manifest.current_card_id).toBe('goal-resume');
      expect(manifest.queue).toEqual([]);
      expect(manifest.running_processes).toEqual([]);

      // Resume
      const result = resumeFromFreeze();
      expect(result.freeze_id).toBe(manifest.freeze_id);
      expect(result.restored_queue).toEqual([]);
      expect(result.restored_processes).toEqual([]);
      expect(result.restored_card_id).toBe('goal-resume');

      // Runtime state should be restored
      const state = readRuntimeState(tmpDir);
      expect(state).not.toBeNull();
      expect(state!.status).toBe('idle');
      expect(state!.current_card_id).toBe('goal-resume');

      // Manifest should be cleared
      expect(readFreezeManifest(tmpDir)).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Resume without manifest throws
  // ═══════════════════════════════════════════════════════════════

  describe('Resume error cases', () => {
    it('resumeFromFreeze() throws when no freeze manifest exists', async () => {
      makeRuntime();
      await harness.api.start();

      expect(() => resumeFromFreeze()).toThrow(
        'Cannot resume: no freeze manifest found'
      );
    });

    it('resumeFromFreeze() throws when schema version is newer than supported', async () => {
      makeRuntime();
      await harness.api.start();

      // Save a manifest with a future schema version
      const badManifest: FreezeManifest = {
        freeze_id: 'bad-freeze',
        reason: 'future version',
        created_at: new Date().toISOString(),
        status: 'frozen' as const,
        project_id: 'project' as const,
        pid: process.pid,
        started_at: new Date().toISOString(),
        current_card_id: null,
        current_agent_session_id: null,
        queue: [],
        running_processes: [],
        handoff_summaries: [],
        schema_version: 999,
        runtime_version: '999.0.0',
      };
      saveFreezeManifest(tmpDir, badManifest);

      expect(() => resumeFromFreeze()).toThrow(
        /schema version 999 is newer/
      );

      clearFreezeManifest(tmpDir);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Freeze while idle
  // ═══════════════════════════════════════════════════════════════

  describe('Freeze while idle', () => {
    it('freeze() while idle saves manifest with empty state', async () => {
      makeRuntime();
      await harness.api.start();

      const manifest = freeze('idle freeze');
      expect(manifest.current_card_id).toBeNull();
      expect(manifest.queue).toEqual([]);
      expect(manifest.running_processes).toEqual([]);
      expect(manifest.handoff_summaries).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Freeze while paused
  // ═══════════════════════════════════════════════════════════════

  describe('Freeze while paused', () => {
    it('freeze() while paused upgrades pause to freeze', async () => {
      makeRuntime();
      await harness.api.start();

      harness.api.pause();
      expect(paused()).toBe(true);
      expect(status()).toBe('paused');

      const manifest = freeze('pause upgrade');
      expect(manifest.reason).toBe('pause upgrade');

      // After freeze, status is 'frozen'
      expect(status()).toBe('frozen');

      // Resume should work
      const result = resumeFromFreeze();
      expect(result.freeze_id).toBe(manifest.freeze_id);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Deferred Process Reconciliation Absence
  // ═══════════════════════════════════════════════════════════════

  describe('Deferred process reconciliation during freeze', () => {
    it('does not persist process action plans for reattach/kill/detach', async () => {
      makeRuntime();
      await harness.api.start();

      updateRuntimeState(tmpDir, {
        status: 'idle' as const,
        project_id: 'project' as const,
        started_at: new Date().toISOString(),
        current_card_id: null,
        current_agent_session_id: null,
        paused: false,
        paused_at: null,
        updated_at: new Date().toISOString(),
      });

      const manifest = freeze('process reconciliation deferred');
      expect(manifest.running_processes).toEqual([]);
      expect(JSON.stringify(manifest)).not.toMatch(/reattach|detach|kill/);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Handoff Summary Format
  // ═══════════════════════════════════════════════════════════════

  describe('Handoff summary format', () => {
    it('handoff summary matches required format', () => {
      const summary: HandoffSummary = {
        session_id: 'session-1',
        role: 'planner',
        last_action: 'Created cards for data acquisition',
        next_action: 'Wait for executor results',
        context_summary: 'Goal: goal-1, Card: plan-1',
      };

      expect(summary).toHaveProperty('session_id');
      expect(summary).toHaveProperty('role');
      expect(summary).toHaveProperty('last_action');
      expect(summary).toHaveProperty('next_action');
      expect(summary).toHaveProperty('context_summary');
      expect(['analyst', 'planner', 'executor', 'reviewer', 'content_supervisor']).toContain(summary.role);
    });

    it('no active sessions produces empty handoff_summaries', async () => {
      makeRuntime();
      await harness.api.start();

      const manifest = freeze('no sessions');
      expect(manifest.handoff_summaries).toEqual([]);
    });

    it('freeze with active session state collects handoff in manifest', async () => {
      // Use a custom AgentRuntime that returns handoff summaries
      const mockHandoffs: HandoffSummary[] = [
        {
          session_id: 'planner-goal1-0',
          role: 'planner',
          last_action: 'Created initial plan',
          next_action: 'Wait for cards to complete',
          context_summary: 'Goal: goal-1',
        },
        {
          session_id: 'executor-code1-goal1-0',
          role: 'executor',
          last_action: 'Implementing feature X',
          next_action: 'Running tests',
          context_summary: 'Card: code-1, Goal: goal-1',
        },
      ];

      const customRt = new FakeAgentAdapter({
        mapping: { '*': 'happy' },
        fixtureDir,
      });

      // Override getActiveSessionHandoffs
      customRt.getActiveSessionHandoffs = () => mockHandoffs;

      writeFixture(fixtureDir, 'happy', createHappyFixture());
      makeRuntime(customRt);
      await harness.api.start();

      const manifest = freeze('with handoffs');
      expect(manifest.handoff_summaries).toHaveLength(2);
      expect(manifest.handoff_summaries[0].session_id).toBe('planner-goal1-0');
      expect(manifest.handoff_summaries[0].role).toBe('planner');
      expect(manifest.handoff_summaries[1].session_id).toBe('executor-code1-goal1-0');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Handoff Context Injection on Resume
  // ═══════════════════════════════════════════════════════════════

  describe('Handoff context injection on resume', () => {
    it('resumeFromFreeze() stores handoff context for dispatch loop', async () => {
      makeRuntime();
      await harness.api.start();

      // Set up state with an active session
      updateRuntimeState(tmpDir, {
        status: 'idle' as const,
        project_id: 'project' as const,
        started_at: new Date().toISOString(),
        current_card_id: 'card-1',
        current_agent_session_id: 'executor-card1-goal1-0',
        paused: false,
        paused_at: null,
        updated_at: new Date().toISOString(),
      });

      // Manually save a manifest with handoff summaries
      const manifest: FreezeManifest = {
        freeze_id: 'handoff-resume-test',
        reason: 'test handoff injection',
        created_at: new Date().toISOString(),
        status: 'frozen' as const,
        project_id: 'project' as const,
        pid: process.pid,
        started_at: new Date().toISOString(),
        current_card_id: 'card-1',
        current_agent_session_id: 'executor-card1-goal1-0',
        queue: [],
        running_processes: [],
        handoff_summaries: [
          {
            session_id: 'executor-card1-goal1-0',
            role: 'executor',
            last_action: 'Writing implementation',
            next_action: 'Run tests',
            context_summary: 'Card: card-1',
          },
        ],
        schema_version: 1,
        runtime_version: '0.1.0',
      };
      saveFreezeManifest(tmpDir, manifest);

      // Resume and check handoff context
      const result = resumeFromFreeze();
      expect(result.freeze_id).toBe('handoff-resume-test');

      const context = harness.lifecycleTestTools.consumeResumeHandoffContext();
      expect(context).not.toBeNull();
      expect(context).toContain('[Handoff]');
      expect(context).toContain('executor-card1-goal1-0');
      expect(context).toContain('Writing implementation');
      expect(context).toContain('Run tests');
    });

    it('resume without handoff summaries returns null context', async () => {
      makeRuntime();
      await harness.api.start();

      // Freeze without active sessions
      const manifest = freeze('no handoffs');
      const context = harness.lifecycleTestTools.consumeResumeHandoffContext();
      expect(context).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Manifest Schema Validation
  // ═══════════════════════════════════════════════════════════════

  describe('Manifest schema validation', () => {
    it('invalid manifest (missing required field) is rejected by saveFreezeManifest', () => {
      const badManifest = {
        freeze_id: 'test',
        reason: 'test',
        created_at: new Date().toISOString(),
        // missing status, project_id, pid, etc.
      };

      expect(() => saveFreezeManifest(tmpDir, badManifest as unknown as FreezeManifest)).toThrow(
        'FreezeManifest validation failed'
      );
    });

    it('manifest with wrong status value is rejected', () => {
      const badManifest = {
        freeze_id: 'test',
        reason: 'test',
        created_at: new Date().toISOString(),
        status: 'not-frozen',
        project_id: 'project',
        pid: process.pid,
        started_at: new Date().toISOString(),
        current_card_id: null,
        current_agent_session_id: null,
        queue: [],
        running_processes: [],
        handoff_summaries: [],
        schema_version: 1,
        runtime_version: '0.1.0',
      };

      expect(() => saveFreezeManifest(tmpDir, badManifest as unknown as FreezeManifest)).toThrow(
        'FreezeManifest validation failed'
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Freeze Status Transitions
  // ═══════════════════════════════════════════════════════════════

  describe('Freeze status transitions', () => {
    it('freeze sets runtime status to frozen', async () => {
      makeRuntime();
      await harness.api.start();

      expect(status()).toBe('idle');
      freeze();
      expect(status()).toBe('frozen');
      expect(paused()).toBe(true);
    });

    it('resumeFromFreeze sets runtime status to idle', async () => {
      makeRuntime();
      await harness.api.start();

      freeze();
      expect(status()).toBe('frozen');

      resumeFromFreeze();
      expect(status()).toBe('idle');
      expect(paused()).toBe(false);
    });

    it('shutdown while frozen does not require full cleanup', async () => {
      makeRuntime();
      await harness.api.start();

      freeze();
      await harness.api.shutdown();

      // Should not throw — shutdown handles frozen state gracefully.
      // Status remains 'frozen' on disk (freeze manifest persists); only
      // resumeFromFreeze() clears it back to 'idle'.
      expect(status()).toBe('frozen');
    });
  });

});
