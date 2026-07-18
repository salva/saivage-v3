import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveSyncInvalidateFrame, LiveSyncSubscribedFrame, WsConnectionState } from '../api/types';
import type { WsConnectionManager, WsEventHandler, WsOpenHandler, WsStateHandler, WsSyncFrameHandler } from '../api/websocket';
import { SyncClient } from '../sync/client';

function connectionHarness() {
  const syncHandlers = new Set<WsSyncFrameHandler>();
  const openHandlers = new Set<WsOpenHandler>();
  const conn: WsConnectionManager = {
    state: { value: 'offline' as WsConnectionState },
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

describe('application bootstrap live sync', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setActivePinia(createPinia());
  });

  it('owns one root load and wires scoped invalidation/reconnect with baseline suppression', async () => {
    const harness = connectionHarness();
    const client = new SyncClient(harness.conn);
    const runtimeRefetch = vi.fn(async () => undefined);
    const ensureRoot = vi.fn(async () => undefined);
    const reset = vi.fn();
    const onInvalidate = vi.fn();
    const onReconnect = vi.fn();
    const agentsRefetch = vi.fn(async () => undefined);
    const fetchSessions = vi.fn(async () => undefined);
    const authRefresh = vi.fn();
    vi.doMock('../sync/client', () => ({ syncClient: client }));
    vi.doMock('../stores/runtime', () => ({ useRuntimeStore: () => ({ refetch: runtimeRefetch, markWsSync: vi.fn() }) }));
    vi.doMock('../stores/cards', () => ({ useCardStore: () => ({ ensureRoot, reset, onInvalidate, onReconnect }) }));
    vi.doMock('../stores/agents', () => ({ useAgentStore: () => ({ fetchSessions, refetch: agentsRefetch, markWsSync: vi.fn() }) }));
    vi.doMock('../stores/auth', () => ({ AUTH_TOKEN_CHANGED_EVENT: 'saivage-auth-token-changed', useAuthStore: () => ({ refresh: authRefresh }) }));
    const { startAppBootstrap } = await import('../composables/useAppBootstrap');

    startAppBootstrap();
    await flush();
    expect(harness.conn.connect).toHaveBeenCalledTimes(1);
    expect(runtimeRefetch).toHaveBeenCalledTimes(1);
    expect(ensureRoot).toHaveBeenCalledTimes(1);
    expect(fetchSessions).toHaveBeenCalledTimes(1);
    expect(agentsRefetch).not.toHaveBeenCalled();
    startAppBootstrap();
    await flush();
    expect(harness.conn.connect).toHaveBeenCalledTimes(1);
    expect(runtimeRefetch).toHaveBeenCalledTimes(1);
    expect(ensureRoot).toHaveBeenCalledTimes(1);
    expect(fetchSessions).toHaveBeenCalledTimes(1);

    runtimeRefetch.mockClear();
    ensureRoot.mockClear();
    agentsRefetch.mockClear();

    harness.emit({ t: 'invalidate', resource: 'runtime' });
    await flush();
    expect(runtimeRefetch).toHaveBeenCalledTimes(1);
    expect(ensureRoot).not.toHaveBeenCalled();
    expect(agentsRefetch).not.toHaveBeenCalled();

    runtimeRefetch.mockClear();
    harness.emit({ t: 'invalidate', resource: 'cards', scope: 'children', card_id: 'project' });
    await flush();
    expect(ensureRoot).not.toHaveBeenCalled();
    expect(onInvalidate).toHaveBeenCalledWith({ t: 'invalidate', resource: 'cards', scope: 'children', card_id: 'project' });
    expect(runtimeRefetch).not.toHaveBeenCalled();
    expect(agentsRefetch).not.toHaveBeenCalled();

    ensureRoot.mockClear();
    harness.emit({ t: 'invalidate', resource: 'agents' });
    await flush();
    expect(agentsRefetch).toHaveBeenCalledTimes(1);
    expect(runtimeRefetch).not.toHaveBeenCalled();
    expect(ensureRoot).not.toHaveBeenCalled();

    agentsRefetch.mockClear();
    window.dispatchEvent(new Event('saivage-auth-token-changed'));
    await flush();
    expect(authRefresh).toHaveBeenCalledTimes(1);
    expect(harness.conn.reconfigure).toHaveBeenCalledTimes(1);
    expect(runtimeRefetch).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(ensureRoot).toHaveBeenCalledTimes(1);
    expect(agentsRefetch).toHaveBeenCalledTimes(1);
    expect(fetchSessions).toHaveBeenCalledTimes(1);
    harness.open();
    expect(onReconnect).not.toHaveBeenCalled();
    harness.open();
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});
