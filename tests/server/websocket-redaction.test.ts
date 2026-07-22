import { describe, expect, it, jest } from '@jest/globals';
import type { WebSocket } from 'ws';

import { KnownWsEnvelopeSchema } from '../../src/contracts/index.js';
import { sendToClient } from '../../src/server/websocket.js';
import { projectAnalystToolInvocationActivity } from '../../src/server/tool-activity-projection.js';
import { OUTBOUND_RAW_MARKER } from '../helpers/outbound-identity-fixtures.js';

describe('WebSocket outbound serialization', () => {
  it('validates, redacts, and serializes a known envelope without changing its safe shape', () => {
    const secret = OUTBOUND_RAW_MARKER;
    const ws = {
      OPEN: 1,
      readyState: 1,
      send: jest.fn(),
    } as unknown as WebSocket;

    const activity = projectAnalystToolInvocationActivity({
      tool: 'unsupported_tok_primary',
      params: { safe: 'visible', nested: { apiKey: secret, count: 3 } },
      result: { success: false, error: `failed token=${secret}`, data: { status: 'visible' } },
      sourceInputId: '11111111-1111-4111-8111-111111111111',
      toolCallId: 'call-tok_primary',
    },'agent:analyst:global');
    sendToClient(ws, {
      type: 'activity',
      content: activity,
    });

    expect(ws.send).toHaveBeenCalledTimes(1);
    const serialized = jest.mocked(ws.send).mock.calls[0]?.[0] as string;
    expect(serialized).not.toContain(secret);
    expect(KnownWsEnvelopeSchema.parse(JSON.parse(serialized))).toEqual({
      type: 'activity',
      content: {
        event: 'tool_invocation',
        sessionId: 'agent:analyst:global',
        tool: 'unsupported_tok_primary',
        params: {
          safe: 'visible',
          nested: { apiKey: '[REDACTED]', count: 3 },
        },
        result: { success: false, error: 'failed token=[REDACTED]', data: { status: 'visible' } },
      },
    });
  });
});
