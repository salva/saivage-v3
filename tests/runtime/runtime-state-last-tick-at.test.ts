import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRuntimeState, readRuntimeState, updateRuntimeState } from '../../src/runtime/state.js';
import { runtimeStateSchema } from '../../src/schemas/validators.js';

function root(): string { return mkdtempSync(join(tmpdir(), 'saivage-runtime-last-tick-')); }

describe('RuntimeState.last_tick_at round-trip', () => {
  it('defaults to null after initRuntimeState', () => {
    const projectRoot = root();
    try {
      const state = initRuntimeState(projectRoot);
      expect(state.last_tick_at ?? null).toBeNull();
      const reread = readRuntimeState(projectRoot);
      expect(reread).not.toBeNull();
      expect(reread!.last_tick_at ?? null).toBeNull();
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('persists a non-null ISO timestamp through updateRuntimeState and survives re-read', () => {
    const projectRoot = root();
    try {
      initRuntimeState(projectRoot);
      const tick = new Date('2026-05-24T10:11:12.000Z').toISOString();
      const written = updateRuntimeState(projectRoot, { last_tick_at: tick });
      expect(written.last_tick_at).toBe(tick);
      const reread = readRuntimeState(projectRoot);
      expect(reread!.last_tick_at).toBe(tick);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('accepts null in the Zod schema and rejects non-datetime strings', () => {
    const baseOk = {
      status: 'stopped' as const,
      project_id: 'project' as const,
      started_at: new Date().toISOString(),
      active_card_run: null,
      updated_at: new Date().toISOString(),
      pid: 123,
      last_tick_at: null,
    };
    expect(() => runtimeStateSchema.parse(baseOk)).not.toThrow();
    expect(() => runtimeStateSchema.parse({ ...baseOk, last_tick_at: 'not-a-datetime' })).toThrow();
    expect(() => runtimeStateSchema.parse({ ...baseOk, last_tick_at: new Date('2026-05-24T00:00:00.000Z').toISOString() })).not.toThrow();
  });
});
