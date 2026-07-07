import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initProjectTree } from '../../src/persistence/file-tree.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import type { ProcessRecord } from '../../src/schemas/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ProcessRunner', () => {
  let root: string;
  let runner: ProcessRunner;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'proc-runner-'));
    initProjectTree(root);
    runner = new ProcessRunner(root);
  });

  afterEach(async () => {
    await runner.stopRuntimeOwned('test cleanup', { graceMs: 100 });
    rmSync(root, { recursive: true, force: true });
  });

  function spawn(command: string, cardId = 'card-1') {
    return runner.spawn({ command, cardId, ownerId: `owner:${cardId}`, ownerKind: 'agent' });
  }

  it('spawns a process and records durable output paths', async () => {
    const rec = spawn('echo "hello stdout"; echo "hello stderr" >&2', 'card-out');
    expect(rec.status).toBe('running');

    const result = await runner.wait(rec.id, 1000);
    await sleep(100);

    expect(result.status).toBe('exited');
    expect(existsSync(rec.stdout_path)).toBe(true);
    expect(existsSync(rec.stderr_path)).toBe(true);
    expect(existsSync(join(rec.output_dir, 'combined.log'))).toBe(false);
    expect(readFileSync(rec.stderr_path, 'utf-8')).toContain('hello stderr');
  });

  it('generates unique process IDs', async () => {
    const rec1 = spawn('echo one');
    const rec2 = spawn('echo two');
    expect(rec1.id).not.toBe(rec2.id);
    await runner.wait(rec1.id, 1000);
    await runner.wait(rec2.id, 1000);
  });

  it('marks process as failed when command exits with non-zero', async () => {
    const rec = spawn('exit 42', 'card-fail');
    await runner.wait(rec.id, 1000);

    const reloaded = runner.get(rec.id);
    expect(reloaded).toMatchObject({ status: 'failed', exit_code: 42 });
  });

  it('persists and reloads ProcessRecord registry under .saivage/runtime/processes.json', async () => {
    const rec = spawn('echo registry', 'card-reg');
    await runner.wait(rec.id, 1000);

    expect(existsSync(join(root, '.saivage', 'runtime', 'processes.json'))).toBe(true);
    expect(new ProcessRunner(root).get(rec.id)).toMatchObject({ id: rec.id, status: 'exited' });
  });

  it('honors spawn spec ownership and lifecycle metadata', async () => {
    const rec = runner.spawn({
      command: 'echo options',
      cardId: 'card-own',
      ownerId: 'session-test-123',
      requiredForCardCompletion: false,
      agentSessionId: 'session-test-123',
      goalId: 'goal-test-456',
      launchReason: 'test executor tool call',
      ownerKind: 'agent',
      backgroundPolicy: 'foreground',
    });

    expect(rec.required_for_card_completion).toBe(false);
    expect(rec.owner_id).toBe('session-test-123');
    expect(rec.agent_session_id).toBe('session-test-123');
    expect(rec.owner_kind).toBe('agent');
    await runner.wait(rec.id, 1000);
  });

  it('times out without killing the process and can later observe normal completion', async () => {
    const rec = spawn('sleep 0.2 && echo done', 'card-timeout');
    const timed = await runner.wait(rec.id, 10);
    expect(timed).toMatchObject({ timedOut: true, status: 'running' });

    const finished = await runner.wait(rec.id, 1000);
    expect(finished.status).toBe('exited');
    expect(readFileSync(runner.get(rec.id)!.stdout_path, 'utf-8')).toContain('done');
  });

  it('lists process records and filters by status/card id', async () => {
    const rec1 = spawn('echo a', 'card-a');
    const rec2 = spawn('echo b', 'card-b');
    await runner.wait(rec1.id, 1000);
    await runner.wait(rec2.id, 1000);

    expect(runner.list()).toHaveLength(2);
    expect(runner.list({ cardId: 'card-a' })).toHaveLength(1);
    expect(runner.list({ status: 'exited' }).length).toBeGreaterThanOrEqual(2);
  });

  it('kills running processes', async () => {
    const rec = spawn('sleep 5', 'card-kill');
    const killed = await runner.kill(rec.id, 'test kill', { graceMs: 100 });
    expect(killed?.status).toBe('killed');
    expect(runner.get(rec.id)).toMatchObject({ status: 'killed' });
  });

  it('reconciles stale running records as lost', async () => {
    const rec: ProcessRecord = {
      id: 'proc-reconcile',
      card_id: 'card-reconcile',
      owner_id: 'owner:card-reconcile',
      owner_kind: 'agent',
      command: 'sleep 5',
      command_hash: 'a'.repeat(64),
      cwd: root,
      cwd_canonical: root,
      status: 'running',
      pid: 999999,
      started_at: new Date().toISOString(),
      started_at_monotonic: 10,
      completed_at: null,
      exit_code: null,
      signal: null,
      terminal_reason: null,
      required_for_card_completion: true,
      output_dir: join(root, '.saivage-work/processes/proc-reconcile'),
      stdout_path: join(root, '.saivage-work/processes/proc-reconcile/stdout.log'),
      stderr_path: join(root, '.saivage-work/processes/proc-reconcile/stderr.log'),
      agent_session_id: null,
      goal_id: null,
      launch_reason: null,
      background_policy: null,
      process_group_id: null,
      failure_classification: null,
    };
    runner.setTransientRegistry(new Map([[rec.id, rec]]));

    const result = await runner.reconcile({ nowMonotonicMs: rec.started_at_monotonic + 1 });

    expect(result.lost).toEqual([rec.id]);
    expect(runner.get(rec.id)).toMatchObject({ status: 'failed', failure_classification: 'lost' });
  });

  it('fails fast when waiting on an unattached running record', async () => {
    const rec = spawn('sleep 5', 'card-unattached');
    const detached = new ProcessRunner(root);

    await expect(detached.wait(rec.id, 10)).rejects.toThrow(`Cannot wait for unattached running process ${rec.id}`);
  });
});
