import { afterEach, expect, it, jest } from '@jest/globals';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { CardService } from '../../../src/cards/card-service.js';
import { initProjectTree } from '../../helpers/canonical-project.js';
import { TEST_SAIVAGE_CONFIG } from '../../helpers/test-saivage-config.js';
import { effectiveSaivageConfigSchema } from '../../../src/schemas/saivage-config.js';
import { compileProjectWorkflows, bindRuntimeWorkflows } from '../../../src/runtime/card-process/card-process-config.js';
import { ProviderRegistry } from '../../../src/agents/provider.js';
import { ModelRouter } from '../../../src/agents/model-router.js';
import { createSupervisorRuntimeApi } from '../../../src/runtime/actors/supervisor-runtime-api.js';
import { createTestProcessRunner } from '../../helpers/test-process-runner.js';
import { createTestPromptTemplateRegistry } from '../../helpers/prompt-template-registry.js';
import { scriptedAdmissionProvider, testAutonomousCompaction } from '../../helpers/llm-test-helpers.js';
import { testApplicationFatalPort } from '../../helpers/test-application-fatal-port.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import { readCardExecutions } from '../../../src/persistence/card-execution-log.js';
import type { OperationDefinition } from '../../../src/runtime/card-process/operation-contract.js';
import { readConversation } from '../../../src/persistence/conversation-file.js';
import { ActivationOperationTracker } from '../../../src/runtime/actors/invocation-lifecycle.js';
import { RuntimeStoppedInterruption } from '../../../src/runtime/actors/runtime-stopped-interruption.js';
import type { CardActivationOwner } from '../../../src/runtime/actors/card-activation-owner.js';
import { cardExecutionFile } from '../../../src/persistence/layout.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); jest.restoreAllMocks(); });
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(definition?: OperationDefinition, script = 'printf "real action"; exit 0', typedHandoff = false, allowRecovery = false, requireAccepted = false, shellConfig: Record<string, unknown> = {}, attachment?: { definition?: OperationDefinition; script?: string; args?: string[]; child?: boolean; status?: 'done' | 'blocked' | 'failed'; requiredCheck?: boolean }, retainedRoot?: string, stdoutRecord = false) {
  const root = retainedRoot ?? mkdtempSync(join(tmpdir(), 'action-runtime-'));
  const config = effectiveSaivageConfigSchema.parse(structuredClone(TEST_SAIVAGE_CONFIG));
  const workflow = config.card_types.project!.workflow;
  const recovery = workflow.nodes.plan!;
  workflow.entries.BACKLOG = { node: 'check' };
  workflow.entries.CHANGED = { node: 'check' };
  workflow.entries.BLOCKED = { node: 'plan' };
  workflow.entries.STOPPED = { ...workflow.entries.STOPPED, node: 'plan' };
  workflow.nodes = {
    plan: { ...recovery, initialize_records: [], records: {}, edges: { retry: { target: { node: 'check' } }, complete: { target: { terminal: 'BLOCKED', promote: 'current', export_records: [] } } } },
    check: { execution: { kind: 'action', action: definition?.id ?? 'shell.run', contract_version: 1,
      config: definition ? {} : { script, timeout_ms: 1000, terminate_grace_ms: 50, ...shellConfig },
      inputs: definition ? {} : { args: { literal: [] } } }, records: {},
      edges: Object.fromEntries((definition ? Object.keys(definition.outcomes) : ['passed', 'failed', 'signalled', 'timed_out'])
        .map((outcome) => [outcome, { target: { terminal: 'BLOCKED', promote: 'current', export_records: [] } }])) },
  };
  if (requireAccepted) {
    workflow.nodes.check!.records = { 'status.md': { mode: 'continue', gate: 'exists' } };
    for (const edge of Object.values(workflow.nodes.check!.edges)) {
      if ('target' in edge && 'terminal' in edge.target) edge.target.export_records = ['status.md'];
    }
  }
  if (stdoutRecord) {
    workflow.nodes.check!.stdout_record = 'status.md';
    workflow.nodes.check!.records = { 'status.md': { mode: 'continue', gate: 'updated' } };
    for (const edge of Object.values(workflow.nodes.check!.edges))
      if ('target' in edge && 'terminal' in edge.target) edge.target.export_records = ['status.md'];
  }
  if (typedHandoff) {
    if (recovery.execution.kind !== 'agent') throw new Error();
    for (const node of ['assess', 'repair']) workflow.nodes[node] = { ...recovery, initialize_records: [], records: {},
      execution: { ...recovery.execution, data_inputs: { findings: { type: 'integer', min: 0, max: 1000 } } },
      edges: { complete: { target: { terminal: 'BLOCKED', promote: 'current', export_records: [] } } } };
    workflow.nodes.check!.edges = { finished: {
      cases: [{ id: 'findings', when: { field: 'count', op: 'gt', value: 0 }, target: { node: 'assess' }, inputs: { findings: { output: 'count' } } }],
      otherwise: { target: { node: 'repair' }, inputs: { findings: { output: 'count' } } },
    } };
  }
  if (attachment) {
    for (const edge of Object.values(workflow.nodes.check!.edges))
      if ('target' in edge && 'terminal' in edge.target) {
        edge.target.terminal = attachment.status && attachment.status !== 'done' ? 'BLOCKED' : 'DONE';
        if (edge.target.terminal === 'DONE' && recovery.execution.kind === 'agent')
          edge.pending_notifications = { node: 'plan', prompt: recovery.execution.prompt };
      }
    if (attachment.requiredCheck) {
      for (const outcome of ['failed', 'signalled', 'timed_out'])
        workflow.nodes.check!.edges[outcome] = { target: { terminal: 'BLOCKED', promote: 'current', export_records: [] } };
    }
    workflow.after_activation_commit = { statuses: [attachment.status ?? 'done'], execution: {
      kind: 'action', action: attachment.definition?.id ?? 'shell.run', contract_version: 1,
      config: attachment.definition ? {} : { script: attachment.script ?? 'printf "actual hook"', timeout_ms: 1000, terminate_grace_ms: 50 },
      inputs: attachment.definition ? {} : { args: { literal: attachment.args ?? [] } },
    } };
    if (attachment.child) {
      config.card_types.goal!.workflow = structuredClone(workflow);
      delete workflow.after_activation_commit;
      workflow.entries.BACKLOG = { node: 'plan' };
      workflow.nodes.plan!.edges = { complete: { target: { terminal: 'DONE', promote: 'current', export_records: [] } }, retry: { target: { node: 'check' } } };
    }
  }
  const operation = definition ?? attachment?.definition;
  const compiled = compileProjectWorkflows(config, { operationPlugins: operation ? [{ namespace: 'acme', operations: { inspect: operation } }] : [] });
  const registry = new ProviderRegistry(config);
  const workflows = bindRuntimeWorkflows(compiled, new ModelRouter(registry), registry, config.compaction.context_utilization_fraction);
  if (!retainedRoot) initProjectTree(root);
  const cards = new CardService(root, compiled);
  const processes = createTestProcessRunner(root);
  let providerCalls = 0;
  let childId = '';
  if (attachment?.child) childId = cards.create({ type: 'goal', parent: 'project', title: 'Hook child', bootstrap_content: 'Finite child', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
  const provider = jest.fn(async () => {
    if (attachment?.child && ++providerCalls === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-child', type: 'function' as const,
      function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId, instructions: 'Complete the finite check.' }) } }] }, provider_exchanges: [] };
    if (!typedHandoff && !allowRecovery && !attachment?.child) throw new Error('Action must not invoke a provider.');
    return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'accepted-result', type: 'function' as const,
      function: { name: 'emit_result', arguments: JSON.stringify({ outcome: 'complete', summary: 'Assessed selected facts.' }) } }] }, provider_exchanges: [] };
  });
  const supervisorOptions = { ...testAutonomousCompaction, workflows,
    fatalPort: testApplicationFatalPort, runtimeGate: new RuntimeGate(), projectRoot: root, actorStore: cards,
    provider: scriptedAdmissionProvider(provider), conversations: { projectRoot: root }, freshness: { runtimeChanged() {}, agentMembershipChanged() {} },
    processRunner: processes.processRunner, runtimeProcessRootScope: processes.runtimeProcessRootScope,
    promptTemplates: createTestPromptTemplateRegistry(),
  };
  const supervisor = createSupervisorRuntimeApi(supervisorOptions);
  cleanups.push(async () => {
    await processes.processRunner.terminateScopeTree({ rootScope: processes.runtimeProcessRootScope, categories: ['runtime_card'], reason: 'test cleanup', graceMs: 50 });
    rmSync(root, { recursive: true, force: true });
  });
  return { root, cards, supervisor, provider, processes, childId, supervisorOptions };
}
async function launch(f: ReturnType<typeof fixture>) {
  await f.supervisor.start();
  const internal = f.supervisor as unknown as { beginStartProject(): Promise<{ accepted: boolean; launch: { owner: CardActivationOwner } }>; launchStartedProject(plan: unknown): void };
  const prepared = await internal.beginStartProject();
  if (!prepared.accepted) throw new Error('Rejected test launch.');
  const owner = prepared.launch.owner;
  void owner.settlement.promise.catch(() => undefined);
  internal.launchStartedProject(prepared.launch);
  return owner;
}
function stdoutFixture(script: string, config: Record<string, unknown> = {}) {
  return fixture(undefined, script, false, false, false, config, undefined, undefined, true);
}
function acceptedReport(f: ReturnType<typeof fixture>) {
  const result = f.cards.readRecordCurrent('project', 'status.md');
  if (result.kind !== 'found') throw new Error('Missing fixture card.');
  return result.value.projection;
}
const nodeCommand = (code: string) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;

it('publishes independent exact stdout twice with new ordinary provenance and retained history', async () => {
  const content = '\uFEFFReport\r\nUnicode: λ 日本語\r\n \n';
  const f = stdoutFixture(nodeCommand(`process.stdout.write(${JSON.stringify(content)}); process.stderr.write('NOT THE REPORT');`));
  const close = jest.spyOn(f.cards, 'closeRecord');
  const first = await launch(f);
  await expect(first.settlement.promise).resolves.toMatchObject({ status: 'blocked', result: { outcome: 'passed', records: [{ name: 'status.md', version: 1 }] } });
  const before = acceptedReport(f)!;
  expect(before.accepted).toMatchObject({ content, source_version: 1,
    content_sha256: createHash('sha256').update(content).digest('hex'),
    size_bytes: Buffer.byteLength(content), author: { kind: 'shell-stdout', node_id: 'check', outcome: 'passed', leader_exit: { exit_code: 0, signal: null } } });
  f.cards.setStatus('project', 'changed');
  const second = await launch(f);
  await expect(second.settlement.promise).resolves.toMatchObject({ status: 'blocked', result: { records: [{ version: 2 }] } });
  const after = acceptedReport(f)!;
  expect(after.headId).not.toBe(before.headId);
  expect(after.revision).toBeGreaterThan(before.revision);
  expect(after.accepted!.content).toBe(content);
  expect(after.accepted!.author).not.toEqual(before.accepted!.author);
  const history = f.cards.readRecordHistory('project', 'status.md');
  const diff = f.cards.diffRecordVersions('project', 'status.md', { from: 1, to: 2 });
  const old = f.cards.readRecordVersion('project', 'status.md', 1);
  for (const row of readCardExecutions(f.root, 'project')) if (row.kind === 'process_started') {
    const stdout = row.files.find((file) => file.kind === 'capture' && file.stream === 'stdout')!;
    writeFileSync(join(f.root, stdout.path), 'changed capture');
    rmSync(join(f.root, stdout.path));
  }
  expect(f.cards.readRecordVersion('project', 'status.md', 1)).toEqual(old);
  expect(f.cards.readRecordHistory('project', 'status.md')).toEqual(history);
  expect(f.cards.diffRecordVersions('project', 'status.md', { from: 1, to: 2 })).toEqual(diff);
  expect(acceptedReport(f)!.accepted!.content).toBe(content);
  expect(close).not.toHaveBeenCalled();
  expect(f.provider).not.toHaveBeenCalled();
});

it.each([
  ['printf report; exit 7', 'failed', { exit_code: 7, signal: null }],
  ['printf report; kill -TERM $$', 'signalled', { exit_code: null, signal: 'SIGTERM' }],
  ['printf report; sleep 30', 'timed_out', { exit_code: null, signal: 'SIGTERM' }],
] as const)('publishes completed capture without changing disposition: %s', async (script, outcome, leader) => {
  const f = stdoutFixture(script);
  const owner = await launch(f);
  await expect(owner.settlement.promise).resolves.toMatchObject({ status: 'blocked', result: { outcome } });
  expect(acceptedReport(f)!.accepted).toMatchObject({ content: 'report', author: { kind: 'shell-stdout', outcome, leader_exit: leader } });
  expect(readCardExecutions(f.root, 'project').at(-1)).toMatchObject({ outcome, leader_exit: leader });
});

it.each(['entry', 'publication'] as const)('preserves an open draft and accepted backing at %s', async (when) => {
  const f = stdoutFixture('printf report');
  f.cards.acceptRecord('project', 'status.md', 'Prior accepted', { kind: 'agent', agent: 'analyst' });
  const draft = () => { f.cards.openRecord('project', 'status.md'); f.cards.editRecord('project', 'status.md', 'Do not overwrite'); };
  let preserved: ReturnType<typeof acceptedReport>;
  const spawn = jest.spyOn(f.processes.processRunner, 'spawnCaptured');
  if (when === 'entry') { draft(); preserved = acceptedReport(f); }
  else {
    const close = f.processes.processRunner.closeAndTerminateDirectScope.bind(f.processes.processRunner);
    jest.spyOn(f.processes.processRunner, 'closeAndTerminateDirectScope').mockImplementation(async (args) => {
      const result = await close(args); draft(); preserved = acceptedReport(f); return result;
    });
  }
  const owner = await launch(f);
  await expect(owner.settlement.promise).resolves.toMatchObject({ status: 'failed' });
  expect(acceptedReport(f)).toEqual(preserved!);
  expect(spawn).toHaveBeenCalledTimes(when === 'entry' ? 0 : 1);
});

it.each([
  ['cap', "process.stdout.write('x'.repeat(1024*1024))", true],
  ['oversize', "process.stdout.write('x'.repeat(1024*1024+1))", false],
  ['invalid UTF8', 'process.stdout.write(Buffer.from([0xff]))', false],
  ['NUL', "process.stdout.write('report\\0')", false],
  ['empty', "process.stdout.write(' \\r\\n\\t')", false],
] as const)('admits complete stdout text only: %s', async (_name, code, valid) => {
  const f = stdoutFixture(nodeCommand(code));
  f.cards.acceptRecord('project', 'status.md', 'Prior accepted', { kind: 'agent', agent: 'analyst' });
  const before = acceptedReport(f);
  const owner = await launch(f);
  await expect(owner.settlement.promise).resolves.toMatchObject({ status: valid ? 'blocked' : 'failed' });
  if (valid) expect(acceptedReport(f)!.accepted).toMatchObject({ source_version: 2, content: 'x'.repeat(1024*1024) });
  else expect(acceptedReport(f)).toEqual(before);
});

it('Stop before publication joins completed raw cleanup without a report or late acceptance', async () => {
  const f = stdoutFixture('printf report');
  const closed = deferred(); const release = deferred();
  const close = f.processes.processRunner.closeAndTerminateDirectScope.bind(f.processes.processRunner);
  jest.spyOn(f.processes.processRunner, 'closeAndTerminateDirectScope').mockImplementation(async (args) => {
    const result = await close(args); closed.resolve(); await release.promise; return result;
  });
  const publish = jest.spyOn(f.cards, 'acceptRecord');
  await launch(f); await closed.promise;
  const stop = f.supervisor.stopProject();
  release.resolve();
  await expect(stop).resolves.toMatchObject({ contained: true });
  expect(publish).not.toHaveBeenCalled();
  expect(acceptedReport(f)).toBeNull();
  expect(f.processes.processRunner.list()).toEqual([]);
  // The process completed before Stop; the log remains factual, not a publication receipt.
  expect(readCardExecutions(f.root, 'project').at(-1)).toMatchObject({ disposition: 'returned', outcome: 'passed' });
});

it.each(['stdout-artifact-publication', 'stdout-head-publication'])('halts at the real record publisher before late acknowledgement or cleanup: %s', (mode) => {
  const root = mkdtempSync(join(tmpdir(), 'stdout-fatal-'));
  cleanups.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const marker = join(root, 'marker'); writeFileSync(marker, '');
  const fatal = spawnSync(process.execPath, ['--import', 'tsx',
    join(process.cwd(), 'tests/fixtures/publication-fatal-boundaries.ts'), mode, marker],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 });
  expect(fatal.status).toBe(1);
  expect(fatal.stdout).toBe('');
  expect(fatal.stderr).toBe('Fatal: PublicationOutcomeUnknownError; Saivage is halting because durable publication outcome is unknown. Cause: record publication uncertain\n');
  expect(readFileSync(marker, 'utf8')).toBe('publishing\nuncertain\n');
}, 35_000);

it.each(['missing', 'directory'] as const)('rejects a %s completed capture without replacing accepted content', async (kind) => {
  const f = stdoutFixture('printf report');
  f.cards.acceptRecord('project', 'status.md', 'Prior accepted', { kind: 'agent', agent: 'analyst' });
  const before = acceptedReport(f);
  let capture = '';
  const spawn = f.processes.processRunner.spawnCaptured.bind(f.processes.processRunner);
  jest.spyOn(f.processes.processRunner, 'spawnCaptured').mockImplementation((args) => {
    const record = spawn(args); capture = record.stdout_path; return record;
  });
  const close = f.processes.processRunner.closeAndTerminateDirectScope.bind(f.processes.processRunner);
  jest.spyOn(f.processes.processRunner, 'closeAndTerminateDirectScope').mockImplementation(async (args) => {
    const result = await close(args); rmSync(capture); if (kind === 'directory') mkdirSync(capture); return result;
  });
  const owner = await launch(f);
  await expect(owner.settlement.promise).resolves.toMatchObject({ status: 'failed' });
  expect(acceptedReport(f)).toEqual(before);
});

it('keeps the factual report when a later real descendant gate refuses DONE', async () => {
  const f = fixture(undefined, 'printf report', false, false, false, {}, {}, undefined, true);
  f.cards.create({ type: 'goal', parent: 'project', title: 'Incomplete child', bootstrap_content: 'Work remains', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
  const owner = await launch(f);
  await expect(owner.settlement.promise).resolves.toMatchObject({ status: 'failed', result: { summary: expect.stringContaining('descendant') } });
  expect(acceptedReport(f)!.accepted).toMatchObject({ content: 'report', source_version: 1, author: { kind: 'shell-stdout' } });
  expect(readCardExecutions(f.root, 'project')).toHaveLength(3);
});

it('rejects a positive short stdout read without publishing its prefix or replacing prior acceptance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stdout-short-read-'));
  cleanups.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const marker = join(root, 'marker'); writeFileSync(marker, '');
  const child = spawnSync(process.execPath, ['--import', 'tsx',
    join(process.cwd(), 'tests/fixtures/publication-fatal-boundaries.ts'), 'stdout-short-read', marker],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 });
  expect(child.stderr).toBe('');
  expect(child.status).toBe(0);
  expect(readFileSync(marker, 'utf8')).toBe('short-read\nclosed\npreserved\n');
}, 35_000);

it.each([['printf "real action"; exit 0', 'passed'], ['exit 9', 'failed'], ['kill -TERM $$', 'signalled'], ['sleep 30', 'timed_out']])(
  'executes a real action on the graph: %s', async (script, outcome) => {
    const f = fixture(undefined, script); const owner = await launch(f);
    await expect(owner.settlement.promise).resolves.toMatchObject({ status: 'blocked', result: { executor: { kind: 'action', action: 'shell.run', invocation_id: expect.any(String) }, outcome } });
    expect(f.cards.read('project')!.lifecycle).toMatchObject({ status: 'blocked', result: { executor: { kind: 'action' } } });
    expect(f.provider).not.toHaveBeenCalled();
    expect(owner.processor.executingLlmSnapshot()).toBeNull();
    expect(readCardExecutions(f.root, 'project').at(-1)).toMatchObject({ outcome });
    await expect(f.supervisor.stopProject()).resolves.toMatchObject({ contained: false });
  });

it.each([false, true])('Stop joins actual delayed raw plugin cleanup beyond command exit; cleanup failure=%s', async (failCleanup) => {
  const commandExited = deferred(); const finishCleanup = deferred(); const cleanupFailure = new Error('raw cleanup failed');
  let callbacks = 0;
  const definition: OperationDefinition = { id: 'acme.inspect', provider: { kind: 'plugin', name: 'acme' }, contractVersion: 1,
    bindings: ['node'], config: z.object({}).strict(), inputs: {}, outcomes: { finished: {} }, retainFields: [],
    async run(_config, _inputs, capabilities, signal) {
      await capabilities.command!({ script: 'exit 0', args: [], cwd: '.', env: {}, timeoutMs: 1000, terminateGraceMs: 50 }, signal);
      commandExited.resolve();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      await finishCleanup.promise;
      callbacks++;
      if (failCleanup) throw cleanupFailure;
      throw signal.reason;
    } };
  const f = fixture(definition); const owner = await launch(f); await commandExited.promise;
  let settled = false;
  const stop = f.supervisor.stopProject();
  void stop.then(() => { settled = true; }, () => { settled = true; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false); expect(callbacks).toBe(0);
    expect(readCardExecutions(f.root, 'project').some(({ kind }) => kind === 'invocation_finished')).toBe(false);
    finishCleanup.resolve();
    if (failCleanup) await expect(stop).rejects.toBe(cleanupFailure);
    else await expect(stop).resolves.toMatchObject({ contained: true });
  } finally {
    finishCleanup.resolve();
    await stop.catch(() => undefined);
  }
  expect(callbacks).toBe(1); expect(f.provider).not.toHaveBeenCalled();
  expect(readCardExecutions(f.root, 'project').at(-1)).toMatchObject({ disposition: failCleanup ? 'unavailable' : 'cancelled', outcome: null });
  expect(owner.processor.executingLlmSnapshot()).toBeNull();
  if (failCleanup) expect(f.supervisor.getStatus().status).toBe('error');
});

it.each([false, true])('cancelCard retains finite cleanup and exact root/child authority until settlement; child=%s', async (child) => {
  const commandExited = deferred(); const aborted = deferred(); const finishCleanup = deferred(); const rawFinished = deferred();
  let interruption: unknown;
  const definition: OperationDefinition = { id: 'acme.inspect', provider: { kind: 'plugin', name: 'acme' }, contractVersion: 1,
    bindings: ['node'], config: z.object({}).strict(), inputs: {}, outcomes: { finished: {} }, retainFields: [],
    async run(_config, _inputs, capabilities, signal) {
      await capabilities.command!({ script: 'exit 0', args: [], cwd: '.', env: {}, timeoutMs: 1000, terminateGraceMs: 50 }, signal);
      commandExited.resolve();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => { interruption = signal.reason; aborted.resolve(); resolve(); }, { once: true }));
      await finishCleanup.promise;
      rawFinished.resolve();
      throw signal.reason;
    } };
  const f = fixture(definition, '', false, false, false, {}, child ? { child: true } : undefined);
  const rootOwner = await launch(f);
  let cancellation: Promise<unknown> | undefined;
  try {
    await commandExited.promise;
    const id = child ? f.childId : 'project';
    const owners = (f.supervisor as unknown as { activationOwners: Map<string, CardActivationOwner> }).activationOwners;
    const actionOwner = owners.get(id)!;
    const invocation = actionOwner.parentRelationship?.invocation;
    let cancellationSettled = false; let actionSettled = false; let delivered = false;
    void actionOwner.settlement.promise.then(() => { actionSettled = true; }, () => { actionSettled = true; });
    if (invocation) void invocation.activation.then(() => { delivered = true; }, () => { delivered = true; });
    cancellation = f.supervisor.cancelCard(id, 'cancel finite action');
    // Observe rejections immediately, including when a pending-state assertion fails.
    void cancellation.then(() => { cancellationSettled = true; }, () => { cancellationSettled = true; });
    await aborted.promise;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(interruption).toBe(actionOwner.abortController.signal.reason);
    expect(cancellationSettled).toBe(false);
    expect(actionSettled).toBe(false);
    expect(f.cards.read(id)!.lifecycle.status).toBe('running');
    expect(owners.get('project')).toBe(rootOwner);
    expect(owners.get(id)).toBe(actionOwner);
    if (invocation) {
      expect(invocation.phase()).toBe('settling');
      expect(delivered).toBe(false);
      expect(f.provider).toHaveBeenCalledTimes(1);
    }
    finishCleanup.resolve();
    await expect(cancellation).resolves.toMatchObject({ card_id: id, status: 'cancelled', cancelled_card_ids: [id] });
    await expect(actionOwner.settlement.promise).resolves.toMatchObject({ status: 'cancelled' });
    expect(f.cards.read(id)!.lifecycle.status).toBe('cancelled');
    expect(owners.has(id)).toBe(false);
    if (invocation) {
      expect(invocation.phase()).toBe('released');
      await expect(invocation.activation).resolves.toMatchObject({ status: 'cancelled' });
      await expect(rootOwner.settlement.promise).resolves.toMatchObject({ status: 'done' });
    }
    expect(readCardExecutions(f.root, id).at(-1)).toMatchObject({ disposition: 'cancelled', outcome: null });
  } finally {
    finishCleanup.resolve();
    if (cancellation) {
      await rawFinished.promise;
      await cancellation.catch(() => undefined);
    }
    await f.supervisor.stopProject().catch(() => undefined);
  }
});

it('cancelCard surfaces a distinct late finite cleanup failure instead of successful CANCELLED release', async () => {
  const commandExited = deferred(); const aborted = deferred(); const finishCleanup = deferred(); const rawFinished = deferred();
  const cleanupFailure = new Error('distinct cancelCard finite cleanup failure');
  let interruption: unknown;
  const definition: OperationDefinition = { id: 'acme.inspect', provider: { kind: 'plugin', name: 'acme' }, contractVersion: 1,
    bindings: ['node'], config: z.object({}).strict(), inputs: {}, outcomes: { finished: {} }, retainFields: [],
    async run(_config, _inputs, capabilities, signal) {
      await capabilities.command!({ script: 'exit 0', args: [], cwd: '.', env: {}, timeoutMs: 1000, terminateGraceMs: 50 }, signal);
      commandExited.resolve();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => { interruption = signal.reason; aborted.resolve(); resolve(); }, { once: true }));
      await finishCleanup.promise;
      rawFinished.resolve();
      throw cleanupFailure;
    } };
  const f = fixture(definition); await launch(f);
  let observed: Promise<{ result: unknown } | { error: unknown }> | undefined;
  try {
    await commandExited.promise;
    observed = f.supervisor.cancelCard('project', 'cancel before distinct cleanup failure').then(
      (result) => ({ result }), (error: unknown) => ({ error }));
    await aborted.promise;
    expect(interruption).not.toBe(cleanupFailure);
    finishCleanup.resolve();
    const outcome = await observed;
    expect(outcome).toHaveProperty('error');
    expect('error' in outcome && outcome.error).toBe(cleanupFailure);
    await expect(f.supervisor.stopProject()).rejects.toBe(cleanupFailure);
    expect(f.supervisor.getStatus().status).toBe('error');
    expect(f.cards.read('project')!.lifecycle.status).not.toBe('cancelled');
    expect(readCardExecutions(f.root, 'project').at(-1)).toMatchObject({ disposition: 'unavailable', outcome: null });
  } finally {
    finishCleanup.resolve();
    if (observed) { await rawFinished.promise; await observed; }
    await f.supervisor.stopProject().catch(() => undefined);
  }
});

it('cancelCard joins real managed shell TERM cleanup, capture and direct scope before releasing the child lease', async () => {
  const script = `
    trap 'printf term > cancel-term; deadline=$((SECONDS + 3)); while [[ ! -f cancel-release && $SECONDS -lt $deadline ]]; do sleep 0.02; done; printf "term cleanup complete"; exit 0' TERM
    printf ready > cancel-ready
    deadline=$((SECONDS + 10))
    while [[ $SECONDS -lt $deadline ]]; do sleep 0.02; done
  `;
  const f = fixture(undefined, script, false, false, false, { timeout_ms: 15000, terminate_grace_ms: 2000 }, { child: true });
  const directClosed = deferred(); const finishDirectCleanup = deferred();
  const close = f.processes.processRunner.closeAndTerminateDirectScope.bind(f.processes.processRunner);
  jest.spyOn(f.processes.processRunner, 'closeAndTerminateDirectScope').mockImplementation(async (args) => {
    const result = await close(args);
    directClosed.resolve();
    await finishDirectCleanup.promise;
    return result;
  });
  const waitForFile = async (name: string) => {
    const deadline = Date.now() + 3000;
    while (!existsSync(join(f.root, name))) {
      if (Date.now() >= deadline) throw new Error(`Managed shell did not publish ${name}.`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const rootOwner = await launch(f);
  let cancellation: Promise<unknown> | undefined;
  try {
    await waitForFile('cancel-ready');
    const owners = (f.supervisor as unknown as { activationOwners: Map<string, CardActivationOwner> }).activationOwners;
    const childOwner = owners.get(f.childId)!;
    const lease = childOwner.parentRelationship!.invocation;
    let settled = false; let delivered = false;
    void lease.activation.then(() => { delivered = true; }, () => { delivered = true; });
    cancellation = f.supervisor.cancelCard(f.childId, 'cancel managed shell');
    void cancellation.then(() => { settled = true; }, () => { settled = true; });
    await waitForFile('cancel-term');
    expect(settled).toBe(false);
    expect(lease.phase()).toBe('settling');
    expect(delivered).toBe(false);
    expect(f.cards.read(f.childId)!.lifecycle.status).toBe('running');
    expect(f.processes.processRunner.list()).toHaveLength(1);
    expect(readCardExecutions(f.root, f.childId).map(({ kind }) => kind)).toEqual(['invocation_started', 'process_started']);

    writeFileSync(join(f.root, 'cancel-release'), 'release');
    await directClosed.promise;
    expect(settled).toBe(false);
    expect(delivered).toBe(false);
    expect(owners.get(f.childId)).toBe(childOwner);
    expect(owners.get('project')).toBe(rootOwner);
    expect(f.provider).toHaveBeenCalledTimes(1);
    expect(f.processes.processRunner.list()).toEqual([]);
    finishDirectCleanup.resolve();
    await expect(cancellation).resolves.toMatchObject({ status: 'cancelled' });
    await expect(lease.activation).resolves.toMatchObject({ status: 'cancelled' });
    expect(lease.phase()).toBe('released');
    await expect(rootOwner.settlement.promise).resolves.toMatchObject({ status: 'done' });
    const rows = readCardExecutions(f.root, f.childId);
    expect(rows).toHaveLength(3);
    expect(rows.at(-1)).toMatchObject({ disposition: 'cancelled', outcome: null,
      process: { group: 'absent', stdout: 'eof', stderr: 'eof', stdout_error: null, stderr_error: null },
      leader_exit: { exit_code: 0, signal: null }, external_effects: 'unknown' });
    const started = rows.find((row) => row.kind === 'process_started')!;
    if (started.kind !== 'process_started') throw new Error('Missing actual managed process start.');
    const stdout = started.files.find((file) => file.kind === 'capture' && file.stream === 'stdout')!;
    expect(readFileSync(join(f.root, stdout.path), 'utf8')).toBe('term cleanup complete');
  } finally {
    // Both shell-side and owner-side gates open even when an observation fails.
    writeFileSync(join(f.root, 'cancel-release'), 'release');
    finishDirectCleanup.resolve();
    if (cancellation) await cancellation.catch(() => undefined);
    await f.supervisor.stopProject().catch(() => undefined);
    expect(f.processes.processRunner.list()).toEqual([]);
  }
}, 15_000);

it('cancelCard abandons an ordinary agent while its deferred provider remains unresolved', async () => {
  const f = fixture(undefined, 'exit 0', false, false, false, {}, { child: true });
  const entered = deferred(); const release = deferred();
  const ordinary = f.provider.getMockImplementation()!;
  let providerSettled = false;
  let providerCompletion: ReturnType<typeof f.provider> | undefined;
  f.provider.mockImplementationOnce(() => {
    providerCompletion = (async () => {
      entered.resolve();
      await release.promise;
      providerSettled = true;
      return ordinary();
    })();
    return providerCompletion;
  });
  const owner = await launch(f);
  const failsafe = setTimeout(() => release.resolve(), 3000);
  try {
    await entered.promise;
    await expect(f.supervisor.cancelCard('project', 'abandon deferred provider')).resolves.toMatchObject({ status: 'cancelled' });
    expect(providerSettled).toBe(false);
    await expect(owner.settlement.promise).resolves.toMatchObject({ status: 'cancelled' });
    expect((f.supervisor as unknown as { activationOwners: Map<string, CardActivationOwner> }).activationOwners.size).toBe(0);
    expect(f.cards.read('project')!.lifecycle.status).toBe('cancelled');
    expect(readCardExecutions(f.root, f.childId)).toEqual([]);
  } finally {
    clearTimeout(failsafe);
    release.resolve();
    if (providerCompletion) await providerCompletion;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await f.supervisor.stopProject().catch(() => undefined);
  }
  expect(f.provider).toHaveBeenCalledTimes(1);
  expect(f.cards.read('project')!.lifecycle.status).toBe('cancelled');
  expect(readCardExecutions(f.root, f.childId)).toEqual([]);
});

it('cancelCard retains an urgent retiring action and its first interruption without admitting a successor', async () => {
  const entered = deferred(); const aborted = deferred(); const finishCleanup = deferred(); const rawFinished = deferred();
  let interruption: unknown; let finalReason: unknown;
  const definition: OperationDefinition = { id: 'acme.inspect', provider: { kind: 'plugin', name: 'acme' }, contractVersion: 1,
    bindings: ['node'], config: z.object({}).strict(), inputs: {}, outcomes: { finished: {} }, retainFields: [],
    async run(_config, _inputs, _capabilities, signal) {
      entered.resolve();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => { interruption = signal.reason; aborted.resolve(); resolve(); }, { once: true }));
      await finishCleanup.promise;
      finalReason = signal.reason;
      rawFinished.resolve();
      throw signal.reason;
    } };
  const f = fixture(definition, '', false, true);
  const child = f.cards.create({ type: 'goal', parent: 'project', title: 'Urgent context target', bootstrap_content: 'No active child invocation.', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
  const owner = await launch(f);
  let urgent: Promise<unknown> | undefined; let cancellation: Promise<unknown> | undefined;
  try {
    await entered.promise;
    urgent = f.supervisor.submitNotification(child.id, { id: '22222222-2222-4222-8222-222222222222', content: 'Urgent new context', created_at: new Date().toISOString() }, 'urgent');
    void urgent.catch(() => undefined);
    await aborted.promise;
    const urgentReason = interruption;
    const owners = (f.supervisor as unknown as { activationOwners: Map<string, CardActivationOwner> }).activationOwners;
    expect(owner.terminalWinner).toBe('open');
    let settled = false;
    cancellation = f.supervisor.cancelCard('project', 'cancel during urgent retirement');
    void cancellation.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    expect(owners.get('project')).toBe(owner);
    expect(f.cards.read('project')!.lifecycle.status).toBe('running');
    expect(owner.abortController.signal.reason).not.toBe(urgentReason);
    expect(f.provider).not.toHaveBeenCalled();
    finishCleanup.resolve();
    await expect(cancellation).resolves.toMatchObject({ status: 'cancelled' });
    await urgent;
    expect(finalReason).toBe(urgentReason);
    expect(f.provider).not.toHaveBeenCalled();
    expect(readCardExecutions(f.root, 'project')).toHaveLength(2);
    expect(readCardExecutions(f.root, 'project').at(-1)).toMatchObject({ disposition: 'cancelled', outcome: null });
    expect(f.cards.read('project')!.lifecycle.status).toBe('cancelled');
    expect(owners.size).toBe(0);
  } finally {
    finishCleanup.resolve();
    if (urgent) { await rawFinished.promise; await urgent.catch(() => undefined); }
    if (cancellation) await cancellation.catch(() => undefined);
    await f.supervisor.stopProject().catch(() => undefined);
  }
});

it.each([0, 3])('selects the typed plugin branch and feeds only declared factual inputs to the real agent: %i', async (count) => {
  const definition: OperationDefinition = { id: 'acme.inspect', provider: { kind: 'plugin', name: 'acme' }, contractVersion: 1,
    bindings: ['node'], config: z.object({}).strict(), inputs: {},
    outcomes: { finished: { count: { type: 'integer', min: 0, max: 1000, workflow: true }, private: { type: 'string', workflow: false } } }, retainFields: ['count'],
    async run() { return { outcome: 'finished', summary: 'Analysis observed.', values: { count, private: 'PRIVATE-NOT-FED' } }; } };
  const f = fixture(definition, '', true); const owner = await launch(f);
  await expect(owner.settlement.promise).resolves.toMatchObject({ status: 'blocked', result: { executor: { kind: 'agent', agent: 'planner' }, node_id: count ? 'assess' : 'repair' } });
  expect(f.provider).toHaveBeenCalledTimes(1);
  const rows = readConversation(f.root, 'agent:planner:project').physicalRows;
  const handoff = rows.find((row) => row.kind === 'text' && row.content.includes('Previous action observation'))!;
  expect(handoff).toBeDefined();
  const quoted = JSON.parse(handoff.content.split('\n')[1]!);
  expect(quoted).toMatchObject({ operation: 'acme.inspect', inputs: { findings: count }, summary: 'Analysis observed.', execution_detail: expect.stringContaining('/executions/') });
  expect(JSON.stringify(rows)).not.toContain('PRIVATE-NOT-FED');
  expect(JSON.stringify(readCardExecutions(f.root, 'project'))).not.toContain('PRIVATE-NOT-FED');
});

it('selects cancel-and-settle before an action raw body is entered', async () => {
  const f = stdoutFixture('printf report');
  const run = ActivationOperationTracker.prototype.run;
  let stop!: ReturnType<typeof f.supervisor.stopProject>;
  jest.spyOn(ActivationOperationTracker.prototype, 'run').mockImplementation(function (this: ActivationOperationTracker, ...args: Parameters<typeof run>) {
    const value = run.apply(this, args);
    stop = f.supervisor.stopProject();
    return value;
  } as typeof run);
  await launch(f);
  await expect(stop).resolves.toMatchObject({ contained: true });
  expect(f.processes.processRunner.list()).toEqual([]);
  expect(readCardExecutions(f.root, 'project')).toEqual([]);
  expect(f.provider).not.toHaveBeenCalled();
  expect(acceptedReport(f)).toBeNull();
});

it.each(['Stop', 'shutdown', 'urgent'] as const)('joins a real action command on %s without replay or false outcome', async (mode) => {
  const f = fixture(undefined, 'printf report; sleep 30', false, mode === 'urgent', false, {}, undefined, undefined, true);
  const spawned = deferred();
  const original = f.processes.processRunner.spawnCaptured.bind(f.processes.processRunner);
  jest.spyOn(f.processes.processRunner, 'spawnCaptured').mockImplementation((args) => original({ ...args,
    onSpawn(record) { args.onSpawn(record); spawned.resolve(); } }));
  const owner = await launch(f); await spawned.promise;
  if (mode === 'Stop') await expect(f.supervisor.stopProject()).resolves.toMatchObject({ contained: true });
  else if (mode === 'shutdown') await expect(f.supervisor.cleanupForApplicationStop()).resolves.toBeUndefined();
  else {
    await expect(f.supervisor.submitNotification('project', { id: '11111111-1111-4111-8111-111111111111', content: 'Urgent new context', created_at: new Date().toISOString() }, 'urgent')).resolves.toMatchObject({ queued: true });
    await expect(owner.settlement.promise).resolves.toMatchObject({ status: 'stopped' });
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const observe = () => {
        if (f.cards.read('project')!.lifecycle.status === 'blocked') { resolve(); return; }
        if (Date.now() >= deadline) { reject(new Error('Urgent replacement did not settle.')); return; }
        setTimeout(observe, 5);
      };
      observe();
    });
  }
  const rows = readCardExecutions(f.root, 'project');
  expect(rows).toHaveLength(3);
  expect(rows.at(-1)).toMatchObject({ disposition: 'cancelled', outcome: null, process: { group: 'absent' } });
  expect(f.processes.processRunner.list()).toEqual([]);
  expect(f.provider).toHaveBeenCalledTimes(mode === 'urgent' ? 1 : 0);
  expect(acceptedReport(f)).toBeNull();
});

it.each(['accepted-with-empty-draft', 'draft-only', 'baseline0'] as const)('action record requirements consume accepted content only: %s', async (state) => {
  const f = fixture(undefined, 'exit 0', false, false, true);
  if (state === 'accepted-with-empty-draft') f.cards.acceptRecord('project', 'status.md', 'Accepted factual status.', { kind: 'agent', agent: 'analyst' });
  if (state === 'baseline0') f.cards.initializeRecord('project', 'status.md', () => 'Unfilled template.');
  else {
    f.cards.openRecord('project', 'status.md');
    if (state === 'draft-only') f.cards.editRecord('project', 'status.md', 'Draft is not acceptance.');
  }
  const before = f.cards.readRecordCurrent('project', 'status.md');
  if (before.kind !== 'found') throw new Error('Missing required fixture card.');
  const close = jest.spyOn(f.cards, 'closeRecord');
  const owner = await launch(f);
  await expect(owner.settlement.promise).resolves.toMatchObject({ status: state === 'accepted-with-empty-draft' ? 'blocked' : 'failed' });
  if (state === 'accepted-with-empty-draft') await expect(owner.settlement.promise).resolves.toMatchObject({ result: {
    records: [{ name: 'status.md', url: 'record:///status.md?card=project&v=1', version: 1 }],
  } });
  expect(close).not.toHaveBeenCalled();
  const after = f.cards.readRecordCurrent('project', 'status.md');
  if (after.kind !== 'found') throw new Error('Missing required fixture card.');
  expect(after.value.projection).toEqual(before.value.projection);
  expect(readCardExecutions(f.root, 'project').at(-1)).toMatchObject({ outcome: 'passed' });
});

it('retains real shell spawn failure as an engine failure without an outcome or fake spawn', async () => {
  const f = fixture(undefined, 'exit 0', false, false, false, { env: { PATH: '/nonexistent-action-test-path' } });
  const owner = await launch(f);
  await expect(owner.settlement.promise).resolves.toMatchObject({ status: 'failed', result: { kind: 'runtime-failure', summary: expect.stringContaining('no leader PID') } });
  expect(readCardExecutions(f.root, 'project').map(({ kind }) => kind)).toEqual(['invocation_started', 'invocation_finished']);
  expect(readCardExecutions(f.root, 'project').at(-1)).toMatchObject({ outcome: null, process: null, leader_exit: null });
  expect(f.provider).not.toHaveBeenCalled();
});

it('retains required operation scope settlement failure after a known successful command', async () => {
  const f = fixture();
  const failure = new Error('required operation scope join failed');
  jest.spyOn(f.processes.processRunner, 'closeAndTerminateDirectScope').mockRejectedValueOnce(failure);
  const owner = await launch(f);
  await expect(owner.settlement.promise).rejects.toBeInstanceOf(RuntimeStoppedInterruption);
  await expect(f.supervisor.stopProject()).rejects.toBe(failure);
  expect(f.supervisor.getStatus().status).toBe('error');
  expect(readCardExecutions(f.root, 'project').at(-1)).toMatchObject({ disposition: 'unavailable', outcome: null, leader_exit: { exit_code: 0 } });
});

it.each([false, true])('natural DONE hook consumes delivery and releases actual root/child lease; child=%s', async (child) => {
  const args = ['explicit hook argument', 'second-λ'];
  const f = fixture(undefined, 'exit 0', false, false, false, {}, {
    child, args, script: 'printf "<%s>\\n" "$@"',
  });
  const commit = jest.spyOn(f.cards, 'commitActivationOutcome');
  const consumers = jest.spyOn(ActivationOperationTracker.prototype, 'trackConsumer');
  const owner = await launch(f);
  await expect(owner.settlement.promise).resolves.toMatchObject({ status: 'done' });
  const id = child ? f.childId : 'project';
  const rows = readCardExecutions(f.root, id);
  expect(rows.filter((row) => row.kind === 'invocation_started')).toHaveLength(2);
  const hook = rows.find((row) => row.kind === 'invocation_started' && row.binding.kind === 'card-hook');
  if (!hook || hook.kind !== 'invocation_started') throw new Error('Missing real hook invocation.');
  const commitIndex = commit.mock.calls.findIndex(([cardId]) => cardId === id);
  expect(commitIndex).toBeGreaterThanOrEqual(0);
  const committed = commit.mock.results[commitIndex]!;
  if (committed.type !== 'return') throw new Error('Expected known successful Supervisor commit.');
  expect(committed.value.card.lifecycle.status).toBe('done');
  expect(hook).toMatchObject({ operation: 'shell.run', input: [{ name: 'args', type: 'strings', value: args }],
    binding: { status: 'done', committed_card_artifact: committed.value.artifact } });
  expect(hook.shell!.argv.slice(-args.length)).toEqual(args);
  expect(committed.value.artifact.version).toBe(f.cards.read(id)!.version_seq);
  expect(f.cards.read(id)!.lifecycle.status).toBe('done');
  const process = rows.find((row) => row.kind === 'process_started' && row.invocation_id === hook.invocation_id);
  if (!process || process.kind !== 'process_started') throw new Error('Missing real hook process.');
  const stdout = process.files.find((file) => file.kind === 'capture' && file.stream === 'stdout')!;
  expect(readFileSync(join(f.root, stdout.path), 'utf8')).toBe('<explicit hook argument>\n<second-λ>\n');
  expect(rows.at(-1)).toMatchObject({ invocation_id: hook.invocation_id, disposition: 'returned', outcome: 'passed', leader_exit: { exit_code: 0, signal: null } });
  expect(consumers).toHaveBeenCalledTimes(child ? 3 : 2);
  expect(f.supervisor.getStatus().status).toBe('stopped');
  expect((f.supervisor as unknown as { activationOwners: Map<string, CardActivationOwner> }).activationOwners.size).toBe(0);
  expect(f.processes.processRunner.list()).toEqual([]);
});

it.each([false, true])('advisory hook nonzero preserves DONE and releases root/child; child=%s', async (child) => {
  const f = fixture(undefined, 'exit 0', false, false, false, {}, { child, script: 'exit 7' });
  const owner = await launch(f);
  await expect(owner.settlement.promise).resolves.toMatchObject({ status: 'done' });
  expect(f.cards.read(child ? f.childId : 'project')!.lifecycle.status).toBe('done');
  expect(readCardExecutions(f.root, child ? f.childId : 'project').at(-1)).toMatchObject({ outcome: 'failed', values: [{ name: 'exit_code', value: 7 }] });
  expect(f.supervisor.getStatus().status).toBe('stopped');
});

it.each([false, true])('Stop retains hook owner through finite raw cleanup after process exit; failure=%s', async (failure) => {
  const exited = deferred(); let callbacks = 0;
  const cleanupError = new Error('hook raw cleanup failed');
  const definition: OperationDefinition = { id: 'acme.inspect', provider: { kind: 'plugin', name: 'acme' }, contractVersion: 1,
    bindings: ['after_activation_commit'], config: z.object({}).strict(), inputs: {}, outcomes: { finished: {} }, retainFields: [],
    async run(_config, _inputs, capabilities, signal) {
      await capabilities.command!({ script: 'exit 0', args: [], cwd: '.', env: {}, timeoutMs: 1000, terminateGraceMs: 50 }, signal);
      exited.resolve();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      await new Promise((resolve) => setTimeout(resolve, 120));
      callbacks++;
      if (failure) throw cleanupError;
      throw signal.reason;
    } };
  const f = fixture(undefined, 'exit 0', false, false, false, {}, { definition });
  const owner = await launch(f); await exited.promise;
  expect(f.cards.read('project')!.lifecycle.status).toBe('done');
  await expect(f.supervisor.cancelCard('project', 'cannot replace a natural hook winner')).rejects.toThrow("ownership is 'settling'");
  let stopped = false;
  const stop = f.supervisor.stopProject();
  const assertion = failure ? expect(stop).rejects.toBe(cleanupError) : expect(stop).resolves.toMatchObject({ contained: true });
  void stop.then(() => { stopped = true; }, () => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(stopped).toBe(false); expect(callbacks).toBe(0);
  expect((f.supervisor as unknown as { activationOwners: Map<string, CardActivationOwner> }).activationOwners.get('project')).toBe(owner);
  await assertion;
  expect(callbacks).toBe(1);
  expect(f.cards.read('project')!.lifecycle.status).toBe('done');
  const rows = readCardExecutions(f.root, 'project');
  expect(rows.at(-1)).toMatchObject({ disposition: failure ? 'unavailable' : 'cancelled', outcome: null });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(readCardExecutions(f.root, 'project')).toEqual(rows); expect(callbacks).toBe(1);
  expect(f.provider).not.toHaveBeenCalled();
});

it('Stop before hook raw entry consumes only its matching interruption without launching or appending', async () => {
  const f = fixture(undefined, 'exit 0', false, false, false, {}, { script: 'exit 0' });
  const run = ActivationOperationTracker.prototype.run; let runs = 0;
  let stop: ReturnType<typeof f.supervisor.stopProject> | undefined;
  const consumer = jest.spyOn(ActivationOperationTracker.prototype, 'trackConsumer');
  jest.spyOn(ActivationOperationTracker.prototype, 'run').mockImplementation(function (this: ActivationOperationTracker, ...args: Parameters<typeof run>) {
    const value = run.apply(this, args);
    if (++runs === 2) stop = f.supervisor.stopProject();
    return value;
  } as typeof run);
  await launch(f);
  // Wait on the actual node's finite command and Supervisor commit, not an invented hook dispatch.
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const observe = () => { if (stop) { resolve(); return; } if (Date.now() >= deadline) { reject(new Error('Hook did not enter')); return; } setTimeout(observe, 5); }; observe();
  });
  await expect(stop).resolves.toMatchObject({ contained: true });
  expect(consumer).toHaveBeenCalledTimes(2);
  expect(readCardExecutions(f.root, 'project')).toHaveLength(3);
  expect(f.cards.read('project')!.lifecycle.status).toBe('done');
});

it.each(['blocked', 'failed'] as const)('runs the selected natural %s attachment once, without recursively triggering on log writes', async (status) => {
  const f = fixture(undefined, 'exit 0', false, false, false,
    status === 'failed' ? { env: { PATH: '/no-such-bash' } } : {}, { status });
  const owner = await launch(f);
  await expect(owner.settlement.promise).resolves.toMatchObject({ status });
  const starts = readCardExecutions(f.root, 'project').filter((row) => row.kind === 'invocation_started');
  expect(starts).toHaveLength(2);
  expect(starts[1]).toMatchObject({ binding: { kind: 'card-hook', status } });
  expect(f.cards.read('project')!.lifecycle.status).toBe(status);
});

it('a required pre-DONE check fails before DONE commit and does not run the done attachment', async () => {
  const f = fixture(undefined, 'exit 6', false, false, false, {}, { requiredCheck: true });
  const commit = jest.spyOn(f.cards, 'commitActivationOutcome');
  const owner = await launch(f);
  await expect(owner.settlement.promise).resolves.toMatchObject({ status: 'blocked' });
  expect(commit.mock.calls.map((call) => call[1].status)).toEqual(['blocked']);
  expect(readCardExecutions(f.root, 'project')).toHaveLength(3);
});

it('Stop, direct status changes, record writes and stopped-chain recovery do not dispatch a card hook', async () => {
  const f = fixture(undefined, 'sleep 30', false, false, false, {}, { status: 'blocked' });
  const spawned = deferred();
  const spawn = f.processes.processRunner.spawnCaptured.bind(f.processes.processRunner);
  jest.spyOn(f.processes.processRunner, 'spawnCaptured').mockImplementation((args) => spawn({ ...args,
    onSpawn(record) { args.onSpawn(record); spawned.resolve(); } }));
  await launch(f); await spawned.promise;
  await f.supervisor.stopProject();
  const rows = readCardExecutions(f.root, 'project');
  expect(rows).toHaveLength(3);
  // A fresh Supervisor consumes the real interrupted running chain, never its log.
  const fresh = createSupervisorRuntimeApi(f.supervisorOptions);
  await fresh.start();
  expect(f.cards.read('project')!.lifecycle.status).toBe('stopped');
  f.cards.acceptRecord('project', 'status.md', 'Direct factual record update', { kind: 'agent', agent: 'analyst' });
  f.cards.setStatus('project', 'cancelled');
  expect(readCardExecutions(f.root, 'project')).toEqual(rows);
  expect(f.provider).not.toHaveBeenCalled();
});

it('fresh startup preserves a fatal lost finish and explicit Run enters STOPPED, never the logged action', async () => {
  const root = mkdtempSync(join(tmpdir(), 'action-lost-finish-'));
  cleanups.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const marker = join(root, 'marker');
  writeFileSync(marker, '');
  // The existing disposable fatal owner enters a real operation and exits before
  // cleanup, finish publication, or acknowledgement. Do not synthesize log rows.
  const fatal = spawnSync(process.execPath, ['--import', 'tsx',
    join(process.cwd(), 'tests', 'fixtures', 'publication-fatal-boundaries.ts'),
    'action-node-publication', marker], { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 });
  expect(fatal.status).toBe(1);
  expect(fatal.stdout).toBe('');
  expect(fatal.stderr).toBe('Fatal: PublicationOutcomeUnknownError; Saivage is halting because durable publication outcome is unknown.\n');
  expect(readFileSync(marker, 'utf8')).toBe('entered\n');
  const run = jest.fn<OperationDefinition['run']>(async () => {
    throw new Error('Lost invocation must not be replayed.');
  });
  const definition: OperationDefinition = { id: 'acme.inspect', provider: { kind: 'plugin', name: 'acme' }, contractVersion: 1,
    bindings: ['node'], config: z.object({}).strict(), inputs: {}, outcomes: { finished: {} }, retainFields: [], run };
  const f = fixture(definition, '', false, true, false, {}, undefined, root);
  expect(f.cards.read('project')!.lifecycle.status).toBe('running');
  const file = cardExecutionFile(root, 'project');
  const bytes = readFileSync(file);
  const rows = readCardExecutions(root, 'project');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: 'invocation_started', operation: 'acme.inspect',
    binding: { kind: 'node', node_id: 'check' }, input: [] });

  await f.supervisor.start();
  expect(f.cards.read('project')!.lifecycle.status).toBe('stopped');
  expect(f.supervisor.getStatus().status).toBe('stopped');
  expect(f.provider).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(f.processes.processRunner.list()).toEqual([]);
  expect(readFileSync(file)).toEqual(bytes);
  expect(readCardExecutions(root, 'project')).toEqual(rows);

  const owner = await launch(f);
  await expect(owner.settlement.promise).resolves.toMatchObject({ status: 'blocked',
    result: { node_id: 'plan', executor: { kind: 'agent', agent: 'planner' } } });
  expect(f.provider).toHaveBeenCalledTimes(1);
  expect(run).not.toHaveBeenCalled();
  expect(f.processes.processRunner.list()).toEqual([]);
  expect(readFileSync(file)).toEqual(bytes);
  expect(readCardExecutions(root, 'project')).toEqual(rows);
  expect(readFileSync(marker, 'utf8')).toBe('entered\n');
}, 35_000);

it('reopening an actually completed card does not dispatch another attachment', async () => {
  const f = fixture(undefined, 'exit 0', false, false, false, {}, {});
  const owner = await launch(f);
  await expect(owner.settlement.promise).resolves.toMatchObject({ status: 'done' });
  const rows = readCardExecutions(f.root, 'project');
  f.cards.setStatus('project', 'changed');
  f.cards.acceptRecord('project', 'status.md', 'Updated requirement after reopen', { kind: 'agent', agent: 'analyst' });
  expect(readCardExecutions(f.root, 'project')).toEqual(rows);
  expect(f.cards.read('project')!.lifecycle.status).toBe('changed');
});

it('known hook scope cleanup failure retains containment error without replacing committed DONE', async () => {
  const f = fixture(undefined, 'exit 0', false, false, false, {}, {});
  const close = f.processes.processRunner.closeAndTerminateDirectScope.bind(f.processes.processRunner);
  const failure = new Error('hook scope containment failed'); let calls = 0;
  jest.spyOn(f.processes.processRunner, 'closeAndTerminateDirectScope').mockImplementation(async (args) => {
    const report = await close(args);
    if (++calls === 2) throw failure;
    return report;
  });
  const owner = await launch(f);
  await expect(owner.settlement.promise).rejects.toBe(failure);
  await expect(f.supervisor.stopProject()).rejects.toBe(failure);
  expect(f.cards.read('project')!.lifecycle.status).toBe('done');
  expect(f.supervisor.getStatus().status).toBe('error');
});

it('invalid advisory return after a known plugin effect preserves DONE, with no retry', async () => {
  let effects = 0;
  const definition: OperationDefinition = { id: 'acme.inspect', provider: { kind: 'plugin', name: 'acme' }, contractVersion: 1,
    bindings: ['after_activation_commit'], config: z.object({}).strict(), inputs: {}, outcomes: { finished: {} }, retainFields: [],
    async run() { effects++; return { outcome: 'undeclared', summary: 'Not a valid verdict', values: {} }; } };
  const f = fixture(undefined, 'exit 0', false, false, false, {}, { definition });
  const owner = await launch(f);
  await expect(owner.settlement.promise).resolves.toMatchObject({ status: 'done' });
  expect(effects).toBe(1);
  expect(readCardExecutions(f.root, 'project').at(-1)).toMatchObject({ disposition: 'unavailable', outcome: null });
});

it('strict hook log failure prevents launch and retains storage failure, never advisory success', async () => {
  const f = fixture(undefined, 'exit 0', false, false, false, {}, {});
  const commit = f.cards.commitActivationOutcome.bind(f.cards);
  jest.spyOn(f.cards, 'commitActivationOutcome').mockImplementation((...args) => {
    const committed = commit(...args);
    appendFileSync(cardExecutionFile(f.root, 'project'), '{"version":999,"type":"card-execution","rows":[]}\n');
    return committed;
  });
  const spawn = jest.spyOn(f.processes.processRunner, 'spawnCaptured');
  const owner = await launch(f);
  await expect(owner.settlement.promise).rejects.toBeInstanceOf(Error);
  await expect(f.supervisor.stopProject()).rejects.toBeInstanceOf(Error);
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(f.cards.read('project')!.lifecycle.status).toBe('done');
  expect(f.supervisor.getStatus().status).toBe('error');
});
