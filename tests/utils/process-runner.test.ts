import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initProjectTree } from '../../src/utils/file-tree.js';
import { createRuntimeLifecycleHarness, type RuntimeLifecycleHarness } from './runtime-lifecycle-harness.js';
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
  isProcessLiveAttached,
  snapshotProcessRuntimeScope,
  disposeProcessRuntimeScope,
} from '../../src/runtime/process-runner.js';
import type { ProcessRecord } from '../../src/schemas/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Process Runner', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'proc-runner-'));
    initProjectTree(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports live attachment true only for a started running process', async () => {
    const rec = startProcess(root, 'sleep 0.2', { cardId: 'card-live-attached' });
    expect(isProcessLiveAttached(rec.id)).toBe(true);
    await waitProcess(root, rec.id, 1000);
    expect(isProcessLiveAttached(rec.id)).toBe(false);
  });

  it('spawns a process and returns a valid transient ProcessRecord with output files', async () => {
    const rec = startProcess(root, 'echo "hello stdout"; echo "hello stderr" >&2', { cardId: 'card-out' });
    expect(rec.status).toBe('running');
    await waitProcess(root, rec.id);
    await sleep(300);
    expect(existsSync(rec.stdout_path)).toBe(true);
    expect(existsSync(rec.stderr_path)).toBe(true);
    expect(existsSync(rec.combined_log_path)).toBe(true);
    expect(readFileSync(rec.combined_log_path, 'utf-8')).toContain('hello stderr');
  });

  it('generates unique process IDs', async () => {
    const rec1 = startProcess(root, 'echo one', { cardId: 'card-1' });
    const rec2 = startProcess(root, 'echo two', { cardId: 'card-1' });
    expect(rec1.id).not.toBe(rec2.id);
    await waitProcess(root, rec1.id);
    await waitProcess(root, rec2.id);
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

  it('persists ProcessRecord registry under .saivage/runtime/processes.json', async () => {
    const rec = startProcess(root, 'echo registry', { cardId: 'card-reg' });
    expect(loadRegistry(root).has(rec.id)).toBe(true);
    await waitProcess(root, rec.id);
    expect(existsSync(join(root, '.saivage', 'runtime', 'processes.json'))).toBe(true);
  });

  it('respects ProcessStartOptions fields for synchronous command logs', async () => {
    const rec = startProcess(root, 'echo options', {
      cardId: 'card-own',
      requiredForCardCompletion: false,
      agentSessionId: 'session-test-123',
      goalId: 'goal-test-456',
      launchReason: 'test executor tool call',
      ownerKind: 'agent',
      backgroundPolicy: 'foreground',
    });
    expect(rec.required_for_card_completion).toBe(false);
    expect(rec.agent_session_id).toBe('session-test-123');
    await waitProcess(root, rec.id);
  });

  it('waits for a process to complete and returns exited status', async () => {
    const rec = startProcess(root, 'echo done', { cardId: 'card-wait' });
    const result = await waitProcess(root, rec.id);
    expect(result.status).toBe('exited');
  });

  it('times out without killing the process and can later observe normal completion', async () => {
    const rec = startProcess(root, 'sleep 0.2 && echo done', { cardId: 'card-timeout' });
    const result = await waitProcess(root, rec.id, 10);
    expect(result.timedOut).toBe(true);
    expect(result.status).toBe('running');
    const finished = await waitProcess(root, rec.id, 1000);
    expect(finished.status).toBe('exited');
  });

  it('clears wait timeout listeners and timers after timeout resolution', async () => {
    const rec = startProcess(root, 'sleep 0.2', { cardId: 'card-wait-cleanup' });
    const result = await waitProcess(root, rec.id, 5);
    expect(result.timedOut).toBe(true);
    expect(snapshotProcessRuntimeScope(root).resources.some((resource) => resource.label === `wait-timeout:${rec.id}`)).toBe(false);
    await waitProcess(root, rec.id, 1000);
  });

  it('reports deterministic detached/closed cleanup for a running process scope', async () => {
    const harness: RuntimeLifecycleHarness = createRuntimeLifecycleHarness('proc-runner-scope-');
    try {
      const rec = startProcess(harness.root, 'sleep 5', { cardId: 'card-scope-cleanup' });
      expect(isProcessLiveAttached(rec.id)).toBe(true);
      expect(harness.snapshot().resources.map((resource: { kind: string }) => resource.kind)).toEqual(expect.arrayContaining(['child_process', 'stream']));
      const report = await harness.dispose();
      expect(report).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'child_process', status: expect.stringMatching(/detached|killed/) }),
        expect.objectContaining({ kind: 'stream', status: expect.stringMatching(/closed|noop/) }),
      ]));
      expect(isProcessLiveAttached(rec.id)).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  it('starts and waits for a quick command', async () => {
    const result = await startAndWait(root, 'echo "hello world"', { cardId: 'card-saw' });
    expect(result.status).toBe('exited');
  });

  it('returns last N lines of process output', async () => {
    const cmd = Array.from({ length: 20 }, (_, i) => `echo "line_${i}"`).join(' && ');
    const result = await startAndWait(root, cmd, { cardId: 'card-tail' });
    await sleep(300);
    expect(tailOutput(root, result.id, 5)).toContain('line_19');
  });

  it('returns all processes and filters by status/cardId from transient state', async () => {
    const rec1 = startProcess(root, 'echo a', { cardId: 'card-a' });
    const rec2 = startProcess(root, 'echo b', { cardId: 'card-b' });
    await waitProcess(root, rec1.id);
    await waitProcess(root, rec2.id);
    await sleep(200);
    expect(listProcesses(root)).toHaveLength(2);
    expect(listProcesses(root, { cardId: 'card-a' })).toHaveLength(1);
    expect(listProcesses(root, { status: 'exited' }).length).toBeGreaterThanOrEqual(2);
  });

  it('saveRegistry persists durable registry files', () => {
    const validRecords: ProcessRecord[] = [{
      id: 'proc-test-valid',
      card_id: 'card-1',
      command: 'echo test',
      command_hash: 'a'.repeat(64),
      cwd: root,
      cwd_canonical: root,
      status: 'exited',
      pid: 12345,
      started_at: new Date().toISOString(),
      started_at_monotonic: 1,
      completed_at: new Date().toISOString(),
      exit_code: 0,
      required_for_card_completion: true,
      output_dir: join(root, '.saivage-work/processes/proc-test-valid'),
      stdout_path: join(root, '.saivage-work/processes/proc-test-valid/stdout.log'),
      stderr_path: join(root, '.saivage-work/processes/proc-test-valid/stderr.log'),
      combined_log_path: join(root, '.saivage-work/processes/proc-test-valid/combined.log'),
    }];
    saveRegistry(root, validRecords);
    expect(loadRegistry(root).has('proc-test-valid')).toBe(true);
    expect(readFileSync(join(root, '.saivage', 'runtime', 'processes.json'), 'utf-8')).toContain('proc-test-valid');
  });

  it('cleans completed process dirs', async () => {
    const result = await startAndWait(root, 'echo cleanup-test', { cardId: 'card-clean' });
    await sleep(200);
    const proc = getProcess(root, result.id);
    expect(proc).not.toBeNull();
    expect(cleanupProcessOutput(root, result.id)).toBe(true);

    await startAndWait(root, 'echo a', { cardId: 'card-1' });
    await startAndWait(root, 'echo b', { cardId: 'card-2' });
    await sleep(300);
    expect(cleanupAllCompleted(root)).toBe(3);
  });
});
