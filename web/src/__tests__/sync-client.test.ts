import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { LiveSyncInvalidateFrame, LiveSyncSubscribedFrame, WsConnectionState } from '../api/types';
import type { WsConnectionManager, WsEventHandler, WsOpenHandler, WsStateHandler, WsSyncFrameHandler } from '../api/websocket';
import { SyncClient, type SyncResourceRegistration } from '../sync/client';
import { useAnalystChat } from '../stores/analystChat';
import { useFeedbackStore } from '../stores/feedback';

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (reason: unknown) => void } {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createConn(initial: WsConnectionState = 'offline') {
  const openHandlers = new Set<WsOpenHandler>();
  const stateHandlers = new Set<WsStateHandler>();
  const syncHandlers = new Set<WsSyncFrameHandler>();
  const eventHandlers = new Set<WsEventHandler>();
  const conn: WsConnectionManager = {
    state: { value: initial },
    sessionId: { value: null },
    connect: vi.fn(),
    disconnect: vi.fn(),
    reconfigure: vi.fn(),
    sendMessage: vi.fn(),
    sendRaw: vi.fn(() => true),
    onEvent: vi.fn((handler) => { eventHandlers.add(handler); return () => eventHandlers.delete(handler); }),
    onSyncFrame: vi.fn((handler) => { syncHandlers.add(handler); return () => syncHandlers.delete(handler); }),
    onOpen: vi.fn((handler) => { openHandlers.add(handler); return () => openHandlers.delete(handler); }),
    onState: vi.fn((handler) => { stateHandlers.add(handler); return () => stateHandlers.delete(handler); }),
  };
  return {
    conn,
    emitOpen() { for (const handler of openHandlers) handler(); },
    emitSync(frame: LiveSyncInvalidateFrame | LiveSyncSubscribedFrame) { for (const handler of syncHandlers) handler(frame); },
    emitEvent(envelope: Parameters<WsEventHandler>[0]) { for (const handler of eventHandlers) handler(envelope); },
    setState(state: WsConnectionState) {
      conn.state.value = state;
      for (const handler of stateHandlers) handler(state);
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('SyncClient', () => {
  let entropyCall = 0;
  let getRandomValues: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setActivePinia(createPinia());
    entropyCall = 0;
    getRandomValues = vi.fn((bytes: Uint8Array) => {
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.byteLength).toBe(16);
      const offset = entropyCall++ * 16;
      bytes.forEach((_, index) => { bytes[index] = offset + index; });
      return bytes;
    });
    vi.stubGlobal('crypto', { getRandomValues });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('connects once, suppresses the Cards baseline open, then heals on reconnect', async () => {
    const { conn, emitOpen } = createConn();
    const client = new SyncClient(conn);
    const onReconnect = vi.fn();

    client.register({ resource: 'cards', onInvalidate: vi.fn(), onReconnect });
    client.start();
    client.start();
    emitOpen();
    await flush();

    expect(conn.connect).toHaveBeenCalledTimes(1);
    expect(onReconnect).not.toHaveBeenCalled();
    emitOpen();
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('delivers every exact Cards invalidation immediately without trailing state', async () => {
    const { conn, emitSync } = createConn();
    const client = new SyncClient(conn);
    const onInvalidate = vi.fn();
    client.register({ resource: 'cards', onInvalidate, onReconnect: vi.fn() });
    client.start();

    emitSync({ t: 'invalidate', resource: 'cards', scope: 'detail', card_id: 'card-a' });
    emitSync({ t: 'invalidate', resource: 'cards', scope: 'record', card_id: 'card-a', slot: 'brief' });
    await flush();
    expect(onInvalidate.mock.calls.map(([target]) => target)).toEqual([
      { t: 'invalidate', resource: 'cards', scope: 'detail', card_id: 'card-a' },
      { t: 'invalidate', resource: 'cards', scope: 'record', card_id: 'card-a', slot: 'brief' },
    ]);
  });

  it('resets baseline suppression synchronously on every reconfigure', () => {
    const { conn, emitOpen } = createConn();
    const client = new SyncClient(conn);
    const onReconnect = vi.fn();
    client.register({ resource: 'cards', onInvalidate: vi.fn(), onReconnect });
    client.start();
    emitOpen(); emitOpen();
    expect(onReconnect).toHaveBeenCalledTimes(1);
    client.reconfigure(); client.reconfigure();
    expect(conn.reconfigure).toHaveBeenCalledTimes(2);
    emitOpen();
    expect(onReconnect).toHaveBeenCalledTimes(1);
    emitOpen();
    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  it('keeps non-Cards refetches single-flight with one trailing call and settlement callback', async () => {
    const { conn, emitSync } = createConn();
    const client = new SyncClient(conn);
    const first = deferred();
    const second = deferred();
    const refetch = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const onRefetch = vi.fn();
    client.register({ resource: 'runtime', scope: 'core', refetch, onRefetch });
    client.start();

    emitSync({ t: 'invalidate', resource: 'runtime' });
    emitSync({ t: 'invalidate', resource: 'runtime' });
    await flush();
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(onRefetch).not.toHaveBeenCalled();

    first.resolve();
    await flush();
    expect(refetch).toHaveBeenCalledTimes(2);
    expect(onRefetch).toHaveBeenCalledTimes(1);
    expect(onRefetch).toHaveBeenCalledWith(expect.any(String));

    second.resolve();
    await flush();
    expect(onRefetch).toHaveBeenCalledTimes(1);
  });

  it('uses a Cards-specific registration boundary', () => {
    const { conn } = createConn();
    const client = new SyncClient(conn);
    const cardsRegistration = {
      resource: 'cards',
      onInvalidate: vi.fn(),
      onReconnect: vi.fn(),
    } satisfies SyncResourceRegistration;
    const runtimeRegistration = {
      resource: 'runtime',
      scope: 'core',
      refetch: async () => undefined,
      onRefetch: (_timestamp: string) => undefined,
    } satisfies SyncResourceRegistration;
    client.register(cardsRegistration)();
    client.register(runtimeRegistration)();
  });

  it('ignores invalidations for inactive resources', async () => {
    const { conn, emitSync } = createConn();
    const client = new SyncClient(conn);
    const refetch = vi.fn(async () => undefined);
    client.register({ resource: 'files', scope: 'active', refetch })();

    emitSync({ t: 'invalidate', resource: 'files' });
    await flush();

    expect(refetch).not.toHaveBeenCalled();
  });

  it('subscribes without randomUUID, refetches on acknowledgement, and unsubscribes with the current opaque lease', async () => {
    const { conn, emitOpen, emitSync, setState } = createConn();
    const client = new SyncClient(conn);
    const refetch = vi.fn(async () => undefined);

    expect('randomUUID' in globalThis.crypto).toBe(false);

    const close = client.openConversation('planner:project', refetch);
    await flush();
    expect(conn.sendRaw).not.toHaveBeenCalled();
    expect(refetch).not.toHaveBeenCalled();

    client.start();
    setState('connected');
    emitOpen();
    await flush();
    const subscribe = vi.mocked(conn.sendRaw).mock.calls.at(-1)![0] as { t: string; resource: string; id: string; lease: string };
    expect(subscribe).toMatchObject({ t: 'subscribe', resource: 'conversation', id: 'planner:project' });
    expect(subscribe.lease).toBe('000102030405060708090a0b0c0d0e0f');
    expect(subscribe.lease).toMatch(/^[0-9a-f]{32}$/);
    expect(subscribe.lease).not.toContain('-');
    expect(getRandomValues).toHaveBeenCalledTimes(1);
    expect(client.connectionState.value).toBe('connected');
    emitSync({ t: 'subscribed', resource: 'conversation', id: 'planner:project', lease: subscribe.lease });
    await flush();
    expect(refetch).toHaveBeenCalledTimes(1);

    emitSync({ t: 'invalidate', resource: 'conversation', id: 'planner:project' });
    await flush();
    expect(refetch).toHaveBeenCalledTimes(2);

    close();
    expect(conn.sendRaw).toHaveBeenCalledWith({ t: 'unsubscribe', resource: 'conversation', id: 'planner:project', lease: subscribe.lease });
  });

  it('shares one conversation subscription until its final consumer leaves', async () => {
    const { conn, emitOpen, emitSync } = createConn();
    const client = new SyncClient(conn);
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    const closeFirst = client.openConversation('planner:project', first);
    const closeSecond = client.openConversation('planner:project', second);
    client.start();
    emitOpen();
    await flush();

    const subscriptions = vi.mocked(conn.sendRaw).mock.calls.map(([frame]) => frame).filter((frame: any) => frame.t === 'subscribe');
    expect(subscriptions).toHaveLength(1);
    const lease = (subscriptions[0] as any).lease;
    emitSync({ t: 'subscribed', resource: 'conversation', id: 'planner:project', lease });
    await flush();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    closeFirst();
    expect(vi.mocked(conn.sendRaw).mock.calls.map(([frame]) => frame).filter((frame: any) => frame.t === 'unsubscribe')).toHaveLength(0);
    closeSecond();
    expect(conn.sendRaw).toHaveBeenLastCalledWith({ t: 'unsubscribe', resource: 'conversation', id: 'planner:project', lease });
  });

  it('subscribes every mounted conversation when the socket opens', () => {
    const { conn, emitOpen } = createConn();
    const client = new SyncClient(conn);
    client.openConversation('planner:project', async () => undefined);
    client.openConversation('analyst:global', async () => undefined);
    client.start();

    emitOpen();

    expect(vi.mocked(conn.sendRaw).mock.calls.map(([frame]) => frame)).toEqual([
      { t: 'subscribe', resource: 'conversation', id: 'planner:project', lease: '000102030405060708090a0b0c0d0e0f' },
      { t: 'subscribe', resource: 'conversation', id: 'analyst:global', lease: '101112131415161718191a1b1c1d1e1f' },
    ]);
  });

  it('ignores a stale acknowledgement and refetches only after the current lease is acknowledged', async () => {
    const { conn, emitOpen, emitSync } = createConn();
    const client = new SyncClient(conn);
    const refetch = vi.fn(async () => undefined);
    client.openConversation('planner:project', refetch);
    client.start();
    emitOpen();
    await flush();
    const firstLease = (vi.mocked(conn.sendRaw).mock.calls.at(-1)![0] as any).lease;
    emitOpen();
    await flush();
    const currentLease = (vi.mocked(conn.sendRaw).mock.calls.at(-1)![0] as any).lease;

    expect(firstLease).toBe('000102030405060708090a0b0c0d0e0f');
    expect(currentLease).toBe('101112131415161718191a1b1c1d1e1f');
    expect(currentLease).not.toBe(firstLease);
    expect(getRandomValues).toHaveBeenCalledTimes(2);

    emitSync({ t: 'subscribed', resource: 'conversation', id: 'planner:project', lease: firstLease });
    await flush();
    expect(refetch).not.toHaveBeenCalled();
    emitSync({ t: 'subscribed', resource: 'conversation', id: 'planner:project', lease: currentLease });
    await flush();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps connected transport state after a failed send and makes a fresh attempt only on reconnect', async () => {
    const { conn, emitOpen, setState } = createConn();
    vi.mocked(conn.sendRaw).mockReturnValue(false);
    const client = new SyncClient(conn);
    const refetch = vi.fn(async () => undefined);
    const close = client.openConversation('planner:project', refetch);
    client.start();
    setState('connected');

    emitOpen();
    await flush();
    const firstLease = (vi.mocked(conn.sendRaw).mock.calls.at(-1)![0] as any).lease;
    expect(refetch).not.toHaveBeenCalled();
    expect(client.connectionState.value).toBe('connected');

    emitOpen();
    await flush();
    const secondLease = (vi.mocked(conn.sendRaw).mock.calls.at(-1)![0] as any).lease;
    expect(secondLease).not.toBe(firstLease);
    expect(conn.sendRaw).toHaveBeenCalledTimes(2);
    expect(refetch).not.toHaveBeenCalled();
    expect(client.connectionState.value).toBe('connected');

    close();
    expect(conn.sendRaw).toHaveBeenLastCalledWith({ t: 'unsubscribe', resource: 'conversation', id: 'planner:project', lease: secondLease });
  });

  it('refetches conversations only from canonical live-sync invalidate frames', async () => {
    const harness = createConn();
    const client = new SyncClient(harness.conn);
    const refetch = vi.fn(async () => undefined);
    client.openConversation('analyst:global', refetch);
    client.start();
    await flush();
    refetch.mockClear();

    harness.emitEvent({
      type: 'activity',
      content: { event: 'analyst_tool_invoked', session_id: 'analyst:global', tool: 'read', summary: 'opened docs', success: true },
    } as Parameters<WsEventHandler>[0]);
    await flush();
    expect(refetch).not.toHaveBeenCalled();

    harness.emitSync({ t: 'invalidate', resource: 'conversation', id: 'analyst:global' });
    await flush();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('ingests only canonical Analyst WS restart acknowledgements through the shared presenter', async () => {
    const harness = createConn();
    const client = new SyncClient(harness.conn);
    const chat = useAnalystChat();
    client.start();

    harness.emitEvent({
      type: 'status',
      content: { event: 'analyst_turn_acknowledged', sessionId: 'other-session', restart: { status: 'confirmation_required', confirmationMessage: 'RESTART SERVER' } },
    } as Parameters<WsEventHandler>[0]);
    expect(chat.restartAcknowledgement).toBeNull();

    harness.emitEvent({
      type: 'status',
      content: { event: 'analyst_turn_acknowledged', sessionId: 'analyst:global', restart: { status: 'confirmation_required', confirmationMessage: 'RESTART SERVER' } },
    } as Parameters<WsEventHandler>[0]);
    expect(chat.restartAcknowledgement).toEqual({ status: 'confirmation_required', confirmationMessage: 'RESTART SERVER' });

    harness.emitEvent({
      type: 'status',
      content: { event: 'analyst_turn_acknowledged', sessionId: 'analyst:global', restart: { status: 'scheduled' } },
    } as Parameters<WsEventHandler>[0]);
    expect(chat.restartAcknowledgement).toBeNull();
    expect(useFeedbackStore().toasts).toContainEqual(expect.objectContaining({ title: 'Server restart scheduled' }));
  });
});
