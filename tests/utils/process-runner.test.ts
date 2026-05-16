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
  killAllRunning,
  isProcessLiveAttached,
} from '../../src/utils/process-runner.js';
import type { ProcessRecord } from '../../src/schemas/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Process Runner', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'proc-runner-'));
    initProjectTree(root);
  });

  afterEach(async () => {
    try {
      await killAllRunning(root);
      rmSync(root, { recursive: true, force: true });
    } catch {
    }
  });

  it('reports live attachment true only for a started running process', async () => {
    const rec = startProcess(root, 'sleep 30', { cardId: 'card-live-attached' });
    expect(isProcessLiveAttached(rec.id)).toBe(true);
    await killProcess(root, rec.id);
  });

  it('reports live attachment false after process exit or kill', async () => {
    const exited = startProcess(root, 'echo done', { cardId: 'card-exit' });
    await waitProcess(root, exited.id);
    await sleep(300);
    expect(isProcessLiveAttached(exited.id)).toBe(false);

    const killed = startProcess(root, 'sleep 30', { cardId: 'card-kill' });
    expect(isProcessLiveAttached(killed.id)).toBe(true);
    await killProcess(root, killed.id);
    await sleep(100);
    expect(isProcessLiveAttached(killed.id)).toBe(false);
  });

  it('reports live attachment false for a manually persisted stale-running record', () => {
    const stale: ProcessRecord = {
      id: 'proc-stale-running',
      card_id: 'card-stale',
      command: 'sleep 99',
      cwd: root,
      status: 'running',
      pid: 99999,
      started_at: new Date().toISOString(),
      completed_at: null,
      exit_code: null,
      required_for_card_completion: true,
      output_dir: join(root, '.saivage-work/processes/proc-stale-running'),
      stdout_path: join(root, '.saivage-work/processes/proc-stale-running/stdout.log'),
      stderr_path: join(root, '.saivage-work/processes/proc-stale-running/stderr.log'),
      combined_log_path: join(root, '.saivage-work/processes/proc-stale-running/combined.log'),
    };
    saveRegistry(root, [stale]);
    expect(isProcessLiveAttached(stale.id)).toBe(false);
  });

  it('spawns a process and returns a valid ProcessRecord', async () => {
    const rec = startProcess(root, 'sleep 5', { cardId: 'card-test' });
    expect(rec.status).toBe('running');
    await killProcess(root, rec.id);
  });

  it('creates output files on disk for stdout/stderr/combined', async () => {
    const rec = startProcess(root, 'echo "hello stdout"; echo "hello stderr" >&2', {
      cardId: 'card-out',
    });
    await waitProcess(root, rec.id);
    await sleep(500);
    expect(existsSync(rec.stdout_path)).toBe(true);
    expect(existsSync(rec.stderr_path)).toBe(true);
    expect(existsSync(rec.combined_log_path)).toBe(true);
    const combined = readFileSync(rec.combined_log_path, 'utf-8');
    expect(combined).toContain('hello stdout');
    expect(combined).toContain('hello stderr');
  });

  it('generates unique process IDs', async () => {
    const rec1 = startProcess(root, 'sleep 5', { cardId: 'card-1' });
    const rec2 = startProcess(root, 'sleep 5', { cardId: 'card-1' });
    expect(rec1.id).not.toBe(rec2.id);
    await killProcess(root, rec1.id);
    await killProcess(root, rec2.id);
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

  it('persists to the registry immediately on start', async () => {
    const rec = startProcess(root, 'sleep 10', { cardId: 'card-reg' });
    const registry = loadRegistry(root);
    expect(registry.has(rec.id)).toBe(true);
    await killProcess(root, rec.id);
  });

  it('respects required_for_card_completion option', async () => {
    const rec1 = startProcess(root, 'sleep 3', { cardId: 'card-opt', requiredForCardCompletion: false });
    const rec2 = startProcess(root, 'sleep 3', { cardId: 'card-opt', requiredForCardCompletion: true });
    const rec3 = startProcess(root, 'sleep 3', { cardId: 'card-opt' });
    expect(rec1.required_for_card_completion).toBe(false);
    expect(rec2.required_for_card_completion).toBe(true);
    expect(rec3.required_for_card_completion).toBe(true);
    await killProcess(root, rec1.id);
    await killProcess(root, rec2.id);
    await killProcess(root, rec3.id);
  });

  it('includes new ownership fields from ProcessStartOptions', async () => {
    const rec = startProcess(root, 'sleep 3', {
      cardId: 'card-own',
      agentSessionId: 'session-test-123',
      goalId: 'goal-test-456',
      launchReason: 'test executor tool call',
      ownerKind: 'agent',
      backgroundPolicy: 'foreground',
    });
    expect(rec.agent_session_id).toBe('session-test-123');
    await killProcess(root, rec.id);
  });

  it('sets new fields to null when not provided', async () => {
    const rec = startProcess(root, 'sleep 3', { cardId: 'card-null' });
    expect(rec.agent_session_id).toBeNull();
    await killProcess(root, rec.id);
  });

  it('waits for a process to complete and returns exited status', async () => {
    const rec = startProcess(root, 'echo done', { cardId: 'card-wait' });
    const result = await waitProcess(root, rec.id);
    expect(result.status).toBe('exited');
  });

  it('times out without killing the process', async () => {
    const rec = startProcess(root, 'sleep 30', { cardId: 'card-timeout' });
    const result = await waitProcess(root, rec.id, 500);
    expect(result.timedOut).toBe(true);
    expect(result.status).toBe('running');
    await killProcess(root, rec.id);
  });

  it('starts and waits for a quick command', async () => {
    const result = await startAndWait(root, 'echo "hello world"', { cardId: 'card-saw' });
    expect(result.status).toBe('exited');
  });

  it('returns last N lines of process output', async () => {
    const cmd = Array.from({ length: 20 }, (_, i) => `echo "line_${i}"`).join(' && ');
    const result = await startAndWait(root, cmd, { cardId: 'card-tail' });
    await sleep(300);
    const tail = tailOutput(root, result.id, 5);
    expect(tail).toContain('line_19');
  });

  it('kills a running process via SIGTERM', async () => {
    const rec = startProcess(root, 'sleep 30', { cardId: 'card-kill' });
    await sleep(100);
    const killed = await killProcess(root, rec.id);
    expect(killed.status).toBe('killed');
  });

  it('returns all processes', async () => {
    const rec1 = startProcess(root, 'echo a', { cardId: 'card-a' });
    const rec2 = startProcess(root, 'echo b', { cardId: 'card-b' });
    await waitProcess(root, rec1.id);
    await waitProcess(root, rec2.id);
    await sleep(200);
    const all = listProcesses(root);
    expect(all.length).toBe(2);
  });

  it('saves and loads the registry correctly', async () => {
    const result = await startAndWait(root, 'echo test', { cardId: 'card-reg' });
    await sleep(200);
    const reg = loadRegistry(root);
    expect(reg.has(result.id)).toBe(true);
  });

  it('saveRegistry validates records with Zod', () => {
    const validRecords: ProcessRecord[] = [{
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
    }];
    expect(() => saveRegistry(root, validRecords)).not.toThrow();
  });

  it('loadRegistry handles corrupted registry file gracefully', () => {
    const regPath = join(root, '.saivage/runtime/processes.json');
    writeFileSync(regPath, 'this is not valid json {{{', 'utf-8');
    const reg = loadRegistry(root);
    expect(reg.size).toBe(0);
  });

  it('removes output dir for completed process', async () => {
    const result = await startAndWait(root, 'echo cleanup-test', { cardId: 'card-clean' });
    await sleep(200);
    const proc = getProcess(root, result.id);
    expect(proc).not.toBeNull();
    const cleaned = cleanupProcessOutput(root, result.id);
    expect(cleaned).toBe(true);
  });

  it('cleans all completed process dirs', async () => {
    await startAndWait(root, 'echo a', { cardId: 'card-1' });
    await startAndWait(root, 'echo b', { cardId: 'card-2' });
    await sleep(300);
    const running = startProcess(root, 'sleep 30', { cardId: 'card-3' });
    await sleep(100);
    const count = cleanupAllCompleted(root);
    expect(count).toBe(2);
    await killProcess(root, running.id);
  });
}
);
