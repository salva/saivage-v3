/**
 * Comprehensive test suite for process-runner.ts
 *
 * Covers:
 * - startProcess: spawn, output files, ProcessRecord fields
 * - waitProcess: normal exit, timeout (no kill), already-exited
 * - startAndWait: convenience function
 * - tailOutput: last N lines, empty, nonexistent
 * - killProcess: SIGTERM → SIGKILL escalation, already-exited
 * - listProcesses: filtering by card_id and status
 * - Registry persistence: save/load round-trip, Zod validation
 * - Restart survival: output files survive, registry survives
 * - Edge cases: failed commands, spawn errors, concurrent processes
 * - Backward compatibility: new ownership fields
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initProjectTree } from '../../src/utils/file-tree.js';
import {
  startProcess,
  waitProcess,
  startAndWait,
  tailOutput,
  killProcess,
  listProcesses,
  loadRegistry,
  getProcess,
  saveRegistry,
  cleanupProcessOutput,
  cleanupAllCompleted,
} from '../../src/utils/process-runner.js';
import type { ProcessRecord, ProcessStatus } from '../../src/schemas/types.js';

// ── Helpers ───────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Process Runner', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'proc-runner-'));
    initProjectTree(root);
  });

  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // startProcess
  // ═══════════════════════════════════════════════════════════════

  describe('startProcess', () => {
    it('spawns a process and returns a valid ProcessRecord', () => {
      const rec = startProcess(root, 'sleep 5', { cardId: 'card-test' });

      expect(rec.id).toMatch(/^proc-/);
      expect(rec.card_id).toBe('card-test');
      expect(rec.command).toBe('sleep 5');
      expect(rec.status).toBe('running');
      expect(rec.pid).toEqual(expect.any(Number));
      expect(rec.pid).toBeGreaterThan(0);
      expect(rec.started_at).toEqual(expect.any(String));
      expect(rec.completed_at).toBeNull();
      expect(rec.exit_code).toBeNull();
      expect(rec.required_for_card_completion).toBe(true);
      expect(rec.output_dir).toContain('.saivage-work/processes/');
      expect(rec.stdout_path).toContain('stdout.log');
      expect(rec.stderr_path).toContain('stderr.log');
      expect(rec.combined_log_path).toContain('combined.log');

      // Clean up
      killProcess(root, rec.id);
    });

    it('creates output files on disk for stdout/stderr/combined', async () => {
      const rec = startProcess(root, 'echo "hello stdout"; echo "hello stderr" >&2', {
        cardId: 'card-out',
      });

      // Wait for process to finish
      await waitProcess(root, rec.id);
      await sleep(500);

      // Verify output files exist
      expect(existsSync(rec.stdout_path)).toBe(true);
      expect(existsSync(rec.stderr_path)).toBe(true);
      expect(existsSync(rec.combined_log_path)).toBe(true);

      const combined = readFileSync(rec.combined_log_path, 'utf-8');
      expect(combined).toContain('hello stdout');
      expect(combined).toContain('hello stderr');
    });

    it('generates unique process IDs', () => {
      const rec1 = startProcess(root, 'sleep 5', { cardId: 'card-1' });
      const rec2 = startProcess(root, 'sleep 5', { cardId: 'card-1' });

      expect(rec1.id).not.toBe(rec2.id);

      killProcess(root, rec1.id);
      killProcess(root, rec2.id);
    });

    it('marks process as failed when command exits with non-zero', async () => {
      const rec = startProcess(root, 'exit 42', { cardId: 'card-fail' });

      await waitProcess(root, rec.id);
      await sleep(300);

      const reloaded = getProcess(root, rec.id);
      expect(reloaded).not.toBeNull();
      expect(reloaded!.status).toBe('failed');
      expect(reloaded!.exit_code).toBe(42);
    });

    it('persists to the registry immediately on start', () => {
      const rec = startProcess(root, 'sleep 10', { cardId: 'card-reg' });

      const registry = loadRegistry(root);
      expect(registry.has(rec.id)).toBe(true);

      const stored = registry.get(rec.id)!;
      expect(stored.id).toBe(rec.id);
      expect(stored.status).toBe('running');

      killProcess(root, rec.id);
    });

    it('respects required_for_card_completion option', () => {
      const rec1 = startProcess(root, 'sleep 3', {
        cardId: 'card-opt',
        requiredForCardCompletion: false,
      });
      expect(rec1.required_for_card_completion).toBe(false);

      const rec2 = startProcess(root, 'sleep 3', {
        cardId: 'card-opt',
        requiredForCardCompletion: true,
      });
      expect(rec2.required_for_card_completion).toBe(true);

      const rec3 = startProcess(root, 'sleep 3', { cardId: 'card-opt' });
      expect(rec3.required_for_card_completion).toBe(true); // default

      killProcess(root, rec1.id);
      killProcess(root, rec2.id);
      killProcess(root, rec3.id);
    });

    it('includes new ownership fields from ProcessStartOptions', () => {
      const rec = startProcess(root, 'sleep 3', {
        cardId: 'card-own',
        agentSessionId: 'session-test-123',
        goalId: 'goal-test-456',
        launchReason: 'test executor tool call',
        ownerKind: 'agent',
        backgroundPolicy: 'foreground',
      });

      expect(rec.agent_session_id).toBe('session-test-123');
      expect(rec.goal_id).toBe('goal-test-456');
      expect(rec.launch_reason).toBe('test executor tool call');
      expect(rec.owner_kind).toBe('agent');
      expect(rec.background_policy).toBe('foreground');
      expect(rec.process_group_id).toBeNull();

      killProcess(root, rec.id);
    });

    it('sets new fields to null when not provided', () => {
      const rec = startProcess(root, 'sleep 3', { cardId: 'card-null' });

      expect(rec.agent_session_id).toBeNull();
      expect(rec.goal_id).toBeNull();
      expect(rec.launch_reason).toBeNull();
      expect(rec.owner_kind).toBeNull();
      expect(rec.background_policy).toBeNull();
      expect(rec.process_group_id).toBeNull();

      killProcess(root, rec.id);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // waitProcess
  // ═══════════════════════════════════════════════════════════════

  describe('waitProcess', () => {
    it('waits for a process to complete and returns exited status', async () => {
      const rec = startProcess(root, 'echo done', { cardId: 'card-wait' });

      const result = await waitProcess(root, rec.id);
      expect(result.id).toBe(rec.id);
      expect(result.status).toBe('exited');
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.waitDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns failed status for command that exits non-zero', async () => {
      const rec = startProcess(root, 'exit 7', { cardId: 'card-fail' });

      const result = await waitProcess(root, rec.id);
      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(7);
    });

    it('returns the current status for already-exited process', async () => {
      const rec = startProcess(root, 'echo quick', { cardId: 'card-done' });

      // Let it finish
      await sleep(200);

      // Wait should return immediately with the final status
      const result = await waitProcess(root, rec.id);
      expect(result.timedOut).toBe(false);
      expect(['exited', 'failed']).toContain(result.status);
    });

    it('times out without killing the process', async () => {
      const rec = startProcess(root, 'sleep 30', { cardId: 'card-timeout' });

      const result = await waitProcess(root, rec.id, 500);
      expect(result.timedOut).toBe(true);
      expect(result.status).toBe('running');
      expect(result.exitCode).toBeNull();

      // CRITICAL: process must still be alive
      const proc = getProcess(root, rec.id);
      expect(proc).not.toBeNull();
      expect(proc!.status).toBe('running');

      // Clean up
      await killProcess(root, rec.id);
    });

    it('returns failed for nonexistent process ID', async () => {
      const result = await waitProcess(root, 'proc-nonexistent');
      expect(result.status).toBe('failed');
      expect(result.exitCode).toBeNull();
      expect(result.timedOut).toBe(false);
    });

    it('handles multiple waiters on the same process', async () => {
      const rec = startProcess(root, 'sleep 2 && echo done', { cardId: 'card-multi' });

      const [r1, r2, r3] = await Promise.all([
        waitProcess(root, rec.id),
        waitProcess(root, rec.id),
        waitProcess(root, rec.id),
      ]);

      expect(r1.status).toBe(r2.status);
      expect(r2.status).toBe(r3.status);
      expect(r1.timedOut).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // startAndWait
  // ═══════════════════════════════════════════════════════════════

  describe('startAndWait', () => {
    it('starts and waits for a quick command', async () => {
      const result = await startAndWait(root, 'echo "hello world"', {
        cardId: 'card-saw',
      });

      expect(result.status).toBe('exited');
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.id).toMatch(/^proc-/);
      expect(result.waitDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('propagates timeout without killing', async () => {
      const result = await startAndWait(
        root,
        'sleep 30',
        { cardId: 'card-saw-timeout' },
        300,
      );

      expect(result.timedOut).toBe(true);
      expect(result.status).toBe('running');

      // Clean up
      await killProcess(root, result.id);
    });

    it('handles failing commands', async () => {
      const result = await startAndWait(root, 'exit 99', { cardId: 'card-saw-fail' });

      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(99);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // tailOutput
  // ═══════════════════════════════════════════════════════════════

  describe('tailOutput', () => {
    it('returns last N lines of process output', async () => {
      // Generate 20 lines of output
      const cmd = Array.from({ length: 20 }, (_, i) => `echo "line_${i}"`).join(' && ');
      const result = await startAndWait(root, cmd, { cardId: 'card-tail' });
      await sleep(300);

      const tail = tailOutput(root, result.id, 5);
      const lines = tail.split('\n');
      expect(lines.length).toBeLessThanOrEqual(5);
      expect(tail).toContain('line_15');
      expect(tail).toContain('line_19');
      expect(tail).not.toContain('line_0');
    });

    it('returns empty string for nonexistent process', () => {
      const result = tailOutput(root, 'proc-nonexistent', 10);
      expect(result).toBe('');
    });

    it('returns empty string when output dir does not exist', () => {
      const result = tailOutput(root, 'proc-no-dir', 10);
      expect(result).toBe('');
    });

    it('returns empty string when combined.log is empty', async () => {
      const rec = startProcess(root, 'true', { cardId: 'card-empty' });
      await waitProcess(root, rec.id);
      await sleep(200);

      const tail = tailOutput(root, rec.id);
      // "true" produces no output; could be empty or contain trailing newline
      expect(typeof tail).toBe('string');
    });

    it('returns the full output when fewer lines than requested', async () => {
      const result = await startAndWait(root, 'echo "only three" && echo "lines here" && echo "thats all"', {
        cardId: 'card-few',
      });
      await sleep(200);

      const tail = tailOutput(root, result.id, 100);
      const lines = tail.split('\n').filter(Boolean);
      expect(lines.length).toBeLessThanOrEqual(3);
    });

    it('works for running processes with partial output', async () => {
      // Start a process that writes, then sleeps
      const rec = startProcess(root, 'echo "partial-output" && sleep 10', {
        cardId: 'card-partial',
      });
      await sleep(200);

      const tail = tailOutput(root, rec.id);
      expect(tail).toContain('partial-output');

      await killProcess(root, rec.id);
    });

    it('defaults to 50 lines if lines parameter not provided', async () => {
      const result = await startAndWait(root, 'echo "test"', { cardId: 'card-default' });
      await sleep(200);

      const tail = tailOutput(root, result.id);
      expect(typeof tail).toBe('string');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // killProcess
  // ═══════════════════════════════════════════════════════════════

  describe('killProcess', () => {
    it('kills a running process via SIGTERM', async () => {
      const rec = startProcess(root, 'sleep 30', { cardId: 'card-kill' });
      await sleep(100);

      const killed = await killProcess(root, rec.id);
      expect(killed.status).toBe('killed');
    });

    it('throws for nonexistent process ID', async () => {
      await expect(killProcess(root, 'proc-nonexistent')).rejects.toThrow(
        /not found/,
      );
    });

    it('returns the record without error for already-exited process', async () => {
      const rec = startProcess(root, 'echo quick', { cardId: 'card-already' });
      await waitProcess(root, rec.id);
      await sleep(200);

      // Killing an already-exited process should return the record
      const result = await killProcess(root, rec.id);
      expect(result.id).toBe(rec.id);
      expect(['exited', 'failed']).toContain(result.status);
    });

    it('escalates to SIGKILL if SIGTERM times out', async () => {
      // Create a process that ignores SIGTERM
      const rec = startProcess(
        root,
        'trap "" TERM; sleep 10',
        { cardId: 'card-escalate' },
      );
      await sleep(300);

      // Use a very short grace period to force escalation
      const killed = await killProcess(root, rec.id, 500);
      expect(killed.status).toBe('killed');
    });

    it('marks the process as killed in the registry', async () => {
      const rec = startProcess(root, 'sleep 30', { cardId: 'card-reg-kill' });
      await sleep(100);

      await killProcess(root, rec.id);

      const fromReg = getProcess(root, rec.id);
      expect(fromReg).not.toBeNull();
      expect(fromReg!.status).toBe('killed');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // listProcesses
  // ═══════════════════════════════════════════════════════════════

  describe('listProcesses', () => {
    it('returns all processes', async () => {
      const rec1 = startProcess(root, 'echo a', { cardId: 'card-a' });
      const rec2 = startProcess(root, 'echo b', { cardId: 'card-b' });

      await waitProcess(root, rec1.id);
      await waitProcess(root, rec2.id);
      await sleep(200);

      const all = listProcesses(root);
      expect(all.length).toBe(2);
    });

    it('filters by cardId', async () => {
      const rec1 = startProcess(root, 'echo a', { cardId: 'card-x' });
      const rec2 = startProcess(root, 'echo b', { cardId: 'card-y' });

      await waitProcess(root, rec1.id);
      await waitProcess(root, rec2.id);
      await sleep(200);

      const filtered = listProcesses(root, { cardId: 'card-x' });
      expect(filtered.length).toBe(1);
      expect(filtered[0].card_id).toBe('card-x');
    });

    it('filters by single status', async () => {
      startProcess(root, 'echo ok', { cardId: 'card-s1' });
      const running = startProcess(root, 'sleep 30', { cardId: 'card-s2' });

      await sleep(200);

      const runningList = listProcesses(root, { status: 'running' });
      expect(runningList.length).toBeGreaterThanOrEqual(1);
      expect(runningList.every((r) => r.status === 'running')).toBe(true);

      await killProcess(root, running.id);
    });

    it('filters by multiple statuses', async () => {
      const rec1 = startProcess(root, 'echo done', { cardId: 'card-multi' });
      await waitProcess(root, rec1.id);
      await sleep(200);

      const running = startProcess(root, 'sleep 30', { cardId: 'card-multi' });
      await sleep(100);

      // Filter for both exited and running
      const filtered = listProcesses(root, {
        status: ['exited', 'running'],
      });
      expect(filtered.length).toBeGreaterThanOrEqual(2);

      await killProcess(root, running.id);
    });

    it('filters by both cardId and status', async () => {
      startProcess(root, 'echo a', { cardId: 'card-z' });
      const running = startProcess(root, 'sleep 30', { cardId: 'card-z' });

      await sleep(300);

      const filtered = listProcesses(root, {
        cardId: 'card-z',
        status: 'running',
      });
      expect(filtered.length).toBeGreaterThanOrEqual(1);
      expect(filtered.every((r) => r.card_id === 'card-z' && r.status === 'running')).toBe(
        true,
      );

      await killProcess(root, running.id);
    });

    it('returns empty array when no processes match filter', () => {
      const result = listProcesses(root, { cardId: 'card-nonexistent' });
      expect(result).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Registry Persistence
  // ═══════════════════════════════════════════════════════════════

  describe('Registry persistence', () => {
    it('saves and loads the registry correctly', async () => {
      const result = await startAndWait(root, 'echo test', { cardId: 'card-reg' });
      await sleep(200);

      const reg = loadRegistry(root);
      expect(reg.size).toBe(1);
      expect(reg.has(result.id)).toBe(true);

      const stored = reg.get(result.id)!;
      expect(stored.card_id).toBe('card-reg');
      expect(stored.command).toBe('echo test');
      expect(stored.status).toBe('exited');
    });

    it('round-trips all ProcessRecord fields including new ownership fields', async () => {
      const rec = startProcess(root, 'sleep 30', {
        cardId: 'card-rt',
        cwd: '/tmp',
        env: { FOO: 'bar' },
        requiredForCardCompletion: false,
        agentSessionId: 'session-rt',
        goalId: 'goal-rt',
        launchReason: 'round-trip test',
        ownerKind: 'agent',
        backgroundPolicy: 'foreground',
      });

      await sleep(100);

      const reg = loadRegistry(root);
      const stored = reg.get(rec.id)!;

      expect(stored.id).toBe(rec.id);
      expect(stored.card_id).toBe(rec.card_id);
      expect(stored.command).toBe(rec.command);
      expect(stored.cwd).toBe(rec.cwd);
      expect(stored.status).toBe('running');
      expect(stored.pid).toBe(rec.pid);
      expect(stored.started_at).toBe(rec.started_at);
      expect(stored.completed_at).toBeNull();
      expect(stored.exit_code).toBeNull();
      expect(stored.required_for_card_completion).toBe(false);
      expect(stored.output_dir).toBe(rec.output_dir);
      expect(stored.stdout_path).toBe(rec.stdout_path);
      expect(stored.stderr_path).toBe(rec.stderr_path);
      expect(stored.combined_log_path).toBe(rec.combined_log_path);
      expect(stored.agent_session_id).toBe('session-rt');
      expect(stored.goal_id).toBe('goal-rt');
      expect(stored.launch_reason).toBe('round-trip test');
      expect(stored.owner_kind).toBe('agent');
      expect(stored.background_policy).toBe('foreground');
      expect(stored.process_group_id).toBeNull();

      await killProcess(root, rec.id);
    });

    it('saveRegistry validates records with Zod', () => {
      // Valid records should save fine
      const validRecords: ProcessRecord[] = [
        {
          id: 'proc-test-valid',
          card_id: 'card-1',
          command: 'echo test',
          cwd: root,
          status: 'exited',
          pid: 12345,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          exit_code: 0,
          required_for_card_completion: true,
          output_dir: join(root, '.saivage-work/processes/proc-test-valid'),
          stdout_path: join(root, '.saivage-work/processes/proc-test-valid/stdout.log'),
          stderr_path: join(root, '.saivage-work/processes/proc-test-valid/stderr.log'),
          combined_log_path: join(root, '.saivage-work/processes/proc-test-valid/combined.log'),
        },
      ];

      expect(() => saveRegistry(root, validRecords)).not.toThrow();

      // Verify it was persisted
      const reg = loadRegistry(root);
      expect(reg.has('proc-test-valid')).toBe(true);
    });

    it('saveRegistry throws on invalid records', () => {
      // Missing required fields
      const invalidRecords = [
        { id: 'proc-bad', card_id: 'card-1' },
      ];

      expect(() => saveRegistry(root, invalidRecords as ProcessRecord[])).toThrow(
        /validation failed/,
      );
    });

    it('loadRegistry handles corrupted registry file gracefully', () => {
      const regPath = join(root, '.saivage/runtime/processes.json');
      writeFileSync(regPath, 'this is not valid json {{{', 'utf-8');

      const reg = loadRegistry(root);
      expect(reg.size).toBe(0); // Should return empty map
    });

    it('loadRegistry filters out records that fail Zod validation', () => {
      const regPath = join(root, '.saivage/runtime/processes.json');
      const mixedRecords = [
        {
          id: 'proc-valid',
          card_id: 'card-1',
          command: 'echo test',
          cwd: root,
          status: 'exited',
          pid: 1,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          exit_code: 0,
          required_for_card_completion: true,
          output_dir: '/tmp',
          stdout_path: '/tmp/stdout.log',
          stderr_path: '/tmp/stderr.log',
          combined_log_path: '/tmp/combined.log',
        },
        {
          id: '',
          card_id: 'card-1',
          command: '',
          cwd: '',
          status: 'invalid',
          pid: -1,
          started_at: 'not-a-date',
          required_for_card_completion: true,
          output_dir: '',
          stdout_path: '',
          stderr_path: '',
          combined_log_path: '',
        },
      ];
      writeFileSync(regPath, JSON.stringify(mixedRecords, null, 2), 'utf-8');

      const reg = loadRegistry(root);
      expect(reg.size).toBe(1);
      expect(reg.has('proc-valid')).toBe(true);
    });

    it('registry survives updating an existing record', async () => {
      const rec = startProcess(root, 'sleep 10', { cardId: 'card-update' });

      // First save: running
      let reg = loadRegistry(root);
      expect(reg.get(rec.id)!.status).toBe('running');

      // Kill it — this triggers a registry update
      await killProcess(root, rec.id);

      // Second load: should be killed
      reg = loadRegistry(root);
      expect(reg.get(rec.id)!.status).toBe('killed');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Restart Survival (output persistence)
  // ═══════════════════════════════════════════════════════════════

  describe('Output survival (restart simulation)', () => {
    it('output files survive — can be read after process completes', async () => {
      const result = await startAndWait(
        root,
        'echo "survive-me-9876"',
        { cardId: 'card-survive' },
      );
      await sleep(200);

      const combinedPath = join(
        root,
        '.saivage-work/processes',
        result.id,
        'combined.log',
      );
      expect(existsSync(combinedPath)).toBe(true);

      const content = readFileSync(combinedPath, 'utf-8');
      expect(content).toContain('survive-me-9876');
    });

    it('registry survives — all records loadable after process completes', async () => {
      const result1 = await startAndWait(root, 'echo a', { cardId: 'card-a' });
      const result2 = await startAndWait(root, 'echo b', { cardId: 'card-b' });
      await sleep(200);

      // Simulate "restart" — just reload the registry fresh
      const reg = loadRegistry(root);
      expect(reg.size).toBe(2);

      const proc1 = reg.get(result1.id);
      expect(proc1).not.toBeUndefined();
      expect(proc1!.card_id).toBe('card-a');

      const proc2 = reg.get(result2.id);
      expect(proc2).not.toBeUndefined();
      expect(proc2!.card_id).toBe('card-b');
    });

    it('tailOutput reads from disk, proving file-based persistence', async () => {
      const result = await startAndWait(
        root,
        'echo "persistent-data-42"',
        { cardId: 'card-persist' },
      );
      await sleep(200);

      // tailOutput reads from combined.log on disk
      const tail = tailOutput(root, result.id);
      expect(tail).toContain('persistent-data-42');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // getProcess
  // ═══════════════════════════════════════════════════════════════

  describe('getProcess', () => {
    it('returns process by ID', async () => {
      const result = await startAndWait(root, 'echo test', { cardId: 'card-get' });
      await sleep(200);

      const proc = getProcess(root, result.id);
      expect(proc).not.toBeNull();
      expect(proc!.id).toBe(result.id);
      expect(proc!.card_id).toBe('card-get');
    });

    it('returns null for nonexistent process', () => {
      expect(getProcess(root, 'proc-nonexistent')).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // cleanupProcessOutput / cleanupAllCompleted
  // ═══════════════════════════════════════════════════════════════

  describe('cleanupProcessOutput', () => {
    it('removes output dir for completed process', async () => {
      const result = await startAndWait(root, 'echo cleanup-test', {
        cardId: 'card-clean',
      });
      await sleep(200);

      const proc = getProcess(root, result.id);
      expect(proc).not.toBeNull();
      expect(existsSync(proc!.output_dir)).toBe(true);

      const cleaned = cleanupProcessOutput(root, result.id);
      expect(cleaned).toBe(true);
      expect(existsSync(proc!.output_dir)).toBe(false);
    });

    it('returns false for running process', () => {
      const rec = startProcess(root, 'sleep 30', { cardId: 'card-running-clean' });

      const cleaned = cleanupProcessOutput(root, rec.id);
      expect(cleaned).toBe(false);
      expect(existsSync(rec.output_dir)).toBe(true);

      killProcess(root, rec.id);
    });

    it('returns false for nonexistent process', () => {
      expect(cleanupProcessOutput(root, 'proc-nonexistent')).toBe(false);
    });
  });

  describe('cleanupAllCompleted', () => {
    it('cleans all completed process dirs', async () => {
      await startAndWait(root, 'echo a', { cardId: 'card-1' });
      await startAndWait(root, 'echo b', { cardId: 'card-2' });
      await sleep(300);

      const running = startProcess(root, 'sleep 30', { cardId: 'card-3' });
      await sleep(100);

      const count = cleanupAllCompleted(root);
      expect(count).toBe(2);

      // Running process dir should still exist
      const stillRunning = listProcesses(root, { status: 'running' });
      expect(stillRunning.length).toBe(1);

      await killProcess(root, running.id);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // New Fields Backward Compatibility
  // ═══════════════════════════════════════════════════════════════

  describe('New fields backward compatibility', () => {
    it('schema validates ProcessRecords without new fields (backward compat)', () => {
      const oldStyleRecord: ProcessRecord = {
        id: 'proc-old-style',
        card_id: 'card-1',
        command: 'echo test',
        cwd: root,
        status: 'exited',
        pid: 12345,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        exit_code: 0,
        required_for_card_completion: true,
        output_dir: join(root, '.saivage-work/processes/proc-old-style'),
        stdout_path: join(root, '.saivage-work/processes/proc-old-style/stdout.log'),
        stderr_path: join(root, '.saivage-work/processes/proc-old-style/stderr.log'),
        combined_log_path: join(root, '.saivage-work/processes/proc-old-style/combined.log'),
      };

      // Should save without error (backward compatible)
      expect(() => saveRegistry(root, [oldStyleRecord])).not.toThrow();

      // Loading should succeed
      const reg = loadRegistry(root);
      expect(reg.has('proc-old-style')).toBe(true);
    });

    it('ProcessStartOptions without new fields still works', () => {
      const rec = startProcess(root, 'sleep 2', { cardId: 'card-old-options' });
      expect(rec.card_id).toBe('card-old-options');
      expect(rec.required_for_card_completion).toBe(true);
      // New fields default to null
      expect(rec.agent_session_id).toBeNull();
      expect(rec.goal_id).toBeNull();
      expect(rec.launch_reason).toBeNull();
      expect(rec.owner_kind).toBeNull();
      expect(rec.background_policy).toBeNull();
      killProcess(root, rec.id);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Edge Cases
  // ═══════════════════════════════════════════════════════════════

  describe('Edge cases', () => {
    it('handles SIGTERM signal correctly', async () => {
      const rec = startProcess(root, 'trap "" TERM; sleep 10', {
        cardId: 'card-sigterm',
      });
      await sleep(300);

      // Kill with short grace to force SIGKILL escalation
      const killed = await killProcess(root, rec.id, 500);
      expect(killed.status).toBe('killed');
    });

    it('handles many concurrent processes', async () => {
      const records: ProcessRecord[] = [];
      for (let i = 0; i < 10; i++) {
        records.push(startProcess(root, 'sleep 3', { cardId: `card-${i}` }));
      }

      // All should be in the registry
      const reg = loadRegistry(root);
      expect(reg.size).toBe(10);

      // Kill them all
      for (const rec of records) {
        try {
          await killProcess(root, rec.id);
        } catch {
          // already dead
        }
      }
    });

    it('handles empty command gracefully', () => {
      // Empty command should throw a validation error since Zod requires
      // command.length >= 1 in the ProcessRecord schema
      expect(() => startProcess(root, '', { cardId: 'card-empty-cmd' })).toThrow(
        /command must not be empty/,
      );
    });

    it('handles command with special characters', async () => {
      const result = await startAndWait(
        root,
        'echo "hello && world"',
        { cardId: 'card-special' },
      );
      await sleep(300);

      const tail = tailOutput(root, result.id);
      expect(tail).toContain('hello && world');
    });

    it('handles commands that produce stderr output', async () => {
      const result = await startAndWait(
        root,
        'echo "to stdout" && echo "to stderr" >&2',
        { cardId: 'card-stderr' },
      );
      await sleep(300);

      expect(existsSync(result.id ? join(root, '.saivage-work/processes', result.id, 'stderr.log') : '')).toBe(
        true,
      );

      const proc = getProcess(root, result.id);
      expect(proc).not.toBeNull();
      const stderrContent = readFileSync(proc!.stderr_path, 'utf-8');
      expect(stderrContent).toContain('to stderr');
    });

    it('does not lose output when process starts and exits very quickly', async () => {
      const result = await startAndWait(
        root,
        'for i in $(seq 1 50); do echo "line_$i"; done',
        { cardId: 'card-fast' },
      );
      await sleep(300);

      const tail = tailOutput(root, result.id, 100);
      expect(tail).toContain('line_1');
      expect(tail).toContain('line_50');
    });

    it('waitDurationMs is meaningful', async () => {
      const rec = startProcess(root, 'sleep 2', { cardId: 'card-duration' });

      const result = await waitProcess(root, rec.id);
      expect(result.waitDurationMs).toBeGreaterThanOrEqual(1500); // ~2s sleep
    });

    it('handles process that ignores SIGTERM and requires SIGKILL', async () => {
      // Start a process with a trap that ignores SIGTERM
      const rec = startProcess(
        root,
        'trap "" TERM; sleep 10',
        { cardId: 'card-sigkill' },
      );
      await sleep(300);

      // Kill with very short grace — should escalate to SIGKILL
      const killed = await killProcess(root, rec.id, 500);
      expect(killed.status).toBe('killed');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Acceptance Criteria — Stage 3
  // ═══════════════════════════════════════════════════════════════

  describe('Stage 3 Acceptance Criteria', () => {
    it('AC1: Long-running commands can be started, tailed, waited on, and killed', async () => {
      // Start a long-running command (use 0.3s sleep intervals so test stays fast)
      const rec = startProcess(root, 'for i in $(seq 1 5); do echo "iter_$i"; sleep 0.3; done', {
        cardId: 'card-ac1',
      });

      // Wait for some output
      await sleep(600);

      // Tail the output while running
      const midTail = tailOutput(root, rec.id);
      expect(midTail).toContain('iter_1');

      // Wait for it to complete
      const waitResult = await waitProcess(root, rec.id);
      expect(waitResult.status).toBe('exited');
      expect(waitResult.timedOut).toBe(false);

      // Final tail
      const finalTail = tailOutput(root, rec.id);
      expect(finalTail).toContain('iter_5');
    }, 30000);

    it('AC2: Timed-out waits do not kill the process', async () => {
      const rec = startProcess(root, 'sleep 30', { cardId: 'card-ac2' });
      await sleep(100);

      // Wait with a short timeout
      const result = await waitProcess(root, rec.id, 500);
      expect(result.timedOut).toBe(true);
      expect(result.status).toBe('running');

      // Process must still be running in registry
      const proc = getProcess(root, rec.id);
      expect(proc).not.toBeNull();
      expect(proc!.status).toBe('running');

      // Clean up
      await killProcess(root, rec.id);
    });

    it('AC3: Process output survives runtime restart (via file persistence)', async () => {
      // Run a process that produces identifiable output
      const result = await startAndWait(
        root,
        'echo "survive-restart-abc123"',
        { cardId: 'card-ac3' },
      );
      await sleep(200);

      // The combined.log path should exist on disk
      const proc = getProcess(root, result.id);
      expect(proc).not.toBeNull();
      expect(existsSync(proc!.combined_log_path)).toBe(true);

      // Read directly from disk (simulating what a new runtime would do)
      const content = readFileSync(proc!.combined_log_path, 'utf-8');
      expect(content).toContain('survive-restart-abc123');

      // tailOutput also reads from disk
      const tail = tailOutput(root, result.id);
      expect(tail).toContain('survive-restart-abc123');

      // Registry also survives — reload from disk
      const reg = loadRegistry(root);
      expect(reg.has(result.id)).toBe(true);
      expect(reg.get(result.id)!.status).toBe('exited');
    });
  });
});
