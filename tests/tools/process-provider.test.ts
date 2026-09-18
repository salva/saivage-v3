import { bindToolProvider } from '../helpers/bind-tool-provider.js';
import { describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


import { invokeTestTool } from '../helpers/invoke-test-tool.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import { cleanupProcessProvider, processToolBinders, type ProcessProviderContext } from '../../src/tools/process-provider.js';
import { cleanupTestProcessRunners, createTestProcessRunner, type TestProcessRunnerComposition } from '../helpers/test-process-runner.js';
import type { LlmToolInvocationContext } from '../../src/runtime/actors/executing-llm-snapshot.js';
import { testLlmToolInvocationContext } from '../helpers/llm-test-helpers.js';
import { cardProcessOutputRoot, cardWorkRoot, nonCardProcessOutputRoot } from '../../src/persistence/layout.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';

function executorProvider(root: string, processes: TestProcessRunnerComposition, ownerId = 'activation-1') {
  return bindToolProvider('process', processToolBinders, { projectRoot: root, processRunner: processes.processRunner, directScope: processes.processRunner.createDirectScope(processes.runtimeProcessRootScope, `test:${ownerId}`, 'runtime_card'), category: 'runtime_card', ownerId, cardId: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', ownerKind: 'agent' });
}

function analystProvider(root: string, processes: TestProcessRunnerComposition) {
  return bindToolProvider('process', processToolBinders, { projectRoot: root, processRunner: processes.processRunner, directScope: processes.processRunner.createDirectScope(processes.analystProcessRootScope, 'test:analyst', 'operator_session'), category: 'operator_session', ownerId: 'agent:analyst:global', ownerKind: 'operator' });
}

function expectUnifiedProcessResult(data: unknown, processId?: string): void {
  expect(data).toEqual(expect.objectContaining({
    ...(processId ? { process_id: processId } : {}),
    status: expect.any(String),
    stdout: expect.any(String),
    stderr: expect.any(String),
    stdout_complete: expect.any(Boolean),
    stderr_complete: expect.any(Boolean),
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
  return fn(root).finally(async () => { await cleanupTestProcessRunners(root); rmSync(root, { recursive: true, force: true }); });
}

describe('process provider', () => {
  it('labels every cleanup reason before terminating the direct scope', async () => withRoot(async (root) => {
    const processes = createTestProcessRunner(root);
    const directScope = processes.processRunner.createDirectScope(processes.runtimeProcessRootScope, 'test:cleanup-labels', 'runtime_card');
    const context: ProcessProviderContext = { projectRoot: root, processRunner: processes.processRunner, directScope, category: 'runtime_card', ownerId: 'activation-1', cardId: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', ownerKind: 'agent' };
    const terminate = jest.spyOn(processes.processRunner, 'closeAndTerminateDirectScope').mockResolvedValue({ selected: [], stopped: [], failed: [] });

    await cleanupProcessProvider(context, { kind: 'activation_settled', status: 'done' });
    await cleanupProcessProvider(context, { kind: 'session_closed' });
    await cleanupProcessProvider(context, { kind: 'runtime_shutdown' });

    expect(terminate.mock.calls.map(([options]) => options)).toEqual([
      { directScope, category: 'runtime_card', reason: 'activation settled: done' },
      { directScope, category: 'runtime_card', reason: 'session closed' },
      { directScope, category: 'runtime_card', reason: 'runtime shutdown' },
    ]);
  }));

  it('segments only unfinished process waits and retires a background process only after terminal consumption', async () => withRoot(async (root) => {
    const processRunner = createTestProcessRunner(root);
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processRunner)]);
    const waitProcessCalls: string[] = [];
    const waitProcess = async <T>(processId: string, promise: Promise<T>): Promise<T> => {
      waitProcessCalls.push(processId);
      expect(processRunner.processRunner.get(processId)?.status).toBe('running');
      return promise;
    };
    const context: LlmToolInvocationContext = {
      ...testLlmToolInvocationContext({ sessionId: 'agent:executor:card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', toolCallId: 'call-process', toolName: 'run_command' }),
      waits: { waitProcess, waitExternal: async <T>(_promise: Promise<T>) => { throw new Error('unexpected external wait'); } },
    };

    const foreground = await invokeTestTool(surface, 'run_command', { command: 'sleep 0.05', timeout_ms: 1000 }, new AbortController().signal, context);
    expect(foreground.success).toBe(true);
    expect(waitProcessCalls).toHaveLength(1);

    waitProcessCalls.length = 0;
    const background = await invokeTestTool(surface, 'run_command', { command: 'sleep 0.1', wait: false }, new AbortController().signal, context);
    if (!background.success) throw new Error(background.error);
    const processId = (background.data as { process_id: string }).process_id;
    await invokeTestTool(surface, 'wait_process', { process_id: processId, timeout_ms: 0 }, new AbortController().signal, { ...context, toolName: 'wait_process' });
    expect(waitProcessCalls).toHaveLength(0);
    const consumed = await invokeTestTool(surface, 'wait_process', { process_id: processId, timeout_ms: 1000 }, new AbortController().signal, { ...context, toolName: 'wait_process' });
    expect(consumed.success).toBe(true);
    expect(waitProcessCalls).toHaveLength(1);
    expect(processRunner.processRunner.get(processId)).toBeNull();

    waitProcessCalls.length = 0;
    const repeated = await invokeTestTool(surface, 'wait_process', { process_id: processId, timeout_ms: 1000 }, new AbortController().signal, { ...context, toolName: 'wait_process' });
    const killed = await invokeTestTool(surface, 'kill_process', { process_id: processId }, new AbortController().signal, { ...context, toolName: 'kill_process' });
    expect(repeated.success).toBe(false);
    expect(killed.success).toBe(false);
    expect(waitProcessCalls).toHaveLength(0);
  }));

  it('runs foreground commands with canonical run_command', async () => withRoot(async (root) => {
    const processRunner = createTestProcessRunner(root);
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processRunner)]);

    const result = await invokeTestTool(surface, 'run_command', { command: 'printf hello', timeout_ms: 1000 });

    expect(result.success).toBe(true);
    if (result.success) {
      expectUnifiedProcessResult(result.data);
      expect(result.data).toEqual(expect.objectContaining({ exit_code: 0, status: 'exited', stdout: 'hello', stderr: '', stdout_complete: true, stderr_complete: true, stdout_bytes: 5, stderr_bytes: 0 }));
      expect(result.data).not.toHaveProperty('log_path');
      expect(result.data).not.toHaveProperty('truncated');
    }
  }));

  it('captures independently bounded, redacted heads with raw byte counts and line-relative completeness', async () => withRoot(async (root) => {
    const processes = createTestProcessRunner(root);
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processes)]);
    const script = [
      `process.stdout.write(${JSON.stringify(`${'out\n'.repeat(30)}after`)});`,
      `process.stderr.write(${JSON.stringify(`${'é'.repeat(1_024)}z token=synthetic-secret-value`)});`,
    ].join('');

    const invocation = await invokeTestTool(surface, 'run_command', { command: `${process.execPath} -e ${JSON.stringify(script)}`, timeout_ms: 1_000 });
    if (!invocation.success) throw new Error(invocation.error);
    const data = invocation.data as Record<string, unknown>;
    expect(data.stdout).toBe('out\n'.repeat(30));
    expect(data.stdout_complete).toBe(false);
    expect(data.stdout_bytes).toBe(Buffer.byteLength(`${'out\n'.repeat(30)}after`));
    expect(Buffer.byteLength(data.stderr as string, 'utf8')).toBeLessThanOrEqual(2_048);
    expect(data.stderr).not.toContain('synthetic-secret-value');
    expect(data.stderr_complete).toBe(false);
    expect(data.stderr_bytes).toBe(Buffer.byteLength(`${'é'.repeat(1_024)}z token=synthetic-secret-value`));
  }));

  it('omits an incomplete final UTF-8 sequence from a running capture', async () => withRoot(async (root) => {
    const processes = createTestProcessRunner(root);
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processes)]);
    const started = await invokeTestTool(surface, 'run_command', { command: `printf '\\360\\237'; sleep 60`, wait: false });
    if (!started.success) throw new Error(started.error);
    const processId = (started.data as { process_id: string }).process_id;
    await new Promise((resolve) => setTimeout(resolve, 50));

    const observed = await invokeTestTool(surface, 'wait_process', { process_id: processId, timeout_ms: 0 });
    if (!observed.success) throw new Error(observed.error);
    expect(observed.data).toEqual(expect.objectContaining({ stdout: '', stdout_complete: false, stdout_bytes: 2 }));
    await invokeTestTool(surface, 'kill_process', { process_id: processId });
  }));

  it('reconstructs a multibyte character split across running writes before terminal capture', async () => withRoot(async (root) => {
    const processes = createTestProcessRunner(root);
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processes)]);
    const script = 'process.stdout.write(Buffer.from([0xf0,0x9f]));setTimeout(()=>process.stdout.write(Buffer.from([0x99,0x82])),500);';
    const started = await invokeTestTool(surface, 'run_command', { command: `${process.execPath} -e ${JSON.stringify(script)}`, wait: false });
    if (!started.success) throw new Error(started.error);
    const processId = (started.data as { process_id: string }).process_id;
    let partial = await invokeTestTool(surface, 'wait_process', { process_id: processId, timeout_ms: 0 });
    for (let attempt = 0; attempt < 40 && partial.success && (partial.data as { stdout_bytes: number }).stdout_bytes < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      partial = await invokeTestTool(surface, 'wait_process', { process_id: processId, timeout_ms: 0 });
    }
    expect(partial).toEqual(expect.objectContaining({ success: true, data: expect.objectContaining({ status: 'running', stdout: '', stdout_complete: false, stdout_bytes: 2 }) }));
    const terminal = await invokeTestTool(surface, 'wait_process', { process_id: processId, timeout_ms: 2_000 });
    expect(terminal).toEqual(expect.objectContaining({ success: true, data: expect.objectContaining({ status: 'exited', stdout: '🙂', stdout_complete: true, stdout_bytes: 4 }) }));
  }));

  it.each([
    `${'a'.repeat(2_035)} sk-${'x'.repeat(200)}`,
    `${'a'.repeat(2_035)} token=${'x'.repeat(200)}`,
  ])('retreats from a redaction span near the byte boundary without emitting an unstable fragment', async (output) => withRoot(async (root) => {
    const processes = createTestProcessRunner(root);
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processes)]);
    const script = `process.stdout.write(${JSON.stringify(output)});`;
    const invocation = await invokeTestTool(surface, 'run_command', { command: `${process.execPath} -e ${JSON.stringify(script)}`, timeout_ms: 1_000 });
    if (!invocation.success) throw new Error(invocation.error);
    const data = invocation.data as { stdout: string; stdout_complete: boolean };
    expect(data.stdout_complete).toBe(false);
    expect(Buffer.byteLength(data.stdout, 'utf8')).toBeLessThanOrEqual(2_048);
    expect(data.stdout).not.toMatch(/sk-\[REDAC?$/u);
    expect(data.stdout).not.toMatch(/token=\[REDAC?$/u);
  }));

  it('preserves BOM and CRLF text at exact independent byte and line boundaries', async () => withRoot(async (root) => {
    const processes = createTestProcessRunner(root);
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processes)]);
    const stdout = `\uFEFF${'x'.repeat(2_045)}`;
    const stderr = `${'line\r\n'.repeat(29)}last`;
    const script = `process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});`;

    const invocation = await invokeTestTool(surface, 'run_command', { command: `${process.execPath} -e ${JSON.stringify(script)}`, timeout_ms: 1_000 });
    if (!invocation.success) throw new Error(invocation.error);
    expect(invocation.data).toEqual(expect.objectContaining({
      stdout,
      stderr,
      stdout_complete: true,
      stderr_complete: true,
      stdout_bytes: 2_048,
      stderr_bytes: Buffer.byteLength(stderr),
    }));
  }));

  it('retires a known terminal foreground result when capture fails without attempting a kill', async () => withRoot(async (root) => {
    const processes = createTestProcessRunner(root);
    const kill = jest.spyOn(processes.processRunner, 'kill');
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processes)]);
    let processId = '';
    const context: LlmToolInvocationContext = {
      ...testLlmToolInvocationContext({ sessionId: 'agent:executor:card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', toolCallId: 'capture-failure', toolName: 'run_command' }),
      waits: {
        waitProcess: async <T>(_id: string, promise: Promise<T>): Promise<T> => {
          const value = await promise;
          const record = (value as { record: { id: string; stdout_path: string } }).record;
          processId = record.id;
          unlinkSync(record.stdout_path);
          return value;
        },
        waitExternal: async <T>(_promise: Promise<T>) => { throw new Error('unexpected external wait'); },
      },
    };

    const invocation = await invokeTestTool(surface, 'run_command', { command: 'printf captured', timeout_ms: 1_000 }, new AbortController().signal, context);
    expect(invocation.success).toBe(false);
    if (!invocation.success) expect(invocation.error).toMatch(/ENOENT/u);
    expect(kill).not.toHaveBeenCalled();
    expect(processes.processRunner.get(processId)).toBeNull();
  }));

  it('retires a terminal wait capture failure without re-entering process termination', async () => withRoot(async (root) => {
    const processes = createTestProcessRunner(root);
    const originalWait = processes.processRunner.wait.bind(processes.processRunner);
    const sentinel = new Error('terminal capture failure');
    jest.spyOn(processes.processRunner, 'wait').mockImplementation(async (processId, timeoutMs) => {
      await originalWait(processId, timeoutMs);
      throw sentinel;
    });
    const kill = jest.spyOn(processes.processRunner, 'kill');
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processes)]);

    const invocation = await invokeTestTool(surface, 'run_command', { command: 'exit 0', timeout_ms: 1_000 });
    expect(invocation).toEqual({ success: false, error: sentinel.message });
    expect(kill).not.toHaveBeenCalled();
    expect(processes.processRunner.list()).toEqual([]);
  }));

  it('performs no process follow-up after an outcome-unknown wait publication', async () => withRoot(async (root) => {
    const processes = createTestProcessRunner(root);
    const failure = new PublicationOutcomeUnknownError();
    jest.spyOn(processes.processRunner, 'wait').mockRejectedValue(failure);
    const get = jest.spyOn(processes.processRunner, 'get');
    const kill = jest.spyOn(processes.processRunner, 'kill');
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processes)]);

    await expect(invokeTestTool(surface, 'run_command', { command: 'sleep 60', timeout_ms: 1_000 })).rejects.toBe(failure);
    expect(get).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  }));

  it('uses the shared semantic validator on producer output and lets oversized fixed metadata escape only as failure', async () => withRoot(async (root) => {
    const processes = createTestProcessRunner(root);
    const originalSpawn = processes.processRunner.spawn.bind(processes.processRunner);
    jest.spyOn(processes.processRunner, 'spawn').mockImplementation((options) => {
      const record = originalSpawn(options);
      record.card_id = `card-${'a'.repeat(40_000)}`;
      return record;
    });
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processes)]);
    const invocation = await invokeTestTool(surface, 'run_command', { command: 'sleep 60', wait: false });
    expect(invocation.success).toBe(false);
    if (!invocation.success) expect(invocation.error).toMatch(/provider-envelope byte limit/u);
  }));

  it('retires a killed process when terminal capture fails without repeating termination', async () => withRoot(async (root) => {
    const processes = createTestProcessRunner(root);
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processes)]);
    const started = await invokeTestTool(surface, 'run_command', { command: 'sleep 60', wait: false });
    if (!started.success) throw new Error(started.error);
    const processId = (started.data as { process_id: string }).process_id;
    const stdoutPath = processes.processRunner.get(processId)!.stdout_path;
    const originalKill = processes.processRunner.kill.bind(processes.processRunner);
    const kill = jest.spyOn(processes.processRunner, 'kill').mockImplementation(async (...args) => {
      const record = await originalKill(...args);
      unlinkSync(stdoutPath);
      return record;
    });
    const invocation = await invokeTestTool(surface, 'kill_process', { process_id: processId });
    expect(invocation.success).toBe(false);
    if (!invocation.success) expect(invocation.error).toMatch(/ENOENT/u);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(processes.processRunner.get(processId)).toBeNull();
  }));

  it('performs no follow-up after outcome-unknown kill publication', async () => withRoot(async (root) => {
    const processes = createTestProcessRunner(root);
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processes)]);
    const started = await invokeTestTool(surface, 'run_command', { command: 'sleep 60', wait: false });
    if (!started.success) throw new Error(started.error);
    const processId = (started.data as { process_id: string }).process_id;
    const failure = new PublicationOutcomeUnknownError();
    jest.spyOn(processes.processRunner, 'kill').mockRejectedValue(failure);
    const get = jest.spyOn(processes.processRunner, 'get');
    await expect(invokeTestTool(surface, 'kill_process', { process_id: processId })).rejects.toBe(failure);
    expect(get).toHaveBeenCalledTimes(1);
  }));

  it('bounds ordinary process errors with a certified 512-byte projection', async () => withRoot(async (root) => {
    const processes = createTestProcessRunner(root);
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processes)]);
    const invocation = await invokeTestTool(surface, 'wait_process', { process_id: `proc-${'z'.repeat(5_000)}`, timeout_ms: 0 });
    expect(invocation.success).toBe(false);
    if (invocation.success) return;
    expect(Buffer.byteLength(invocation.error, 'utf8')).toBeLessThanOrEqual(512);
    expect(invocation.error).not.toContain('z'.repeat(1_000));
  }));

  it('supplies the existing card work root to card commands without changing default cwd', async () => withRoot(async (root) => {
    const processes = createTestProcessRunner(root);
    const spawn = jest.spyOn(processes.processRunner, 'spawn');
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processes)]);

    const result = await invokeTestTool(surface, 'run_command', {
      command: `printf '%s\\n%s\\n' "$SAIVAGE_CARD_WORK_ROOT" "$PWD"; test -d "$SAIVAGE_CARD_WORK_ROOT"`,
      timeout_ms: 1000,
    });

    expect(result).toEqual(expect.objectContaining({ success: true, data: expect.objectContaining({ exit_code: 0 }) }));
    if (!result.success) return;
    const processId = (result.data as { process_id: string }).process_id;
    expect(readFileSync(join(cardProcessOutputRoot(root, 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', processId), 'stdout.log'), 'utf8')).toBe(`${cardWorkRoot(root, 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa')}\n${root}\n`);
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: root }));
  }));

  it('does not supply a card work root to global Analyst commands', async () => withRoot(async (root) => {
    const processes = createTestProcessRunner(root);
    const spawn = jest.spyOn(processes.processRunner, 'spawn');
    const surface = buildInvocationSurfaceFixture('analyst', [analystProvider(root, processes)]);

    const result = await invokeTestTool(surface, 'run_command', {
      command: `printf '%s\\n%s\\n' "\${SAIVAGE_CARD_WORK_ROOT+set}" "$PWD"`,
      timeout_ms: 1000,
    });

    expect(result).toEqual(expect.objectContaining({ success: true, data: expect.objectContaining({ exit_code: 0 }) }));
    if (!result.success) return;
    const processId = (result.data as { process_id: string }).process_id;
    expect(readFileSync(join(nonCardProcessOutputRoot(root, processId), 'stdout.log'), 'utf8')).toBe(`\n${root}\n`);
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: root }));
  }));

  it('rejects the removed inactivity timeout before launching a process', async () => withRoot(async (root) => {
    const processRunner = createTestProcessRunner(root);
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processRunner)]);

    await expect(invokeTestTool(surface, 'run_command', { command: 'printf never', inactivity_timeout_ms: 1000 })).rejects.toThrow(/inactivity_timeout_ms/);
    expect(processRunner.processRunner.list()).toEqual([]);
  }));

  it('runs commands in canonical project and system cwd URLs', async () => withRoot(async (root) => {
    mkdirSync(join(root, 'packages', 'api'), { recursive: true });
    const processRunner = createTestProcessRunner(root);
    const spawn = jest.spyOn(processRunner.processRunner, 'spawn');
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processRunner)]);
    const cases = [
      ['project:///', root],
      ['project:///packages/api', join(root, 'packages', 'api')],
      ['packages/api', join(root, 'packages', 'api')],
      ['system:///', '/'],
      ['system:///tmp', '/tmp'],
    ] as const;

    for (const [cwd, expected] of cases) {
      const result = await invokeTestTool(surface, 'run_command', { command: 'exit 0', cwd, timeout_ms: 1000 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(spawn).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: expected }));
      }
    }
  }));

  it('rejects malformed and unsupported scoped cwd values before launch', async () => withRoot(async (root) => {
    const processRunner = createTestProcessRunner(root);
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processRunner)]);
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
      const result = await invokeTestTool(surface, 'run_command', { command: 'exit 0', cwd });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain(message);
      expect(processRunner.processRunner.list()).toEqual([]);
    }
  }));

  it('executes run_command with Bash semantics', async () => withRoot(async (root) => {
    const processRunner = createTestProcessRunner(root);
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processRunner)]);

    const result = await invokeTestTool(surface, 'run_command', { command: 'set -o pipefail; [[ value == v* ]]', timeout_ms: 1000 });

    expect(result).toEqual(expect.objectContaining({ success: true, data: expect.objectContaining({ status: 'exited', exit_code: 0 }) }));
  }));

  it('starts and inspects background commands', async () => withRoot(async (root) => {
    const processRunner = createTestProcessRunner(root);
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processRunner)]);
    const started = await invokeTestTool(surface, 'run_command', { command: 'sleep 1 && printf done', wait: false });
    expect(started.success).toBe(true);
    if (!started.success) return;
    const processId = (started.data as { process_id: string }).process_id;

    const inspected = await invokeTestTool(surface, 'wait_process', { process_id: processId, timeout_ms: 0 });

    expect(inspected.success).toBe(true);
    if (inspected.success) {
      expectUnifiedProcessResult(inspected.data, processId);
      expect(inspected.data).toEqual(expect.objectContaining({ status: 'running', exit_code: null }));
      expect(inspected.data).not.toHaveProperty('still_running');
    }
  }));

  it('keeps wait:false and timed-out observations unconsumed until a terminal wait or kill owns the result', async () => withRoot(async (root) => {
    const processes = createTestProcessRunner(root);
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processes)]);

    const fast = await invokeTestTool(surface, 'run_command', { command: 'exit 0', wait: false });
    if (!fast.success) throw new Error(fast.error);
    const fastId = (fast.data as { process_id: string }).process_id;
    await processes.processRunner.waitForSettlement(fastId);
    expect(processes.processRunner.get(fastId)).toMatchObject({ status: 'exited' });
    const consumed = await invokeTestTool(surface, 'wait_process', { process_id: fastId, timeout_ms: 0 });
    expect(consumed).toEqual(expect.objectContaining({ success: true, data: expect.objectContaining({ status: 'exited' }) }));
    expect(processes.processRunner.get(fastId)).toBeNull();

    const slow = await invokeTestTool(surface, 'run_command', { command: 'sleep 60', timeout_ms: 5 });
    if (!slow.success) throw new Error(slow.error);
    const slowId = (slow.data as { process_id: string }).process_id;
    expect(slow.data).toEqual(expect.objectContaining({ status: 'running' }));
    expect(processes.processRunner.get(slowId)).toMatchObject({ status: 'running' });
    const killed = await invokeTestTool(surface, 'kill_process', { process_id: slowId });
    expect(killed).toEqual(expect.objectContaining({ success: true, data: expect.objectContaining({ status: 'killed' }) }));
    expect(processes.processRunner.get(slowId)).toBeNull();
  }));

  it('returns a killed partial result when a foreground command is aborted', async () => withRoot(async (root) => {
    const processRunner = createTestProcessRunner(root);
    const kill = jest.spyOn(processRunner.processRunner, 'kill');
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processRunner)]);
    const controller = new AbortController();
    const pending = invokeTestTool(surface, 'run_command', { command: `exec ${process.execPath} -e 'process.stdout.write("before"); setInterval(() => {}, 1000)'`, timeout_ms: 10_000 }, controller.signal);
    setTimeout(() => controller.abort(new Error('stop')), 50);

    const result = await pending;

    expect(result.success).toBe(true);
    if (result.success) {
      expectUnifiedProcessResult(result.data);
      expect(result.data).toEqual(expect.objectContaining({ status: 'killed' }));
    }
    expect(kill).toHaveBeenCalledWith(expect.any(String), {
      directScope: expect.anything(),
      category: 'runtime_card',
      reason: 'tool invocation interrupted',
    });
  }));

  it('leaves a background process owned and available when wait_process is interrupted', async () => withRoot(async (root) => {
    const processes = createTestProcessRunner(root);
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processes)]);
    const started = await invokeTestTool(surface, 'run_command', { command: 'sleep 60', wait: false });
    if (!started.success) throw new Error(started.error);
    const processId = (started.data as { process_id: string }).process_id;
    const controller = new AbortController();
    const pending = invokeTestTool(surface, 'wait_process', { process_id: processId, timeout_ms: 10_000 }, controller.signal);
    setTimeout(() => controller.abort(new Error('interrupt wait only')), 25);
    await expect(pending).rejects.toThrow('interrupt wait only');
    expect(processes.processRunner.get(processId)).toMatchObject({ status: 'running' });
    await expect(invokeTestTool(surface, 'kill_process', { process_id: processId })).resolves.toEqual(expect.objectContaining({ success: true, data: expect.objectContaining({ status: 'killed' }) }));
  }));

  it('rejects process control from a same-owner sibling scope', async () => withRoot(async (root) => {
    const processRunner = createTestProcessRunner(root);
    const owner = buildInvocationSurfaceFixture('executor', [executorProvider(root, processRunner)]);
    const stranger = buildInvocationSurfaceFixture('executor', [executorProvider(root, processRunner)]);
    const started = await invokeTestTool(owner, 'run_command', { command: 'sleep 1', wait: false });
    expect(started.success).toBe(true);
    if (!started.success) return;
    const processId = (started.data as { process_id: string }).process_id;

    const denied = await invokeTestTool(stranger, 'kill_process', { process_id: processId });

    expect(denied.success).toBe(false);
    if (!denied.success) expect(denied.error).toContain('not bound');
    await invokeTestTool(owner, 'kill_process', { process_id: processId });
  }));

  it('records Analyst command provenance as operator-owned session work', async () => withRoot(async (root) => {
    const processRunner = createTestProcessRunner(root);
    const spawn = jest.spyOn(processRunner.processRunner, 'spawn');
    const surface = buildInvocationSurfaceFixture('analyst', [analystProvider(root, processRunner)]);

    const result = await invokeTestTool(surface, 'run_command', { command: 'printf analyst', timeout_ms: 1000 });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      cardId: null,
      ownerId: 'agent:analyst:global',
      agentSessionId: 'agent:analyst:global',
      ownerKind: 'operator',
    }));
  }));

  it('records executor command provenance as agent-owned card work', async () => withRoot(async (root) => {
    const processRunner = createTestProcessRunner(root);
    const spawn = jest.spyOn(processRunner.processRunner, 'spawn');
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processRunner)]);

    const result = await invokeTestTool(surface, 'run_command', { command: 'printf executor', timeout_ms: 1000 });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      cardId: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ownerId: 'activation-1',
      agentSessionId: 'activation-1',
      ownerKind: 'agent',
    }));
  }));

  it('proceeds with runtime-owned command spawn even when the gate is closed', async () => withRoot(async (root) => {
    const processRunner = createTestProcessRunner(root);
    const surface = buildInvocationSurfaceFixture('executor', [executorProvider(root, processRunner)]);

    const result = await invokeTestTool(surface, 'run_command', { command: 'printf gated', timeout_ms: 1000 });

    expect(result.success).toBe(true);
    expect(processRunner.processRunner.list()).toHaveLength(0);
  }));

  it('does not gate operator-owned Analyst command spawn', async () => withRoot(async (root) => {
    const processRunner = createTestProcessRunner(root);
    const surface = buildInvocationSurfaceFixture('analyst', [analystProvider(root, processRunner)]);

    const result = await invokeTestTool(surface, 'run_command', { command: 'printf operator', timeout_ms: 1000 });

    expect(result.success).toBe(true);
    expect(processRunner.processRunner.list()).toHaveLength(0);
  }));
});
