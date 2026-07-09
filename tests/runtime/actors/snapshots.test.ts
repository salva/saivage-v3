import { describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actorSnapshotPath, readActorSnapshot, readActorSnapshots, saveActorSnapshot } from '../../../src/runtime/actors/snapshots.js';

function snapshot(actorId: string, actorKind: 'card' | 'llm' | 'processor') {
  return {
    actor_id: actorId,
    actor_kind: actorKind,
    state_value: 'idle',
    context: {},
    updated_at: '2026-07-09T00:00:00.000Z',
  };
}

describe('actor snapshots', () => {
  it('routes actor snapshots by card or analyst ownership', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-snapshots-'));

    expect(actorSnapshotPath(root, 'card:card-7')).toBe(join(root, '.saivage', 'cards', 'card-7', 'runtime', 'actors', 'card', 'card%3Acard-7.json'));
    expect(actorSnapshotPath(root, 'processor:card-7')).toBe(join(root, '.saivage', 'cards', 'card-7', 'runtime', 'actors', 'processor', 'processor%3Acard-7.json'));
    expect(actorSnapshotPath(root, 'planner:card-7')).toBe(join(root, '.saivage', 'cards', 'card-7', 'runtime', 'actors', 'llm', 'planner%3Acard-7.json'));
    expect(actorSnapshotPath(root, 'executor:card-7')).toBe(join(root, '.saivage', 'cards', 'card-7', 'runtime', 'actors', 'llm', 'executor%3Acard-7.json'));
    expect(actorSnapshotPath(root, 'reviewer:card-7')).toBe(join(root, '.saivage', 'cards', 'card-7', 'runtime', 'actors', 'llm', 'reviewer%3Acard-7.json'));
    expect(actorSnapshotPath(root, 'analyst:global')).toBe(join(root, '.saivage', 'agents', 'runtime', 'actors', 'llm', 'analyst%3Aglobal.json'));
  });

  it('writes and reads snapshots from all current cursor roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-snapshots-'));

    saveActorSnapshot(root, snapshot('card:card-7', 'card'));
    saveActorSnapshot(root, snapshot('processor:card-7', 'processor'));
    saveActorSnapshot(root, snapshot('planner:card-7', 'llm'));
    saveActorSnapshot(root, snapshot('analyst:global', 'llm'));

    expect(existsSync(actorSnapshotPath(root, 'card:card-7'))).toBe(true);
    expect(existsSync(actorSnapshotPath(root, 'processor:card-7'))).toBe(true);
    expect(existsSync(actorSnapshotPath(root, 'planner:card-7'))).toBe(true);
    expect(existsSync(actorSnapshotPath(root, 'analyst:global'))).toBe(true);
    expect(readActorSnapshot(root, 'planner:card-7')?.actor_id).toBe('planner:card-7');
    expect(readActorSnapshots(root).map((item) => item.actor_id)).toEqual(['analyst:global', 'card:card-7', 'planner:card-7', 'processor:card-7']);
  });
});
