import { describe, expect, it, jest } from '@jest/globals';
import type { WebSocket } from 'ws';

import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import { AnalystWsHandler } from '../../src/server/analyst-ws-handler.js';
import { AnalystTurnBusyError } from '../../src/agents/analyst-api.js';
import { testApplicationFatalDelivery, testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';

describe('Analyst WebSocket publication propagation', () => {
  it('rejects with the exact publication error and sends no ordinary error or acknowledgement frame', async () => {
    const error = new PublicationOutcomeUnknownError();
    const sendToClient = jest.fn();
    const handler = new AnalystWsHandler({
      fatalPort: testApplicationFatalPort,
      liveSyncSocket: { handleClientFrame: () => false } as never,
      runtimeApplication: { analystRuntime: { submit: async () => { throw error; } } } as never,
      sendToClient,
    });
    const ws = { OPEN: 1, readyState: 1 } as WebSocket;
    await expect(handler.handleRawMessage(ws, Buffer.from(JSON.stringify({ type: 'message', content: { text: 'inspect' } })))).rejects.toBe(testApplicationFatalDelivery);
    expect(sendToClient).not.toHaveBeenCalled();
  });

  it('sends exact busy immediately and does not queue same-socket overlap for later execution', async () => {
    let release!: (value: { sessionId: 'agent:analyst:global'; restart: null; toolInvocations: [] }) => void;
    const active = new Promise<{ sessionId: 'agent:analyst:global'; restart: null; toolInvocations: [] }>((resolve) => { release = resolve; });
    let submissions = 0;
    const submit = jest.fn((): Promise<{ sessionId: 'agent:analyst:global'; restart: null; toolInvocations: [] }> => {
      submissions += 1;
      return submissions === 1 ? active : Promise.reject(new AnalystTurnBusyError());
    });
    const sendToClient = jest.fn();
    const handler = new AnalystWsHandler({
      fatalPort: testApplicationFatalPort,
      liveSyncSocket: { handleClientFrame: () => false } as never,
      runtimeApplication: { analystSessionId: 'agent:analyst:global', analystRuntime: { submit } } as never,
      sendToClient,
    });
    const ws = { OPEN: 1, readyState: 1 } as WebSocket;
    const first = handler.handleRawMessage(ws, Buffer.from(JSON.stringify({ type: 'message', content: { text: 'first' } })));
    const second = handler.handleRawMessage(ws, Buffer.from(JSON.stringify({ type: 'message', content: { text: 'second' } })));

    await second;
    expect(submit).toHaveBeenCalledTimes(2);
    expect(sendToClient).toHaveBeenCalledTimes(1);
    expect(sendToClient).toHaveBeenLastCalledWith(ws, {
      type: 'error',
      content: { error: 'analyst_turn_busy', message: 'Another Analyst turn is active. Retry after it finishes.' },
    });

    release({ sessionId: 'agent:analyst:global', restart: null, toolInvocations: [] });
    await first;
    expect(submit).toHaveBeenCalledTimes(2);
    expect(sendToClient).toHaveBeenCalledTimes(2);
    expect(sendToClient.mock.calls[1]![1]).toEqual({
      type: 'status',
      content: { event: 'analyst_turn_acknowledged', sessionId: 'agent:analyst:global', restart: null },
    });
  });

  it('shares immediate admission across sockets without attaching busy to the winner', async () => {
    let release!: (value: { sessionId: 'agent:analyst:global'; restart: null; toolInvocations: [] }) => void;
    const active = new Promise<{ sessionId: 'agent:analyst:global'; restart: null; toolInvocations: [] }>((resolve) => { release = resolve; });
    let submissions = 0;
    const submit = jest.fn(() => {
      submissions += 1;
      return submissions === 1 ? active : Promise.reject(new AnalystTurnBusyError());
    });
    const sendToClient = jest.fn();
    const handler = new AnalystWsHandler({
      fatalPort: testApplicationFatalPort,
      liveSyncSocket: { handleClientFrame: () => false } as never,
      runtimeApplication: { analystSessionId: 'agent:analyst:global', analystRuntime: { submit } } as never,
      sendToClient,
    });
    const winnerSocket = { OPEN: 1, readyState: 1 } as WebSocket;
    const loserSocket = { OPEN: 1, readyState: 1 } as WebSocket;

    const winner = handler.handleRawMessage(winnerSocket, Buffer.from(JSON.stringify({ type: 'message', content: { text: 'winner' } })));
    await handler.handleRawMessage(loserSocket, Buffer.from(JSON.stringify({ type: 'message', content: { text: 'loser' } })));

    expect(sendToClient).toHaveBeenCalledTimes(1);
    expect(sendToClient).toHaveBeenCalledWith(loserSocket, {
      type: 'error',
      content: { error: 'analyst_turn_busy', message: 'Another Analyst turn is active. Retry after it finishes.' },
    });
    release({ sessionId: 'agent:analyst:global', restart: null, toolInvocations: [] });
    await winner;
    expect(sendToClient).toHaveBeenLastCalledWith(winnerSocket, {
      type: 'status',
      content: { event: 'analyst_turn_acknowledged', sessionId: 'agent:analyst:global', restart: null },
    }, expect.any(Function));
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('uses one safe generic processing error without dynamic details', async () => {
    const sendToClient = jest.fn();
    const handler = new AnalystWsHandler({
      fatalPort: testApplicationFatalPort,
      liveSyncSocket: { handleClientFrame: () => false } as never,
      runtimeApplication: { analystRuntime: { submit: async () => { throw new Error('secret dynamic failure'); } } } as never,
      sendToClient,
    });
    const ws = { OPEN: 1, readyState: 1 } as WebSocket;
    await handler.handleRawMessage(ws, Buffer.from(JSON.stringify({ type: 'message', content: { text: 'inspect' } })));
    expect(sendToClient).toHaveBeenCalledWith(ws, {
      type: 'error',
      content: { error: 'analyst_processing_failed', message: 'Failed to process Analyst message.' },
    });
  });
});
