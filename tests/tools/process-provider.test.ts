import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildInvocationSurface, invokeTool } from '../../src/tools/invocation.js';
import { createProcessProvider } from '../../src/tools/process-provider.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';

function executorProvider(root: string, processRunner: ProcessRunner, ownerId = 'activation-1') {
  return createProcessProvider({ projectRoot: root, processRunner, directScope: processRunner.createDirectScope(processRunner.runtimeRootScope, `test:${ownerId}`, 'runtime_card'), category: 'runtime_card', ownerId, cardId: '11111111-1111-4111-8111-111111111111', agentRole: 'executor', ownerKind: 'agent' });
}

function analystProvider(root: string, processRunner: ProcessRunner) {
  return createProcessProvider({ projectRoot: root, processRunner, directScope: processRunner.createDirectScope(processRunner.analystRootScope, 'test:analyst', 'operator_session'), category: 'operator_session', ownerId: 'analyst:global', agentRole: 'analyst', ownerKind: 'operator', launchReason: 'analyst workspace run_command' });
}

function expectUnifiedProcessResult(data: unknown, processId?: string): void {
  expect(data).toEqual(expect.objectContaining({
    ...(processId ? { process_id: processId } : {}),
    status: expect.any(String),
    stdout_url: expect.stringMatching(/^work:\/\/\/(?:cards\/[^/]+\/)?processes\/[^/]+\/stdout\.log$/),
    stderr_url: expect.stringMatching(/^work:\/\/\/(?:cards\/[^/]+\/)?processes\/[^/]+\/stderr\.log$/),
    stdout_bytes: expect.any(Number),
    stderr_bytes: expect.any(Number),
  }));
  expect(data as Record<string, unknown>).toHaveProperty('exit_code');
  expect(data as Record<string, unknown>).not.toHaveProperty('stdout_tail');
  expect(data as Record<string, unknown>).not.toHaveProperty('stderr_tail');
  expect(data as Record<string, unknown>).not.toHaveProperty('tail_truncated');
}

function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'saivage-process-provider-'));
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe('process provider', () => {
  it('runs foreground commands with canonical run_command', async () => withRoot(async (root) => {
    const processRunner = createTestProcessRunner(root);
    const surface = buildInvocationSurface('executor', [executorProvider(root, processRunner)]);

    const result = await invokeTool(surface, 'run_command', { command: 'printf hello', timeout_ms: 1000 });

    expect(result.success).toBe(true);
    if (result.success) {
      expectUnifiedProcessResult(result.data);
      expect(result.data).toEqual(expect.objectContaining({ exit_code: 0, status: 'exited', stdout_bytes: 5 }));
      expect(result.data).not.toHaveProperty('stdout');
      expect(result.data).not.toHaveProperty('stderr');
      expect(result.data).not.toHaveProperty('log_path');
      expect(result.data).not.toHaveProperty('truncated');
    }
  }));

  it('runs commands in canonical project and system cwd URLs', async () => withRoot(async (root) => {
    mkdirSync(join(root, 'packages', 'api'), { recursive: true });
    const processRunner = createTestProcessRunner(root);
    const surface = buildInvocationSurface('executor', [executorProvider(root, processRunner)]);
    const cases = [
      ['project:///', root],
      ['project:///packages/api', join(root, 'packages', 'api')],
      ['packages/api', join(root, 'packages', 'api')],
      ['system:///', '/'],
      ['system:///tmp', '/tmp'],
    ] as const;

    for (const [cwd, expected] of cases) {
      const result = await invokeTool(surface, 'run_command', { command: 'exit 0', cwd, timeout_ms: 1000 });
      expect(result.success).toBe(true);
      if (result.success) {
        const processId = (result.data as { process_id: string }).process_id;
        expect(processRunner.get(processId)?.cwd).toBe(expected);
      }
    }
  }));

  it('rejects malformed and unsupported scoped cwd values before launch', async () => withRoot(async (root) => {
    const processRunner = createTestProcessRunner(root);
    const surface = buildInvocationSurface('executor', [executorProvider(root, processRunner)]);
    const cases = [
      ['record:///', 'not supported for cwd'],
      ['tmp:///', 'not supported for cwd'],
      ['work:///', 'not supported for cwd'],
      ['unknown:///path', "Unsupported scoped URL scheme 'unknown'"],
      ['project://', 'expected project:///'],
      ['project://host/path', 'expected project:///'],
      ['project:///packages?mode=test', 'Invalid project cwd'],
      ['project:///packages#fragment', 'Invalid project cwd'],
      ['../outside', 'Path traversal detected'],
    ] as const;

    for (const [cwd, message] of cases) {
      const result = await invokeTool(surface, 'run_command', { command: 'exit 0', cwd });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain(message);
      expect(processRunner.list()).toEqual([]);
    }
  }));

  it('executes run_command with Bash semantics', async () => withRoot(async (root) => {
    const processRunner = createTestProcessRunner(root);
    const surface = buildInvocationSurface('executor', [executorProvider(root, processRunner)]);

    const result = await invokeTool(surface, 'run_command', { command: 'set -o pipefail; [[ value == v* ]]', timeout_ms: 1000 });

    expect(result).toEqual(expect.objectContaining({ success: true, data: expect.objectContaining({ status: 'exited', exit_code: 0 }) }));
  }));

  it('starts and inspects background commands', async () => withRoot(async (root) => {
    const processRunner = createTestProcessRunner(root);
    const surface = buildInvocationSurface('executor', [executorProvider(root, processRunner)]);
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
    const processRunner = createTestProcessRunner(root);
    const surface = buildInvocationSurface('executor', [executorProvider(root, processRunner)]);
    const controller = new AbortController();
    const pending = invokeTool(surface, 'run_command', { command: `exec ${process.execPath} -e 'process.stdout.write("before"); setInterval(() => {}, 1000)'`, timeout_ms: 10_000 }, controller.signal);
    setTimeout(() => controller.abort(new Error('stop')), 50);

    const result = await pending;

    expect(result.success).toBe(true);
    if (result.success) {
      expectUnifiedProcessResult(result.data);
      expect(result.data).toEqual(expect.objectContaining({ status: 'killed' }));
    }
  }));

  it('rejects process control from a same-owner sibling scope', async () => withRoot(async (root) => {
    const processRunner = createTestProcessRunner(root);
    const owner = buildInvocationSurface('executor', [executorProvider(root, processRunner)]);
    const stranger = buildInvocationSurface('executor', [executorProvider(root, processRunner)]);
    const started = await invokeTool(owner, 'run_command', { command: 'sleep 1', wait: false });
    expect(started.success).toBe(true);
    if (!started.success) return;
    const processId = (started.data as { process_id: string }).process_id;

    const denied = await invokeTool(stranger, 'kill_process', { process_id: processId });

    expect(denied.success).toBe(false);
    if (!denied.success) expect(denied.error).toContain('not bound');
    await invokeTool(owner, 'kill_process', { process_id: processId });
  }));

  it('records Analyst command provenance as operator-owned session work', async () => withRoot(async (root) => {
    const processRunner = createTestProcessRunner(root);
    const surface = buildInvocationSurface('analyst', [analystProvider(root, processRunner)]);

    const result = await invokeTool(surface, 'run_command', { command: 'printf analyst', timeout_ms: 1000 });

    expect(result.success).toBe(true);
    if (!result.success) return;
    const processId = (result.data as { process_id: string }).process_id;
    expect(processRunner.get(processId)).toEqual(expect.objectContaining({
      card_id: null,
      owner_id: 'analyst:global',
      agent_session_id: 'analyst:global',
      owner_kind: 'operator',
      required_for_card_completion: false,
      launch_reason: 'analyst workspace run_command',
    }));
  }));

  it('records executor command provenance as agent-owned card work', async () => withRoot(async (root) => {
    const processRunner = createTestProcessRunner(root);
    const surface = buildInvocationSurface('executor', [executorProvider(root, processRunner)]);

    const result = await invokeTool(surface, 'run_command', { command: 'printf executor', timeout_ms: 1000 });

    expect(result.success).toBe(true);
    if (!result.success) return;
    const processId = (result.data as { process_id: string }).process_id;
    expect(processRunner.get(processId)).toEqual(expect.objectContaining({
      card_id: '11111111-1111-4111-8111-111111111111',
      owner_id: 'activation-1',
      agent_session_id: 'activation-1',
      owner_kind: 'agent',
      launch_reason: 'executor process provider run_command',
    }));
  }));

  it('proceeds with runtime-owned command spawn even when the gate is closed', async () => withRoot(async (root) => {
    const processRunner = createTestProcessRunner(root);
    const surface = buildInvocationSurface('executor', [executorProvider(root, processRunner)]);

    const result = await invokeTool(surface, 'run_command', { command: 'printf gated', timeout_ms: 1000 });

    expect(result.success).toBe(true);
    expect(processRunner.list()).toHaveLength(1);
  }));

  it('does not gate operator-owned Analyst command spawn', async () => withRoot(async (root) => {
    const processRunner = createTestProcessRunner(root);
    const surface = buildInvocationSurface('analyst', [analystProvider(root, processRunner)]);

    const result = await invokeTool(surface, 'run_command', { command: 'printf operator', timeout_ms: 1000 });

    expect(result.success).toBe(true);
    expect(processRunner.list()).toHaveLength(1);
  }));
});
