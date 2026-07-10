import { describe, expect, it } from '@jest/globals';
import { AvailabilityComponentSourceSchema, EventsQuerySchema, operatorApiContracts, parseOperatorResponse } from '../../src/contracts/operator-api.js';

const runtimeState = {
  status: 'stopped',
  project_id: 'project',
  started_at: '2026-01-01T00:00:00.000Z',
  active_card_run: null,
  updated_at: '2026-01-01T00:00:01.000Z',
  pid: 123,
};

describe('operator API runtime contract without runtime ledgers', () => {
  it('parses runtime state/status without command/run/activation projections', () => {
    expect(parseOperatorResponse('runtime.getState', { projectRoot: '/work/test', projectId: 'test', runtime: runtimeState, cardIndex: { total: 0, byStatus: {}, byType: {} } }).runtime).toEqual(runtimeState);
    const status = parseOperatorResponse('runtime.status', {
      runtime: 'running',
      currentCardId: 'card-1',
      goalCount: 1,
      lastTickAt: null,
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

  it('accepts only current availability component sources', () => {
    expect(AvailabilityComponentSourceSchema.safeParse('runtime-application').success).toBe(true);
    expect(AvailabilityComponentSourceSchema.safeParse('runtime-state').success).toBe(false);
  });

  it('requires present event pagination parameters to be non-negative integer strings', () => {
    expect(EventsQuerySchema.safeParse({}).success).toBe(true);
    expect(EventsQuerySchema.safeParse({ limit: '0', offset: '10' }).success).toBe(true);
    expect(EventsQuerySchema.safeParse({ limit: '1.5' }).success).toBe(false);
    expect(EventsQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
  });
});
