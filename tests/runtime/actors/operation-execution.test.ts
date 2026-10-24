import { afterEach, expect, it, jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { invokeOperation } from '../../../src/runtime/actors/operation-execution.js';
import { executeFiniteOperation, resolveOperationReadablePath } from '../../../src/runtime/operation-execution.js';
import { shellRunOperation } from '../../../src/runtime/card-process/shell-operation.js';
import { compileActionExecution } from '../../../src/runtime/card-process/operation-routing.js';
import { compileOperations, type OperationDefinition } from '../../../src/runtime/card-process/operation-contract.js';
import { ManagedProcessGroupRegistry } from '../../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../../src/runtime/process-runner.js';
import { readCardExecutions } from '../../../src/persistence/card-execution-log.js';
import { testApplicationFatalPort } from '../../helpers/test-application-fatal-port.js';
import { resolveAgentReadPath } from '../../../src/workspace/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function fixture(script: string, extra: Record<string, unknown> = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'operation-execution-'));
  mkdirSync(join(projectRoot, '.saivage/cards/project/records'), { recursive: true });
  const registry = new ManagedProcessGroupRegistry();
  const runner = new ProcessRunner(projectRoot, registry, testApplicationFatalPort);
  const execution = compileActionExecution({ action: 'shell.run', contract_version: 1,
    config: { script, timeout_ms: 3000, terminate_grace_ms: 50, ...extra }, inputs: { args: { literal: [] } } }, compileOperations([shellRunOperation]), 'node');
  const controller = new AbortController();
  const args = { projectRoot, cardId: 'project', execution, inputs: { args: [] }, collectOutput: false,
    binding: { kind: 'node' as const, activation_id: randomUUID(), node_id: 'check', ordinal: 0 },
    processRunner: runner, runtimeProcessRootScope: registry.rootScope, signal: controller.signal,
    retainSettlementFailure: jest.fn() };
  cleanups.push(async () => {
    await runner.terminateScopeTree({ rootScope: registry.rootScope, categories: ['runtime_card'], reason: 'test cleanup', graceMs: 50 });
    rmSync(projectRoot, { recursive: true, force: true });
  });
  return { args, projectRoot, runner, controller };
}

it.each([0, 7])('runs real shell argv without interpolation, retaining actual captures and exit %i', async (code) => {
  const f = fixture(`printf '%s' "$@"; printf 'err' >&2; printf 'artifact' > result.txt; exit ${code}`, { artifacts: ['result.txt', 'missing.txt'], env: { CI: '1' } });
  f.args.inputs.args = ['$(not-a-command); "quoted"'] as never[];
  const value = await invokeOperation(f.args);
  expect(value.result).toMatchObject({ outcome: code ? 'failed' : 'passed', values: { exit_code: code } });
  const rows = readCardExecutions(f.projectRoot, 'project');
  expect(rows.map(({ kind }) => kind)).toEqual(['invocation_started', 'process_started', 'invocation_finished']);
  expect(rows[0]).toMatchObject({ shell: { env: { CI: '1' }, argv: ['bash', '--noprofile', '--norc', '-o', 'pipefail', '-c', expect.any(String), 'saivage-action', '$(not-a-command); "quoted"'] } });
  const finish = rows.at(-1)!;
  if (finish.kind !== 'invocation_finished') throw new Error();
  expect(finish).toMatchObject({ disposition: 'returned', leader_exit: { exit_code: code, signal: null }, process: { group: 'absent', stdout: 'eof' }, absent_artifacts: ['missing.txt'] });
  const stdout = finish.files.find((file) => file.kind === 'capture' && file.stream === 'stdout')!;
  expect(readFileSync(join(f.projectRoot, stdout.path), 'utf8')).toBe('$(not-a-command); "quoted"');
  expect(finish.files).toContainEqual(expect.objectContaining({ kind: 'artifact', path: 'result.txt', size: 8, source: 'current' }));
  expect(f.runner.list()).toEqual([]);
});
it('routes an observed leader signal separately from nonzero', async () => {
  const f = fixture('kill -TERM $$');
  await expect(invokeOperation(f.args)).resolves.toMatchObject({ result: { outcome: 'signalled', values: { signal: 'SIGTERM' } } });
});
it('terminates and joins before accepting timeout', async () => {
  const f = fixture('sleep 30', { timeout_ms: 40 });
  await expect(invokeOperation(f.args)).resolves.toMatchObject({ result: { outcome: 'timed_out' } });
  expect(readCardExecutions(f.projectRoot, 'project').at(-1)).toMatchObject({ disposition: 'timed_out', process: { group: 'absent' }, leader_exit: { signal: 'SIGTERM', exit_code: null } });
});
it('joins cancellation with the exact reason, never returning a configured outcome', async () => {
  const f = fixture('sleep 30');
  const spawned = new Promise<void>((resolve) => {
    const original = f.runner.spawnCaptured.bind(f.runner);
    jest.spyOn(f.runner, 'spawnCaptured').mockImplementation((args) => original({ ...args, onSpawn: (record) => { args.onSpawn(record); resolve(); } }));
  });
  const invocation = invokeOperation(f.args);
  const reason = new Error('exact interruption');
  const assertion = expect(invocation).rejects.toBe(reason);
  await spawned;
  f.controller.abort(reason);
  await assertion;
  expect(readCardExecutions(f.projectRoot, 'project').at(-1)).toMatchObject({ disposition: 'cancelled', outcome: null, process: { group: 'absent' } });
  expect(f.runner.list()).toEqual([]);
});
it('performs no entry or launch when already aborted', async () => {
  const f = fixture('exit 0'); const reason = new Error('before entry'); f.controller.abort(reason);
  await expect(invokeOperation(f.args)).rejects.toBe(reason);
  expect(readCardExecutions(f.projectRoot, 'project')).toEqual([]);
});
it('treats launch failure as an engine error, not an exit or accepted outcome', async () => {
  const f = fixture('exit 0', { cwd: 'absent-directory' });
  await expect(invokeOperation(f.args)).rejects.toThrow(/no leader PID/);
  expect(readCardExecutions(f.projectRoot, 'project').map(({ kind }) => kind)).toEqual(['invocation_started', 'invocation_finished']);
  expect(readCardExecutions(f.projectRoot, 'project').at(-1)).toMatchObject({ outcome: null, leader_exit: null, process: null });
});
it('does not retry an invalid plugin return after its known effect', async () => {
  const f = fixture('exit 0'); let effects = 0;
  const definition: OperationDefinition = { id: 'acme.inspect', provider: { kind: 'plugin', name: 'acme' }, contractVersion: 1,
    output: null, artifacts: () => [],
    bindings: ['node'], config: z.object({}).strict(), inputs: {}, outcomes: { finished: { count: { type: 'integer', workflow: true } } }, retainFields: ['count'],
    async run() { effects++; return { result: { outcome: 'finished', summary: 'Effect happened.', values: {} }, output: null }; } };
  const execution = compileActionExecution({ action: 'acme.inspect', contract_version: 1, config: {}, inputs: {} }, compileOperations([], [{ namespace: 'acme', operations: { inspect: definition } }]), 'node');
  await expect(invokeOperation({ ...f.args, execution, inputs: {} })).rejects.toThrow();
  expect(effects).toBe(1);
  expect(readCardExecutions(f.projectRoot, 'project').at(-1)).toMatchObject({ disposition: 'unavailable', outcome: null, values: [] });
});

it('uses the same finite body without a card or card-log append for returned text', async () => {
  const f = fixture('exit 0');
  const invocationId = randomUUID();
  const content = '\uFEFF' + 'literal report\r\n'.repeat(500);
  const definition: OperationDefinition = {
    id: 'example.analysis.report', provider: { kind: 'plugin', name: 'example' }, contractVersion: 1,
    bindings: ['node'], config: z.object({}).strict(), inputs: {}, outcomes: { findings: {} },
    retainFields: [], output: 'returned-text', artifacts: (_config, id) => {
      expect(id).toBe(invocationId);
      return [`report-${id}.txt`, `missing-${id}.txt`];
    },
    async run(_config, _inputs, capabilities) {
      expect(capabilities.invocationId).toBe(invocationId);
      writeFileSync(join(f.projectRoot, `report-${capabilities.invocationId}.txt`), content);
      return { result: { outcome: 'findings', summary: 'Observed report.', values: {} }, output: Buffer.from(content) };
    },
  };
  const completed = await executeFiniteOperation({
    invocationId, projectRoot: f.projectRoot, operation: definition, config: {}, inputs: {},
    collectOutput: true, processRunner: f.runner, parentScope: f.args.runtimeProcessRootScope,
    attribution: { category: 'runtime_card', cardId: null, ownerId: invocationId, ownerKind: 'runtime' },
    signal: f.controller.signal, retainSettlementFailure: f.args.retainSettlementFailure,
    resolveReadablePath: (path) => resolveOperationReadablePath(f.projectRoot, path),
  });
  expect(completed.completedOutput).toMatchObject({ content, processId: null, leaderExit: null,
    descriptor: { source: 'returned-text', size_bytes: Buffer.byteLength(content) } });
  expect(completed.result).toEqual({ outcome: 'findings', summary: 'Observed report.', values: {} });
  expect(completed.evidence.output).toEqual(completed.completedOutput!.descriptor);
  expect(completed.evidence.files).toEqual([expect.objectContaining({
    kind: 'artifact', path: `report-${invocationId}.txt`, size: Buffer.byteLength(content), source: 'current',
  })]);
  expect(completed.evidence.absent_artifacts).toEqual([`missing-${invocationId}.txt`]);
  expect(readCardExecutions(f.projectRoot, 'project')).toEqual([]);
});

it.each(['missing', 'cancelled', 'blocked-alias'] as const)('preserves caller artifact admission for %s', async (mode) => {
  const f = fixture('exit 0');
  const reason = new Error('exact owner cancellation');
  const blocked = new Error('caller read refused');
  if (mode === 'blocked-alias') {
    writeFileSync(join(f.projectRoot, '.saivage/private.txt'), 'private');
    symlinkSync(join(f.projectRoot, '.saivage/private.txt'), join(f.projectRoot, 'selected.txt'));
  }
  const definition: OperationDefinition = {
    id: 'example.artifact', provider: { kind: 'plugin', name: 'example' }, contractVersion: 1,
    bindings: ['node'], config: z.object({}).strict(), inputs: {}, outcomes: { finished: {} },
    retainFields: [], output: null, artifacts: () => ['selected.txt'],
    async run() {
      if (mode === 'cancelled') f.controller.abort(reason);
      return { result: { outcome: 'finished', summary: 'Fixture settled.', values: {} }, output: null };
    },
  };
  const invocation = executeFiniteOperation({
    invocationId: randomUUID(), projectRoot: f.projectRoot, operation: definition, config: {}, inputs: {},
    collectOutput: false, processRunner: f.runner, parentScope: f.args.runtimeProcessRootScope,
    attribution: { category: 'runtime_card', cardId: null, ownerId: 'fixture', ownerKind: 'runtime' },
    signal: f.controller.signal, retainSettlementFailure: f.args.retainSettlementFailure,
    resolveReadablePath(path) {
      const selected = resolveAgentReadPath({ projectRoot: f.projectRoot, fail: () => blocked }, path, 'read');
      if (selected.kind === 'record') throw new Error('Unexpected record.');
      return selected.absolutePath;
    },
  });
  if (mode === 'missing') {
    expect((await invocation).evidence.absent_artifacts).toEqual(['selected.txt']);
    expect(f.args.retainSettlementFailure).not.toHaveBeenCalled();
  } else {
    await expect(invocation).rejects.toBe(mode === 'cancelled' ? reason : blocked);
    if (mode === 'cancelled') expect(f.args.retainSettlementFailure).not.toHaveBeenCalled();
    else expect(f.args.retainSettlementFailure).toHaveBeenCalledWith(blocked);
  }
});

it('consumes literal shell output only when selected, without changing nonzero outcomes', async () => {
  const f = fixture('printf "\\357\\273\\277report\\r\\n"; exit 7');
  const completed = await invokeOperation({ ...f.args, collectOutput: true });
  expect(completed.result.outcome).toBe('failed');
  expect(completed.completedOutput).toMatchObject({ content: '\uFEFFreport\r\n',
    descriptor: { source: 'command-stdout', size_bytes: 11 }, leaderExit: { exit_code: 7, signal: null } });
  expect(readCardExecutions(f.projectRoot, 'project').at(-1)).toMatchObject({
    outcome: 'failed', output: completed.completedOutput!.descriptor,
  });
  const captureOnly = fixture('printf "\\377\\000"');
  expect((await invokeOperation(captureOnly.args)).completedOutput).toBeNull();
});
