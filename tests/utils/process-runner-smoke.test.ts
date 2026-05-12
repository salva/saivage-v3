/**
 * Quick smoke test for process-runner.ts
 *
 * This runs as a jest test to verify the process-runner module works.
 * It covers: startProcess, waitProcess, startAndWait, tailOutput,
 * killProcess, listProcesses, loadRegistry, getProcess.
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
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

// ── Helpers ───────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Process Runner Smoke Tests', () => {
  let root: string;

  afterEach(() => {
    if (root) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  function setup(): string {
    root = mkdtempSync(join(tmpdir(), 'proc-runner-'));
    initProjectTree(root);
    return root;
  }

  it('startAndWait: runs a quick command and returns success', async () => {
    const r = setup();
    const result = await startAndWait(r, 'echo "hello world"', { cardId: 'test-card' });
    expect(result.status).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('tailOutput: returns last N lines of process output', async () => {
    const r = setup();
    const result = await startAndWait(r, 'echo line1 && echo line2 && echo line3', {
      cardId: 'test-card',
    });
    // Give streams a moment to flush
    await sleep(200);

    const proc = getProcess(r, result.id);
    expect(proc).not.toBeNull();
    const combinedPath = proc!.combined_log_path;
    expect(existsSync(combinedPath)).toBe(true);

    const content = readFileSync(combinedPath, 'utf-8');
    expect(content).toContain('line1');
    expect(content).toContain('line2');
    expect(content).toContain('line3');

    const tail = tailOutput(r, result.id, 2);
    expect(tail).toContain('line2');
    expect(tail).toContain('line3');
  });

  it('tailOutput: returns empty string for nonexistent process', () => {
    const r = setup();
    const result = tailOutput(r, 'nonexistent', 10);
    expect(result).toBe('');
  });

  it('listProcesses: returns all processes', async () => {
    const r = setup();
    await startAndWait(r, 'echo test1', { cardId: 'card-a' });
    await startAndWait(r, 'echo test2', { cardId: 'card-b' });
    await sleep(200);
    const all = listProcesses(r);
    expect(all.length).toBe(2);
  });

  it('listProcesses: filters by cardId', async () => {
    const r = setup();
    await startAndWait(r, 'echo test-a', { cardId: 'card-a' });
    await startAndWait(r, 'echo test-b', { cardId: 'card-b' });
    await sleep(200);
    const filtered = listProcesses(r, { cardId: 'card-a' });
    expect(filtered.length).toBe(1);
    expect(filtered[0].card_id).toBe('card-a');
  });

  it('listProcesses: filters by status', async () => {
    const r = setup();
    await startAndWait(r, 'echo ok', { cardId: 'card-a' });
    await sleep(200);
    // Start a long-running process
    startProcess(r, 'sleep 60', { cardId: 'card-b' });

    const exited = listProcesses(r, { status: 'exited' });
    const running = listProcesses(r, { status: 'running' });

    expect(exited.length).toBeGreaterThanOrEqual(1);
    expect(running.length).toBeGreaterThanOrEqual(1);

    // Kill the long running process
    const runningList = listProcesses(r, { status: 'running' });
    for (const proc of runningList) {
      await killProcess(r, proc.id);
    }
  });

  it('killProcess: kills a running process', async () => {
    const r = setup();
    const proc = startProcess(r, 'sleep 30', { cardId: 'test-card' });
    expect(proc.status).toBe('running');

    // Wait a tiny bit for the process to actually start
    await sleep(100);

    const killed = await killProcess(r, proc.id);
    expect(killed.status).toBe('killed');
  });

  it('waitProcess: timeout does NOT kill the process', async () => {
    const r = setup();
    const proc = startProcess(r, 'sleep 30', { cardId: 'test-card' });
    await sleep(100);

    const result = await waitProcess(r, proc.id, 1000);
    expect(result.timedOut).toBe(true);
    expect(result.status).toBe('running');

    // The process should still be running
    const list = listProcesses(r, { status: 'running' });
    expect(list.some((p) => p.id === proc.id)).toBe(true);

    // Clean up
    await killProcess(r, proc.id);
  });

  it('loadRegistry: loads persisted registry', async () => {
    const r = setup();
    await startAndWait(r, 'echo test', { cardId: 'card-1' });
    await sleep(200);
    const reg = loadRegistry(r);
    expect(reg.size).toBe(1);
  });

  it('saveRegistry: saves and validates records', () => {
    const r = setup();
    const records = Array.from(loadRegistry(r).values());
    expect(() => saveRegistry(r, records)).not.toThrow();
  });

  it('getProcess: returns process by ID', async () => {
    const r = setup();
    const result = await startAndWait(r, 'echo test', { cardId: 'card-1' });
    await sleep(200);
    const proc = getProcess(r, result.id);
    expect(proc).not.toBeNull();
    expect(proc!.id).toBe(result.id);
    expect(proc!.card_id).toBe('card-1');
  });

  it('getProcess: returns null for nonexistent process', () => {
    const r = setup();
    expect(getProcess(r, 'nonexistent')).toBeNull();
  });

  it('cleanupProcessOutput: removes output dir for completed process', async () => {
    const r = setup();
    const result = await startAndWait(r, 'echo cleanup-test', { cardId: 'card-1' });
    await sleep(200);
    const proc = getProcess(r, result.id);
    expect(proc).not.toBeNull();
    expect(proc!.output_dir).toBeDefined();
    expect(existsSync(proc!.output_dir)).toBe(true);

    const cleaned = cleanupProcessOutput(r, result.id);
    expect(cleaned).toBe(true);
    expect(existsSync(proc!.output_dir)).toBe(false);
  });

  it('cleanupAllCompleted: cleans up all completed processes', async () => {
    const r = setup();
    await startAndWait(r, 'echo a', { cardId: 'card-1' });
    await startAndWait(r, 'echo b', { cardId: 'card-2' });
    await sleep(200);
    // Start a running one too
    const running = startProcess(r, 'sleep 60', { cardId: 'card-3' });
    await sleep(100);

    const count = cleanupAllCompleted(r);
    expect(count).toBe(2);

    // Running process should still exist
    const stillRunning = listProcesses(r, { status: 'running' });
    expect(stillRunning.length).toBe(1);

    // Clean up running
    await killProcess(r, running.id);
  });

  it('startAndWait: with command that fails', async () => {
    const r = setup();
    const result = await startAndWait(r, 'exit 1', { cardId: 'card-fail' });
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
  });

  it('output survives via file persistence on tailOutput', async () => {
    const r = setup();
    const result = await startAndWait(r, 'echo persistent-data', { cardId: 'card-1' });
    await sleep(200);

    // tailOutput reads from file, proving file-based persistence
    const tail = tailOutput(r, result.id);
    expect(tail).toContain('persistent-data');
  });

  it('startProcess includes new ownership fields when provided', async () => {
    const r = setup();
    const rec = startProcess(r, 'echo ownership-test', {
      cardId: 'card-own-smoke',
      agentSessionId: 'session-smoke',
      goalId: 'goal-smoke',
      launchReason: 'smoke test',
      ownerKind: 'runtime',
      backgroundPolicy: 'detach',
    });
    await waitProcess(r, rec.id);
    await sleep(200);

    const proc = getProcess(r, rec.id);
    expect(proc).not.toBeNull();
    expect(proc!.agent_session_id).toBe('session-smoke');
    expect(proc!.goal_id).toBe('goal-smoke');
    expect(proc!.launch_reason).toBe('smoke test');
    expect(proc!.owner_kind).toBe('runtime');
    expect(proc!.background_policy).toBe('detach');
    expect(proc!.process_group_id).toBeNull();
  });
});
