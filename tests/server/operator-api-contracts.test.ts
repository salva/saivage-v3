import { describe, expect, it } from '@jest/globals';
import * as contractsModule from '../../src/contracts/index.js';
import * as operatorApiModule from '../../src/contracts/operator-api.js';
import { AvailabilityComponentSourceSchema, EventsQuerySchema, operatorApiContracts, operatorRouteInventory, parseOperatorResponse, type OperatorApiBody } from '../../src/contracts/operator-api.js';
import { positiveSafeIntegerSchema } from '../../src/schemas/index.js';

const runtimeState = {
  status: 'running',
  project_id: 'project',
  started_at: '2026-01-01T00:00:00.000Z',
  current_card_id: 'project',
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
    expect(parseOperatorResponse('runtime.getState', { projectRoot: '/work/test', projectId: 'test', runtime: runtimeState }).runtime).toEqual(runtimeState);
    const status = parseOperatorResponse('runtime.status', {
      runtime: 'running',
      currentCardId: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      started_at: '2026-01-01T00:00:00.000Z',
      restart_server_available: false,
      pid: 123,
      actorRuntime: { pauseMode: 'running', cards: [] },
    });
    expect(status).not.toHaveProperty('lastCommand');
    expect(status).not.toHaveProperty('activeRun');
    expect(status).not.toHaveProperty('latestRun');
    expect(() => parseOperatorResponse('runtime.status', { ...status, actorRuntime: { ...status.actorRuntime, agents: [] } })).toThrow();
  });

  it('rejects removed runtime ledger fields and public schema exports are absent', () => {
    expect(() => parseOperatorResponse('runtime.getState', { projectRoot: '/work/test', projectId: 'test', runtime: { ...runtimeState, runtime_commands: [], runtime_runs: [], runtime_activations: [] } })).toThrow();
    expect(() => parseOperatorResponse('runtime.getState', { projectRoot: '/work/test', projectId: 'test', runtime: runtimeState, cardIndex: { total: 0, byStatus: {}, byType: {} } })).toThrow();
    expect(operatorApiContracts['runtime.status'].success.keyof().options).not.toEqual(expect.arrayContaining(['lastCommand', 'activeRun', 'latestRun']));
    for (const removed of ['active_card_run', 'last_tick_at']) expect(() => parseOperatorResponse('runtime.getState', { projectRoot: '/work/test', projectId: 'test', runtime: { ...runtimeState, [removed]: null } })).toThrow();
    const validStatus = { runtime: 'running', currentCardId: 'project', started_at: '2026-01-01T00:00:00.000Z', restart_server_available: false, pid: 123, actorRuntime: { pauseMode: 'running', cards: [] } };
    for (const removed of ['goalCount', 'lastTickAt']) expect(() => parseOperatorResponse('runtime.status', { ...validStatus, [removed]: null })).toThrow();
    for (const removed of ['activeWork', 'diagnostics']) expect(() => parseOperatorResponse('runtime.status', { ...validStatus, actorRuntime: { ...validStatus.actorRuntime, [removed]: removed === 'diagnostics' ? [] : 'none' } })).toThrow();
  });

  it('requires strict live process state and a nonnegative safe node ordinal', () => {
    const base = { runtime: 'running', currentCardId: 'project', started_at: '2026-01-01T00:00:00.000Z', restart_server_available: false, pid: 123, actorRuntime: { pauseMode: 'running', cards: [{ cardId: 'project', actorState: 'running', processState: { family: 'planning', stateId: 'node:plan', kind: 'node', nodeId: 'plan', executionOrdinal: 0 } }] } };
    expect(parseOperatorResponse('runtime.status', base)).toEqual(base);
    expect(() => parseOperatorResponse('runtime.status', { ...base, actorRuntime: { ...base.actorRuntime, cards: [{ cardId: 'project', actorState: 'running' }] } })).toThrow();
    for (const executionOrdinal of [-1, Number.MAX_SAFE_INTEGER + 1, 0.5]) expect(() => parseOperatorResponse('runtime.status', { ...base, actorRuntime: { ...base.actorRuntime, cards: [{ ...base.actorRuntime.cards[0], processState: { ...base.actorRuntime.cards[0]!.processState, executionOrdinal } }] } })).toThrow();
  });

  it('accepts the exact runtime card-runs contract', () => {
    const response = { current_card_id: 'project', active_breadcrumb: [], dormant_planners: [] };
    expect(parseOperatorResponse('runtime.cardRuns', response)).toEqual(response);
    expect(() => parseOperatorResponse('runtime.cardRuns', { ...response, active_card_run: null })).toThrow();
  });

  it('rejects removed cards_with_pending_corrections from runtime card-runs', () => {
    const response = { current_card_id: 'project', active_breadcrumb: [], dormant_planners: [] };
    expect(() => parseOperatorResponse('runtime.cardRuns', { ...response, cards_with_pending_corrections: [] })).toThrow();
  });

  it('retains concrete runtime response schemas without a runtime summary contract', () => {
    expect(operatorApiModule).not.toHaveProperty('RuntimeSummarySchema');
    expect(contractsModule).not.toHaveProperty('RuntimeSummarySchema');

    const stateSchema = operatorApiContracts['runtime.getState'].success;
    expect(stateSchema.keyof().options).toEqual(['projectRoot', 'projectId', 'runtime', 'serverAvailability']);
    expect(stateSchema.shape).not.toHaveProperty('summary');
    expect(stateSchema.shape).not.toHaveProperty('runtimeSummary');

    const statusSchema = operatorApiContracts['runtime.status'].success;
    expect(statusSchema.keyof().options).toEqual(['runtime', 'currentCardId', 'started_at', 'restart_server_available', 'pid', 'actorRuntime', 'serverAvailability']);
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
      expect.objectContaining({ operationId: 'cards.children', method: 'GET', path: '/api/cards/:id/children' }),
      expect.objectContaining({ operationId: 'cards.get', method: 'GET', path: '/api/cards/:id' }),
      expect.objectContaining({ operationId: 'cards.history.list', method: 'GET', path: '/api/cards/:id/history' }),
      expect.objectContaining({ operationId: 'cards.history.get', method: 'GET', path: '/api/cards/:id/history/:seq' }),
      expect.objectContaining({ operationId: 'cards.diff', method: 'GET', path: '/api/cards/:id/diff' }),
    ]);
    expect(cardRoutes.every(({ method }) => method === 'GET')).toBe(true);
  });

  it('uses one canonical positive safe integer wire grammar', () => {
    for (const value of [1, Number.MAX_SAFE_INTEGER]) expect(positiveSafeIntegerSchema.parse(value)).toBe(value);
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) expect(positiveSafeIntegerSchema.safeParse(value).success).toBe(false);
    const accepted = ['1', String(Number.MAX_SAFE_INTEGER)];
    for (const raw of accepted) {
      expect(contractsModule.canonicalPositiveSafeIntegerStringSchema.parse(raw)).toBe(Number(raw));
      expect(contractsModule.CardHistoryEntryParamsSchema.parse({ id: 'project', seq: raw }).seq).toBe(Number(raw));
      expect(contractsModule.CardDiffQuerySchema.parse({ from: raw, to: raw })).toEqual({ from: Number(raw), to: Number(raw) });
    }
    for (const raw of ['', '0', '+1', '-1', '1.0', '1.5', '1suffix', ' 1', '1 ', '01', '1e2', '１', '9007199254740992']) {
      expect(contractsModule.canonicalPositiveSafeIntegerStringSchema.safeParse(raw).success).toBe(false);
      expect(contractsModule.CardHistoryEntryParamsSchema.safeParse({ id: 'project', seq: raw }).success).toBe(false);
      expect(contractsModule.CardDiffQuerySchema.safeParse({ from: raw }).success).toBe(false);
      expect(contractsModule.CardDiffQuerySchema.safeParse({ to: raw }).success).toBe(false);
    }
    expect(contractsModule.CardDiffQuerySchema.parse({ from: 'last', to: 'current' })).toEqual({ from: 'last', to: 'current' });
  });

  it('keeps card, history-entry, and diff-source 404 contracts exact and disjoint', () => {
    const card = { error: 'Card not found', cardId: 'project' };
    const entry = { error: 'Card history entry not found', cardId: 'project', version_seq: 1 };
    const diff = { error: 'Card diff source not found', cardId: 'project', from: 1, to: 2, missing_version_seq: 1 };
    expect(contractsModule.CardNotFoundErrorSchema.parse(card)).toEqual(card);
    expect(contractsModule.CardHistoryEntryNotFoundUnionSchema.parse(entry)).toEqual(entry);
    expect(contractsModule.CardDiffNotFoundUnionSchema.parse(diff)).toEqual(diff);
    expect(contractsModule.CardHistoryEntryNotFoundUnionSchema.safeParse(diff).success).toBe(false);
    expect(contractsModule.CardDiffNotFoundUnionSchema.safeParse(entry).success).toBe(false);
    for (const invalid of [{ error: 'Card not found' }, { ...card, message: 'missing' }, { error: 'anything', message: 'missing' }]) {
      expect(contractsModule.CardNotFoundErrorSchema.safeParse(invalid).success).toBe(false);
    }
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
