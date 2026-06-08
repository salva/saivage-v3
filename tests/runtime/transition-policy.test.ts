import { describe, expect, it } from '@jest/globals';
import { planCardTransition } from '../../src/runtime/transition-policy.js';

describe('planCardTransition', () => {
  it('plans ordered start/restart/fail steps without mutating cards', () => {
    expect(planCardTransition({ action: 'start', fromStatus: 'backlog', canTransition: () => true })).toEqual({ accepted: true, steps: ['running'] });
    expect(planCardTransition({ action: 'restart', fromStatus: 'cancelled', canTransition: () => true })).toEqual({ accepted: true, steps: ['backlog', 'running'] });
    expect(planCardTransition({ action: 'fail', fromStatus: 'backlog', canTransition: () => true })).toEqual({ accepted: true, steps: ['running', 'failed'] });
  });

  it('uses supplied transition capability for planner-set and cancel decisions', () => {
    expect(planCardTransition({ action: 'planner_set_status', fromStatus: 'done', payload: { requestedStatus: 'running' }, canTransition: () => false })).toEqual({ accepted: false, code: 'state_machine_planner_status_rejected' });
    expect(planCardTransition({ action: 'planner_set_status', fromStatus: 'backlog', payload: { requestedStatus: 'backlog' }, canTransition: () => false })).toEqual({ accepted: true, steps: [] });
    expect(planCardTransition({ action: 'cancel', fromStatus: 'blocked', canTransition: (to) => to === 'cancelled' })).toEqual({ accepted: true, steps: ['cancelled'] });
  });
});
