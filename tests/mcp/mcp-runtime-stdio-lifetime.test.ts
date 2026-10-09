import { describe, expect, it, jest } from '@jest/globals';
import { PassThrough } from 'node:stream';
import { McpServerRuntime } from '../../src/mcp/server-runtime.js';
import { McpInvocationStatsRecorder } from '../../src/mcp/invocation-stats.js';
import { TransportError } from '../../src/mcp/errors.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';
import { MCP_WIRE_RESPONSE_LIMIT_BYTES } from '../../src/mcp/protocol.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const success = { failed: [] };
const wire = (message: unknown) => JSON.stringify(message) + '\n';
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(options?: {
  rejected?: boolean;
  ids?: { next(): number };
  missingStreams?: boolean;
  pauseDiscovery?: boolean;
  closeDiscoveryStage?: string;
}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const terminal = deferred<any>();
  const containment = deferred<any>();
  const entered = deferred<void>();
  const containmentEntered = deferred<void>();
  const terminate = jest.fn(() => {
    containmentEntered.resolve();
    return containment.promise;
  });
  const retire = jest.fn();
  const calls: any[] = [];
  const methods: string[] = [];
  let id = 0;
  let mutations = 0;
  const events = { appendEventPrepared: jest.fn<(prepare: () => unknown) => void>() };
  const runner = {
    spawnInteractive: () => ({
      process: options?.missingStreams ? { stderr } : { stdin, stdout, stderr },
      record: { id: 'process' },
    }),
    get: () => ({ status: 'running' }),
    waitForSettlement: jest.fn(() => terminal.promise),
    closeAndTerminateDirectScope: terminate,
    retireSettled: retire,
  };
  stdin.on('data', (bytes) => {
    const request = JSON.parse(bytes.toString());
    methods.push(request.method ?? 'roots-answer');
    if (request.method === 'tools/call') {
      mutations++;
      calls.push(request);
      entered.resolve();
      return;
    }
    if (request.method !== 'initialize' && request.method !== 'tools/list') return;
    if (options?.pauseDiscovery) {
      entered.resolve();
      return;
    }
    if (request.method === options?.closeDiscoveryStage) {
      stdout.emit('end');
      return;
    }
    const result =
      request.method === 'initialize'
        ? {}
        : { tools: [{ name: 'mutate', inputSchema: { type: 'object' } }] };
    stdout.write(
      wire({
        jsonrpc: '2.0',
        id: request.id,
        ...(options?.rejected
          ? { error: { code: -32007, message: 'secret remote rejection', data: 'secret' } }
          : { result }),
      }),
    );
  });
  const stats = new McpInvocationStatsRecorder(events as never);
  const runtime = new McpServerRuntime({
    name: 'one',
    config: { transport: 'stdio', command: 'synthetic', autostart: false, disabled: false },
    revision: 'r',
    processRunner: runner as never,
    processScope: {} as never,
    projectRoot: '/project space/á',
    ids: options?.ids ?? { next: () => ++id },
    invocationStats: stats,
  });
  return {
    runtime,
    stdin,
    stdout,
    stderr,
    terminal,
    containment,
    containmentEntered,
    entered,
    terminate,
    retire,
    runner,
    calls,
    methods,
    events,
    stats,
    get mutations() {
      return mutations;
    },
    destroy() {
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    },
  };
}

describe('runtime lifetime receiver ordering', () => {
  it.each(['discovery', 'invocation'] as const)(
    'intentional stop settles pending %s and joins without self-join',
    async (stage) => {
      const f = fixture({ pauseDiscovery: stage === 'discovery' });
      let operation: Promise<unknown>;
      if (stage === 'discovery') operation = f.runtime.start().catch((error) => error);
      else {
        await f.runtime.start();
        operation = f.runtime.invokeTool('mutate', {}).catch((error) => error);
      }
      await f.entered.promise;
      const stopping = f.runtime.stop();
      f.containment.resolve(success);
      expect(await operation).toMatchObject({ code: 'SERVER_NOT_RUNNING' });
      await stopping;
      expect(f.terminate).toHaveBeenCalledTimes(1);
      expect(f.runtime.isContained()).toBe(true);
      expect(f.stdout.listenerCount('data')).toBe(0);
      f.destroy();
    },
  );
  it.each(['roots-write', 'EOF', 'native-error-roots-write', 'native-error-EOF', 'mapped-error'] as const)(
    'retains a consumed known response before %s closure and fences queued work',
    async (mode) => {
      const f = fixture();
      await f.runtime.start();
      const eof = mode.endsWith('EOF');
      const nativeError = mode.startsWith('native-error');
      const result = f.runtime.invokeTool('mutate', {}).catch((error) => error);
      await f.entered.promise;
      const queued = f.runtime.invokeTool('mutate', {}).catch((error) => error);
      if (!eof)
        jest.spyOn(f.stdin, 'write').mockImplementation(() => {
          throw new Error('roots answer write failed');
        });
      f.stdout.write(
        wire({
          jsonrpc: '2.0',
          id: f.calls[0].id,
          ...(mode === 'mapped-error'
            ? { error: { code: -32602, message: 'known failure' } }
            : { result: { content: [{ type: 'text', text: 'known result' }], ...(nativeError ? { isError: true } : {}) } }),
        }) + (!eof ? wire({ jsonrpc: '2.0', id: 'roots', method: 'roots/list' }) : ''),
      );
      if (eof) f.stdout.emit('end');
      expect(f.runtime.isReady()).toBe(false);
      expect(f.runtime.isAdmissionOpen()).toBe(false);
      expect(f.terminate).toHaveBeenCalledTimes(1);
      const known = await result;
      if (mode === 'mapped-error') expect(known).toMatchObject({ code: 'INVALID_ARGUMENTS' });
      else expect(known).toEqual({ content: [{ type: 'text', text: 'known result' }], ...(nativeError ? { isError: true } : {}) });
      expect(f.events.appendEventPrepared).toHaveBeenCalledTimes(1);
      const succeeded = !nativeError && mode !== 'mapped-error';
      expect(f.stats.snapshot()['one:mutate']).toMatchObject({ total: 1, success: succeeded ? 1 : 0, error: succeeded ? 0 : 1 });
      const event = f.events.appendEventPrepared.mock.calls[0][0]();
      expect(event).toMatchObject({ kind: 'mcp_tool_invocation', success: succeeded });
      if (nativeError) expect(event).not.toHaveProperty('error');
      await queued;
      await expect(f.runtime.invokeTool('mutate', {})).rejects.toThrow('not running');
      expect(f.calls).toHaveLength(1);
      expect(f.mutations).toBe(1);
      f.terminal.resolve({ record: { status: 'exited', signal: null } });
      f.containment.resolve(success);
      await f.runtime.stop();
      expect(f.retire).toHaveBeenCalledTimes(1);
      expect(f.stdout.listenerCount('data')).toBe(0);
      jest.restoreAllMocks();
      f.destroy();
    },
  );

  it('retains exact original caller cancellation after correlation despite internal closure', async () => {
    const f = fixture();
    await f.runtime.start();
    const caller = new AbortController();
    const observed = f.runtime
      .invokeTool('mutate', {}, { signal: caller.signal })
      .catch((error) => error);
    await f.entered.promise;
    f.stdout.write(wire({ jsonrpc: '2.0', id: f.calls[0].id, result: { content: [] } }));
    f.stdout.emit('end');
    const reason = { caller: 'after response' };
    caller.abort(reason);
    expect(await observed).toBe(reason);
    expect(f.events.appendEventPrepared).not.toHaveBeenCalled();
    f.terminal.resolve({ record: { status: 'exited', signal: null } });
    f.containment.resolve(success);
    await f.runtime.stop();
    f.destroy();
  });

  it.each(['zero', 'nonzero', 'signal', 'capture'] as const)(
    'copies delayed %s settlement after EOF, then stop retains it',
    async (kind) => {
      const f = fixture();
      await f.runtime.start();
      f.stdout.emit('end');
      expect(f.runtime.isReady()).toBe(false);
      expect(f.runtime.isAdmissionOpen()).toBe(false);
      expect(f.runtime.getStatus().status).toBe('stopped');
      expect(f.retire).not.toHaveBeenCalled();
      let joined = false;
      const stopping = f.runtime.stop().then(
        () => {
          joined = true;
        },
        (error) => error,
      );
      const capture = new Error('exact capture failure');
      if (kind === 'capture') f.terminal.reject(capture);
      else
        f.terminal.resolve({
          record: {
            status: kind === 'zero' ? 'exited' : 'failed',
            signal: kind === 'signal' ? 'SIGTERM' : null,
          },
        });
      await turn();
      expect(joined).toBe(false);
      expect(f.runtime.getStatus()).toMatchObject(
        kind === 'zero'
          ? { status: 'stopped' }
          : {
              status: 'error',
              error:
                kind === 'capture'
                  ? 'Process output capture failed'
                  : kind === 'signal'
                    ? 'Process exited with a signal'
                    : 'Process exited unsuccessfully',
            },
      );
      if (kind === 'capture') f.containment.reject(capture);
      else f.containment.resolve(success);
      const result = await stopping;
      if (kind === 'capture') expect(result).toBe(capture);
      expect(f.runtime.getStatus().status).toBe(kind === 'zero' ? 'stopped' : 'error');
      expect(f.runner.waitForSettlement).toHaveBeenCalledTimes(1);
      expect(f.retire).toHaveBeenCalledTimes(1);
      expect(f.stdout.listenerCount('data')).toBe(0);
      f.destroy();
    },
  );

  it('failed containment releases the retained observer race, propagates identity and never retires a pending launch', async () => {
    const f = fixture();
    await f.runtime.start();
    f.stdout.emit('end');
    const failure = new Error('containment failure');
    const stopping = f.runtime.stop().catch((error) => error);
    f.containment.reject(failure);
    expect(await stopping).toBe(failure);
    expect(f.runtime.getStatus()).toMatchObject({
      status: 'error',
      error: 'Process containment failed',
    });
    expect(f.runtime.isContained()).toBe(false);
    expect(f.retire).not.toHaveBeenCalled();
    f.terminal.resolve({ record: { status: 'exited', signal: null } });
    await turn();
    expect(f.retire).not.toHaveBeenCalled();
    expect(f.runtime.getStatus().status).toBe('error');
    f.destroy();
  });

  it.each(['success', 'failed'] as const)(
    'rejected stdio start waits for %s containment and preserves F-07 classification',
    async (kind) => {
      const f = fixture({ rejected: true });
      let settled = false;
      const observed = f.runtime.start().catch((error) => {
        settled = true;
        return error;
      });
      await turn();
      expect(settled).toBe(false);
      expect(f.terminate).toHaveBeenCalledTimes(1);
      const failure = new Error('containment failure');
      if (kind === 'success') f.containment.resolve(success);
      else f.containment.reject(failure);
      const result = await observed;
      if (kind === 'success') {
        expect(result).toBeInstanceOf(TransportError);
        expect(result.message).toContain('initialize rejected (code -32007)');
        expect(result.message).not.toContain('secret');
        expect(f.runtime.isContained()).toBe(true);
      } else {
        expect(result).toBe(failure);
        expect(f.runtime.isContained()).toBe(false);
        await expect(f.runtime.start()).rejects.toThrow('busy');
      }
      expect(f.events.appendEventPrepared).not.toHaveBeenCalled();
      f.destroy();
    },
  );

  it.each(['initialize', 'tools/list'] as const)(
    'premature %s EOF preserves its safe typed stage through delayed containment and stop',
    async (stage) => {
      const f = fixture({ closeDiscoveryStage: stage });
      let settled = false;
      const observed = f.runtime.start().catch((error) => {
        settled = true;
        return error;
      });
      await turn();
      expect(settled).toBe(false);
      expect(f.runtime.isAdmissionOpen()).toBe(false);
      expect(f.terminate).toHaveBeenCalledTimes(1);
      f.containment.resolve(success);
      await turn();
      expect(settled).toBe(false);
      f.terminal.resolve({ record: { status: 'exited', signal: null } });
      const failure = await observed;
      expect(failure).toBeInstanceOf(TransportError);
      expect(failure.message).toContain(`${stage} stream closed before response`);
      expect(f.runtime.isContained()).toBe(true);
      expect(f.retire).toHaveBeenCalledTimes(1);
      expect(f.methods).toEqual(
        stage === 'initialize'
          ? ['initialize']
          : ['initialize', 'notifications/initialized', 'tools/list'],
      );
      f.destroy();
    },
  );

  it.each(['idle', 'active'] as const)(
    'unknown readable failure during %s retains identity and closes the one containment owner',
    async (state) => {
      const f = fixture();
      await f.runtime.start();
      const failure = new TypeError('exact read failure');
      const observed =
        state === 'active' ? f.runtime.invokeTool('mutate', {}).catch((error) => error) : undefined;
      if (state === 'active') await f.entered.promise;
      f.stdout.emit('error', failure);
      expect(f.runtime.isReady()).toBe(false);
      expect(f.terminate).toHaveBeenCalledTimes(1);
      const stopping = f.runtime.stop();
      f.terminal.resolve({ record: { status: 'exited', signal: null } });
      f.containment.resolve(success);
      if (observed) expect(await observed).toBe(failure);
      await stopping;
      expect(f.events.appendEventPrepared).not.toHaveBeenCalled();
      expect(f.stdout.listenerCount('data')).toBe(0);
      f.destroy();
    },
  );

  it.each(['idle', 'active'] as const)(
    'EOF, bounded partial frame and roots-write faults during %s fence runtime dispatch and join one containment',
    async (state) => {
      for (const kind of ['EOF', 'bound', 'roots-write']) {
        const f = fixture();
        await f.runtime.start();
        const observed =
          state === 'active'
            ? f.runtime.invokeTool('mutate', {}).catch((error) => error)
            : undefined;
        if (state === 'active') await f.entered.promise;
        if (kind === 'EOF') f.stdout.emit('end');
        else if (kind === 'bound')
          f.stdout.write(Buffer.alloc(MCP_WIRE_RESPONSE_LIMIT_BYTES + 1, 120));
        else {
          jest.spyOn(f.stdin, 'write').mockImplementation(() => {
            throw new Error('roots write failed');
          });
          f.stdout.write(wire({ jsonrpc: '2.0', id: 'roots', method: 'roots/list' }));
        }
        await f.containmentEntered.promise;
        expect(f.runtime.isReady()).toBe(false);
        expect(f.runtime.isAdmissionOpen()).toBe(false);
        expect(f.terminate).toHaveBeenCalledTimes(1);
        await expect(f.runtime.invokeTool('mutate', {})).rejects.toThrow('not running');
        const stopping = f.runtime.stop();
        f.terminal.resolve({ record: { status: 'exited', signal: null } });
        f.containment.resolve(success);
        if (observed) {
          const error = await observed;
          expect(error).toBeInstanceOf(TransportError);
          if (!(error instanceof TransportError)) throw error;
          expect(error.message).toContain(
            kind === 'EOF'
              ? 'stream closed before response'
              : kind === 'bound'
                ? '48 MiB'
                : 'stdio write failed',
          );
        }
        await stopping;
        expect(f.calls).toHaveLength(state === 'active' ? 1 : 0);
        expect(f.stdout.listenerCount('data')).toBe(0);
        jest.restoreAllMocks();
        f.destroy();
      }
    },
  );

  it('rejects missing launched streams as an unclassified invariant at the runtime boundary', async () => {
    const f = fixture({ missingStreams: true });
    f.containment.resolve(success);
    const result = await f.runtime.start().catch((error) => error);
    expect(result).not.toBeInstanceOf(TransportError);
    expect(result.message).toBe('Server process has no stdin/stdout');
    expect(f.runtime.isContained()).toBe(true);
    f.destroy();
  });

  it('intentional stop cancels the observer race without awaiting unknown terminal settlement', async () => {
    const f = fixture();
    await f.runtime.start();
    f.containment.resolve(success);
    await f.runtime.stop();
    expect(f.runtime.getStatus().status).toBe('stopped');
    expect(f.retire).not.toHaveBeenCalled();
    expect(f.stdout.listenerCount('data')).toBe(0);
    f.destroy();
  });

  it('fatal observer rejection precedes projection, disposal, retirement and containment', async () => {
    const f = fixture();
    await f.runtime.start();
    const fatal = new PublicationOutcomeUnknownError();
    const unpipe = jest.spyOn(f.stdout, 'unpipe');
    const operations = [...(Reflect.get(f.runtime, 'operations') as Set<Promise<void>>)];
    const observed = operations[0].catch((error) => error);
    f.terminal.reject(fatal);
    expect(await observed).toBe(fatal);
    expect(unpipe).not.toHaveBeenCalled();
    expect(f.retire).not.toHaveBeenCalled();
    expect(f.terminate).not.toHaveBeenCalled();
    expect(f.events.appendEventPrepared).not.toHaveBeenCalled();
    expect(f.runtime.isReady()).toBe(true);
    // Synthetic resource teardown only: no runtime follow-up after fatal uncertainty.
    f.stdout.removeAllListeners();
    f.destroy();
  });

  it.each(['unknown', 'fatal'] as const)(
    'ID-source %s failure retains identity and the appropriate no-followup boundary',
    async (kind) => {
      jest.useFakeTimers();
      const failure =
        kind === 'fatal' ? new PublicationOutcomeUnknownError() : new Error('exact ID invariant');
      const f = fixture({
        ids: {
          next() {
            throw failure;
          },
        },
      });
      const unpipe = jest.spyOn(f.stdout, 'unpipe');
      if (kind === 'unknown') f.containment.resolve(success);
      try {
        expect(await f.runtime.start().catch((error) => error)).toBe(failure);
        expect(f.terminate).toHaveBeenCalledTimes(kind === 'fatal' ? 0 : 1);
        if (kind === 'fatal') expect(unpipe).not.toHaveBeenCalled();
        expect(f.methods).toEqual([]);
        expect(f.events.appendEventPrepared).not.toHaveBeenCalled();
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
        f.stdout.removeAllListeners();
        f.destroy();
      }
    },
  );
});
