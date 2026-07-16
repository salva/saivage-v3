import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveSyncInvalidateFrame, LiveSyncSubscribedFrame, WsConnectionState } from '../api/types';
import type { WsConnectionManager, WsEventHandler, WsOpenHandler, WsStateHandler, WsSyncFrameHandler } from '../api/websocket';
import { SyncClient } from '../sync/client';

function connectionHarness() {
  const syncHandlers = new Set<WsSyncFrameHandler>();
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
    onOpen: vi.fn((_handler: WsOpenHandler) => () => undefined),
    onState: vi.fn((_handler: WsStateHandler) => () => undefined),
  };
  return {
    conn,
    emit(frame: LiveSyncInvalidateFrame | LiveSyncSubscribedFrame) { for (const handler of syncHandlers) handler(frame); },
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

  it('registers the runtime refetch through bootstrap and dispatches the canonical runtime frame', async () => {
    const harness = connectionHarness();
    const client = new SyncClient(harness.conn);
    const runtimeRefetch = vi.fn(async () => undefined);
    vi.doMock('../sync/client', () => ({ syncClient: client }));
    vi.doMock('../stores/runtime', () => ({ useRuntimeStore: () => ({ refetch: runtimeRefetch, markWsSync: vi.fn() }) }));
    vi.doMock('../stores/cards', () => ({ useCardStore: () => ({ refetch: vi.fn(async () => undefined) }) }));
    vi.doMock('../stores/agents', () => ({ useAgentStore: () => ({ refetch: vi.fn(async () => undefined), markWsSync: vi.fn() }) }));
    vi.doMock('../stores/auth', () => ({ AUTH_TOKEN_CHANGED_EVENT: 'saivage-auth-token-changed', useAuthStore: () => ({ refresh: vi.fn() }) }));
    const { startAppBootstrap } = await import('../composables/useAppBootstrap');

    startAppBootstrap();
    await flush();
    expect(harness.conn.connect).toHaveBeenCalledTimes(1);
    expect(runtimeRefetch).toHaveBeenCalledTimes(1);
    runtimeRefetch.mockClear();

    harness.emit({ t: 'invalidate', resource: 'runtime' });
    await flush();

    expect(runtimeRefetch).toHaveBeenCalledTimes(1);
  });
});
