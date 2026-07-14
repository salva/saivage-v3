import { describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { ReadModelChangeBroadcaster } from '../../src/application/read-model-changes.js';
import { ConversationStore } from '../../src/persistence/conversation-store.js';
import { ApplicationPersistenceHealth } from '../../src/application/persistence-health.js';
import { RuntimeStateStore } from '../../src/runtime/state.js';
import { ActorSnapshotStore } from '../../src/runtime/actors/snapshots.js';
import { initRuntimeState } from '../helpers/runtime-state.js';
import { SyncHub } from '../../src/server/sync-hub.js';
import type { LiveSyncSocket } from '../../src/server/live-sync-socket.js';
import type { AgentMessage } from '../../src/schemas/index.js';

const sourceRoot = join(process.cwd(), 'src');

function typescriptFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? typescriptFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('live-update semantic-owner inventory', () => {
  it('keeps every conversation and app-log store mutation at the reviewed call sites', () => {
    const files = typescriptFiles(sourceRoot);
    const owners = (pattern: RegExp) => files.filter((path) => pattern.test(readFileSync(path, 'utf8'))).map((path) => relative(process.cwd(), path)).sort();
    expect(owners(/\.appendBatch\(/)).toEqual([
      'src/runtime/actors/actor-recovery.ts',
      'src/runtime/actors/conversation-store.ts',
      'src/runtime/actors/llm-delivery-log.ts',
    ]);
    expect(owners(/\.publishCompactedVersion\(/)).toEqual(['src/runtime/actors/compaction/compactor.ts']);
    expect(owners(/(?:appLogs|\.appLogs)\.append\(/)).toEqual([
      'src/agents/invocation-service.ts',
      'src/observability/error-logger.ts',
      'src/observability/event-logger.ts',
      'src/persistence/control-action-audit.ts',
      'src/workspace/quarantine.ts',
    ]);
  });

  it('keeps conversation and provider exchange raw writers behind their singular mutation ports', () => {
    const inventory = [
      { symbol: 'appendBatch', owners: [] },
      { symbol: 'publishCompactedVersion', owners: [] },
      {
        symbol: 'appendProviderExchangeLogEntry',
        roots: [sourceRoot, join(process.cwd(), 'tests')],
        owners: [],
      },
    ];

    for (const row of inventory) {
      const importers = (row.roots ?? [sourceRoot]).flatMap(typescriptFiles)
        .filter((path) => new RegExp(`import\\s*{[^}]*\\b${row.symbol}\\b[^}]*}\\s*from`).test(readFileSync(path, 'utf8')))
        .map((path) => relative(process.cwd(), path)).sort();
      expect(importers).toEqual(row.owners);
    }
  });

  it('keeps raw runtime persistence delivery-free and snapshots owned by the required store', () => {
    const stateSource = readFileSync(join(sourceRoot, 'runtime/state.ts'), 'utf8');
    const supervisorSource = readFileSync(join(sourceRoot, 'runtime/actors/supervisor-runtime-api.ts'), 'utf8');
    const snapshotSource = readFileSync(join(sourceRoot, 'runtime/actors/snapshots.ts'), 'utf8');

    expect(stateSource).toContain('export class RuntimeStateStore');
    expect(existsSync(join(sourceRoot, 'runtime/mutations.ts'))).toBe(false);
    expect(supervisorSource).toContain('this.runtimeState.patch');
    expect(supervisorSource).not.toContain('servingRuntimeState');
    expect(snapshotSource).toContain('export class ActorSnapshotStore');
    expect(snapshotSource).not.toMatch(/export (?:function|const) (?:save|remove|append)ActorSnapshot/);
  });
});

describe('server-composed semantic delivery', () => {
  it('delivers representative runtime, conversation, agent, and snapshot targets without metadata', () => {
    jest.useFakeTimers();
    try {
      const root = mkdtempSync(join(tmpdir(), 'saivage-live-delivery-'));
      initRuntimeState(root);
      const invalidate = jest.fn();
      const hub = new SyncHub({ invalidate } as unknown as LiveSyncSocket, 1);
      const changes = new ReadModelChangeBroadcaster();
      const subscription = changes.subscribe(hub);

      const health = new ApplicationPersistenceHealth();
      const runtimeState = new RuntimeStateStore(root, health, changes);
      runtimeState.patch({ status: 'paused' });
      const namespace = { activeCardIds: () => ['project'], isActiveCardId: (cardId: string) => cardId === 'project' };
      const conversations = new ConversationStore(root, health, changes, namespace);
      conversations.restabilize();
      conversations.appendBatch([message('planner:project')]);
      new ActorSnapshotStore(root, health, changes, namespace).save({
        actor_id: 'processor:project', actor_kind: 'processor', state_value: 'idle', context: {}, updated_at: '2026-07-13T00:00:00.000Z',
      });
      jest.advanceTimersByTime(1);

      expect(invalidate.mock.calls.map(([target]) => target)).toEqual([
        { resource: 'runtime' },
        { resource: 'conversation', id: 'planner:project' },
        { resource: 'agents' },
      ]);
      subscription.unsubscribe();
      hub.dispose();
    } finally {
      jest.useRealTimers();
    }
  });
});

function message(sessionId: string): AgentMessage {
  return {
    id: 'message-1', session_id: sessionId, role: 'user', kind: 'text', content: 'hello',
    round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0,
    timestamp: '2026-07-13T00:00:00.000Z',
  };
}
