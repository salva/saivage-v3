import { describe, expect, it, jest } from '@jest/globals';
import type { WebSocket } from 'ws';

import { KnownWsEnvelopeSchema } from '../../src/contracts/index.js';
import { sendToClient } from '../../src/server/websocket.js';

describe('WebSocket outbound serialization', () => {
  it('validates, redacts, and serializes a known envelope without changing its safe shape', () => {
    const secret = 'synthetic_websocket_nested_secret';
    const ws = {
      OPEN: 1,
      readyState: 1,
      send: jest.fn(),
    } as unknown as WebSocket;

    sendToClient(ws, {
      type: 'activity',
      content: {
        event: 'tool_invocation',
        sessionId: 'analyst:global',
        tool: 'read_file',
        params: {
          safe: 'visible',
          nested: { apiKey: secret, count: 3 },
        },
        result: { status: 'ok' },
      },
    });

    expect(ws.send).toHaveBeenCalledTimes(1);
    const serialized = jest.mocked(ws.send).mock.calls[0]?.[0] as string;
    expect(serialized).not.toContain(secret);
    expect(KnownWsEnvelopeSchema.parse(JSON.parse(serialized))).toEqual({
      type: 'activity',
      content: {
        event: 'tool_invocation',
        sessionId: 'analyst:global',
        tool: 'read_file',
        params: {
          safe: 'visible',
          nested: { apiKey: '[REDACTED]', count: 3 },
        },
        result: { status: 'ok' },
      },
    });
  });
});
