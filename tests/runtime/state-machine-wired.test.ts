import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../../src/runtime/runtime.js';
import { readRuntimeState } from '../../src/runtime/state.js';

function root(): string { return mkdtempSync(join(tmpdir(), 'saivage-state-machine-wired-')); }

describe('Runtime wires RuntimeStateMachine (Step 3, observe-only)', () => {
  it('exposes the state machine and advances last_tick_at after a tick', async () => {
    const projectRoot = root();
    try {
      const runtime = new Runtime({ projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' }, autoDispatchBacklog: false });
      expect(runtime.stateMachine).toBeDefined();
      await runtime.startup();
      try {
        const before = readRuntimeState(projectRoot)?.last_tick_at ?? null;
        await runtime.stateMachine.tick();
        const after = readRuntimeState(projectRoot)?.last_tick_at ?? null;
        expect(after).not.toBeNull();
        if (before !== null) expect(new Date(after!).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
      } finally {
        await runtime.shutdown();
      }
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });
});
