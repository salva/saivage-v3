import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree, writeFileAtomic } from '../../src/utils/file-tree.js';
import {
  initRuntimeState,
  legacyRuntimeStatePath,
  readRuntimeState,
  runtimeStatePath,
  saveRuntimeState,
  updateRuntimeState,
  RuntimeStateLayoutError,
} from '../../src/utils/runtime-state.js';
import type { RuntimeState } from '../../src/schemas/types.js';

let root: string;

function authoritativePath(): string {
  return runtimeStatePath(root);
}

function legacyPath(): string {
  return legacyRuntimeStatePath(root);
}

function migratedLegacyPath(): string {
  return join(root, '.saivage', 'runtime', 'state.json.migrated');
}

function readAuthoritative(): RuntimeState {
  return JSON.parse(readFileSync(authoritativePath(), 'utf-8')) as RuntimeState;
}

function legacyRuntimeState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  const now = new Date().toISOString();
  return {
    status: 'paused',
    project_id: 'project',
    pid: 12345,
    started_at: now,
    current_card_id: null,
    current_agent_session_id: null,
    active_card_run: null,
    paused: true,
    paused_at: now,
    queue: ['legacy-card'],
    running_processes: [],
    updated_at: now,
    frozen_reason: null,
    ...overrides,
  };
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

    const updated = updateRuntimeState(root, { status: 'running', current_card_id: 'goal-a' });
    expect(updated).toMatchObject({ status: 'running', current_card_id: 'goal-a' });
    expect(readRuntimeState(root)).toMatchObject({ status: 'running', current_card_id: 'goal-a' });
    expect(existsSync(legacyPath())).toBe(false);
  });

  it('migrates a supported legacy .saivage/runtime/state.json exactly once when no authoritative file exists', () => {
    const legacy = legacyRuntimeState();
    writeFileAtomic(legacyPath(), JSON.stringify(legacy, null, 2) + '\n');

    const migrated = readRuntimeState(root);
    expect(migrated).toMatchObject({ status: 'paused', paused: true, queue: ['legacy-card'] });
    expect(existsSync(authoritativePath())).toBe(true);
    expect(existsSync(legacyPath())).toBe(false);
    expect(existsSync(migratedLegacyPath())).toBe(true);
    expect(readAuthoritative()).toMatchObject({ status: 'paused', paused: true, queue: ['legacy-card'] });

    const afterSecondRead = readRuntimeState(root);
    expect(afterSecondRead).toMatchObject({ status: 'paused', paused: true, queue: ['legacy-card'] });
    expect(existsSync(legacyPath())).toBe(false);
    expect(existsSync(migratedLegacyPath())).toBe(true);
  });

  it('refuses mixed old and new runtime-state layouts with a clear split-brain error', () => {
    const authoritative = initRuntimeState(root);
    writeFileAtomic(legacyPath(), JSON.stringify(legacyRuntimeState({ status: 'paused' }), null, 2) + '\n');

    expect(() => readRuntimeState(root)).toThrow(RuntimeStateLayoutError);
    expect(() => saveRuntimeState(root, authoritative)).toThrow(/split-brain state files/);
    expect(() => updateRuntimeState(root, { status: 'paused' })).toThrow(/both authoritative/);
  });

  it('treats old-path changes as non-authoritative after the authoritative file exists by refusing the mixed layout', () => {
    const authoritative = initRuntimeState(root);
    saveRuntimeState(root, { ...authoritative, status: 'running', current_card_id: 'authoritative-card' });
    writeFileAtomic(legacyPath(), JSON.stringify(legacyRuntimeState({ status: 'paused', current_card_id: null }), null, 2) + '\n');

    expect(() => readRuntimeState(root)).toThrow(RuntimeStateLayoutError);
    const persisted = readAuthoritative();
    expect(persisted).toMatchObject({ status: 'running', current_card_id: 'authoritative-card' });
  });
});
