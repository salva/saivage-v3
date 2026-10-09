import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { McpServerRuntime } from '../../src/mcp/server-runtime.js';
import { McpManager } from '../../src/mcp/mcp-manager.js';
import { McpInvocationStatsRecorder } from '../../src/mcp/invocation-stats.js';
import { TransportError } from '../../src/mcp/errors.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { SyntheticProcessPlatform } from '../helpers/synthetic-process-platform.js';
import { testConfigAuthority } from '../helpers/canonical-project.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const wire = (value: unknown) => JSON.stringify(value) + '\n';
const fixtures: Array<{ root: string; platform: SyntheticProcessPlatform }> = [];
afterEach(() => {
  jest.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    f.platform.destroy();
    rmSync(f.root, { recursive: true, force: true });
  }
});
function fixture(rejectDiscovery = false, io?: ConstructorParameters<typeof ProcessRunner>[3]) {
  const root = mkdtempSync(join(tmpdir(), 'mcp-unavailable-'));
  mkdirSync(join(root, '.saivage'));
  const platform = new SyntheticProcessPlatform();
  const calls: Array<{ id: number; method: string }> = [];
  platform.onSpawn = (child) => {
    child.stdin.on('data', (bytes) => {
      const request = JSON.parse(bytes.toString());
      if (request.method === 'tools/call') {
        calls.push(request);
        return;
      }
      if (!['initialize', 'tools/list'].includes(request.method)) return;
      child.stdout.write(
        wire({
          jsonrpc: '2.0',
          id: request.id,
          ...(rejectDiscovery
            ? { error: { code: -32001, message: 'secret discovery error' } }
            : {
                result:
                  request.method === 'initialize'
                    ? {}
                    : { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] },
              }),
        }),
      );
      if (rejectDiscovery) platform.states.set(child.pid!, 'EPERM');
    });
  };
  const registry = new ManagedProcessGroupRegistry(platform);
  const rootScope = registry.createContainerScope(registry.rootScope, 'mcp');
  const runner = new ProcessRunner(root, registry, testApplicationFatalPort, io);
  const events = { appendEventPrepared: jest.fn<(prepare: () => unknown) => void>() };
  const stats = new McpInvocationStatsRecorder(events as never);
  const config = {
    transport: 'stdio' as const,
    command: 'synthetic',
    autostart: false,
    disabled: false,
  };
  const scope = registry.createDirectScope(rootScope, 'one', 'service_infrastructure');
  let id = 0;
  const runtime = new McpServerRuntime({
    name: 'one',
    config,
    revision: 'r',
    processRunner: runner,
    processScope: scope,
    projectRoot: root,
    ids: { next: () => ++id },
    invocationStats: stats,
  });
  const f = {
    root,
    platform,
    registry,
    rootScope,
    runner,
    events,
    stats,
    config,
    scope,
    runtime,
    calls,
  };
  fixtures.push(f);
  return f;
}

describe('real process authority loss in current stdio lifetime owner', () => {
  it('open observer publishes safe unavailable label and finishes before the existing direct containment settles', async () => {
    const f = fixture();
    await f.runtime.start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const contain = f.runner.closeAndTerminateDirectScope.bind(f.runner);
    const direct = jest
      .spyOn(f.runner, 'closeAndTerminateDirectScope')
      .mockImplementation(async (input) => {
        const report = await contain(input);
        await gate;
        return report;
      });
    const child = f.platform.children[0]!;
    const handle = Reflect.get(f.runtime, 'handle');
    f.platform.states.set(child.pid!, 'EPERM');
    child.emit('exit', 0, null);
    await turn();
    expect(f.runtime.getStatus()).toMatchObject({
      status: 'error',
      error: 'Process evidence unavailable; containment unconfirmed',
    });
    expect(f.runtime.isReady()).toBe(false);
    expect(f.runtime.isAdmissionOpen()).toBe(false);
    expect(f.runtime.isContained()).toBe(false);
    expect(Reflect.get(f.runtime, 'handle')).toBe(handle);
    expect(Reflect.get(f.runtime, 'observedCaptureError')).toBeUndefined();
    expect((Reflect.get(f.runtime, 'operations') as Set<unknown>).size).toBe(0);
    expect(direct).toHaveBeenCalledTimes(1);
    const stop = f.runtime.stop().catch((error) => error);
    release();
    expect(await stop).toBeInstanceOf(Error);
    expect(f.runtime.getStatus().error).toBe('Process containment failed');
    expect(f.runner.list()[0]!.status).toBe('unavailable');
  });
  it('retains known capture rejection and unavailable exact record without taking normal capture-retirement branch', async () => {
    const capture = Object.assign(new Error('ordinary stderr diagnostic capture failure'), {
      code: 'EMFILE',
    });
    const f = fixture(false, {
      output: {
        open: () => {
          throw capture;
        },
      } as never,
    });
    await f.runtime.start();
    const child = f.platform.children[0]!;
    const record = f.runner.list()[0]!;
    const handle = Reflect.get(f.runtime, 'handle');
    const retire = jest.spyOn(f.runner, 'retireSettled');
    child.emit('error', new Error('leader error'));
    f.platform.states.set(child.pid!, 'EPERM');
    child.emit('exit', 0, null);
    await turn();
    await expect(f.runner.waitForSettlement(record.id)).rejects.toBe(capture);
    expect(f.runner.get(record.id)).toMatchObject({
      status: 'unavailable',
      evidence: {
        group: 'unverifiable',
        stderr: 'not_captured',
        stderr_error: capture.message,
        leader_error: { diagnostic: 'leader error' },
      },
    });
    expect(Reflect.get(f.runtime, 'observedCaptureError')).toBe(capture);
    expect(Reflect.get(f.runtime, 'handle')).toBe(handle);
    expect(retire).not.toHaveBeenCalled();
    await expect(f.runtime.stop()).rejects.toThrow('containment failed');
    expect(f.runtime.getStatus().error).toBe('Process containment failed');
    expect(f.events.appendEventPrepared).not.toHaveBeenCalled();
  });
  it.each(['open-observer', 'EOF', 'intentional-stop'] as const)(
    '%s fences admission, retains exact owner and joins failed stop without self-join',
    async (mode) => {
      const f = fixture();
      await f.runtime.start();
      const handle = Reflect.get(f.runtime, 'handle');
      const child = f.platform.children[0]!;
      const record = f.runner.list()[0]!;
      const pending = f.runtime.invokeTool('ping', {}).catch((error) => error);
      await turn();
      const queued = f.runtime.invokeTool('ping', {}).catch((error) => error);
      f.platform.states.set(child.pid!, 'EPERM');
      let stopping: Promise<unknown>;
      if (mode === 'open-observer') {
        // Natural exit triggers registry observation while runtime admission is still open.
        child.emit('exit', 0, null);
        await turn();
        stopping = f.runtime.stop().catch((error) => error);
      } else if (mode === 'EOF') {
        child.stdout.emit('end');
        stopping = f.runtime.stop().catch((error) => error);
      } else stopping = f.runtime.stop().catch((error) => error);
      expect(await stopping).toBeInstanceOf(Error);
      expect(await pending).toBeInstanceOf(Error);
      expect(await queued).toBeInstanceOf(Error);
      expect(f.runtime.isReady()).toBe(false);
      expect(f.runtime.isAdmissionOpen()).toBe(false);
      expect(f.runtime.isContained()).toBe(false);
      expect(f.runtime.getTools()).toBeUndefined();
      expect(f.runtime.getStatus()).toMatchObject({
        status: 'error',
        error: 'Process containment failed',
      });
      expect(Reflect.get(f.runtime, 'handle')).toBe(handle);
      expect(f.runner.get(record.id)).toMatchObject({
        status: 'unavailable',
        completed_at: null,
        evidence: { group: 'unverifiable', stdout: 'not_captured', stderr: 'not_captured' },
      });
      expect(child.stdout.destroyed).toBe(false);
      expect(f.calls).toHaveLength(1);
      expect(f.events.appendEventPrepared).not.toHaveBeenCalled();
      expect((Reflect.get(f.runtime, 'operations') as Set<unknown>).size).toBe(0);
      const operations = [...f.platform.operations];
      f.platform.states.set(child.pid!, 'ESRCH');
      child.emit('exit', 1, null);
      child.emit('error', new Error('late'));
      await turn();
      await expect(f.runtime.stop()).rejects.toThrow('containment failed');
      await expect(f.runtime.start()).rejects.toThrow('busy');
      expect(f.runtime.getStatus().error).toBe('Process containment failed');
      expect(Reflect.get(f.runtime, 'handle')).toBe(handle);
      expect(f.runner.list()).toHaveLength(1);
      expect(f.platform.operations).toEqual(operations);
    },
  );

  it.each([false, true])(
    'keeps correlated native isError=%s outcome and exactly one telemetry event before closure/EPERM',
    async (isError) => {
      const f = fixture();
      await f.runtime.start();
      const child = f.platform.children[0]!;
      const pending = f.runtime.invokeTool('ping', {});
      await turn();
      const queued = f.runtime.invokeTool('ping', {}).catch((error) => error);
      f.platform.states.set(child.pid!, 'EPERM');
      const result = { content: [{ type: 'text', text: 'known' }], isError };
      child.stdout.write(wire({ jsonrpc: '2.0', id: f.calls[0]!.id, result }));
      child.stdout.emit('end');
      expect(await pending).toEqual(result);
      await queued;
      await expect(f.runtime.stop()).rejects.toThrow('containment failed');
      expect(f.events.appendEventPrepared).toHaveBeenCalledTimes(1);
      expect(f.events.appendEventPrepared.mock.calls[0]![0]()).toMatchObject({
        kind: 'mcp_tool_invocation',
        success: !isError,
      });
      expect(f.stats.snapshot()['one:ping']).toMatchObject({
        total: 1,
        success: isError ? 0 : 1,
        error: isError ? 1 : 0,
      });
      expect(f.calls).toHaveLength(1);
      expect(f.runner.list()[0]!.status).toBe('unavailable');
    },
  );

  it('failed containment supersedes classified discovery rejection with retained real launch', async () => {
    const f = fixture(true);
    const error = await f.runtime.start().catch((error) => error);
    expect(error).not.toBeInstanceOf(TransportError);
    expect(error.message).toContain('containment failed');
    expect(f.runtime.isContained()).toBe(false);
    expect(f.runner.list()[0]!.status).toBe('unavailable');
    expect(f.events.appendEventPrepared).not.toHaveBeenCalled();
    await expect(f.runtime.start()).rejects.toThrow('busy');
  });

  it('ordinary EOF still waits for actual delayed leader/group settlement and retires only after successful containment', async () => {
    const f = fixture();
    await f.runtime.start();
    const child = f.platform.children[0]!;
    let release!: () => void;
    const signal = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.platform.signal = () => {
      release();
    };
    child.stdout.emit('end');
    await signal;
    let settled = false;
    const stop = f.runtime.stop().then(() => {
      settled = true;
    });
    await turn();
    expect(settled).toBe(false);
    expect(f.runner.list()[0]!.status).toBe('running');
    f.platform.states.set(child.pid!, 'ESRCH');
    child.emit('exit', 0, null);
    await stop;
    expect(f.runtime.isContained()).toBe(true);
    expect(f.runner.list()).toEqual([]);
    // Real runner retains the pre-existing termination-reason/killed presentation.
    expect(f.runtime.getStatus()).toMatchObject({
      status: 'error',
      error: 'Process exited with a signal',
    });
  });

  it('manager cannot reuse/replace/remove failed owner; root cleanup retires healthy siblings and retains root failure precedence', async () => {
    const f = fixture();
    const writeConfig = (servers: Record<string, unknown>) =>
      writeFileSync(
        join(f.root, '.saivage/saivage.yaml'),
        YAML.stringify({ ...structuredClone(TEST_SAIVAGE_CONFIG), mcpServers: servers }),
      );
    writeConfig({ one: f.config });
    const manager = new McpManager({
      configAuthority: testConfigAuthority(f.root),
      processRunner: f.runner,
      mcpProcessRootScope: f.rootScope,
      eventLogger: f.events as never,
    });
    await manager.startServer('one');
    const record = f.runner.list()[0]!;
    const child = f.platform.children[0]!;
    f.platform.states.set(child.pid!, 'EPERM');
    child.stdout.emit('end');
    await turn();
    await expect(manager.stopServer('one')).rejects.toThrow('containment failed');
    await expect(manager.startServer('one')).rejects.toMatchObject({ statusCode: 409 });
    writeConfig({ one: { ...f.config, args: ['changed'] } });
    await expect(manager.startServer('one')).rejects.toMatchObject({ statusCode: 409 });
    expect(await manager.reconcilePersistedConfig()).toMatchObject({
      converged: false,
      pending: [{ name: 'one', operation: 'replace' }],
    });
    writeConfig({});
    expect(await manager.reconcilePersistedConfig()).toMatchObject({
      converged: false,
      pending: [{ name: 'one', operation: 'remove' }],
    });
    const siblingScope = f.registry.createDirectScope(
      f.rootScope,
      'sibling',
      'service_infrastructure',
    );
    const sibling = f.runner.spawn({
      command: 'sibling',
      directScope: siblingScope,
      category: 'service_infrastructure',
      ownerId: 'sibling',
      ownerKind: 'runtime',
    });
    const terminate = jest.spyOn(f.runner, 'terminateScopeTree');
    await expect(manager.cleanupForApplicationStop()).rejects.toThrow(
      'MCP application cleanup failed',
    );
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(f.runner.get(sibling.id)).toBeNull();
    expect(f.runner.get(record.id)?.status).toBe('unavailable');
    expect(manager.getStatus()).toHaveLength(1);
    expect(manager.getServerTools('one')).toBeUndefined();
    expect(f.platform.children).toHaveLength(2);
  });

  it('fatal exact-launch observer rejection performs no runner inspection/disposal/containment/retirement/event', async () => {
    const f = fixture();
    let reject!: (error: unknown) => void;
    jest.spyOn(f.runner, 'waitForSettlement').mockImplementation(
      () =>
        new Promise((_, no) => {
          reject = no;
        }),
    );
    await f.runtime.start();
    const child = f.platform.children[0]!;
    const get = jest.spyOn(f.runner, 'get');
    const retire = jest.spyOn(f.runner, 'retireSettled');
    const dispose = jest.spyOn(child.stdout, 'unpipe');
    const contain = jest.spyOn(f.runner, 'closeAndTerminateDirectScope');
    const observed = [...(Reflect.get(f.runtime, 'operations') as Set<Promise<unknown>>)];
    const fatal = new PublicationOutcomeUnknownError();
    reject(fatal);
    expect(await observed[0]!.catch((error) => error)).toBe(fatal);
    expect(get).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(contain).not.toHaveBeenCalled();
    expect(f.events.appendEventPrepared).not.toHaveBeenCalled();
    // Test resource teardown only; no production owner follow-up after fatal.
    child.stdout.removeAllListeners();
  });
});
