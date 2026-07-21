import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, jest } from '@jest/globals';
import {
  ManagedProcessGroupRegistry,
  type ManagedProcessPlatform,
  type ManagedProcessScope,
  type ProcessCategory,
  type ProcessStopReport,
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
  it('rejects forged, sibling, container-as-direct, retired, and category-mismatched capabilities before spawn', async () => {
    const { registry, spawnCount } = harness();
    const container = registry.createContainerScope(registry.rootScope, 'same-label');
    const first = registry.createDirectScope(container, 'duplicate', 'runtime_card');
    const sibling = registry.createDirectScope(container, 'duplicate', 'runtime_card');
    expect(first).not.toBe(sibling);
    expect(() => launch(registry, {} as ManagedProcessScope)).toThrow('not allocated');
    expect(() => launch(registry, container)).toThrow('not a direct');
    expect(() => launch(registry, first, 'operator_session')).toThrow('does not authorize');
    registry.closeScope(first);
    expect(() => launch(registry, first)).toThrow('not allocated');
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

  it('retires an empty direct scope synchronously when close-and-contain begins', async () => {
    const { registry } = harness();
    const scope = registry.createDirectScope(registry.rootScope, 'direct', 'runtime_card');

    const report = registry.closeAndTerminateDirectScope({ directScope: scope, category: 'runtime_card', reason: 'done' });

    expect(() => registry.closeScope(scope)).toThrow('not allocated');
    await expect(report).resolves.toEqual({ selected: [], stopped: [], failed: [] });
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

  it('contains asynchronous child errors after rejecting a launch without a leader PID', () => {
    const child = Object.assign(new EventEmitter(), { pid: undefined, kill: jest.fn() }) as unknown as ChildProcess;
    const platform: ManagedProcessPlatform = {
      spawn: () => child,
      probe: () => {},
      signal: () => {},
    };
    const registry = new ManagedProcessGroupRegistry(platform);
    const scope = registry.createDirectScope(registry.rootScope, 'direct', 'runtime_card');

    expect(() => launch(registry, scope)).toThrow("Managed process group 'group-1' has no leader PID.");
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(() => child.emit('error', errno('ENOENT'))).not.toThrow();
    expect(registry.isLive('group-1')).toBe(false);
  });

  it('tolerates overlapping project-Stop/App runtime-root signals and removals without sibling-root impact', async () => {
    const operations: string[] = [];
    let nextPid = 5000;
    const absent = new Set<number>();
    const platform: ManagedProcessPlatform = {
      spawn: () => Object.assign(new EventEmitter(), { pid: nextPid++, kill: jest.fn() }) as unknown as ChildProcess,
      probe: (pgid) => {
        operations.push(`probe:${pgid}:${absent.has(pgid) ? 'ESRCH' : 'live'}`);
        if (absent.has(pgid)) throw errno('ESRCH');
      },
      signal: (pgid, signal) => {
        operations.push(`signal:${pgid}:${signal}`);
        if (absent.has(pgid)) throw errno('ESRCH');
        if (signal === 'SIGKILL') absent.add(pgid);
      },
    };
    const registry = new ManagedProcessGroupRegistry(platform);
    const runtimeRoot = registry.createContainerScope(registry.rootScope, 'runtime');
    const analystRoot = registry.createContainerScope(registry.rootScope, 'analyst');
    const mcpRoot = registry.createContainerScope(registry.rootScope, 'mcp');
    const runtimeScope = registry.createDirectScope(runtimeRoot, 'runtime-card', 'runtime_card');
    const analystScope = registry.createDirectScope(analystRoot, 'analyst-session', 'operator_session');
    const mcpScope = registry.createDirectScope(mcpRoot, 'mcp-server', 'service_infrastructure');
    const launchGroup = (groupId: string, scope: ManagedProcessScope, category: ProcessCategory) => registry.launch({ groupId, directScope: scope, category, file: 'ignored', args: [], options: {}, onAbsent: () => operations.push(`removed:${groupId}`) });
    launchGroup('runtime-group', runtimeScope, 'runtime_card');
    launchGroup('analyst-group', analystScope, 'operator_session');
    launchGroup('mcp-group', mcpScope, 'service_infrastructure');

    const projectStop = registry.terminateScopeTree({ rootScope: runtimeRoot, categories: ['runtime_card'], reason: 'project stop', graceMs: 0 });
    const appStop = registry.terminateScopeTree({ rootScope: runtimeRoot, categories: ['runtime_card'], reason: 'application stop', graceMs: 0 });
    const [projectReport, appReport] = await Promise.all([projectStop, appStop]);

    expect(projectReport.selected).toEqual(['runtime-group']);
    expect(appReport.selected).toEqual(['runtime-group']);
    expect(projectReport.failed).toEqual([]);
    expect(appReport.failed).toEqual([]);
    expect(operations.filter((entry) => entry.includes('5000:SIGTERM'))).toHaveLength(2);
    expect(operations.filter((entry) => entry.includes('5000:SIGKILL'))).toHaveLength(1);
    expect(operations.filter((entry) => entry === 'removed:runtime-group')).toHaveLength(1);
    expect(registry.isLive('runtime-group')).toBe(false);
    expect(registry.isLive('analyst-group')).toBe(true);
    expect(registry.isLive('mcp-group')).toBe(true);
    expect(operations.some((entry) => entry.startsWith('signal:5001:') || entry.startsWith('signal:5002:'))).toBe(false);
  });

  it('settles overlapping direct and root containment after same-record repeated ESRCH and retires only the closed direct scope', async () => {
    const operations: string[] = [];
    const onAbsent = jest.fn();
    const child = Object.assign(new EventEmitter(), { pid: 7000, kill: jest.fn() }) as unknown as ChildProcess;
    let registry!: ManagedProcessGroupRegistry;
    let runtimeRoot!: ManagedProcessScope;
    let rootContainment: Promise<ProcessStopReport> | undefined;
    let probeCount = 0;
    const platform: ManagedProcessPlatform = {
      spawn: () => child,
      probe: () => {
        probeCount += 1;
        operations.push(`probe:${probeCount}`);
        if (probeCount > 1) throw errno('ESRCH');
      },
      signal: (_pgid, signal) => {
        operations.push(`signal:${signal}`);
        rootContainment = registry.terminateScopeTree({ rootScope: runtimeRoot, categories: ['runtime_card'], reason: 'root stop', graceMs: 1 });
        throw errno('ESRCH');
      },
    };
    registry = new ManagedProcessGroupRegistry(platform);
    runtimeRoot = registry.createContainerScope(registry.rootScope, 'runtime');
    const directScope = registry.createDirectScope(runtimeRoot, 'card', 'runtime_card');
    const siblingScope = registry.createDirectScope(runtimeRoot, 'sibling', 'runtime_card');
    registry.launch({ groupId: 'group-1', directScope, category: 'runtime_card', file: 'ignored', args: [], options: {}, onAbsent });
    const settlement = registry.wait('group-1')!;

    const directContainment = registry.closeAndTerminateDirectScope({ directScope, category: 'runtime_card', reason: 'direct stop', graceMs: 1 });
    const [directReport, rootReport] = await Promise.all([directContainment, rootContainment!]);
    await expect(settlement).resolves.toBeUndefined();

    expect(directReport).toEqual({ selected: ['group-1'], stopped: ['group-1'], failed: [] });
    expect(rootReport).toEqual({ selected: ['group-1'], stopped: ['group-1'], failed: [] });
    expect(onAbsent).toHaveBeenCalledTimes(1);
    expect(registry.isLive('group-1')).toBe(false);
    expect(() => registry.closeScope(directScope)).toThrow('not allocated');
    expect(() => registry.closeScope(siblingScope)).not.toThrow();
    expect(operations).toEqual(['probe:1', 'signal:SIGTERM', 'probe:2']);
  });
});
