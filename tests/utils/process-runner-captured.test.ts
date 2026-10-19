import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner, type ProcessRecord } from '../../src/runtime/process-runner.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  jest.useRealTimers();
  for (const run of cleanup.splice(0)) await run();
});
function fixture() {
  const root = mkdtempSync('/home/salva/g/ml/tmp/saivage-captured-');
  const registry = new ManagedProcessGroupRegistry();
  const runner = new ProcessRunner(root, registry, testApplicationFatalPort);
  const scope = runner.createDirectScope(registry.rootScope, 'finite action', 'runtime_card');
  cleanup.push(async () => {
    const report = await runner.terminateScopeTree({
      rootScope: registry.rootScope,
      categories: ['runtime_card'],
      reason: 'test cleanup',
      graceMs: 100,
    });
    expect(report.failed).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, runner, scope };
}

describe('captured argv process ownership', () => {
  it.each([0, 7])(
    'captures argv as isolated data and positively observes spawn before exit%d',
    async (code) => {
      const { runner, scope } = fixture();
      const observed: ProcessRecord[] = [];
      const value = '$(not-executed); whitespace " quote';
      const record = runner.spawnCaptured({
        file: process.execPath,
        args: [
          '-e',
          'process.stdout.write(process.argv[1]);process.stderr.write("error output");process.exitCode=Number(process.argv[2])',
          value,
          String(code),
        ],
        directScope: scope,
        category: 'runtime_card',
        cardId: 'project',
        ownerId: 'invocation',
        ownerKind: 'runtime',
        onSpawn: (process) => observed.push(process),
      });
      expect(observed).toHaveLength(0);
      const settled = await runner.waitForSettlement(record.id);
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        id: record.id,
        owner_kind: 'runtime',
        agent_session_id: null,
      });
      expect(settled.record.evidence).toMatchObject({
        leader_exit: { exit_code: code, signal: null },
        group: 'absent',
        stdout: 'eof',
        stderr: 'eof',
      });
      expect(readFileSync(record.stdout_path, 'utf8')).toBe(value);
      expect(readFileSync(record.stderr_path, 'utf8')).toBe('error output');
    },
  );
  it('retains the actual leader signal, distinct from cleanup classification', async () => {
    const { runner, scope } = fixture();
    const record = runner.spawnCaptured({
      file: process.execPath,
      args: ['-e', 'process.kill(process.pid,"SIGTERM")'],
      directScope: scope,
      category: 'runtime_card',
      ownerId: 'signal',
      ownerKind: 'runtime',
      onSpawn: () => undefined,
    });
    const result = await runner.waitForSettlement(record.id);
    expect(result.record.evidence.leader_exit?.signal).toBe('SIGTERM');
    expect(result.record.evidence.leader_exit?.exit_code).toBeNull();
  });
  it('propagates a no-PID launch failure without claiming spawn or a numeric exit', () => {
    const { root, runner, scope } = fixture();
    const observed: ProcessRecord[] = [];
    expect(() =>
      runner.spawnCaptured({
        file: `${root}/does-not-exist`,
        args: [],
        directScope: scope,
        category: 'runtime_card',
        ownerId: 'missing',
        ownerKind: 'runtime',
        onSpawn: (process) => observed.push(process),
      }),
    ).toThrow(/no leader PID/);
    expect(observed).toEqual([]);
    expect(runner.list()).toEqual([]);
  });
  it('destroys owned lingering captures at the shared deadline instead of abandoning their settlement', async () => {
    const root = mkdtempSync('/home/salva/g/ml/tmp/saivage-capture-deadline-');
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    let absent!: (reason: string) => void;
    const registry = {
      launch(input: { onAbsent(reason: string): void }) {
        absent = input.onAbsent;
        return child;
      },
    };
    const runner = new ProcessRunner(root, registry as never, testApplicationFatalPort);
    cleanup.push(async () => {
      child.stdout.destroy();
      child.stderr.destroy();
      rmSync(root, { recursive: true, force: true });
    });
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const record = runner.spawnCaptured({
      file: process.execPath,
      args: [],
      directScope: {} as never,
      category: 'runtime_card',
      ownerId: 'deadline',
      ownerKind: 'runtime',
      onSpawn: () => undefined,
    });
    child.emit('spawn');
    child.emit('exit', 0, null);
    absent('terminated');
    const settlement = runner.waitForSettlement(record.id);
    const assertion = expect(settlement).rejects.toThrow(/Capture did not settle within 5000ms/);
    await jest.advanceTimersByTimeAsync(4999);
    expect(child.stdout.destroyed).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await assertion;
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(runner.get(record.id)).toMatchObject({
      status: 'unavailable',
      evidence: {
        group: 'absent',
        leader_exit: { exit_code: 0 },
        stdout: 'closed',
        stderr: 'closed',
      },
    });
    expect(jest.getTimerCount()).toBe(0);
  });
  it('bounds and joins the same capture settlement after unconfirmed termination, including the runtime-root join', async () => {
    const root = mkdtempSync('/home/salva/g/ml/tmp/saivage-unconfirmed-capture-');
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    let id!: string;
    const report = () => ({ selected: [id], stopped: [], failed: [{ groupId: id, state: 'unconfirmed' as const, diagnostic: 'Group remained live.' }] });
    const registry = {
      launch(input: { groupId: string }) { id = input.groupId; return child; },
      async closeAndTerminateDirectScope() { return report(); },
      async terminateScopeTree() { return report(); },
    };
    const runner = new ProcessRunner(root, registry as never, testApplicationFatalPort);
    cleanup.push(async () => { child.stdout.destroy(); child.stderr.destroy(); rmSync(root, { recursive: true, force: true }); });
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const scope = {} as never;
    runner.spawnCaptured({ file: process.execPath, args: [], directScope: scope, category: 'runtime_card', ownerId: 'unconfirmed', ownerKind: 'runtime', onSpawn() {} });
    child.emit('spawn'); child.emit('exit', 0, null);
    const direct = runner.closeAndTerminateDirectScope({ directScope: scope, category: 'runtime_card', reason: 'Stop' });
    const runtime = runner.terminateScopeTree({ rootScope: {} as never, categories: ['runtime_card'], reason: 'Stop' });
    const assertions = [expect(direct).rejects.toThrow('Group remained live.'), expect(runtime).rejects.toThrow('Group remained live.')];
    await jest.advanceTimersByTimeAsync(4999);
    expect(child.stdout.destroyed).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await Promise.all(assertions);
    expect(child.stdout.destroyed).toBe(true); expect(child.stderr.destroyed).toBe(true);
    expect(runner.get(id)).toMatchObject({ status: 'unavailable', evidence: { group: 'tracked', group_diagnostic: 'Group remained live.', stdout: 'closed', stderr: 'closed' } });
    expect(jest.getTimerCount()).toBe(0);
  });
});
