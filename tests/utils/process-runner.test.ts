import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProjectTree } from '../helpers/canonical-project.js';
import type { ManagedProcessScope, ProcessCategory, ProcessRunner } from '../../src/runtime/process-runner.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner as ProcessRunnerImplementation } from '../../src/runtime/process-runner.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { dataPropertyGraphContains } from '../helpers/data-property-graph.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { nonCardProcessOutputRoot } from '../../src/persistence/layout.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ProcessRunner managed process groups', () => {
  let root: string;
  let runner: ProcessRunner;
  let registry: ManagedProcessGroupRegistry;
  let runtimeRootScope: ManagedProcessScope;
  let analystRootScope: ManagedProcessScope;
  let mcpRootScope: ManagedProcessScope;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'proc-runner-'));
    initProjectTree(root);
    registry = new ManagedProcessGroupRegistry();
    runtimeRootScope = registry.createContainerScope(registry.rootScope, 'runtime');
    analystRootScope = registry.createContainerScope(registry.rootScope, 'analyst');
    mcpRootScope = registry.createContainerScope(registry.rootScope, 'mcp');
    runner = new ProcessRunnerImplementation(root, registry, testApplicationFatalPort);
  });

  afterEach(async () => {
    await runner.terminateScopeTree({ rootScope: registry.rootScope, categories: ['runtime_card', 'operator_session', 'service_infrastructure'], reason: 'test cleanup', graceMs: 100 });
    rmSync(root, { recursive: true, force: true });
  });

  function direct(category: ProcessCategory, label: string = category): ManagedProcessScope {
    const parent = category === 'runtime_card' ? runtimeRootScope : category === 'operator_session' ? analystRootScope : mcpRootScope;
    return runner.createDirectScope(parent, label, category);
  }

  function launch(command: string, scope = direct('runtime_card'), category: ProcessCategory = 'runtime_card') {
    return runner.spawn({ command, directScope: scope, category, cardId: category === 'runtime_card' ? 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' : null, ownerId: 'same-owner', ownerKind: category === 'operator_session' ? 'operator' : 'agent' });
  }

  it('records output and keeps the registry instance-local and memory-only', async () => {
    const record = launch('echo stdout; echo stderr >&2');
    await runner.waitForSettlement(record.id);
    expect(runner.get(record.id)).toMatchObject({ status: 'exited', exit_code: 0 });
    expect(readFileSync(record.stdout_path, 'utf8')).toContain('stdout');
    expect(readFileSync(record.stderr_path, 'utf8')).toContain('stderr');
    expect(existsSync(join(root, '.saivage', 'state', 'processes.json'))).toBe(false);
    expect(new ProcessRunnerImplementation(root, new ManagedProcessGroupRegistry(), testApplicationFatalPort).list()).toEqual([]);
  });

  it('contains a real spawn error and remains usable after a nonexistent cwd', async () => {
    const failedScope = direct('runtime_card', 'failed-launch');
    expect(() => runner.spawn({
      command: 'exit 0',
      directScope: failedScope,
      category: 'runtime_card',
      ownerId: 'same-owner',
      ownerKind: 'agent',
      cwd: join(root, 'missing-cwd'),
    })).toThrow('has no leader PID');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runner.list()).toEqual([]);

    const subsequent = launch('exit 0');
    await expect(runner.waitForSettlement(subsequent.id)).resolves.toMatchObject({ status: 'exited', exitCode: 0 });
  });

  it.each<ProcessCategory>(['runtime_card', 'operator_session', 'service_infrastructure'])('does not finalize an exited wrapper while its %s descendant remains', async (category) => {
    const scope = direct(category);
    const pidFile = join(root, `${category}.pid`);
    const record = launch(`sleep 60 & echo $! > ${JSON.stringify(pidFile)}; exit`, scope, category);
    for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt += 1) await delay(10);
    await delay(75);
    expect(runner.get(record.id)).toMatchObject({ status: 'running' });
    const report = await runner.closeAndTerminateDirectScope({ directScope: scope, category, reason: 'scope complete', graceMs: 100 });
    expect(report).toEqual({ selected: [record.id], stopped: [record.id], failed: [] });
    expect(runner.get(record.id)).toMatchObject({ status: 'killed' });
  });

  it('uses exact direct scope and category rather than owner metadata for kill authorization', async () => {
    const ownerScope = direct('runtime_card', 'duplicate');
    const siblingScope = direct('runtime_card', 'duplicate');
    const record = launch('sleep 60', ownerScope);
    await expect(runner.kill(record.id, { directScope: siblingScope, category: 'runtime_card' })).rejects.toThrow('not bound');
    await expect(runner.kill(record.id, { directScope: ownerScope, category: 'operator_session' })).rejects.toThrow('does not authorize');
    await expect(runner.kill(record.id, { directScope: ownerScope, category: 'runtime_card', graceMs: 100 })).resolves.toMatchObject({ status: 'killed' });
  });

  it('joins trailing captured output on all three successful termination surfaces', async () => {
    const command = "trap 'echo trailing; exit 0' TERM; echo ready; while :; do sleep 1; done";
    const waitReady = async (path: string): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (readFileSync(path, 'utf8').includes('ready')) return;
        await delay(10);
      }
      throw new Error('process did not become ready');
    };

    const killScope = direct('runtime_card', 'kill-drain');
    const killed = launch(command, killScope);
    await waitReady(killed.stdout_path);
    await runner.kill(killed.id, { directScope: killScope, category: 'runtime_card', graceMs: 100 });
    expect(readFileSync(killed.stdout_path, 'utf8')).toContain('trailing');

    const treeScope = direct('runtime_card', 'tree-drain');
    const tree = launch(command, treeScope);
    await waitReady(tree.stdout_path);
    await runner.terminateScopeTree({ rootScope: runtimeRootScope, categories: ['runtime_card'], reason: 'tree drain', graceMs: 100 });
    expect(readFileSync(tree.stdout_path, 'utf8')).toContain('trailing');

    const directScope = direct('operator_session', 'direct-drain');
    const directRecord = launch(command, directScope, 'operator_session');
    await waitReady(directRecord.stdout_path);
    await runner.closeAndTerminateDirectScope({ directScope, category: 'operator_session', reason: 'direct drain', graceMs: 100 });
    expect(readFileSync(directRecord.stdout_path, 'utf8')).toContain('trailing');
  });

  it.each(['kill', 'terminateScopeTree', 'closeAndTerminateDirectScope'] as const)('%s joins group absence with both readable drains in either event order', async (surface) => {
    const syntheticRoot = mkdtempSync(join(tmpdir(), `proc-runner-${surface}-`));
    initProjectTree(syntheticRoot);
    const stdout = new PassThrough(); const stderr = new PassThrough();
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = stdout; child.stderr = stderr;
    let absent: ((reason?: string) => void) | undefined;
    const report = { selected: ['proc'], stopped: ['proc'], failed: [] };
    const fakeRegistry = {
      launch(input: { groupId: string; onAbsent(reason?: string): void }) { report.selected[0] = input.groupId; report.stopped[0] = input.groupId; absent = input.onAbsent; const outputRoot = nonCardProcessOutputRoot(syntheticRoot, input.groupId); expect(existsSync(join(outputRoot, 'stdout.log'))).toBe(true); expect(existsSync(join(outputRoot, 'stderr.log'))).toBe(true); return child; },
      terminateGroup: async () => { absent?.(); return report; },
      terminateScopeTree: async () => { absent?.(); return report; },
      closeAndTerminateDirectScope: async () => { absent?.(); return report; },
    };
    const synthetic = new ProcessRunnerImplementation(syntheticRoot, fakeRegistry as never, testApplicationFatalPort);
    const record = synthetic.spawn({ command: 'synthetic', directScope: {} as never, category: 'runtime_card', ownerId: 'owner', ownerKind: 'agent' });
    const terminal = surface === 'kill'
      ? synthetic.kill(record.id, { directScope: {} as never, category: 'runtime_card' })
      : synthetic[surface]({ ...(surface === 'terminateScopeTree' ? { rootScope: {} as never, categories: ['runtime_card'] as const } : { directScope: {} as never, category: 'runtime_card' as const }), reason: 'test' } as never);
    let settled = false; void terminal.then(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(await synthetic.wait(record.id, 0)).toMatchObject({ status: 'running', timedOut: false });
    expect(await synthetic.wait(record.id, 1)).toMatchObject({ status: 'running', timedOut: true });
    stdout.write('late-out'); stderr.write('late-err'); child.emit('exit', 0, null); stdout.end(); stderr.end();
    await terminal;
    expect(readFileSync(record.stdout_path, 'utf8')).toBe('late-out');
    expect(readFileSync(record.stderr_path, 'utf8')).toBe('late-err');
    expect(synthetic.get(record.id)?.status).not.toBe('running');
    rmSync(syntheticRoot, { recursive: true, force: true });
  });

  it('joins stopped siblings but never waits for failed/unconfirmed process ids', async () => {
    const syntheticRoot = mkdtempSync(join(tmpdir(), 'proc-runner-mixed-')); initProjectTree(syntheticRoot);
    const stdout = new PassThrough(); const stderr = new PassThrough(); const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough }; child.stdout = stdout; child.stderr = stderr;
    let absent!: () => void; let id = '';
    const fakeRegistry = { launch(input: { groupId: string; onAbsent(): void }) { id = input.groupId; absent = input.onAbsent; return child; }, terminateScopeTree: async () => { absent(); return { selected: [id, 'unconfirmed'], stopped: [id], failed: [{ groupId: 'unconfirmed', state: 'unverifiable', diagnostic: 'still live' }] }; } };
    const synthetic = new ProcessRunnerImplementation(syntheticRoot, fakeRegistry as never, testApplicationFatalPort);
    const record = synthetic.spawn({ command: 'synthetic', directScope: {} as never, category: 'runtime_card', ownerId: 'owner', ownerKind: 'agent' });
    const termination = synthetic.terminateScopeTree({ rootScope: {} as never, categories: ['runtime_card'], reason: 'mixed' });
    let settled = false; void termination.then(() => { settled = true; }); await new Promise<void>((resolve) => setImmediate(resolve)); expect(settled).toBe(false);
    child.emit('exit', 0, null); stdout.end('tail'); stderr.end();
    await expect(termination).resolves.toMatchObject({ stopped: [record.id], failed: [{ groupId: 'unconfirmed' }] });
    rmSync(syntheticRoot, { recursive: true, force: true });
  });

  it('runtime-card cleanup excludes Analyst and service groups', async () => {
    const runtime = launch('sleep 60', direct('runtime_card'), 'runtime_card');
    const analyst = launch('sleep 60', direct('operator_session'), 'operator_session');
    const service = launch('sleep 60', direct('service_infrastructure'), 'service_infrastructure');
    const report = await runner.terminateScopeTree({ rootScope: registry.rootScope, categories: ['runtime_card'], reason: 'runtime shutdown', graceMs: 100 });
    expect(report.selected).toEqual([runtime.id]);
    expect(runner.get(runtime.id)?.status).toBe('killed');
    expect(runner.get(analyst.id)?.status).toBe('running');
    expect(runner.get(service.id)?.status).toBe('running');
  });

  it('retains registry authority only in native-private state', () => {
    expect(dataPropertyGraphContains(runner, new Set([registry, runtimeRootScope, analystRootScope, mcpRootScope]))).toBe(false);
    expect(Reflect.ownKeys(runner)).not.toContain('registry');
  });
});
