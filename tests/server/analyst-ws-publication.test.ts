import { describe, expect, it, jest } from '@jest/globals';
import type { WebSocket } from 'ws';

import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import { AnalystWsHandler } from '../../src/server/analyst-ws-handler.js';
import { testApplicationFatalDelivery, testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';

describe('Analyst WebSocket publication propagation', () => {
  it('rejects with the exact publication error and sends no ordinary error or acknowledgement frame', async () => {
    const error = new PublicationOutcomeUnknownError();
    const sendToClient = jest.fn();
    const handler = new AnalystWsHandler({
      fatalPort: testApplicationFatalPort,
      projectRoot: '.',
      saivageConfig: {} as never,
      liveSyncSocket: { handleClientFrame: () => false } as never,
      runtimeApplication: { analystRuntime: { submit: async () => { throw error; } } } as never,
      sendToClient,
    });
    const ws = { OPEN: 1, readyState: 1 } as WebSocket;
    await expect(handler.handleRawMessage(ws, Buffer.from(JSON.stringify({ type: 'message', content: { text: 'inspect' } })))).rejects.toBe(testApplicationFatalDelivery);
    expect(sendToClient).not.toHaveBeenCalled();
  });
});
