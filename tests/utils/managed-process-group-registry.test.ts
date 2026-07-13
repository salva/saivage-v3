import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, jest } from '@jest/globals';
import {
  ManagedProcessGroupRegistry,
  type ManagedProcessPlatform,
  type ManagedProcessScope,
  type ProcessCategory,
} from '../../src/runtime/managed-process-group-registry.js';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function harness(probes: Array<'live' | 'ESRCH' | 'EPERM'> = ['live']): {
  registry: ManagedProcessGroupRegistry;
  operations: string[];
  spawnCount: () => number;
} {
  const operations: string[] = [];
  let spawned = 0;
  const child = Object.assign(new EventEmitter(), { pid: 4242, kill: jest.fn() }) as unknown as ChildProcess;
  const platform: ManagedProcessPlatform = {
    spawn: () => { spawned += 1; return child; },
    probe: () => {
      const result = probes.shift() ?? 'live';
      operations.push(`probe:${result}`);
      if (result !== 'live') throw errno(result);
    },
    signal: (_pgid, signal) => { operations.push(`signal:${signal}`); },
  };
  return { registry: new ManagedProcessGroupRegistry(platform), operations, spawnCount: () => spawned };
}

function launch(registry: ManagedProcessGroupRegistry, directScope: ManagedProcessScope, category: ProcessCategory = 'runtime_card'): void {
  registry.launch({ groupId: 'group-1', directScope, category, file: 'ignored', args: [], options: {}, onAbsent: () => {} });
}

describe('ManagedProcessGroupRegistry capabilities and process-group truth', () => {
  it('rejects forged, sibling, container-as-direct, closed, and category-mismatched capabilities before spawn', async () => {
    const { registry, spawnCount } = harness();
    const container = registry.createContainerScope(registry.rootScope, 'same-label');
    const first = registry.createDirectScope(container, 'duplicate', 'runtime_card');
    const sibling = registry.createDirectScope(container, 'duplicate', 'runtime_card');
    expect(first).not.toBe(sibling);
    expect(() => launch(registry, {} as ManagedProcessScope)).toThrow('not allocated');
    expect(() => launch(registry, container)).toThrow('not a direct');
    expect(() => launch(registry, first, 'operator_session')).toThrow('does not authorize');
    registry.closeScope(first);
    expect(() => launch(registry, first)).toThrow('closed');
    expect(spawnCount()).toBe(0);

    launch(registry, sibling);
    const other = registry.createDirectScope(container, 'duplicate', 'runtime_card');
    await expect(registry.terminateGroup({ groupId: 'group-1', directScope: other, category: 'runtime_card', reason: 'forbidden' })).rejects.toThrow('not bound');
  });

  it('only ESRCH releases a live group binding', async () => {
    const { registry } = harness(['ESRCH']);
    const scope = registry.createDirectScope(registry.rootScope, 'direct', 'runtime_card');
    launch(registry, scope);
    const report = await registry.terminateScopeTree({ rootScope: registry.rootScope, categories: ['runtime_card'], reason: 'done', graceMs: 1 });
    expect(report).toEqual({ selected: ['group-1'], stopped: ['group-1'], failed: [] });
    expect(registry.isLive('group-1')).toBe(false);
  });

  it('an ambiguous pre-TERM probe permanently forbids later probes and signals', async () => {
    const { registry, operations } = harness(['EPERM', 'ESRCH']);
    const scope = registry.createDirectScope(registry.rootScope, 'direct', 'runtime_card');
    launch(registry, scope);
    const first = await registry.terminateScopeTree({ rootScope: registry.rootScope, categories: ['runtime_card'], reason: 'done', graceMs: 1 });
    expect(first.failed).toEqual([expect.objectContaining({ groupId: 'group-1', state: 'unverifiable' })]);
    const beforeRecall = [...operations];
    const recalled = await registry.terminateScopeTree({ rootScope: registry.rootScope, categories: ['runtime_card'], reason: 'again', graceMs: 1 });
    expect(recalled.failed).toEqual([expect.objectContaining({ state: 'unverifiable' })]);
    expect(operations).toEqual(beforeRecall);
  });

  it('ambiguity after TERM emits no KILL or later probe', async () => {
    const { registry, operations } = harness(['live', 'EPERM', 'ESRCH']);
    const scope = registry.createDirectScope(registry.rootScope, 'direct', 'runtime_card');
    launch(registry, scope);
    const report = await registry.terminateScopeTree({ rootScope: registry.rootScope, categories: ['runtime_card'], reason: 'done', graceMs: 1 });
    expect(report.failed).toEqual([expect.objectContaining({ state: 'unverifiable' })]);
    expect(operations).toEqual(['probe:live', 'signal:SIGTERM', 'probe:EPERM']);
  });

  it('a closed launch-admission fence rejects before spawn', () => {
    const { registry, spawnCount } = harness();
    const scope = registry.createDirectScope(registry.rootScope, 'direct', 'runtime_card');
    registry.closeLaunchAdmission();
    expect(() => launch(registry, scope)).toThrow('admission is closed');
    expect(spawnCount()).toBe(0);
  });
});
