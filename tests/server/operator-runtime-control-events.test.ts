import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';

const appendEvent = jest.fn();
jest.unstable_mockModule('../../src/observability/event-logger.js', () => ({
  createEventLog: () => ({ appendEvent, appendEventPrepared: jest.fn() }),
}));
const { buildRuntimeCardOperatorContractHandlers } = await import('../../src/server/routes/operator-runtime-card-handlers.js');

const pause = jest.fn();
const resume = jest.fn();
const stopProject = jest.fn(async () => ({ status: 'stopped' as const, contained: false }));
const schedule = jest.fn();
const acknowledge = jest.fn(async () => {});
const getStatus = jest.fn(() => ({ status: 'pausing', currentCardId: null, pid: 1, startedAt: '2026-01-01T00:00:00.000Z' }));
const getActorRuntimeReadModel = jest.fn(() => ({ pauseMode: 'idle', cards: [] }));
const getOversightStatus = jest.fn(() => ({}));
const serverAvailabilityProvider = jest.fn(() => ({}));
const once = jest.fn();
function handlers(available = true) {
  return buildRuntimeCardOperatorContractHandlers({
    projectRoot: '/unused', cardStore: {} as never,
    runtimeApplication: { runtimeApi: { pause, resume, stopProject, getStatus, getActorRuntimeReadModel }, getOversightStatus } as never,
    serverAvailabilityProvider: serverAvailabilityProvider as never,
    restartCapability: available ? { available: true, port: { schedule, acknowledge } } : { available: false },
  });
}
const input = (body?: unknown) => ({ request: { body }, reply: { raw: { once } } }) as never;
beforeEach(() => {
  jest.clearAllMocks();
  appendEvent.mockReset();
  pause.mockReset();
  resume.mockReset();
  schedule.mockReset();
  stopProject.mockReset().mockResolvedValue({ status: 'stopped', contained: false });
  getStatus.mockReturnValue({ status: 'pausing', currentCardId: null, pid: 1, startedAt: '2026-01-01T00:00:00.000Z' });
});

describe('direct operator control evidence', () => {
  it.each(['runtime.pause', 'runtime.resume'] as const)('records the already built status response for %s', async (operation) => {
    const status = operation === 'runtime.pause' ? 'pausing' : 'running';
    getStatus.mockReturnValue({ status, currentCardId: null, pid: 1, startedAt: '2026-01-01T00:00:00.000Z' });
    const result = await handlers()[operation]!(input());
    expect(result).toMatchObject({ body: { runtime: status } });
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(appendEvent).toHaveBeenCalledTimes(1);
    expect(appendEvent).toHaveBeenCalledWith({ kind: 'operator_runtime_control', actor: 'operator', surface: 'operator_api', result: { operation: operation === 'runtime.pause' ? 'pause_runtime' : 'resume_runtime', outcome: 'returned', runtime_status: status } });
  });
  it.each([true, false])('preserves Stop contained=%s', async (contained) => {
    stopProject.mockResolvedValue({ status: 'stopped', contained });
    expect(await handlers().stop_project!(input())).toEqual({ body: { status: 'stopped', contained } });
    expect(appendEvent).toHaveBeenCalledTimes(1);
    expect(appendEvent).toHaveBeenCalledWith(expect.objectContaining({ result: { operation: 'stop_project', outcome: 'returned', status: 'stopped', contained } }));
    expect(getStatus).not.toHaveBeenCalled();
  });
  it.each(['runtime.pause', 'runtime.resume', 'stop_project'] as const)('records only body rejection for %s', async (operation) => {
    expect(await handlers()[operation]!(input({ secret: 'not retained' }))).toMatchObject({ statusCode: 400 });
    expect(appendEvent).toHaveBeenCalledTimes(1);
    expect(appendEvent).toHaveBeenCalledWith(expect.objectContaining({ result: { operation: operation === 'runtime.pause' ? 'pause_runtime' : operation === 'runtime.resume' ? 'resume_runtime' : 'stop_project', outcome: 'rejected', reason: 'body_not_allowed' } }));
    expect(pause).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled(); expect(stopProject).not.toHaveBeenCalled(); expect(getStatus).not.toHaveBeenCalled();
  });
  it('records capability denial without scheduling or acknowledgement', async () => {
    expect(await handlers(false).restart_server!(input())).toMatchObject({ statusCode: 403 });
    expect(appendEvent).toHaveBeenCalledTimes(1);
    expect(appendEvent).toHaveBeenCalledWith(expect.objectContaining({ result: { operation: 'restart_server', outcome: 'rejected', reason: 'restart_unavailable' } }));
    expect(schedule).not.toHaveBeenCalled(); expect(once).not.toHaveBeenCalled();
  });
  it('schedules, appends, then installs the sole finish acknowledgement', async () => {
    expect(await handlers().restart_server!(input())).toEqual({ body: { status: 'restart_scheduled' } });
    expect(schedule).toHaveBeenCalledTimes(1); expect(appendEvent).toHaveBeenCalledTimes(1); expect(once).toHaveBeenCalledTimes(1);
    expect(schedule.mock.invocationCallOrder[0]).toBeLessThan(appendEvent.mock.invocationCallOrder[0]!);
    expect(appendEvent.mock.invocationCallOrder[0]).toBeLessThan(once.mock.invocationCallOrder[0]!);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(once.mock.calls[0]![0]).toBe('finish');
    (once.mock.calls[0]![1] as () => void)();
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });
  it.each([new Error('known append failure'), new PublicationOutcomeUnknownError()])('propagates append failure identically with no follow-up: %s', async (failure) => {
    for (const operation of ['runtime.pause', 'runtime.resume', 'stop_project', 'restart_server'] as const) {
      jest.clearAllMocks();
      appendEvent.mockImplementation(() => { throw failure; });
      const invoke = async () => handlers()[operation]!(input());
      await expect(invoke()).rejects.toBe(failure);
      expect(appendEvent).toHaveBeenCalledTimes(1);
      expect(once).not.toHaveBeenCalled(); expect(acknowledge).not.toHaveBeenCalled();
      expect(getStatus).toHaveBeenCalledTimes(operation === 'runtime.pause' || operation === 'runtime.resume' ? 1 : 0);
      expect(pause).toHaveBeenCalledTimes(operation === 'runtime.pause' ? 1 : 0);
      expect(resume).toHaveBeenCalledTimes(operation === 'runtime.resume' ? 1 : 0);
      expect(stopProject).toHaveBeenCalledTimes(operation === 'stop_project' ? 1 : 0);
      expect(schedule).toHaveBeenCalledTimes(operation === 'restart_server' ? 1 : 0);
    }
  });
  it.each([new Error('known rejection append failure'), new PublicationOutcomeUnknownError()])('propagates rejection append failure without subsequent work: %s', async (failure) => {
    for (const operation of ['runtime.pause', 'runtime.resume', 'stop_project', 'restart_server'] as const) {
      jest.clearAllMocks();
      appendEvent.mockImplementation(() => { throw failure; });
      await expect((async () => handlers(false)[operation]!(input({ secret: 'not retained' })))()).rejects.toBe(failure);
      expect(appendEvent).toHaveBeenCalledTimes(1);
      for (const followup of [pause, resume, stopProject, schedule, once, acknowledge, getStatus, getActorRuntimeReadModel, getOversightStatus, serverAvailabilityProvider]) expect(followup).not.toHaveBeenCalled();
    }
  });
  it('does not append when the principal control throws', async () => {
    const failure = new Error('control failed');
    pause.mockImplementation(() => { throw failure; });
    await expect((async () => handlers()['runtime.pause']!(input()))()).rejects.toBe(failure);
    expect(appendEvent).not.toHaveBeenCalled(); expect(getStatus).not.toHaveBeenCalled();
  });
});
