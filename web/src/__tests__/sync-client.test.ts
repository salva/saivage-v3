import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { LiveSyncInvalidateFrame, LiveSyncSubscribedFrame, WsConnectionState } from '../api/types';
import type { WsConnectionManager, WsEventHandler, WsOpenHandler, WsStateHandler, WsSyncFrameHandler } from '../api/websocket';
import { SyncClient } from '../sync/client';
import { useAnalystChat } from '../stores/analystChat';
import { useFeedbackStore } from '../stores/feedback';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
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
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('connects once and refetches registered resources on open', async () => {
    const { conn, emitOpen } = createConn();
    const client = new SyncClient(conn);
    const refetch = vi.fn(async () => undefined);

    client.register({ resource: 'cards', scope: 'core', refetch });
    client.start();
    client.start();
    emitOpen();
    await flush();

    expect(conn.connect).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('uses single-flight plus trailing refetch per resource', async () => {
    const { conn, emitSync } = createConn();
    const client = new SyncClient(conn);
    const first = deferred();
    const refetch = vi.fn(() => first.promise);
    client.register({ resource: 'cards', scope: 'core', refetch });
    client.start();
    await flush();
    refetch.mockClear();

    emitSync({ t: 'invalidate', resource: 'cards' });
    emitSync({ t: 'invalidate', resource: 'cards' });
    await flush();
    expect(refetch).toHaveBeenCalledTimes(1);

    first.resolve();
    await flush();
    expect(refetch).toHaveBeenCalledTimes(2);
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

  it('subscribes, refetches, resubscribes, and unsubscribes scoped conversations', async () => {
    const { conn, emitOpen, emitSync } = createConn();
    const client = new SyncClient(conn);
    const refetch = vi.fn(async () => undefined);

    const close = client.openConversation('planner:g1', refetch);
    await flush();
    expect(conn.sendRaw).not.toHaveBeenCalled();
    expect(refetch).not.toHaveBeenCalled();

    client.start();
    emitOpen();
    await flush();
    const subscribe = vi.mocked(conn.sendRaw).mock.calls.at(-1)![0] as { t: string; resource: string; id: string; lease: string };
    expect(subscribe).toMatchObject({ t: 'subscribe', resource: 'conversation', id: 'planner:g1' });
    emitSync({ t: 'subscribed', resource: 'conversation', id: 'planner:g1', lease: subscribe.lease });
    await flush();
    expect(refetch).toHaveBeenCalledTimes(1);

    emitSync({ t: 'invalidate', resource: 'conversation', id: 'planner:g1' });
    await flush();
    expect(refetch).toHaveBeenCalledTimes(2);

    close();
    expect(conn.sendRaw).toHaveBeenCalledWith({ t: 'unsubscribe', resource: 'conversation', id: 'planner:g1', lease: subscribe.lease });
  });

  it('shares one conversation lease and refetches every current consumer after acknowledgement', async () => {
    const { conn, emitOpen, emitSync } = createConn();
    const client = new SyncClient(conn);
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    client.openConversation('planner:g1', first);
    client.openConversation('planner:g1', second);
    client.start();
    emitOpen();
    await flush();

    const subscriptions = vi.mocked(conn.sendRaw).mock.calls.map(([frame]) => frame).filter((frame: any) => frame.t === 'subscribe');
    expect(subscriptions).toHaveLength(1);
    const lease = (subscriptions[0] as any).lease;
    emitSync({ t: 'subscribed', resource: 'conversation', id: 'planner:g1', lease });
    await flush();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale acknowledgement and refetches only after the current lease is acknowledged', async () => {
    const { conn, emitOpen, emitSync } = createConn();
    const client = new SyncClient(conn);
    const refetch = vi.fn(async () => undefined);
    client.openConversation('planner:g1', refetch);
    client.start();
    emitOpen();
    await flush();
    const firstLease = (vi.mocked(conn.sendRaw).mock.calls.at(-1)![0] as any).lease;
    emitOpen();
    await flush();
    const currentLease = (vi.mocked(conn.sendRaw).mock.calls.at(-1)![0] as any).lease;

    emitSync({ t: 'subscribed', resource: 'conversation', id: 'planner:g1', lease: firstLease });
    await flush();
    expect(refetch).not.toHaveBeenCalled();
    emitSync({ t: 'subscribed', resource: 'conversation', id: 'planner:g1', lease: currentLease });
    await flush();
    expect(refetch).toHaveBeenCalledTimes(1);
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
