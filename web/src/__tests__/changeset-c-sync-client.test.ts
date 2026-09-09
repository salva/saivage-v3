import { describe, expect, it, vi } from 'vitest';
import { SyncClient } from '../sync/client';
import type { WsConnectionManager, WsOpenHandler, WsSyncFrameHandler } from '../api/websocket';

function harness() {
  let open: WsOpenHandler = () => {};
  let sync: WsSyncFrameHandler = () => {};
  const sent: unknown[] = [];
  const conn = {
    state: { value: 'connected' as const },
    connect: vi.fn(),
    reconfigure: vi.fn(),
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

function pending<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function acknowledgeAgents(h: ReturnType<typeof harness>) {
  const subscribe = h.sent.find(
    (value) => (value as { t?: string; resource?: string }).t === 'subscribe'
      && (value as { resource?: string }).resource === 'agents',
  ) as { lease: string };
  h.sync({ t: 'subscribed', resource: 'agents', lease: subscribe.lease });
  return subscribe;
}

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
      segment_version: 1, visible_message_id: 'z',
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
      segment_version: 1, visible_message_id: 'a',
    });
    release();
    await flush();
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('serializes within each generation without letting old completion gate or drain the new generation', async () => {
    const h = harness();
    const order: string[] = [];
    let releaseOld!: () => void;
    let releaseCurrent!: () => void;
    const oldRequest = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const currentRequest = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const callback = vi.fn((frame) => {
      if (callback.mock.calls.length === 1) {
        order.push('old null start');
        return oldRequest.then(() => { order.push('old null settle'); });
      }
      if (callback.mock.calls.length === 2) {
        order.push('new null start');
        return currentRequest.then(() => { order.push('new null settle'); });
      }
      order.push('current invalidation start');
      expect(frame).toMatchObject({ t: 'invalidate', visible_message_id: 'a' });
      return Promise.resolve();
    });

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
    expect(order).toEqual(['old null start', 'new null start']);

    h.sync({
      t: 'subscribed',
      resource: 'conversation',
      id: 'agent:planner:project',
      lease: firstSubscribe.lease,
    });
    h.sync({
      t: 'invalidate',
      resource: 'conversation',
      id: 'agent:planner:project',
      segment_version: 1, visible_message_id: 'a',
    });

    releaseOld();
    await flush();
    expect(callback).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['old null start', 'new null start', 'old null settle']);
    releaseCurrent();
    await flush();
    expect(callback).toHaveBeenCalledTimes(3);
    expect(order).toEqual([
      'old null start',
      'new null start',
      'old null settle',
      'new null settle',
      'current invalidation start',
    ]);
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

  it.each([
    {
      name: 'same card scope remains scoped',
      pendingFrames: [
        { t: 'invalidate', resource: 'agent-membership', scope: 'card', card_id: 'card-a' },
        { t: 'invalidate', resource: 'agent-membership', scope: 'card', card_id: 'card-a' },
      ],
      expected: { t: 'invalidate', resource: 'agent-membership', scope: 'card', card_id: 'card-a' },
    },
    {
      name: 'distinct card scopes broaden',
      pendingFrames: [
        { t: 'invalidate', resource: 'agent-membership', scope: 'card', card_id: 'card-a' },
        { t: 'invalidate', resource: 'agent-membership', scope: 'card', card_id: 'card-b' },
      ],
      expected: null,
    },
    {
      name: 'mixed card and global-session scopes broaden',
      pendingFrames: [
        { t: 'invalidate', resource: 'agent-membership', scope: 'card', card_id: 'card-a' },
        { t: 'invalidate', resource: 'agent-membership', scope: 'global-session', session_id: 'agent:analyst:global' },
      ],
      expected: null,
    },
    {
      name: 'a broadened request remains absorbing through a third event',
      pendingFrames: [
        { t: 'invalidate', resource: 'agent-membership', scope: 'card', card_id: 'card-a' },
        { t: 'invalidate', resource: 'agent-membership', scope: 'card', card_id: 'card-b' },
        { t: 'invalidate', resource: 'agent-membership', scope: 'card', card_id: 'card-b' },
      ],
      expected: null,
    },
  ])('$name while an Agents callback is held', async ({ pendingFrames, expected }) => {
    const h = harness();
    const held = pending();
    const callback = vi.fn().mockResolvedValue(undefined);
    callback.mockImplementationOnce(async () => undefined).mockImplementationOnce(() => held.promise);
    h.client.openAgents(callback);
    acknowledgeAgents(h);
    await flush();
    callback.mockClear();

    h.sync({ t: 'invalidate', resource: 'agent-membership', scope: 'card', card_id: 'card-held' });
    expect(callback).toHaveBeenCalledOnce();
    for (const frame of pendingFrames) h.sync(frame as Parameters<WsSyncFrameHandler>[0]);
    expect(callback).toHaveBeenCalledOnce();

    held.resolve(undefined);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(2));
    expect(callback).toHaveBeenLastCalledWith(expected);
  });

  it('holds pre-ack mixed scopes behind the initial baseline and drains the broadened request afterward', async () => {
    const h = harness();
    const baseline = pending();
    const callback = vi.fn().mockImplementationOnce(() => baseline.promise).mockResolvedValue(undefined);
    h.client.openAgents(callback);
    h.sync({ t: 'invalidate', resource: 'agent-membership', scope: 'card', card_id: 'card-a' });
    h.sync({ t: 'invalidate', resource: 'agent-membership', scope: 'card', card_id: 'card-b' });
    expect(callback).not.toHaveBeenCalled();

    acknowledgeAgents(h);
    expect(callback.mock.calls).toEqual([[null]]);
    baseline.resolve(undefined);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(2));
    expect(callback.mock.calls).toEqual([[null], [null]]);
  });

  it('acknowledges a late Agents registration before pending work and resets obsolete work on reconnect', async () => {
    const h = harness();
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    h.client.openAgents(first);
    const firstSubscribe = acknowledgeAgents(h);
    await flush();

    h.client.openAgents(second);
    await flush();
    expect(second.mock.calls).toEqual([[null]]);
    h.sync({ t: 'invalidate', resource: 'agent-membership', scope: 'card', card_id: 'card-obsolete' });
    h.reconnect();
    const reconnectSubscribe = h.sent.at(-1) as { lease: string };
    expect(reconnectSubscribe.lease).not.toBe(firstSubscribe.lease);
    h.sync({ t: 'subscribed', resource: 'agents', lease: firstSubscribe.lease });
    await flush();
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);

    h.sync({ t: 'subscribed', resource: 'agents', lease: reconnectSubscribe.lease });
    await flush();
    expect(first.mock.calls).toEqual([[null], [expect.objectContaining({ card_id: 'card-obsolete' })], [null]]);
    expect(second.mock.calls).toEqual([[null], [expect.objectContaining({ card_id: 'card-obsolete' })], [null]]);
  });

  it('drains a broadened Agents request after a held callback rejects', async () => {
    const h = harness();
    const held = pending();
    const callback = vi.fn().mockResolvedValue(undefined);
    callback.mockImplementationOnce(async () => undefined).mockImplementationOnce(() => held.promise);
    h.client.openAgents(callback);
    acknowledgeAgents(h);
    await flush();
    callback.mockClear();

    h.sync({ t: 'invalidate', resource: 'agent-membership', scope: 'card', card_id: 'card-held' });
    h.sync({ t: 'invalidate', resource: 'agent-membership', scope: 'card', card_id: 'card-a' });
    h.sync({ t: 'invalidate', resource: 'agent-membership', scope: 'card', card_id: 'card-b' });
    held.reject(new Error('held refresh failed'));
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(2));
    expect(callback).toHaveBeenLastCalledWith(null);
  });

  it('keeps dedicated card routing exact while the shared Agents lease receives all membership scopes', async () => {
    const h = harness();
    const agents = vi.fn().mockResolvedValue(undefined);
    const cardA = vi.fn().mockResolvedValue(undefined);
    const cardB = vi.fn().mockResolvedValue(undefined);
    h.client.openAgents(agents);
    h.client.openCardAgentSessions('card-a', cardA);
    h.client.openCardAgentSessions('card-b', cardB);
    for (const value of h.sent.filter((frame) => (frame as { t?: string }).t === 'subscribe')) {
      const frame = value as { resource: 'agents' | 'card-agent-sessions'; id?: string; lease: string };
      h.sync(frame.resource === 'agents'
        ? { t: 'subscribed', resource: 'agents', lease: frame.lease }
        : { t: 'subscribed', resource: 'card-agent-sessions', id: frame.id!, lease: frame.lease });
    }
    await flush();
    agents.mockClear();
    cardA.mockClear();
    cardB.mockClear();

    const frame = { t: 'invalidate', resource: 'agent-membership', scope: 'card', card_id: 'card-a' } as const;
    h.sync(frame);
    await flush();
    expect(agents).toHaveBeenCalledWith(frame);
    expect(cardA).toHaveBeenCalledWith(frame);
    expect(cardB).not.toHaveBeenCalled();
  });

  it('retains the greatest conversation segment and the latest equal-version tip', async () => {
    const h = harness();
    const held = pending();
    const callback = vi.fn().mockResolvedValue(undefined);
    callback.mockImplementationOnce(async () => undefined).mockImplementationOnce(() => held.promise);
    h.client.openConversation('agent:planner:project', callback);
    const subscribe = h.sent.at(-1) as { lease: string };
    h.sync({ t: 'subscribed', resource: 'conversation', id: 'agent:planner:project', lease: subscribe.lease });
    await flush();
    callback.mockClear();

    h.sync({ t: 'invalidate', resource: 'conversation', id: 'agent:planner:project', segment_version: 1, visible_message_id: 'held' });
    h.sync({ t: 'invalidate', resource: 'conversation', id: 'agent:planner:project', segment_version: 3, visible_message_id: 'first-tip' });
    h.sync({ t: 'invalidate', resource: 'conversation', id: 'agent:planner:project', segment_version: 2, visible_message_id: 'older' });
    h.sync({ t: 'invalidate', resource: 'conversation', id: 'agent:planner:project', segment_version: 3, visible_message_id: 'latest-tip' });
    held.resolve(undefined);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(2));
    expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({
      segment_version: 3,
      visible_message_id: 'latest-tip',
    }));
  });
});
