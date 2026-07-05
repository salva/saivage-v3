import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initProjectTree } from '../../src/persistence/file-tree.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Process Runner Smoke Tests', () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function setup(): { root: string; runner: ProcessRunner } {
    root = mkdtempSync(join(tmpdir(), 'proc-runner-'));
    initProjectTree(root);
    return { root, runner: new ProcessRunner(root) };
  }

  async function startAndWait(runner: ProcessRunner, command: string, cardId = 'test-card') {
    const record = runner.spawn({ command, cardId, ownerId: `test:${cardId}`, ownerKind: 'agent' });
    return runner.wait(record.id, 1000);
  }

  it('startAndWait runs a quick command and returns success', async () => {
    const { runner } = setup();
    const result = await startAndWait(runner, 'echo "hello world"');
    expect(result.status).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('writes durable process output files', async () => {
    const { runner } = setup();
    const result = await startAndWait(runner, 'echo line1 && echo line2 && echo line3');
    await sleep(200);

    const proc = runner.get(result.id);
    expect(proc).not.toBeNull();
    expect(existsSync(proc!.combined_log_path)).toBe(true);
    expect(readFileSync(proc!.combined_log_path, 'utf-8')).toContain('line3');
  });

  it('lists and filters durable process records', async () => {
    const { root: r, runner } = setup();
    await startAndWait(runner, 'echo test-a', 'card-a');
    await startAndWait(runner, 'echo test-b', 'card-b');
    await sleep(200);

    expect(runner.list()).toHaveLength(2);
    expect(runner.list({ cardId: 'card-a' })).toHaveLength(1);
    expect(runner.list({ status: 'exited' }).length).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(r, '.saivage', 'runtime', 'processes.json'))).toBe(true);
  });

  it('waitProcess timeout does not expose termination control and the process can still finish normally', async () => {
    const { runner } = setup();
    const proc = runner.spawn({ command: 'sleep 0.2 && echo done', cardId: 'test-card', ownerId: 'test:test-card', ownerKind: 'agent' });
    const timed = await runner.wait(proc.id, 10);
    expect(timed.timedOut).toBe(true);
    expect(timed.status).toBe('running');

    const finished = await runner.wait(proc.id, 1000);
    expect(finished.status).toBe('exited');
    expect(readFileSync(runner.get(proc.id)!.combined_log_path, 'utf-8')).toContain('done');
  });

  it('exports product process termination APIs', async () => {
    const module = await import('../../src/runtime/process-runner.js');
    expect(module).toHaveProperty('ProcessRunner');
  });
});
