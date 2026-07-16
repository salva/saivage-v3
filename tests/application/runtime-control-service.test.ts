import { describe, expect, it, jest } from '@jest/globals';
import { RuntimeControlService, type RuntimeControlMechanics } from '../../src/application/runtime-control-service.js';
import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js';
import type { RuntimeState } from '../../src/schemas/index.js';

const state: RuntimeState = { status: 'starting', project_id: 'project', pid: process.pid, started_at: new Date().toISOString(), active_card_run: null, updated_at: new Date().toISOString(), last_tick_at: null };

function mechanics(): RuntimeControlMechanics {
  return {
    start: async () => {},
    closeApplicationAdmission: jest.fn(),
    cleanupForApplicationStop: jest.fn(async () => {}),
    stopProject: jest.fn(async () => ({ status: 'stopped' as const, contained: true })),
    cancelCard: jest.fn(async (cardId: string) => ({ card_id: cardId, status: 'cancelled' as const, cancelled_card_ids: [cardId] })),
    beginStartProject: jest.fn(async () => ({ accepted: true as const, state })),
    launchStartedProject: jest.fn(),
    beginPause: jest.fn(() => ({ patch: { status: 'pausing' as const }, settled: false })),
    beginResume: jest.fn((current: RuntimeState) => ({ ...current, status: 'running' as const })),
    finishResume: jest.fn(),
    notifyCard: (_cardId, notification) => ({ ok: true, notificationId: notification.id }),
    subscribe: () => ({ id: 'test', pause() {}, resume() {}, unsubscribe() {} }),
    getStatus: () => ({ status: 'running', currentCardId: null, goalCount: 0, lastTickAt: null }),
    getRuntimeState: () => state,
    getActorRuntimeReadModel: () => ({ pauseMode: 'running', activeWork: 'none', cards: [], agents: [], diagnostics: [] }),
  };
}

describe('RuntimeControlService process-local control', () => {
  it('starts through source-free preparation and launches the prepared project', async () => {
    const runtime = mechanics();
    const service = new RuntimeControlService({ projectRoot: '/project', interventionBinding: new RuntimeInterventionBinding(), mechanics: runtime });

    await expect(service.startProject()).resolves.toEqual({ runtime: state, status: 'starting', started: true, stopped: false });
    expect(runtime.beginStartProject).toHaveBeenCalledWith();
    expect(runtime.launchStartedProject).toHaveBeenCalledWith(state);
    expect(service.getRuntimeState()).toBe(state);
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
