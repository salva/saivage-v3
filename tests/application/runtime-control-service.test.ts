import { describe, expect, it, jest } from '@jest/globals';
import { RuntimeControlService, type RuntimeControlMechanics, type RuntimeLaunchPlan } from '../../src/application/runtime-control-service.js';
import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js';
import type { RuntimeState } from '../../src/schemas/index.js';

const launch = {} as RuntimeLaunchPlan;
const state: RuntimeState = { status: 'running', project_id: 'project', pid: 4242, started_at: '2026-07-18T00:00:00.000Z', current_card_id: 'project', updated_at: '2026-07-18T00:00:01.000Z' };

function mechanics(): RuntimeControlMechanics {
  return {
    start: async () => {},
    closeApplicationAdmission: jest.fn(),
    cleanupForApplicationStop: jest.fn(async () => {}),
    stopProject: jest.fn(async () => ({ status: 'stopped' as const, contained: true })),
    cancelCard: jest.fn(async (cardId: string) => ({ card_id: cardId, status: 'cancelled' as const, cancelled_card_ids: [cardId] })),
    beginStartProject: jest.fn(async () => ({ accepted: true as const, launch })),
    launchStartedProject: jest.fn(() => state),
    beginPause: jest.fn(() => ({ settled: false })),
    beginResume: jest.fn(() => undefined),
    finishResume: jest.fn(),
    notifyCard: (_cardId, notification) => ({ ok: true, notificationId: notification.id }),
    subscribe: () => ({ id: 'test', pause() {}, resume() {}, unsubscribe() {} }),
    getStatus: () => ({ status: 'running', currentCardId: 'project', pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' }),
    getRuntimeState: () => state,
    getActorRuntimeReadModel: () => ({ pauseMode: 'running', cards: [] }),
    captureAutonomousExecutingLlmSnapshots: () => [],
  };
}

describe('RuntimeControlService process-local control', () => {
  it('starts through source-free preparation and launches the prepared project', async () => {
    const runtime = mechanics();
    const service = new RuntimeControlService({ projectRoot: '/project', interventionBinding: new RuntimeInterventionBinding(), mechanics: runtime });

    await expect(service.startProject()).resolves.toEqual({ runtime: state, status: 'running', started: true, stopped: false });
    expect(runtime.beginStartProject).toHaveBeenCalledWith();
    expect(runtime.launchStartedProject).toHaveBeenCalledWith(launch);
    expect(service.getRuntimeState()).toBe(state);
  });

  it('delegates fresh state after Start and uses state-free pause/resume commands', async () => {
    const runtime = mechanics();
    let projected = state;
    runtime.getRuntimeState = jest.fn(() => projected);
    const service = new RuntimeControlService({ projectRoot: '/project', interventionBinding: new RuntimeInterventionBinding(), mechanics: runtime });
    await service.startProject();
    projected = { ...state, status: 'paused', current_card_id: 'card-a', updated_at: '2026-07-18T00:00:02.000Z' };
    expect(service.getRuntimeState()).toBe(projected);
    service.pause();
    service.resume();
    expect(runtime.getRuntimeState).toHaveBeenCalledTimes(1);
    expect(runtime.beginPause).toHaveReturnedWith({ settled: false });
    expect(runtime.beginResume).toHaveBeenCalledWith();
  });

  it('returns no successful Start result when synchronous launch fails', async () => {
    const runtime = mechanics();
    (runtime.launchStartedProject as jest.Mock).mockImplementation(() => { throw new Error('launch failed'); });
    runtime.getRuntimeState = jest.fn(() => null);
    const service = new RuntimeControlService({ projectRoot: '/project', interventionBinding: new RuntimeInterventionBinding(), mechanics: runtime });
    await expect(service.startProject()).rejects.toThrow('launch failed');
    expect(service.getRuntimeState()).toBeNull();
  });

  it('keeps project stop separate from terminal application disposal', async () => {
    const runtime = mechanics();
    const service = new RuntimeControlService({ projectRoot: '/project', interventionBinding: new RuntimeInterventionBinding(), mechanics: runtime });
    await expect(service.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
    expect(runtime.stopProject).toHaveBeenCalledTimes(1);
    await service.cleanupForApplicationStop();
    expect(runtime.cleanupForApplicationStop).toHaveBeenCalledTimes(1);
  });
});
