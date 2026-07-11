import { describe, expect, it } from 'vitest';
import websocketSource from '../api/websocket.ts?raw';

describe('websocket bootstrap boundary after S06', () => {
  it('uses bounded ws-ticket bootstrap and does not append bearer/api-token query parameters', () => {
    expect(websocketSource).toContain('issueWebSocketTicket');
    expect(websocketSource).toContain("wsUrl.searchParams.set('ticket', ticket)");
    expect(websocketSource).toContain('must never be placed in WebSocket URLs');

    expect(websocketSource).not.toMatch(/searchParams\.set\(['\"](?:token|apiToken|bearer|authorization)['\"]/i);
  });

  it('keeps analyst chat as the only websocket send payload path', () => {
    expect(websocketSource).toContain('buildInboundAnalystMessageEnvelope(text)');
    expect(websocketSource).toContain('sendMessage(text: string)');
    expect(websocketSource).not.toMatch(/createCard|updateCard|deleteCard|startProject|terminateProcess/);
  });
});
