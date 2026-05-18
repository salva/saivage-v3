import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initProjectTree } from '../../src/utils/file-tree.js';
import {
  startProcess,
  waitProcess,
  killProcess,
  saveRegistry,
  loadRegistry,
  reconcileProcessRecords,
  registerProcessTerminalSink,
  setProcessTerminalBuffering,
} from '../../src/utils/process-runner.js';
import type { ProcessRecord } from '../../src/schemas/types.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function durableFile(root: string): string {
  return join(root, '.saivage', 'runtime', 'processes.json');
}

describe('durable async process handling', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'proc-durable-'));
    initProjectTree(root);
  });

  afterEach(() => {
    setProcessTerminalBuffering(root, false);
    rmSync(root, { recursive: true, force: true });
  });

  it('persists ProcessRecord shape with salted command_hash and no command token in the hash', async () => {
    const secretToken = 'sk-live-secret-123';
    const rec = startProcess(root, `echo ${secretToken}`, { cardId: 'card-secret', goalId: 'goal-secret' });
    await waitProcess(root, rec.id, 1000);
    const raw = readFileSync(durableFile(root), 'utf-8');
    const parsed = JSON.parse(raw) as { records: ProcessRecord[] };
    const persisted = parsed.records.find((record) => record.id === rec.id)!;
    expect(persisted.command_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted.command_hash).not.toContain(secretToken);
    expect(persisted.command).not.toContain(secretToken);
    expect(persisted.command).toContain('sk-[REDACTED]');
    expect(persisted.cwd_canonical).toBe(root);
    expect(typeof persisted.started_at_monotonic).toBe('number');
    expect(persisted.terminal_reason).toBe('exit');
    expect(persisted.exit_code).toBe(0);
    expect(raw).not.toContain('salt');
  });

  it('uses a non-persisted per-runtime salt for command_hash', () => {
    const command = 'echo deterministic-command';
    const rec1 = startProcess(root, command, { cardId: 'card-1' });
    const otherRoot = mkdtempSync(join(tmpdir(), 'proc-durable-'));
    try {
      initProjectTree(otherRoot);
      const rec2 = startProcess(otherRoot, command, { cardId: 'card-1' });
      expect(rec1.command_hash).not.toBe(rec2.command_hash);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  function runningRecord(overrides: Partial<ProcessRecord> = {}): ProcessRecord {
    const now = new Date().toISOString();
    return {
      id: overrides.id ?? 'proc-persisted',
      card_id: 'card-1',
      command: 'sleep 10',
      command_hash: 'a'.repeat(64),
      cwd: root,
      cwd_canonical: root,
      status: 'running',
      pid: 12345,
      started_at: now,
      started_at_monotonic: 1000,
      completed_at: null,
      exit_code: null,
      signal: null,
      terminal_reason: null,
      required_for_card_completion: true,
      output_dir: join(root, '.saivage-work/processes/proc-persisted'),
      stdout_path: join(root, '.saivage-work/processes/proc-persisted/stdout.log'),
      stderr_path: join(root, '.saivage-work/processes/proc-persisted/stderr.log'),
      combined_log_path: join(root, '.saivage-work/processes/proc-persisted/combined.log'),
      goal_id: 'goal-1',
      reattach_state: 'attached',
      failure_classification: null,
      ...overrides,
    };
  }

  it('restart identity probe reattaches matching running processes', () => {
    const record = runningRecord();
    saveRegistry(root, [record]);
    const result = reconcileProcessRecords(root, {
      nowMonotonicMs: 1500,
      probe: () => ({ running: true, pid: 12345, started_at_monotonic: 1000 }),
      reattach: () => true,
    });
    expect(result.matched).toEqual([record.id]);
    expect(loadRegistry(root).get(record.id)?.reattach_state).toBe('reattached');
  });

  it('restart identity mismatch and clock-skew produce synthetic lost/process_failed terminals exactly once', () => {
    const notes: unknown[] = [];
    registerProcessTerminalSink(root, (note) => notes.push(note));
    const mismatch = runningRecord({ id: 'proc-mismatch', pid: 1 });
    const skewed = runningRecord({ id: 'proc-skewed', pid: 2, started_at_monotonic: 999999 });
    saveRegistry(root, [mismatch, skewed]);
    const result = reconcileProcessRecords(root, {
      nowMonotonicMs: 1000,
      maxClockSkewMs: 100,
      probe: () => ({ running: false }),
    });
    expect(result.lost).toEqual(expect.arrayContaining(['proc-mismatch', 'proc-skewed']));
    expect(result.skewed).toEqual(['proc-skewed']);
    expect(loadRegistry(root).get('proc-mismatch')).toEqual(expect.objectContaining({ status: 'failed', terminal_reason: 'lost', failure_classification: 'lost' }));
    expect(notes).toHaveLength(2);
    reconcileProcessRecords(root, { nowMonotonicMs: 1000, probe: () => ({ running: false }) });
    expect(notes).toHaveLength(2);
  });

  it('reattach failure produces a synthetic process_failed terminal classified as lost', () => {
    const notes: Array<{ status: string; classification?: string | null }> = [];
    registerProcessTerminalSink(root, (note) => notes.push(note));
    const record = runningRecord({ id: 'proc-reattach-fails' });
    saveRegistry(root, [record]);
    reconcileProcessRecords(root, {
      nowMonotonicMs: 1100,
      probe: () => ({ running: true, pid: 12345, started_at_monotonic: 1000 }),
      reattach: () => false,
    });
    expect(loadRegistry(root).get(record.id)).toEqual(expect.objectContaining({ status: 'failed', failure_classification: 'lost', reattach_state: 'lost' }));
    expect(notes).toEqual([expect.objectContaining({ status: 'failed', classification: 'lost', route: 'planner' })]);
  });

  it('wait_for_process and kill_process semantics on already-terminal records are cached/no-op', async () => {
    const terminal = runningRecord({ id: 'proc-terminal', status: 'exited', completed_at: new Date().toISOString(), exit_code: 0, terminal_reason: 'exit' });
    saveRegistry(root, [terminal]);
    await expect(waitProcess(root, terminal.id, 100)).resolves.toEqual(expect.objectContaining({ id: terminal.id, status: 'exited', exitCode: 0, timedOut: false }));
    await expect(killProcess(root, terminal.id)).resolves.toEqual(expect.objectContaining({ id: terminal.id, status: 'exited', exit_code: 0 }));
  });

  it('pause-time buffering delivers exactly one terminal note on resume to planner route', async () => {
    const notes: unknown[] = [];
    registerProcessTerminalSink(root, (note) => notes.push(note));
    setProcessTerminalBuffering(root, true);
    const rec = startProcess(root, 'echo paused-finish', { cardId: 'card-paused', goalId: 'goal-paused' });
    await waitProcess(root, rec.id, 1000);
    await sleep(100);
    expect(notes).toHaveLength(0);
    setProcessTerminalBuffering(root, false);
    setProcessTerminalBuffering(root, false);
    expect(notes).toEqual([expect.objectContaining({ route: 'planner', kind: 'process_terminal', process_id: rec.id, card_id: 'card-paused', goal_id: 'goal-paused', status: 'exited' })]);
  });
});
