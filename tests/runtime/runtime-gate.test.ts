import { describe, expect, it } from '@jest/globals';
import { RuntimeGate } from '../../src/runtime/runtime-gate.js';

describe('RuntimeGate', () => {
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

  it('terminally rejects current and future waiters and cannot reopen', async () => {
    const gate = new RuntimeGate(false);
    const current = gate.waitUntilOpen(new AbortController().signal);
    const reason = new Error('runtime disposed');

    gate.dispose(reason);

    await expect(current).rejects.toBe(reason);
    await expect(gate.waitUntilOpen(new AbortController().signal)).rejects.toBe(reason);
    expect(() => gate.open()).toThrow(/terminally closed/);
    expect(() => gate.setOpen(true)).toThrow(/terminally closed/);
    gate.dispose(new Error('ignored repeated disposal'));
  });
});
