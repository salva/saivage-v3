import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRuntimeState } from '../../src/runtime/state.js';
import { createRuntimeTestHarness } from '../utils/runtime-test-harness.js';

function root(): string { return mkdtempSync(join(tmpdir(), 'saivage-state-machine-wired-')); }

describe('Runtime wires RuntimeStateMachine', () => {
  it('advances last_tick_at through startup without exposing the state machine', async () => {
    const projectRoot = root();
    try {
      const { api } = createRuntimeTestHarness({
        config: { projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' }, autoDispatchBacklog: false },
      });
      await api.start();
      try {
        let after = readRuntimeState(projectRoot)?.last_tick_at ?? null;
        for (let i = 0; i < 10 && after === null; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          after = readRuntimeState(projectRoot)?.last_tick_at ?? null;
        }
        expect(after).not.toBeNull();
      } finally {
        await api.shutdown();
      }
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });
});
