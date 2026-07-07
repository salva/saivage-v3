import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildInvocationSurface, invokeTool } from '../../src/tools/invocation.js';
import { createProcessProvider } from '../../src/tools/process-provider.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import type { ProcessRecord } from '../../src/schemas/index.js';

function expectUnifiedProcessResult(data: unknown, processId?: string): void {
  expect(data).toEqual(expect.objectContaining({
    ...(processId ? { process_id: processId } : {}),
    status: expect.any(String),
    stdout_url: expect.stringMatching(/^work:\/\/\/processes\/[^/]+\/stdout\.log$/),
    stderr_url: expect.stringMatching(/^work:\/\/\/processes\/[^/]+\/stderr\.log$/),
    stdout_bytes: expect.any(Number),
    stderr_bytes: expect.any(Number),
    stdout_tail: expect.any(String),
    stderr_tail: expect.any(String),
    tail_truncated: expect.any(Boolean),
  }));
  expect(data as Record<string, unknown>).toHaveProperty('exit_code');
}

function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'saivage-process-provider-'));
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe('process provider', () => {
  it('runs foreground commands with canonical run_command', async () => withRoot(async (root) => {
    const processRunner = new ProcessRunner(root);
    const surface = buildInvocationSurface('executor', [createProcessProvider({ projectRoot: root, processRunner, ownerId: 'activation-1', cardId: 'card-1', ownerKind: 'agent' })]);

    const result = await invokeTool(surface, 'run_command', { command: 'printf hello', timeout_ms: 1000 });

    expect(result.success).toBe(true);
    if (result.success) {
      expectUnifiedProcessResult(result.data);
      expect(result.data).toEqual(expect.objectContaining({ exit_code: 0, status: 'exited', stdout_tail: 'hello' }));
      expect(result.data).not.toHaveProperty('stdout');
      expect(result.data).not.toHaveProperty('stderr');
      expect(result.data).not.toHaveProperty('log_path');
      expect(result.data).not.toHaveProperty('truncated');
    }
  }));

  it('starts and inspects background commands', async () => withRoot(async (root) => {
    const processRunner = new ProcessRunner(root);
    const surface = buildInvocationSurface('executor', [createProcessProvider({ projectRoot: root, processRunner, ownerId: 'activation-1', cardId: 'card-1', ownerKind: 'agent' })]);
    const started = await invokeTool(surface, 'run_command', { command: 'sleep 1 && printf done', wait: false });
    expect(started.success).toBe(true);
    if (!started.success) return;
    const processId = (started.data as { process_id: string }).process_id;

    const inspected = await invokeTool(surface, 'wait_process', { process_id: processId, timeout_ms: 0 });

    expect(inspected.success).toBe(true);
    if (inspected.success) {
      expectUnifiedProcessResult(inspected.data, processId);
      expect(inspected.data).toEqual(expect.objectContaining({ status: 'running', exit_code: null }));
      expect(inspected.data).not.toHaveProperty('still_running');
    }
  }));

  it('returns a killed partial result when a foreground command is aborted', async () => withRoot(async (root) => {
    const processRunner = new ProcessRunner(root);
    const surface = buildInvocationSurface('executor', [createProcessProvider({ projectRoot: root, processRunner, ownerId: 'activation-1', cardId: 'card-1', ownerKind: 'agent' })]);
    const controller = new AbortController();
    const pending = invokeTool(surface, 'run_command', { command: 'printf before && sleep 5', timeout_ms: 10_000 }, controller.signal);
    setTimeout(() => controller.abort(new Error('stop')), 50);

    const result = await pending;

    expect(result.success).toBe(true);
    if (result.success) {
      expectUnifiedProcessResult(result.data);
      expect(result.data).toEqual(expect.objectContaining({ status: 'killed' }));
    }
  }));

  it('returns zero-byte tails when live log files do not exist yet', async () => withRoot(async (root) => {
    const processRunner = new ProcessRunner(root);
    const missing = join(root, '.saivage-work', 'processes', 'proc-missing');
    processRunner.setTransientRegistry(new Map([['proc-missing', {
      id: 'proc-missing', card_id: 'card-1', owner_id: 'activation-1', command: 'sleep 1', command_hash: 'a'.repeat(64), cwd: root, cwd_canonical: root, status: 'running', pid: 123, started_at: '2026-01-01T00:00:00.000Z', started_at_monotonic: 1, completed_at: null, exit_code: null, signal: null, terminal_reason: null, required_for_card_completion: true, output_dir: missing, stdout_path: join(missing, 'stdout.log'), stderr_path: join(missing, 'stderr.log'), agent_session_id: 'activation-1', goal_id: null, launch_reason: null, owner_kind: 'agent', background_policy: null, process_group_id: 123, failure_classification: null,
    } satisfies ProcessRecord]]));
    const surface = buildInvocationSurface('executor', [createProcessProvider({ projectRoot: root, processRunner, ownerId: 'activation-1', cardId: 'card-1', ownerKind: 'agent' })]);

    const result = await invokeTool(surface, 'wait_process', { process_id: 'proc-missing', timeout_ms: 0 });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(expect.objectContaining({ stdout_bytes: 0, stderr_bytes: 0, stdout_tail: '', stderr_tail: '', tail_truncated: false }));
  }));

  it('rejects process control from a different owner', async () => withRoot(async (root) => {
    const processRunner = new ProcessRunner(root);
    const owner = buildInvocationSurface('executor', [createProcessProvider({ projectRoot: root, processRunner, ownerId: 'activation-1', cardId: 'card-1', ownerKind: 'agent' })]);
    const stranger = buildInvocationSurface('executor', [createProcessProvider({ projectRoot: root, processRunner, ownerId: 'activation-2', cardId: 'card-1', ownerKind: 'agent' })]);
    const started = await invokeTool(owner, 'run_command', { command: 'sleep 1', wait: false });
    expect(started.success).toBe(true);
    if (!started.success) return;
    const processId = (started.data as { process_id: string }).process_id;

    const denied = await invokeTool(stranger, 'kill_process', { process_id: processId });

    expect(denied.success).toBe(false);
    if (!denied.success) expect(denied.error).toContain('not owned');
    await invokeTool(owner, 'kill_process', { process_id: processId });
  }));

  it('records Analyst command provenance as operator-owned session work', async () => withRoot(async (root) => {
    const processRunner = new ProcessRunner(root);
    const surface = buildInvocationSurface('analyst', [createProcessProvider({ projectRoot: root, processRunner, ownerId: 'analyst:global', agentRole: 'analyst', ownerKind: 'operator', launchReason: 'analyst workspace run_command' })]);

    const result = await invokeTool(surface, 'run_command', { command: 'printf analyst', timeout_ms: 1000 });

    expect(result.success).toBe(true);
    if (!result.success) return;
    const processId = (result.data as { process_id: string }).process_id;
    expect(processRunner.get(processId)).toEqual(expect.objectContaining({
      card_id: 'analyst:global',
      owner_id: 'analyst:global',
      agent_session_id: 'analyst:global',
      owner_kind: 'operator',
      launch_reason: 'analyst workspace run_command',
    }));
  }));

  it('records executor command provenance as agent-owned card work', async () => withRoot(async (root) => {
    const processRunner = new ProcessRunner(root);
    const surface = buildInvocationSurface('executor', [createProcessProvider({ projectRoot: root, processRunner, ownerId: 'activation-1', cardId: 'card-1', agentRole: 'executor', ownerKind: 'agent' })]);

    const result = await invokeTool(surface, 'run_command', { command: 'printf executor', timeout_ms: 1000 });

    expect(result.success).toBe(true);
    if (!result.success) return;
    const processId = (result.data as { process_id: string }).process_id;
    expect(processRunner.get(processId)).toEqual(expect.objectContaining({
      card_id: 'card-1',
      owner_id: 'activation-1',
      agent_session_id: 'activation-1',
      owner_kind: 'agent',
      launch_reason: 'executor process provider run_command',
    }));
  }));

  it('proceeds with runtime-owned command spawn even when the gate is closed', async () => withRoot(async (root) => {
    const processRunner = new ProcessRunner(root);
    const surface = buildInvocationSurface('executor', [createProcessProvider({ projectRoot: root, processRunner, ownerId: 'activation-1', cardId: 'card-1', agentRole: 'executor', ownerKind: 'agent' })]);

    const result = await invokeTool(surface, 'run_command', { command: 'printf gated', timeout_ms: 1000 });

    expect(result.success).toBe(true);
    expect(processRunner.list()).toHaveLength(1);
  }));

  it('does not gate operator-owned Analyst command spawn', async () => withRoot(async (root) => {
    const processRunner = new ProcessRunner(root);
    const surface = buildInvocationSurface('analyst', [createProcessProvider({ projectRoot: root, processRunner, ownerId: 'analyst:global', agentRole: 'analyst', ownerKind: 'operator' })]);

    const result = await invokeTool(surface, 'run_command', { command: 'printf operator', timeout_ms: 1000 });

    expect(result.success).toBe(true);
    expect(processRunner.list()).toHaveLength(1);
  }));
});
