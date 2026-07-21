import { describe, expect, it, jest } from '@jest/globals';
import { RuntimeControlService, type RuntimeControlMechanics } from '../../src/application/runtime-control-service.js';
import type { RuntimeLaunchPlan } from '../../src/application/runtime-control-service.js';

function mechanics(): RuntimeControlMechanics {
  return {
    start: jest.fn(async () => undefined), closeApplicationAdmission: jest.fn(), cleanupForApplicationStop: jest.fn(async () => undefined),
    beginStartProject: jest.fn(async () => ({ accepted: false as const, result: { runtime: null, status: 'stopped' as const, started: false, stopped: true } })),
    launchStartedProject: jest.fn(), pause: jest.fn(), resume: jest.fn(), stopProject: jest.fn(async () => ({ status: 'stopped' as const, contained: false })),
    cancelCard: jest.fn(), notifyCard: jest.fn(), subscribe: jest.fn(), getStatus: jest.fn(), getRuntimeState: jest.fn(), getActorRuntimeReadModel: jest.fn(), captureAutonomousExecutingLlmSnapshots: jest.fn(() => []),
  } as RuntimeControlMechanics;
}

describe('RuntimeControlService delegation', () => {
  it('delegates rejected Run without readiness authority', async () => { const m = mechanics(); const service = new RuntimeControlService({ mechanics: m }); await expect(service.startProject()).resolves.toMatchObject({ started: false }); expect(m.launchStartedProject).not.toHaveBeenCalled(); });
  it('passes an accepted prepared launch directly to launch', async () => { const m = mechanics(); const launch = {} as never; jest.mocked(m.beginStartProject).mockResolvedValueOnce({ accepted: true, launch }); jest.mocked(m.launchStartedProject).mockReturnValueOnce({ status: 'running', project_id: 'project', pid: 1, started_at: 'now', current_card_id: 'project', updated_at: 'now' }); const service = new RuntimeControlService({ mechanics: m }); await expect(service.startProject()).resolves.toMatchObject({ started: true, status: 'running' }); expect(m.launchStartedProject).toHaveBeenCalledWith(launch); });
  it('delegates Pause, Resume, Stop, and application containment exactly once', async () => { const m = mechanics(); const service = new RuntimeControlService({ mechanics: m }); service.pause(); service.resume(); await service.stopProject(); service.closeApplicationAdmission(); await service.cleanupForApplicationStop(); expect(m.pause).toHaveBeenCalledTimes(1); expect(m.resume).toHaveBeenCalledTimes(1); expect(m.stopProject).toHaveBeenCalledTimes(1); expect(m.closeApplicationAdmission).toHaveBeenCalledTimes(1); expect(m.cleanupForApplicationStop).toHaveBeenCalledTimes(1); });

  it('cannot launch while an accepted prepared start is suspended and then contained', async () => {
    const m = mechanics(); const launch = {} as RuntimeLaunchPlan;
    let release!: (value: { accepted: true; launch: RuntimeLaunchPlan }) => void;
    jest.mocked(m.beginStartProject).mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const service = new RuntimeControlService({ mechanics: m }); const start = service.startProject();
    service.closeApplicationAdmission(); await service.cleanupForApplicationStop(); release({ accepted: true, launch });
    jest.mocked(m.launchStartedProject).mockImplementationOnce(() => { throw new Error('Prepared runtime launch is no longer admissible.'); });
    await expect(start).rejects.toThrow('no longer admissible'); expect(m.launchStartedProject).toHaveBeenCalledWith(launch);
    expect(m.closeApplicationAdmission).toHaveBeenCalledTimes(1); expect(m.cleanupForApplicationStop).toHaveBeenCalledTimes(1);
  });

  it('performs no caller-side readiness work across every rejected or throwing control', async () => {
    const m = mechanics(); const service = new RuntimeControlService({ mechanics: m });
    jest.mocked(m.beginStartProject).mockResolvedValueOnce({ accepted: false, result: { runtime: null, status: 'error', started: false, stopped: false, error: 'retained' } });
    await expect(service.startProject()).resolves.toMatchObject({ status: 'error', started: false });
    for (const [method, call] of [['pause', () => service.pause()], ['resume', () => service.resume()]] as const) {
      jest.mocked(m[method]).mockImplementationOnce(() => { throw new Error(`${method} rejected`); }); expect(call).toThrow(`${method} rejected`);
    }
    jest.mocked(m.stopProject).mockRejectedValueOnce(new Error('containment failed')); await expect(service.stopProject()).rejects.toThrow('containment failed');
    expect(Object.keys(service)).toEqual(['options']);
  });
});
