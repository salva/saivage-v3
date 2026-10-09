import { describe, expect, it, jest } from '@jest/globals';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { StdioMcpConnection } from '../../src/mcp/stdio-transport.js';
import { TransportError } from '../../src/mcp/errors.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';
import { MCP_WIRE_RESPONSE_LIMIT_BYTES } from '../../src/mcp/protocol.js';

const signal = () => new AbortController().signal;
const wire = (message: unknown) => JSON.stringify(message) + '\n';
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(ids?: { next(): number | string }) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const failure = jest.fn();
  let id = 0;
  const rootUri = pathToFileURL('/project space/á').href;
  const connection = new StdioMcpConnection({
    serverName: 'one',
    stdin,
    stdout,
    ids: ids ?? { next: () => ++id },
    rootUri,
    onFailure: failure,
  });
  return {
    stdin,
    stdout,
    failure,
    rootUri,
    connection,
    close() {
      connection.dispose(new Error('test complete'));
      stdin.destroy();
      stdout.destroy();
    },
  };
}

describe('connection-owned stdio receiver', () => {
  it('dispatches paginated, colliding, idle and fragmented roots across successive side-effecting calls without replay', async () => {
    const f = fixture();
    const answers: any[] = [];
    const methods: string[] = [];
    let mutations = 0;
    const roots = (id: string | number) => ({ jsonrpc: '2.0', id, method: 'roots/list' });
    f.stdin.on('data', (bytes) => {
      const request = JSON.parse(bytes.toString());
      if (request.result?.roots) {
        answers.push(request);
        return;
      }
      methods.push(request.method);
      if (request.method === 'notifications/initialized') return;
      if (request.method === 'initialize') {
        expect(request.params.capabilities).toEqual({ roots: { listChanged: false } });
        // Synchronous responses exercise register-before-send, too.
        f.stdout.write(
          wire(roots(request.id)) +
            wire({ jsonrpc: '2.0', id: request.id, result: {} }) +
            wire(roots('after-init')),
        );
      } else if (request.method === 'tools/list') {
        const page = request.params?.cursor
          ? { tools: [{ name: 'second' }] }
          : { tools: [{ name: 'first' }], nextCursor: 'page2' };
        f.stdout.write(
          wire({ jsonrpc: '2.0', id: request.id, result: page }) +
            wire(roots(`page-${request.id}`)),
        );
      } else {
        mutations++;
        const bytes = Buffer.from(
          wire(roots(`before-${mutations}`)) +
            wire({
              jsonrpc: '2.0',
              id: request.id,
              result: { content: [{ type: 'text', text: `é:${mutations}` }] },
            }) +
            wire(roots(`after-${mutations}`)),
        );
        const split = bytes.indexOf(Buffer.from('é')) + 1;
        f.stdout.write(bytes.subarray(0, split));
        f.stdout.write(bytes.subarray(split));
      }
    });
    try {
      expect(await f.connection.discover(signal())).toEqual([
        { name: 'first' },
        { name: 'second' },
      ]);
      await turn();
      f.stdout.write(wire(roots('idle')));
      for (let n = 1; n <= 2; n++) {
        expect(
          await f.connection.invoke({
            toolName: 'first',
            args: {},
            signal: signal(),
            onResponse() {},
          }),
        ).toMatchObject({ content: [{ type: 'text', text: `é:${n}` }] });
        f.stdout.write(wire(roots(`between-${n}`)));
      }
      f.stdout.write(wire({ method: 'roots/list' }) + wire({ method: 'roots/list', id: {} }));
      expect(answers.map((a) => a.id)).toEqual([
        1,
        'after-init',
        'page-2',
        'page-3',
        'idle',
        'before-1',
        'after-1',
        'between-1',
        'before-2',
        'after-2',
        'between-2',
      ]);
      for (const answer of answers) expect(answer.result).toEqual({ roots: [{ uri: f.rootUri }] });
      expect(methods).toEqual([
        'initialize',
        'notifications/initialized',
        'tools/list',
        'tools/list',
        'tools/call',
        'tools/call',
      ]);
      expect(mutations).toBe(2);
      expect(f.failure).not.toHaveBeenCalled();
      expect(f.stdout.listenerCount('data')).toBe(1);
    } finally {
      f.close();
    }
  });

  it.each(['initialize', 'tools/list'] as const)(
    'keeps fixed %s rejection diagnostics and only finite numeric codes',
    async (stage) => {
      for (const code of [-32001, 'secret-code', null, Infinity, NaN]) {
        const f = fixture();
        f.stdin.on('data', (bytes) => {
          const request = JSON.parse(bytes.toString());
          if (request.method === 'notifications/initialized') return;
          const response = wire({
            jsonrpc: '2.0',
            id: request.id,
            ...(request.method === stage
              ? { error: { code, message: 'secret-message', data: 'secret-data' } }
              : { result: {} }),
          });
          f.stdout.write(
            code === Infinity ? response.replace('"code":null', '"code":1e999') : response,
          );
        });
        try {
          const error = await f.connection.discover(signal()).catch((error) => error);
          expect(error).toBeInstanceOf(TransportError);
          expect(error.message).toBe(
            `Transport error on MCP server 'one': ${stage} rejected${code === -32001 ? ' (code -32001)' : ''}`,
          );
        } finally {
          f.close();
        }
      }
    },
  );

  it.each(['idle', 'active'] as const)(
    'handles ordinary %s reader faults and detaches exactly its listeners',
    async (state) => {
      for (const kind of ['EOF', 'error', 'bound', 'roots-write']) {
        const f = fixture();
        const unknown = new TypeError('reader identity');
        const observed =
          state === 'active'
            ? f.connection
                .invoke({ toolName: 'tool', args: {}, signal: signal(), onResponse() {} })
                .catch((e) => e)
            : undefined;
        try {
          if (kind === 'EOF') f.stdout.emit('end');
          if (kind === 'error') f.stdout.emit('error', unknown);
          if (kind === 'bound') {
            f.stdout.write(Buffer.alloc(MCP_WIRE_RESPONSE_LIMIT_BYTES, 120));
            f.stdout.write(Buffer.from('x'));
            await turn();
          }
          if (kind === 'roots-write') {
            jest.spyOn(f.stdin, 'write').mockImplementation(() => {
              throw new Error('write failure');
            });
            f.stdout.write(wire({ jsonrpc: '2.0', method: 'roots/list', id: 1 }));
          }
          expect(f.failure).toHaveBeenCalledTimes(1);
          const failure = f.failure.mock.calls[0][0];
          if (kind === 'error') expect(failure).toBe(unknown);
          else expect(failure).toBeInstanceOf(TransportError);
          if (observed) expect(await observed).toBe(failure);
          expect(f.stdout.listenerCount('data')).toBe(0);
          expect(f.stdout.listenerCount('end')).toBe(0);
          expect(f.stdout.listenerCount('close')).toBe(0);
          expect(f.stdout.listenerCount('error')).toBe(0);
        } finally {
          f.close();
        }
      }
    },
  );

  it('disposes discovery and invocation with the owning reason, without failure notification or residual abort listeners', async () => {
    for (let n = 0; n < 12; n++) {
      const f = fixture();
      const caller = new AbortController();
      const remove = jest.spyOn(caller.signal, 'removeEventListener');
      const observed = (
        n % 2
          ? f.connection.discover(caller.signal)
          : f.connection.invoke({
              toolName: 'tool',
              args: {},
              signal: caller.signal,
              onResponse() {},
            })
      ).catch((e) => e);
      const reason = { stopped: n };
      f.connection.dispose(reason);
      f.connection.dispose(reason);
      expect(await observed).toBe(reason);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(f.failure).not.toHaveBeenCalled();
      expect(f.stdout.listenerCount('data')).toBe(0);
      const lines = Reflect.get(f.connection, 'lines');
      const bounded = Reflect.get(f.connection, 'bounded');
      for (const event of ['line', 'close', 'error']) expect(lines.listenerCount(event)).toBe(0);
      for (const event of ['data', 'error']) expect(bounded.listenerCount(event)).toBe(0);
      expect(f.stdin.listenerCount('error')).toBe(0);
      f.close();
    }
  });

  it('preserves unknown response-hook identity and rejects concurrent exchange as an invariant', async () => {
    const f = fixture();
    const failure = new Error('hook');
    const observed = f.connection
      .invoke({
        toolName: 'tool',
        args: {},
        signal: signal(),
        onResponse() {
          throw failure;
        },
      })
      .catch((e) => e);
    try {
      await expect(
        f.connection.invoke({ toolName: 'tool', args: {}, signal: signal(), onResponse() {} }),
      ).rejects.toThrow('Concurrent');
      f.stdout.write(wire({ jsonrpc: '2.0', id: 1, result: {} }));
      expect(await observed).toBe(failure);
      expect(f.failure).toHaveBeenCalledWith(failure);
    } finally {
      f.close();
    }
  });

  it.each(['reader', 'roots-write', 'hook'] as const)(
    'fatal %s uncertainty precedes disposal, callback or subsequent roots effects',
    (kind) => {
      const f = fixture();
      const fatal = new PublicationOutcomeUnknownError();
      const unpipe = jest.spyOn(f.stdout, 'unpipe');
      const write = jest.spyOn(f.stdin, 'write');
      if (kind === 'hook')
        void f.connection.invoke({
          toolName: 'tool',
          args: {},
          signal: signal(),
          onResponse() {
            throw fatal;
          },
        });
      if (kind === 'roots-write')
        write.mockImplementation(() => {
          throw fatal;
        });
      try {
        expect(() => {
          if (kind === 'reader') f.stdout.emit('error', fatal);
          else
            // Assert at the owning callback: Node 24 pipe catches a thrown
            // destination write and schedules a second fatal error event.
            Reflect.get(f.connection, 'lines').emit(
              'line',
              JSON.stringify(
                kind === 'hook'
                  ? { jsonrpc: '2.0', id: 1, result: {} }
                  : { method: 'roots/list', id: 1 },
              ),
            );
        }).toThrow(fatal);
        expect(unpipe).not.toHaveBeenCalled();
        expect(f.failure).not.toHaveBeenCalled();
        expect(write).toHaveBeenCalledTimes(kind === 'reader' ? 0 : 1);
      } finally {
        // Test-owned teardown is deliberately not product cleanup after uncertainty.
        jest.restoreAllMocks();
        f.stdin.destroy();
        f.stdout.removeAllListeners();
        f.stdout.destroy();
      }
    },
  );

  it.each(['discovery', 'invocation'] as const)(
    'does not classify or clean up fatal %s request-write uncertainty',
    async (stage) => {
      const f = fixture();
      const fatal = new PublicationOutcomeUnknownError();
      const unpipe = jest.spyOn(f.stdout, 'unpipe');
      const write = jest.spyOn(f.stdin, 'write').mockImplementation(() => {
        throw fatal;
      });
      try {
        const operation =
          stage === 'discovery'
            ? f.connection.discover(signal())
            : f.connection.invoke({
                toolName: 'tool',
                args: {},
                signal: signal(),
                onResponse() {},
              });
        await expect(operation).rejects.toBe(fatal);
        expect(write).toHaveBeenCalledTimes(1);
        expect(unpipe).not.toHaveBeenCalled();
        expect(f.failure).not.toHaveBeenCalled();
      } finally {
        jest.restoreAllMocks();
        f.stdin.destroy();
        f.stdout.removeAllListeners();
        f.stdout.destroy();
      }
    },
  );

  it('does not advertise or manufacture roots without an admitted project', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const requests: any[] = [];
    const connection = new StdioMcpConnection({
      serverName: 'one',
      stdin,
      stdout,
      ids: { next: () => 1 },
      onFailure() {},
    });
    stdin.on('data', (bytes) => {
      const request = JSON.parse(bytes.toString());
      requests.push(request);
      if (request.method === 'initialize' || request.method === 'tools/list')
        stdout.write(wire({ jsonrpc: '2.0', id: request.id, result: { tools: [] } }));
    });
    try {
      await connection.discover(signal());
      stdout.write(wire({ method: 'roots/list', id: 9 }));
      expect(requests[0].params.capabilities).toEqual({});
      expect(requests).toHaveLength(3);
    } finally {
      connection.dispose(new Error('test complete'));
      stdin.destroy();
      stdout.destroy();
    }
  });
});
