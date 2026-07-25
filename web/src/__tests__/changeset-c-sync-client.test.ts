import { describe, expect, it, vi } from 'vitest';
import { SyncClient } from '../sync/client';
import type { WsConnectionManager, WsOpenHandler, WsSyncFrameHandler } from '../api/websocket';

function harness() {
  let open: WsOpenHandler = () => {};
  let sync: WsSyncFrameHandler = () => {};
  const sent: unknown[] = [];
  const conn = {
    state: { value: 'connected' as const },
    sessionId: { value: null },
    connect: vi.fn(),
    disconnect: vi.fn(),
    reconfigure: vi.fn(),
    sendMessage: vi.fn(),
    sendRaw: vi.fn((value) => {
      sent.push(value);
      return true;
    }),
    onEvent: vi.fn(() => () => {}),
    onState: vi.fn(() => () => {}),
    onOpen: vi.fn((handler) => {
      open = handler;
      return () => {};
    }),
    onSyncFrame: vi.fn((handler) => {
      sync = handler;
      return () => {};
    }),
  } satisfies WsConnectionManager;
  const client = new SyncClient(conn);
  client.start();
  open();
  return {
    client,
    sent,
    sync: (frame: Parameters<WsSyncFrameHandler>[0]) => sync(frame),
    reconnect: () => open(),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('changeset C lease ownership', () => {
  it('waits for the exact ack and retains one trailing invalidation', async () => {
    const h = harness();
    let release!: () => void;
    const baseline = new Promise<void>((resolve) => {
      release = resolve;
    });
    const callback = vi
      .fn()
      .mockImplementationOnce(() => baseline)
      .mockResolvedValue(undefined);
    h.client.openConversation('agent:planner:project', callback);
    const subscribe = h.sent.at(-1) as { lease: string };
    expect(callback).not.toHaveBeenCalled();
    h.sync({
      t: 'invalidate',
      resource: 'conversation',
      id: 'agent:planner:project',
      through_message_id: 'z',
    });
    h.sync({
      t: 'subscribed',
      resource: 'conversation',
      id: 'agent:planner:project',
      lease: 'stale',
    });
    expect(callback).not.toHaveBeenCalled();
    h.sync({
      t: 'subscribed',
      resource: 'conversation',
      id: 'agent:planner:project',
      lease: subscribe.lease,
    });
    expect(callback).toHaveBeenCalledTimes(1);
    h.sync({
      t: 'invalidate',
      resource: 'conversation',
      id: 'agent:planner:project',
      through_message_id: 'a',
    });
    release();
    await flush();
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('does not let a pre-reconnect completion release the new generation single flight', async () => {
    const h = harness();
    let releaseOld!: () => void;
    let releaseCurrent!: () => void;
    const oldRequest = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const currentRequest = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const callback = vi
      .fn()
      .mockImplementationOnce(() => oldRequest)
      .mockImplementationOnce(() => currentRequest)
      .mockResolvedValue(undefined);

    h.client.openConversation('agent:planner:project', callback);
    const firstSubscribe = h.sent.at(-1) as { lease: string };
    h.sync({
      t: 'subscribed',
      resource: 'conversation',
      id: 'agent:planner:project',
      lease: firstSubscribe.lease,
    });
    expect(callback).toHaveBeenCalledTimes(1);

    h.reconnect();
    const reconnectSubscribe = h.sent.at(-1) as { lease: string };
    expect(reconnectSubscribe.lease).not.toBe(firstSubscribe.lease);
    h.sync({
      t: 'subscribed',
      resource: 'conversation',
      id: 'agent:planner:project',
      lease: reconnectSubscribe.lease,
    });
    expect(callback).toHaveBeenCalledTimes(2);

    releaseOld();
    await flush();
    h.sync({
      t: 'invalidate',
      resource: 'conversation',
      id: 'agent:planner:project',
      through_message_id: 'a',
    });
    expect(callback).toHaveBeenCalledTimes(2);
    releaseCurrent();
    await flush();
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it('routes exchange independently and exact-unsubscribes the final owner', async () => {
    const h = harness();
    const exchange = vi.fn().mockResolvedValue(undefined);
    const conversation = vi.fn().mockResolvedValue(undefined);
    const close = h.client.openLlmExchange('agent:planner:project', exchange);
    h.client.openConversation('agent:planner:project', conversation);
    const exchangeSubscribe = h.sent.find(
      (value) => (value as { resource?: string }).resource === 'llm-exchange',
    ) as { lease: string };
    h.sync({
      t: 'subscribed',
      resource: 'llm-exchange',
      id: 'agent:planner:project',
      lease: exchangeSubscribe.lease,
    });
    await flush();
    h.sync({ t: 'invalidate', resource: 'llm-exchange', id: 'agent:planner:project' });
    await flush();
    expect(exchange).toHaveBeenCalledTimes(2);
    expect(conversation).not.toHaveBeenCalled();
    close();
    expect(h.sent.at(-1)).toEqual({
      t: 'unsubscribe',
      resource: 'llm-exchange',
      id: 'agent:planner:project',
      lease: exchangeSubscribe.lease,
    });
  });
});
