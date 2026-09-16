import { describe, expect, it, jest } from '@jest/globals';
import type { WebSocket } from 'ws';

import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import { AnalystWsHandler } from '../../src/server/analyst-ws-handler.js';
import { AnalystTurnBusyError } from '../../src/agents/analyst-api.js';
import { testApplicationFatalDelivery, testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { toolFailed } from '../../src/contracts/tool-result.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import { canonicalJson } from '../../src/schemas/index.js';
import { OUTBOUND_RAW_MARKER } from '../helpers/outbound-identity-fixtures.js';

const noopLog = { error() {} };

describe('Analyst WebSocket publication propagation', () => {
  it('acknowledges a scheduled restart through the available capability after frame delivery', async () => {
    const acknowledge = jest.fn(async () => {});
    const sendToClient = jest.fn((_ws, _event, callback?: (error?: Error) => void) => callback?.());
    const handler = new AnalystWsHandler({
      fatalPort: testApplicationFatalPort,
      restartCapability: { available: true, port: { schedule() {}, acknowledge } },
      liveSyncSocket: { handleClientFrame: () => false } as never,
      runtimeApplication: {
        analystSessionId: 'agent:analyst:global',
        analystRuntime: { submit: async () => ({ sessionId: 'agent:analyst:global', restart: { status: 'scheduled' }, toolInvocations: [] }) },
      } as never,
      sendToClient,
    });
    const ws = { OPEN: 1, readyState: 1 } as WebSocket;

    await handler.handleRawMessage(ws, Buffer.from(JSON.stringify({ type: 'message', content: { text: 'RESTART SERVER' } })), noopLog);

    expect(sendToClient).toHaveBeenCalledWith(ws, {
      type: 'status',
      content: { event: 'analyst_turn_acknowledged', sessionId: 'agent:analyst:global', restart: { status: 'scheduled' } },
    }, expect.any(Function));
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it('publishes the complete exact settled durable result and projects only parameters', async () => {
    const settled = settleToolActionOutcome(toolFailed('denied token=sk-a', { code: 'record_mutation_denied', detail: 'sk-a', formerly_narrowed: true }));
    const response = {
      sessionId: 'agent:analyst:global' as const,
      restart: null,
      toolInvocations: [{
        tool: 'write',
        params: { path: 'record:///brief.md?card=project', content: `token=${OUTBOUND_RAW_MARKER}` },
        result: settled.providerResult,
        sourceInputId: '11111111-1111-4111-8111-111111111111',
        toolCallId: 'call-ws-settled',
      }],
    };
    const sendToClient = jest.fn();
    const handler = new AnalystWsHandler({
      fatalPort: testApplicationFatalPort,
      restartCapability: { available: false },
      liveSyncSocket: { handleClientFrame: () => false } as never,
      runtimeApplication: { analystSessionId: 'agent:analyst:global', analystRuntime: { submit: async () => response } } as never,
      sendToClient,
    });
    const ws = { OPEN: 1, readyState: 1 } as WebSocket;

    await handler.handleRawMessage(ws, Buffer.from(JSON.stringify({ type: 'message', content: { text: 'write' } })), noopLog);

    const activity = sendToClient.mock.calls[0]![1] as { type: string; content: { params: unknown; result: unknown } };
    expect(activity.type).toBe('activity');
    expect(canonicalJson(activity.content.result)).toBe(settled.settledResultBytes);
    expect(activity.content.result).toEqual(settled.providerResult);
    expect(JSON.stringify(activity.content.params)).not.toContain(OUTBOUND_RAW_MARKER);
  });

  it('rejects with the exact publication error and sends no ordinary error or acknowledgement frame', async () => {
    const error = new PublicationOutcomeUnknownError();
    const sendToClient = jest.fn();
    const handler = new AnalystWsHandler({
      fatalPort: testApplicationFatalPort,
      restartCapability: { available: false },
      liveSyncSocket: { handleClientFrame: () => false } as never,
      runtimeApplication: { analystRuntime: { submit: async () => { throw error; } } } as never,
      sendToClient,
    });
    const ws = { OPEN: 1, readyState: 1 } as WebSocket;
    const log = { error: jest.fn() };
    await expect(handler.handleRawMessage(ws, Buffer.from(JSON.stringify({ type: 'message', content: { text: 'inspect' } })), log)).rejects.toBe(testApplicationFatalDelivery);
    expect(sendToClient).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('sends exact busy immediately and does not queue same-socket overlap for later execution', async () => {
    let release!: (value: { sessionId: 'agent:analyst:global'; restart: null; toolInvocations: [] }) => void;
    const active = new Promise<{ sessionId: 'agent:analyst:global'; restart: null; toolInvocations: [] }>((resolve) => { release = resolve; });
    let submissions = 0;
    const busyFailure = new AnalystTurnBusyError();
    const submit = jest.fn((): Promise<{ sessionId: 'agent:analyst:global'; restart: null; toolInvocations: [] }> => {
      submissions += 1;
      return submissions === 1 ? active : Promise.reject(busyFailure);
    });
    const sendToClient = jest.fn();
    const handler = new AnalystWsHandler({
      fatalPort: testApplicationFatalPort,
      restartCapability: { available: false },
      liveSyncSocket: { handleClientFrame: () => false } as never,
      runtimeApplication: { analystSessionId: 'agent:analyst:global', analystRuntime: { submit } } as never,
      sendToClient,
    });
    const ws = { OPEN: 1, readyState: 1 } as WebSocket;
    const log = { error: jest.fn() };
    const first = handler.handleRawMessage(ws, Buffer.from(JSON.stringify({ type: 'message', content: { text: 'first' } })), log);
    const second = handler.handleRawMessage(ws, Buffer.from(JSON.stringify({ type: 'message', content: { text: 'second' } })), log);

    await second;
    expect(submit).toHaveBeenCalledTimes(2);
    expect(sendToClient).toHaveBeenCalledTimes(1);
    expect(sendToClient).toHaveBeenLastCalledWith(ws, {
      type: 'error',
      content: { error: 'analyst_turn_busy', message: 'Another Analyst turn is active. Retry after it finishes.' },
    });
    expect(log.error).toHaveBeenCalledWith({ err: busyFailure, code: 'analyst_websocket_message_failed', transport: 'websocket' }, 'Analyst WebSocket message failed');
    expect(log.error.mock.invocationCallOrder[0]).toBeLessThan(sendToClient.mock.invocationCallOrder[0]!);

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
      restartCapability: { available: false },
      liveSyncSocket: { handleClientFrame: () => false } as never,
      runtimeApplication: { analystSessionId: 'agent:analyst:global', analystRuntime: { submit } } as never,
      sendToClient,
    });
    const winnerSocket = { OPEN: 1, readyState: 1 } as WebSocket;
    const loserSocket = { OPEN: 1, readyState: 1 } as WebSocket;

    const winner = handler.handleRawMessage(winnerSocket, Buffer.from(JSON.stringify({ type: 'message', content: { text: 'winner' } })), noopLog);
    await handler.handleRawMessage(loserSocket, Buffer.from(JSON.stringify({ type: 'message', content: { text: 'loser' } })), noopLog);

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
    const failure = new Error('secret dynamic failure');
    const handler = new AnalystWsHandler({
      fatalPort: testApplicationFatalPort,
      restartCapability: { available: false },
      liveSyncSocket: { handleClientFrame: () => false } as never,
      runtimeApplication: { analystRuntime: { submit: async () => { throw failure; } } } as never,
      sendToClient,
    });
    const ws = { OPEN: 1, readyState: 1 } as WebSocket;
    const log = { error: jest.fn() };
    await handler.handleRawMessage(ws, Buffer.from(JSON.stringify({ type: 'message', content: { text: 'inspect' } })), log);
    expect(log.error).toHaveBeenCalledWith({ err: failure, code: 'analyst_websocket_message_failed', transport: 'websocket' }, 'Analyst WebSocket message failed');
    expect(log.error.mock.invocationCallOrder[0]).toBeLessThan(sendToClient.mock.invocationCallOrder[0]!);
    expect(sendToClient).toHaveBeenCalledWith(ws, {
      type: 'error',
      content: { error: 'analyst_processing_failed', message: 'Failed to process Analyst message.' },
    });
  });
});
