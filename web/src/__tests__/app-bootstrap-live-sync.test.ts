import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveSyncInvalidateFrame, LiveSyncSubscribedFrame, WsConnectionState } from '../api/types';
import type { WsConnectionManager, WsEventHandler, WsOpenHandler, WsStateHandler, WsSyncFrameHandler } from '../api/websocket';
import { SyncClient } from '../sync/client';

let authEventSequence = 0;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function connectionHarness(initial: WsConnectionState = 'offline') {
  const syncHandlers = new Set<WsSyncFrameHandler>();
  const openHandlers = new Set<WsOpenHandler>();
  const conn: WsConnectionManager = {
    state: { value: initial },
    sessionId: { value: null },
    connect: vi.fn(),
    disconnect: vi.fn(),
    reconfigure: vi.fn(),
    sendMessage: vi.fn(),
    sendRaw: vi.fn(() => true),
    onEvent: vi.fn((_handler: WsEventHandler) => () => undefined),
    onSyncFrame: vi.fn((handler) => { syncHandlers.add(handler); return () => syncHandlers.delete(handler); }),
    onOpen: vi.fn((handler: WsOpenHandler) => { openHandlers.add(handler); return () => openHandlers.delete(handler); }),
    onState: vi.fn((_handler: WsStateHandler) => () => undefined),
  };
  return {
    conn,
    emit(frame: LiveSyncInvalidateFrame | LiveSyncSubscribedFrame) { for (const handler of syncHandlers) handler(frame); },
    open() { for (const handler of openHandlers) handler(); },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function installBootstrapMocks(options: {
  client: SyncClient;
  roots: Array<Promise<void>>;
  aggregate?: Promise<void>;
  ledger: string[];
}) {
  const authEvent = `saivage-test-auth-token-changed-${++authEventSequence}`;
  let activeToken: object | null = null;
  let gateOpen = true;
  let tokenNumber = 0;
  const fetchSessions = vi.fn(async () => {
    options.ledger.push(`agents:${gateOpen ? 'request' : 'gated'}`);
    if (!gateOpen) return false;
    await (options.aggregate ?? Promise.resolve());
    return true;
  });
  const beginSessionsBootstrap = vi.fn(() => {
    const token = { id: ++tokenNumber };
    options.ledger.push(`begin:${token.id}`);
    activeToken = token;
    gateOpen = false;
    return token;
  });
  const finishSessionsBootstrap = vi.fn(async (token: object) => {
    options.ledger.push(`finish:${(token as { id: number }).id}`);
    if (activeToken !== token) return;
    activeToken = null;
    gateOpen = true;
    await fetchSessions();
  });
  const ensureRoot = vi.fn(() => {
    options.ledger.push('root');
    const next = options.roots.shift();
    if (!next) throw new Error('Unexpected root attempt');
    return next;
  });
  const runtimeRefetch = vi.fn(async () => { options.ledger.push('runtime'); });
  const reset = vi.fn(() => { options.ledger.push('reset'); });
  const authRefresh = vi.fn(() => { options.ledger.push('auth'); });
  vi.doMock('../sync/client', () => ({ syncClient: options.client }));
  vi.doMock('../stores/runtime', () => ({ useRuntimeStore: () => ({ refetch: runtimeRefetch, markWsSync: vi.fn() }) }));
  vi.doMock('../stores/cards', () => ({ useCardStore: () => ({ ensureRoot, reset, onInvalidate: vi.fn(), onReconnect: vi.fn() }) }));
  vi.doMock('../stores/agents', () => ({ useAgentStore: () => ({ fetchSessions, beginSessionsBootstrap, finishSessionsBootstrap, markWsSync: vi.fn() }) }));
  vi.doMock('../stores/auth', () => ({ AUTH_TOKEN_CHANGED_EVENT: authEvent, useAuthStore: () => ({ refresh: authRefresh }) }));
  return { fetchSessions, beginSessionsBootstrap, finishSessionsBootstrap, ensureRoot, authEvent };
}

describe('application bootstrap live sync', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setActivePinia(createPinia());
  });

  it.each(['success', 'failure'] as const)('defers the one initial Agent request until root %s and consumes the first socket open as baseline', async (outcome) => {
    const harness = connectionHarness();
    const client = new SyncClient(harness.conn);
    const root = deferred<void>();
    const aggregate = deferred<void>();
    const ledger: string[] = [];
    const mocks = installBootstrapMocks({ client, roots: [root.promise], aggregate: aggregate.promise, ledger });
    const { startAppBootstrap } = await import('../composables/useAppBootstrap');

    startAppBootstrap();
    startAppBootstrap();
    harness.emit({ t: 'invalidate', resource: 'agents' });
    await flush();
    expect(ledger).toEqual(['begin:1', 'runtime', 'root', 'agents:gated']);
    expect(harness.conn.connect).toHaveBeenCalledOnce();

    if (outcome === 'success') root.resolve(undefined);
    else root.reject(new Error('root failed'));
    await flush();
    expect(ledger).toEqual(['begin:1', 'runtime', 'root', 'agents:gated', 'finish:1', 'agents:request']);
    expect(mocks.fetchSessions).toHaveBeenCalledTimes(2);

    harness.open();
    await flush();
    expect(mocks.fetchSessions).toHaveBeenCalledTimes(2);
    aggregate.resolve(undefined);
    await flush();
  });

  it('supersedes an old root before reconfigure and lets only replacement-root settlement start Agents', async () => {
    const harness = connectionHarness('connected');
    const client = new SyncClient(harness.conn);
    const oldRoot = deferred<void>();
    const replacementRoot = deferred<void>();
    const ledger: string[] = [];
    vi.mocked(harness.conn.reconfigure).mockImplementation(() => { ledger.push('reconfigure'); });
    const mocks = installBootstrapMocks({ client, roots: [oldRoot.promise, replacementRoot.promise], ledger });
    const { startAppBootstrap } = await import('../composables/useAppBootstrap');
    startAppBootstrap();
    await flush();

    window.dispatchEvent(new Event(mocks.authEvent));
    await flush();
    expect(ledger).toEqual(['runtime', 'begin:1', 'runtime', 'root', 'auth', 'begin:2', 'reconfigure', 'runtime', 'reset', 'root']);
    expect(harness.conn.reconfigure).toHaveBeenCalledOnce();

    oldRoot.resolve(undefined);
    await flush();
    expect(ledger).toContain('finish:1');
    expect(ledger).not.toContain('agents:request');

    harness.open();
    await flush();
    expect(mocks.fetchSessions).not.toHaveBeenCalled();

    replacementRoot.resolve(undefined);
    await flush();
    expect(ledger.at(-2)).toBe('finish:2');
    expect(ledger.at(-1)).toBe('agents:request');
    expect(mocks.fetchSessions).toHaveBeenCalledOnce();
  });
});
