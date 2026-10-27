import { afterEach, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NodeExecution,
  type AcceptedNodeResult,
} from '../../../src/runtime/actors/node-execution.js';
import { AgentExecutor } from '../../../src/runtime/actors/agent-executor.js';
import { ProcessRunner } from '../../../src/runtime/process-runner.js';
import { ManagedProcessGroupRegistry } from '../../../src/runtime/managed-process-group-registry.js';
import { PublicationOutcomeUnknownError } from '../../../src/contracts/publication-outcome.js';
import { testApplicationFatalPort } from '../../helpers/test-application-fatal-port.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  jest.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'saivage-node-resource-'));
  const registry = new ManagedProcessGroupRegistry();
  const runner = new ProcessRunner(root, registry, testApplicationFatalPort);
  const runtimeRoot = runner.createContainerScope(registry.rootScope, 'runtime');
  const store = { readRecordCurrent: jest.fn(), discardRecord: jest.fn() };
  const execution = new NodeExecution(
    {
      cardId: 'project',
      projectRoot: root,
      store,
      processRunner: runner,
      runtimeProcessRootScope: runtimeRoot,
      workflows: {
        agentBindings: new Map([['executor', { toolSet: { requiresProcessScope: true } }]]),
      },
    } as never,
    { claimedNodeInterruption: () => false } as never,
  );
  const args = {
    process: { states: new Map() },
    transition: { context: { source: 'entry:BACKLOG', event: 'entry:route' }, acceptedResult: null },
    node: { execution: { kind: 'agent', agent: { name: 'executor' }, dataInputs: {}, inputs: {} }, requirements: [] },
    input: { activationId: '00000000-0000-4000-8000-000000000001', card: { id: 'project', type: 'project', title: 'Project' } },
    signal: new AbortController().signal,
    nodeOrdinal: 0,
  } as never;
  cleanups.push(async () => {
    await runner.terminateScopeTree({
      rootScope: runtimeRoot,
      categories: ['runtime_card'],
      reason: 'test cleanup',
      graceMs: 100,
    });
    rmSync(root, { recursive: true, force: true });
  });
  return { runner, execution, args, store };
}
const accepted: AcceptedNodeResult = {
  nodeOrdinal: 0, source: null,
  nodeId: 'work',
  executor: { kind: 'agent', agent: 'executor' },
  values: {},
  outcome: 'done',
  event: 'result:done',
  summary: 'Observed',
  acceptedRecords: [],
};

it('owns one real node process scope through executor completion and retires its captured process before delivery', async () => {
  const f = fixture();
  const close = jest.spyOn(f.runner, 'closeAndTerminateDirectScope');
  let held!: ReturnType<ProcessRunner['waitForSettlement']>;
  let id!: string;
  jest.spyOn(AgentExecutor.prototype, 'execute').mockImplementation(async (_args, context) => {
    expect(context.scope).not.toBeNull();
    const process = f.runner.spawn({
      command: `exec ${JSON.stringify(globalThis.process.execPath)} -e 'setInterval(()=>{},1000)'`,
      directScope: context.scope!,
      category: 'runtime_card',
      cardId: 'project',
      ownerId: 'node-owner',
      ownerKind: 'agent',
    });
    id = process.id;
    held = f.runner.waitForSettlement(id);
    return accepted;
  });
  await expect(f.execution.execute(f.args)).resolves.toBe(accepted);
  expect(close).toHaveBeenCalledTimes(1);
  await expect(held).resolves.toMatchObject({ record: { evidence: { group: 'absent' } } });
  expect(f.runner.get(id)).toBeNull();
});

it('preserves executor failure only after common resource cleanup, and never cleans after publication uncertainty', async () => {
  const f = fixture();
  const close = jest.spyOn(f.runner, 'closeAndTerminateDirectScope');
  const sentinel = new Error('executor failed');
  const execute = jest.spyOn(AgentExecutor.prototype, 'execute').mockRejectedValueOnce(sentinel);
  await expect(f.execution.execute(f.args)).rejects.toBe(sentinel);
  expect(close).toHaveBeenCalledTimes(1);
  close.mockClear();
  const unknown = new PublicationOutcomeUnknownError(new Error('uncertain append'));
  execute.mockRejectedValueOnce(unknown);
  await expect(f.execution.execute(f.args)).rejects.toBe(unknown);
  expect(close).not.toHaveBeenCalled();
  expect(f.store.readRecordCurrent).not.toHaveBeenCalled();
  expect(f.store.discardRecord).not.toHaveBeenCalled();
});
