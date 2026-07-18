import { describe, expect, it } from '@jest/globals';
import * as contractsModule from '../../src/contracts/index.js';
import * as operatorApiModule from '../../src/contracts/operator-api.js';
import { AvailabilityComponentSourceSchema, EventsQuerySchema, operatorApiContracts, operatorRouteInventory, parseOperatorResponse, type OperatorApiBody } from '../../src/contracts/operator-api.js';

const runtimeState = {
  status: 'stopped',
  project_id: 'project',
  started_at: '2026-01-01T00:00:00.000Z',
  active_card_run: null,
  updated_at: '2026-01-01T00:00:01.000Z',
  pid: 123,
};

describe('operator API runtime contract without runtime ledgers', () => {
  it('declares Pause, Resume, and Stop as bodyless while Restart retains exact confirmation', () => {
    expect(operatorApiContracts['runtime.pause']).not.toHaveProperty('body');
    expect(operatorApiContracts['runtime.resume']).not.toHaveProperty('body');
    expect(operatorApiContracts.stop_project).not.toHaveProperty('body');
    expect(operatorApiContracts.restart_server.body.parse({ confirmation: 'RESTART SERVER' })).toEqual({ confirmation: 'RESTART SERVER' });

    const pauseBody: OperatorApiBody<'runtime.pause'> = undefined;
    const resumeBody: OperatorApiBody<'runtime.resume'> = undefined;
    const stopBody: OperatorApiBody<'stop_project'> = undefined;
    // @ts-expect-error Bodyless runtime control operations do not admit an empty object.
    const invalidPauseBody: OperatorApiBody<'runtime.pause'> = {};
    expect([pauseBody, resumeBody, stopBody, invalidPauseBody]).toEqual([undefined, undefined, undefined, {}]);
  });

  it('parses runtime state/status without command/run/activation projections', () => {
    expect(parseOperatorResponse('runtime.getState', { projectRoot: '/work/test', projectId: 'test', runtime: runtimeState, cardIndex: { total: 0, byStatus: {}, byType: {} } }).runtime).toEqual(runtimeState);
    const status = parseOperatorResponse('runtime.status', {
      runtime: 'running',
      currentCardId: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      goalCount: 1,
      lastTickAt: null,
      restart_server_available: false,
      pid: 123,
      actorRuntime: { pauseMode: 'running', activeWork: 'none', cards: [], agents: [], diagnostics: [], recovery: null },
    });
    expect(status).not.toHaveProperty('lastCommand');
    expect(status).not.toHaveProperty('activeRun');
    expect(status).not.toHaveProperty('latestRun');
  });

  it('rejects removed runtime ledger fields and public schema exports are absent', () => {
    expect(() => parseOperatorResponse('runtime.getState', { projectRoot: '/work/test', projectId: 'test', runtime: { ...runtimeState, runtime_commands: [], runtime_runs: [], runtime_activations: [] }, cardIndex: { total: 0, byStatus: {}, byType: {} } })).toThrow();
    expect(operatorApiContracts['runtime.status'].success.keyof().options).not.toEqual(expect.arrayContaining(['lastCommand', 'activeRun', 'latestRun']));
  });

  it('retains concrete runtime response schemas without a runtime summary contract', () => {
    expect(operatorApiModule).not.toHaveProperty('RuntimeSummarySchema');
    expect(contractsModule).not.toHaveProperty('RuntimeSummarySchema');

    const stateSchema = operatorApiContracts['runtime.getState'].success;
    expect(stateSchema.keyof().options).toEqual(['projectRoot', 'projectId', 'runtime', 'cardIndex', 'serverAvailability']);
    expect(stateSchema.shape).not.toHaveProperty('summary');
    expect(stateSchema.shape).not.toHaveProperty('runtimeSummary');

    const statusSchema = operatorApiContracts['runtime.status'].success;
    expect(statusSchema.keyof().options).toEqual(['runtime', 'currentCardId', 'goalCount', 'lastTickAt', 'restart_server_available', 'pid', 'actorRuntime', 'serverAvailability']);
    expect(statusSchema.shape).not.toHaveProperty('summary');
    expect(statusSchema.shape).not.toHaveProperty('runtimeSummary');
  });

  it('does not expose the removed debug state operation or response schemas', () => {
    expect(operatorApiContracts).not.toHaveProperty('debug.state');
    expect(operatorRouteInventory()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'GET', path: '/api/debug/state' }),
    ]));
    expect(operatorApiModule).not.toHaveProperty('DebugRuntimeStateSchema');
    expect(operatorApiModule).not.toHaveProperty('DebugStateResponseSchema');
    expect(contractsModule).not.toHaveProperty('DebugStateResponseSchema');
  });

  it('keeps the operator card route inventory read-only', () => {
    const cardRoutes = operatorRouteInventory().filter(({ path }) => path.startsWith('/api/cards'));

    expect(cardRoutes).toEqual([
      expect.objectContaining({ operationId: 'cards.list', method: 'GET', path: '/api/cards' }),
      expect.objectContaining({ operationId: 'cards.get', method: 'GET', path: '/api/cards/:id' }),
      expect.objectContaining({ operationId: 'cards.history.list', method: 'GET', path: '/api/cards/:id/history' }),
      expect.objectContaining({ operationId: 'cards.history.get', method: 'GET', path: '/api/cards/:id/history/:seq' }),
      expect.objectContaining({ operationId: 'cards.diff', method: 'GET', path: '/api/cards/:id/diff' }),
    ]);
    expect(cardRoutes.every(({ method }) => method === 'GET')).toBe(true);
  });

  it('accepts only current availability component sources', () => {
    expect(AvailabilityComponentSourceSchema.safeParse('runtime-application').success).toBe(true);
    expect(AvailabilityComponentSourceSchema.safeParse('runtime-state').success).toBe(false);
  });

  it('labels provider availability as process-local and resettable', () => {
    expect(parseOperatorResponse('providers.list', { availabilityScope: 'process_local_reset_on_restart', providers: {} }))
      .toEqual({ availabilityScope: 'process_local_reset_on_restart', providers: {} });
    expect(() => parseOperatorResponse('providers.list', { providers: {} })).toThrow();
  });

  it('requires present event pagination parameters to be non-negative integer strings', () => {
    expect(EventsQuerySchema.safeParse({}).success).toBe(true);
    expect(EventsQuerySchema.safeParse({ limit: '0', offset: '10' }).success).toBe(true);
    expect(EventsQuerySchema.safeParse({ limit: '1.5' }).success).toBe(false);
    expect(EventsQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
  });
});
