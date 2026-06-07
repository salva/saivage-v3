import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { writeFileAtomic } from '../../src/persistence/durable-write.js';
import {
  initRuntimeState,
  legacyRuntimeStatePath,
  readRuntimeState,
  runtimeStatePath,
  saveRuntimeState,
  updateRuntimeState,
  RuntimeStateLayoutError,
} from '../../src/runtime/state.js';
import type { ActiveCardRun, RuntimeState } from '../../src/schemas/types.js';

let root: string;

function authoritativePath(): string {
  return runtimeStatePath(root);
}

function legacyPath(): string {
  return legacyRuntimeStatePath(root);
}


function readAuthoritative(): RuntimeState {
  return (JSON.parse(readFileSync(authoritativePath(), 'utf-8')) as { version: number; data: RuntimeState }).data;
}

function legacyRuntimeState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  const now = new Date().toISOString();
  return {
    status: 'paused',
    project_id: 'project',
    pid: 1234,
    started_at: now,
    active_card_run: null,
    paused: true,
    paused_at: now,
    updated_at: now,
    frozen_reason: null,
    ...overrides,
  };
}

function activeRun(cardId: string): ActiveCardRun {
  const now = new Date().toISOString();
  return { card_id: cardId, card_type: 'goal', ownership: { kind: 'direct', source: 'project_root' },
  runtime_status: 'running', phase: 'planner', caller_session_id: null, caller_tool_call_id: null, planner_session_id: `planner:${cardId}`, correction_attempts: 0, started_at: now, last_turn_at: now };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saivage-runtime-state-layout-'));
  initProjectTree(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('RuntimeState authoritative file layout', () => {
  it('init/save/update/read create and use .saivage/tmp/state/runtime.json as authoritative', () => {
    const initialized = initRuntimeState(root);
    expect(existsSync(authoritativePath())).toBe(true);
    expect(existsSync(legacyPath())).toBe(false);
    expect(readAuthoritative()).toMatchObject({ status: 'idle', project_id: initialized.project_id });

    const saved = saveRuntimeState(root, { ...initialized, status: 'paused', paused: true });
    expect(readAuthoritative()).toMatchObject({ status: 'paused', paused: true });
    expect(saved.status).toBe('paused');

    const updated = updateRuntimeState(root, { status: 'running', active_card_run: activeRun('goal-a') });
    expect(updated).toMatchObject({ status: 'running', active_card_run: expect.objectContaining({ card_id: 'goal-a' }) });
    expect(readRuntimeState(root)).toMatchObject({ status: 'running', active_card_run: expect.objectContaining({ card_id: 'goal-a' }) });
    expect(existsSync(legacyPath())).toBe(false);
  });

  it('ignores legacy .saivage/runtime/state.json when no authoritative file exists', () => {
    const legacy = legacyRuntimeState();
    writeFileAtomic(legacyPath(), JSON.stringify(legacy, null, 2) + '\n');

    expect(readRuntimeState(root)).toBeNull();
    expect(existsSync(authoritativePath())).toBe(false);
    expect(existsSync(legacyPath())).toBe(true);
  });

  it('refuses mixed old and new runtime-state layouts with a clear split-brain error', () => {
    const authoritative = initRuntimeState(root);
    writeFileAtomic(legacyPath(), JSON.stringify(legacyRuntimeState({ status: 'paused' }), null, 2) + '\n');

    expect(() => readRuntimeState(root)).toThrow(RuntimeStateLayoutError);
    expect(() => saveRuntimeState(root, authoritative)).toThrow(/both authoritative/);
    expect(() => updateRuntimeState(root, { status: 'paused' })).toThrow(/both authoritative/);
  });

  it('treats old-path changes as non-authoritative after the authoritative file exists by refusing the mixed layout', () => {
    const authoritative = initRuntimeState(root);
    saveRuntimeState(root, { ...authoritative, status: 'running', active_card_run: activeRun('authoritative-card') });
    writeFileAtomic(legacyPath(), JSON.stringify(legacyRuntimeState({ status: 'paused', active_card_run: null }), null, 2) + '\n');

    expect(() => readRuntimeState(root)).toThrow(RuntimeStateLayoutError);
    const persisted = readAuthoritative();
    expect(persisted).toMatchObject({ status: 'running', active_card_run: expect.objectContaining({ card_id: 'authoritative-card' }) });
  });
});
