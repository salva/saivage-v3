import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import {
  initRuntimeState,
  readRuntimeState,
  runtimeStatePath,
  saveRuntimeState,
  updateRuntimeState,
} from '../../src/runtime/state.js';
import type { ActiveCardRun, RuntimeState } from '../../src/schemas/types.js';

let root: string;

function authoritativePath(): string {
  return runtimeStatePath(root);
}

function readAuthoritative(): RuntimeState {
  return (JSON.parse(readFileSync(authoritativePath(), 'utf-8')) as { version: number; data: RuntimeState }).data;
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
  it('init/save/update/read create and use .saivage/state/runtime.json as authoritative', () => {
    const initialized = initRuntimeState(root);
    expect(existsSync(authoritativePath())).toBe(true);
    expect(readAuthoritative()).toMatchObject({ status: 'stopped', project_id: initialized.project_id });

    const saved = saveRuntimeState(root, { ...initialized, status: 'paused' });
    expect(readAuthoritative()).toMatchObject({ status: 'paused' });
    expect(saved.status).toBe('paused');

    const updated = updateRuntimeState(root, { status: 'running', active_card_run: activeRun('goal-a') });
    expect(updated).toMatchObject({ status: 'running', active_card_run: expect.objectContaining({ card_id: 'goal-a' }) });
    expect(readRuntimeState(root)).toMatchObject({ status: 'running', active_card_run: expect.objectContaining({ card_id: 'goal-a' }) });
  });
});
