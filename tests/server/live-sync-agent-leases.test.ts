import { describe, expect, it, jest } from '@jest/globals';
import { LiveSyncSocket } from '../../src/server/live-sync-socket.js';
function socket() {
  return {
    OPEN: 1,
    CONNECTING: 0,
    readyState: 1,
    send: jest.fn(),
    close: jest.fn(),
    removeAllListeners: jest.fn(),
  } as any;
}
describe('Agent live-sync leases', () => {
  it('replaces exact leases and ignores stale unsubscribe', () => {
    const live = new LiveSyncSocket();
    const ws = socket();
    live.add(ws);
    expect(
      live.handleClientFrame(ws, {
        t: 'subscribe',
        resource: 'conversation',
        id: 'agent:planner:project',
        lease: 'old',
      }),
    ).toBe(true);
    live.handleClientFrame(ws, {
      t: 'subscribe',
      resource: 'conversation',
      id: 'agent:planner:project',
      lease: 'new',
    });
    live.handleClientFrame(ws, {
      t: 'unsubscribe',
      resource: 'conversation',
      id: 'agent:planner:project',
      lease: 'old',
    });
    live.invalidate({
      resource: 'conversation',
      id: 'agent:planner:project',
      through_message_id: 'a',
    });
    expect(ws.send).toHaveBeenLastCalledWith(
      JSON.stringify({
        t: 'invalidate',
        resource: 'conversation',
        id: 'agent:planner:project',
        through_message_id: 'a',
      }),
    );
  });
  it('routes card membership to Agents plus matching card and exchange only to exact exchange', () => {
    const live = new LiveSyncSocket();
    const agents = socket(),
      card = socket(),
      foreign = socket(),
      exchange = socket();
    for (const ws of [agents, card, foreign, exchange]) live.add(ws);
    live.handleClientFrame(agents, { t: 'subscribe', resource: 'agents', lease: 'a' });
    live.handleClientFrame(card, {
      t: 'subscribe',
      resource: 'card-agent-sessions',
      id: 'card-a',
      lease: 'c',
    });
    live.handleClientFrame(foreign, {
      t: 'subscribe',
      resource: 'card-agent-sessions',
      id: 'card-b',
      lease: 'f',
    });
    live.handleClientFrame(exchange, {
      t: 'subscribe',
      resource: 'llm-exchange',
      id: 'agent:planner:card-a',
      lease: 'e',
    });
    for (const ws of [agents, card, foreign, exchange]) ws.send.mockClear();
    live.invalidate({ resource: 'agent-membership', scope: 'card', card_id: 'card-a' });
    expect(agents.send).toHaveBeenCalledTimes(1);
    expect(card.send).toHaveBeenCalledTimes(1);
    expect(foreign.send).not.toHaveBeenCalled();
    expect(exchange.send).not.toHaveBeenCalled();
    live.invalidate({ resource: 'llm-exchange', id: 'agent:planner:card-a' });
    expect(exchange.send).toHaveBeenCalledTimes(1);
    expect(agents.send).toHaveBeenCalledTimes(1);
  });
});
