import { describe, expect, it } from '@jest/globals';
import { RuntimeGate } from '../../src/runtime/runtime-gate.js';

describe('RuntimeGate', () => {
  it('completes a reusable run by clearing its pending Pause callback without delivery', async () => {
    const gate = new RuntimeGate(true); let parked = 0; gate.requestPause(() => { parked += 1; }); gate.completeRun();
    expect(gate.isOpen).toBe(false); expect(parked).toBe(0);
    const controller = new AbortController(); const pending = gate.waitUntilOpen(controller.signal); expect(parked).toBe(0); controller.abort(new Error('done')); await expect(pending).rejects.toThrow('done');
  });

  it('rejects completed-run reset while a frontier remains parked', async () => { const gate = new RuntimeGate(false); const controller = new AbortController(); const pending = gate.waitUntilOpen(controller.signal); expect(() => gate.completeRun()).toThrow(/parked frontier/); controller.abort(new Error('done')); await expect(pending).rejects.toThrow('done'); });

  it('rejects paused admission on abort and removes the waiter before a later open', async () => {
    const gate = new RuntimeGate(false);
    const abort = new AbortController();
    const pending = gate.waitUntilOpen(abort.signal);

    abort.abort(new Error('card cancelled'));
    await expect(pending).rejects.toThrow('card cancelled');

    gate.open();
    expect(gate.isOpen).toBe(true);
  });

  it('rejects an already-aborted admission without retaining it', async () => {
    const gate = new RuntimeGate(false);
    const abort = new AbortController();
    abort.abort(new Error('already cancelled'));

    await expect(gate.waitUntilOpen(abort.signal)).rejects.toThrow('already cancelled');
    gate.open();
  });

});
