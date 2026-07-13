import { testActorSnapshots, type TestActorSnapshotStore } from '../../helpers/actor-snapshots.js';
import { describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ActorSnapshotStore, actorSnapshotPath, readActorSnapshot, readActorSnapshots } from '../../../src/runtime/actors/snapshots.js';
import { ReadModelChangeBroadcaster } from '../../../src/application/read-model-changes.js';
import { createMutationLane } from '../../../src/application/mutation-lane.js';
import { RootCurrentness } from '../../../src/application/mutation-authority.js';

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

    testActorSnapshots(root).save(snapshot('card:card-7', 'card'));
    testActorSnapshots(root).save(snapshot('processor:card-7', 'processor'));
    testActorSnapshots(root).save(snapshot('planner:card-7', 'llm'));
    testActorSnapshots(root).save(snapshot('analyst:global', 'llm'));

    expect(existsSync(actorSnapshotPath(root, 'card:card-7'))).toBe(true);
    expect(existsSync(actorSnapshotPath(root, 'processor:card-7'))).toBe(true);
    expect(existsSync(actorSnapshotPath(root, 'planner:card-7'))).toBe(true);
    expect(existsSync(actorSnapshotPath(root, 'analyst:global'))).toBe(true);
    expect(readActorSnapshot(root, 'planner:card-7')?.actor_id).toBe('planner:card-7');
    expect(readActorSnapshots(root).map((item) => item.actor_id)).toEqual(['analyst:global', 'card:card-7', 'planner:card-7', 'processor:card-7']);
  });

  it.each<[string, 'card' | 'processor' | 'llm', string[]]>([
    ['card:card-7', 'card', ['runtime']],
    ['processor:card-7', 'processor', ['runtime']],
    ['planner:card-7', 'llm', ['runtime', 'agents', 'conversation:planner:card-7']],
  ])('publishes the exact matrix for save and successful remove of %s', (actorId, kind, expected) => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-snapshots-'));
    const { store, observed } = recordingStore(root);

    store.save(snapshot(actorId, kind));
    expect(observed).toEqual(expected);
    observed.length = 0;
    expect(store.remove(actorId)).toBe(true);
    expect(observed).toEqual(expected);
  });

  it('publishes runtime only after a notification append and nothing for remove=false', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-snapshots-'));
    const { store, observed } = recordingStore(root);

    store.appendNotification('card:card-7', { id: 'n-1', message: 'changed', created_at: '2026-07-13T00:00:00.000Z' });
    expect(observed).toEqual(['runtime']);
    observed.length = 0;
    expect(store.remove('processor:missing')).toBe(false);
    expect(observed).toEqual([]);
  });

  it('publishes nothing when snapshot persistence fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-snapshots-'));
    writeFileSync(join(root, '.saivage'), 'blocks persistence');
    const { store, observed } = recordingStore(root);

    expect(() => store.save(snapshot('planner:card-7', 'llm'))).toThrow();
    expect(observed).toEqual([]);
  });

  it('publishes nothing when notification persistence or snapshot removal fails', () => {
    const appendRoot = mkdtempSync(join(tmpdir(), 'saivage-snapshots-'));
    writeFileSync(join(appendRoot, '.saivage'), 'blocks persistence');
    const append = recordingStore(appendRoot);
    expect(() => append.store.appendNotification('card:card-7', { id: 'n-1', message: 'changed', created_at: '2026-07-13T00:00:00.000Z' })).toThrow();
    expect(append.observed).toEqual([]);

    const removeRoot = mkdtempSync(join(tmpdir(), 'saivage-snapshots-'));
    mkdirSync(actorSnapshotPath(removeRoot, 'processor:card-7'), { recursive: true });
    const remove = recordingStore(removeRoot);
    expect(() => remove.store.remove('processor:card-7')).toThrow();
    expect(remove.observed).toEqual([]);
  });

  it('rejects stale actor authority without publishing a snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-snapshots-currentness-'));
    const changes = new ReadModelChangeBroadcaster();
    const composition = createMutationLane();
    const store = new ActorSnapshotStore(root, composition.lane, changes);
    const currentness = new RootCurrentness();
    const rootAuthority = currentness.installRoot();
    const stale = currentness.installLeaf(rootAuthority);
    currentness.clearRoot();
    expect(() => store.save(stale, snapshot('planner:card-7', 'llm'))).toThrow(/stale/);
    expect(existsSync(actorSnapshotPath(root, 'planner:card-7'))).toBe(false);
  });

  it('removes owned snapshot replacement temporaries before strict replay', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-snapshots-temp-'));
    const composition = createMutationLane();
    const store = new ActorSnapshotStore(root, composition.lane, new ReadModelChangeBroadcaster());
    store.save(composition.authority, snapshot('planner:card-7', 'llm'));
    const path = actorSnapshotPath(root, 'planner:card-7');
    const temporary = join(dirname(path), `.${path.split('/').at(-1)}.saivage-write-00000000-0000-0000-0000-000000000000.tmp`);
    writeFileSync(temporary, 'incomplete');
    store.restabilize(composition.authority);
    expect(existsSync(temporary)).toBe(false);
    expect(readActorSnapshot(root, 'planner:card-7')?.actor_id).toBe('planner:card-7');
  });
});

function recordingStore(projectRoot: string): { store: TestActorSnapshotStore; observed: string[] } {
  const changes = new ReadModelChangeBroadcaster();
  const observed: string[] = [];
  changes.subscribe({
    runtimeChanged: jest.fn(() => observed.push('runtime')),
    cardStateChanged: jest.fn(() => observed.push('cards')),
    agentsChanged: jest.fn(() => observed.push('agents')),
    conversationChanged: jest.fn((id: string) => observed.push(`conversation:${id}`)),
  });
  return { store: testActorSnapshots(projectRoot, changes), observed };
}
