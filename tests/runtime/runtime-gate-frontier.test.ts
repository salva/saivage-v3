import { describe, expect, it, jest } from '@jest/globals';
import { RuntimeGate } from '../../src/runtime/runtime-gate.js';

describe('RuntimeGate minimal pause frontier', () => {
  it('parks one frontier and resumes it exactly once', async () => {
    const gate = new RuntimeGate(true);
    const parked = jest.fn();
    gate.requestPause(parked);
    const signal = new AbortController();
    const waiting = gate.waitUntilOpen(signal.signal);
    expect(gate.pauseRequested).toBe(true);
    expect(gate.isParked).toBe(true);
    expect(parked).toHaveBeenCalledTimes(1);
    expect(() => gate.waitUntilOpen(new AbortController().signal)).toThrow('exactly one parked frontier');
    gate.open();
    await waiting;
    expect(gate.pauseRequested).toBe(false);
    expect(gate.isParked).toBe(false);
  });

  it('cancellation rejects the parked frontier without Resume', async () => {
    const gate = new RuntimeGate(true);
    gate.requestPause(() => {});
    const owner = new AbortController();
    const waiting = gate.waitUntilOpen(owner.signal);
    owner.abort(new Error('cancelled'));
    await expect(waiting).rejects.toThrow('cancelled');
    expect(gate.isParked).toBe(false);
  });
});
