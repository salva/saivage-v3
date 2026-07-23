import { describe, expect, it } from '@jest/globals';

import { ChildInvocationLease } from '../../../src/runtime/actors/child-invocation-wait.js';
import { RuntimeStoppedInterruption } from '../../../src/runtime/actors/runtime-stopped-interruption.js';

const identity = { sessionId: 'agent:planner:project', sourceInputId: 'input-1', toolCallId: 'call-1', toolName: 'activate_card' } as const;

describe('ChildInvocationLease interruption', () => {
  it.each(['admitted', 'settling'] as const)('terminally interrupts an %s lease in one synchronous transition', async (phase) => {
    const lease = new ChildInvocationLease(identity, 'card-a');
    const interruption = new RuntimeStoppedInterruption();
    lease.markAdmitted();
    if (phase === 'settling') lease.markSettling();

    lease.interrupt(interruption);

    expect(lease.phase()).toBe('interrupted');
    expect(lease.isWaitingBarrier()).toBe(false);
    expect(lease.isConsumable()).toBe(true);
    await expect(lease.activation).rejects.toBe(interruption);
    await expect(lease.join()).resolves.toBeUndefined();
    expect(() => lease.interrupt(interruption)).toThrow("cannot transition from 'interrupted' to 'interrupted'");
  });

  it('preserves reserved rejection and normal settling release', async () => {
    const rejected = new ChildInvocationLease(identity, 'card-a');
    const rejection = new Error('not admitted');
    rejected.markRejected();
    rejected.deliverInterruption(rejection);
    await expect(rejected.activation).rejects.toBe(rejection);

    const released = new ChildInvocationLease({ ...identity, toolCallId: 'call-2' }, 'card-b');
    const outcome = { status: 'failed' as const, summary: 'finished', result: { kind: 'runtime-failure' as const, summary: 'finished' } };
    released.markAdmitted();
    released.markSettling();
    released.markReleased();
    released.deliverOutcome(outcome);
    await expect(released.activation).resolves.toBe(outcome);
  });
});
