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
  listProcesses,
  loadRegistry,
  getProcess,
  saveRegistry,
  cleanupProcessOutput,
  cleanupAllCompleted,
} from '../../src/utils/process-runner.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Process Runner Smoke Tests', () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function setup(): string {
    root = mkdtempSync(join(tmpdir(), 'proc-runner-'));
    initProjectTree(root);
    return root;
  }

  it('startAndWait runs a quick command and returns success', async () => {
    const r = setup();
    const result = await startAndWait(r, 'echo "hello world"', { cardId: 'test-card' });
    expect(result.status).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('tailOutput returns last N lines of process output', async () => {
    const r = setup();
    const result = await startAndWait(r, 'echo line1 && echo line2 && echo line3', { cardId: 'test-card' });
    await sleep(200);

    const proc = getProcess(r, result.id);
    expect(proc).not.toBeNull();
    expect(existsSync(proc!.combined_log_path)).toBe(true);
    expect(readFileSync(proc!.combined_log_path, 'utf-8')).toContain('line3');
    expect(tailOutput(r, result.id, 2)).toContain('line2');
  });

  it('lists and filters transient process records in the current runtime only', async () => {
    const r = setup();
    await startAndWait(r, 'echo test-a', { cardId: 'card-a' });
    await startAndWait(r, 'echo test-b', { cardId: 'card-b' });
    await sleep(200);

    expect(listProcesses(r)).toHaveLength(2);
    expect(listProcesses(r, { cardId: 'card-a' })).toHaveLength(1);
    expect(listProcesses(r, { status: 'exited' }).length).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(r, '.saivage', 'runtime', 'processes.json'))).toBe(false);
  });

  it('waitProcess timeout does not expose termination control and the process can still finish normally', async () => {
    const r = setup();
    const proc = startProcess(r, 'sleep 0.2 && echo done', { cardId: 'test-card' });
    const timed = await waitProcess(r, proc.id, 10);
    expect(timed.timedOut).toBe(true);
    expect(timed.status).toBe('running');

    const finished = await waitProcess(r, proc.id, 1000);
    expect(finished.status).toBe('exited');
    expect(tailOutput(r, proc.id)).toContain('done');
  });

  it('loadRegistry/saveRegistry are transient helpers and do not write .saivage/runtime/processes.json', async () => {
    const r = setup();
    const result = await startAndWait(r, 'echo test', { cardId: 'card-1' });
    await sleep(200);
    expect(loadRegistry(r).has(result.id)).toBe(true);
    saveRegistry(r, Array.from(loadRegistry(r).values()));
    expect(existsSync(join(r, '.saivage', 'runtime', 'processes.json'))).toBe(false);
  });

  it('cleanup helpers remove completed process output without durable registry persistence', async () => {
    const r = setup();
    const result = await startAndWait(r, 'echo cleanup-test', { cardId: 'card-1' });
    await sleep(200);
    const proc = getProcess(r, result.id);
    expect(proc).not.toBeNull();
    expect(cleanupProcessOutput(r, result.id)).toBe(true);
    expect(existsSync(proc!.output_dir)).toBe(false);

    await startAndWait(r, 'echo a', { cardId: 'card-2' });
    await startAndWait(r, 'echo b', { cardId: 'card-3' });
    await sleep(200);
    expect(cleanupAllCompleted(r)).toBe(3);
  });

  it('does not export product process termination APIs', async () => {
    const module = await import('../../src/utils/process-runner.js');
    expect(module).not.toHaveProperty('killProcess');
    expect(module).not.toHaveProperty('killAllRunning');
  });
});
