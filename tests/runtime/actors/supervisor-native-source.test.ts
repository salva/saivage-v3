import { afterEach, expect, test, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createSupervisorRuntimeApi } from '../../../src/runtime/actors/supervisor-runtime-api.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import { NO_FRESHNESS_EFFECTS } from '../../../src/contracts/index.js';
import { CardService, initProjectTree, TEST_RUNTIME_WORKFLOWS } from '../../helpers/canonical-project.js';
import { cleanupTestProcessRunners, createTestProcessRunner } from '../../helpers/test-process-runner.js';
import { createTestPromptTemplateRegistry } from '../../helpers/prompt-template-registry.js';
import { scriptedAdmissionProvider, testAutonomousCompaction } from '../../helpers/llm-test-helpers.js';
import { testApplicationFatalPort } from '../../helpers/test-application-fatal-port.js';
import { nativeGitRefs } from '../../../src/runtime/git-workflow.js';
import { readCardExecutions } from '../../../src/persistence/card-execution-log.js';
import type { GitWorkflowPolicy } from '../../../src/runtime/card-process/card-process-config.js';
import { createObservedCollections } from '../../../src/retrieval/index.js';

const roots: string[] = [];
const identity = { GIT_AUTHOR_NAME: 'Native Supervisor', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Native Supervisor', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
const prior = Object.fromEntries(Object.keys(identity).map(key => [key, process.env[key]]));
afterEach(async () => {
  for (const root of roots.splice(0)) await cleanupTestProcessRunners(root);
  for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value;
});
function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, env: { ...process.env, ...identity }, encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) throw new Error(`Fixture Git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function fixture() {
  Object.assign(process.env, identity);
  const root = mkdtempSync(join(tmpdir(), 'native-source-')); roots.push(root);
  git(root, 'init', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), '.saivage/\n');
  writeFileSync(join(root, 'source.txt'), 'delivery source\n');
  git(root, 'add', '--all'); git(root, 'commit', '-m', 'fixture delivery');
  const tip = git(root, 'rev-parse', 'HEAD');
  initProjectTree(root);
  const store = new CardService(root);
  const namespace = 'refs/saivage/supervisor';
  const branch = nativeGitRefs({ namespace, card_id: 'project' }, randomUUID()).branch_ref;
  git(root, 'branch', branch.slice('refs/heads/'.length));
  store.publishGitFacts('project', { kind: 'root', policy_digest: 'a'.repeat(64), branch_ref: branch,
    observed_tip: tip, base_oid: tip, parent: { branch_ref: 'refs/heads/main', observed_tip: tip },
    candidate: null, last_delivery: null, correction: null });
  // Source-owner integration fixture only: commissioning/compiler ON remain closed.
  const gitPolicy = { enabled: true, format_version: 1, delivery_branch: 'main', private_ref_namespace: namespace,
    source_roots: ['.'], excluded_paths: ['.git', '.saivage', 'excluded'], integration: 'squash',
    preservation: { source_checkpoint: 'eligible-worktree', interrupted_rebase: 'preserve-source-before-abort' },
    correction: { agent: 'executor', prompt: { reference: 'unused', compactable: true }, correction_prompt: { reference: 'unused', compactable: true } },
    review_bindings: {} } as GitWorkflowPolicy;
  return { root, store, tip, branch, workflows: { ...TEST_RUNTIME_WORKFLOWS, gitPolicy }, processes: createTestProcessRunner(root) };
}

test('real public Run enters root source and provider failure returns source before FAILED publication', async () => {
  const f = fixture();
  let stopped!: () => void;
  const settled = new Promise<void>(resolve => { stopped = resolve; });
  let calls = 0;
  const supervisor = createSupervisorRuntimeApi({ ...testAutonomousCompaction, workflows: f.workflows,
    retrieval: createObservedCollections(f.root),
    projectRoot: f.root, actorStore: f.store, conversations: { projectRoot: f.root }, runtimeGate: new RuntimeGate(),
    processRunner: f.processes.processRunner, runtimeProcessRootScope: f.processes.runtimeProcessRootScope,
    processIdentity: { pid: 1, startedAt: '2026-10-26T00:00:00.000Z' },
    promptTemplates: createTestPromptTemplateRegistry(), fatalPort: testApplicationFatalPort,
    freshness: NO_FRESHNESS_EFFECTS, runtimeStatusChanged: status => { if (status === 'stopped' && calls) stopped(); },
    provider: scriptedAdmissionProvider(async () => {
      calls++;
      expect(git(f.root, 'symbolic-ref', 'HEAD')).toBe(f.branch);
      writeFileSync(join(f.root, 'source.txt'), 'unfinished root work\n');
      throw new Error('synthetic provider failure');
    }) });
  try {
    expect((await supervisor.startProject()).started).toBe(true);
    await settled;
    expect(calls).toBe(1);
    expect(git(f.root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(readFileSync(join(f.root, 'source.txt'), 'utf8')).toBe('delivery source\n');
    const card = f.store.read('project')!;
    expect(card.lifecycle.status).toBe('failed');
    expect(git(f.root, 'show', `${card.git!.observed_tip}:source.txt`)).toBe('unfinished root work');
    expect(card.git!.observed_tip).not.toBe(f.tip);
    expect(readCardExecutions(f.root, 'project').filter(row => row.kind === 'native_finished').map(row => row.outcome))
      .toEqual(['entered', 'returned']);
  } finally { await supervisor.cleanupForApplicationStop(); }
}, 120000);

test('parent checkpoint precedes child admission and failed child returns actual parent before its lease resumes', async () => {
  const f = fixture();
  const child = f.store.create({ type: 'code', parent: 'project', title: 'Native child', bootstrap_content: 'Scoped work',
    priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
  let stopped!: () => void;
  const settled = new Promise<void>(resolve => { stopped = resolve; });
  let rootCalls = 0, childCalls = 0;
  const supervisor = createSupervisorRuntimeApi({ ...testAutonomousCompaction, workflows: f.workflows,
    retrieval: createObservedCollections(f.root), projectRoot: f.root, actorStore: f.store,
    conversations: { projectRoot: f.root }, runtimeGate: new RuntimeGate(),
    processRunner: f.processes.processRunner, runtimeProcessRootScope: f.processes.runtimeProcessRootScope,
    processIdentity: { pid: 1, startedAt: '2026-10-26T00:00:00.000Z' },
    promptTemplates: createTestPromptTemplateRegistry(), fatalPort: testApplicationFatalPort,
    freshness: NO_FRESHNESS_EFFECTS, runtimeStatusChanged: status => { if (status === 'stopped' && rootCalls) stopped(); },
    provider: scriptedAdmissionProvider(async input => {
      if (input.sessionId === 'agent:planner:project') {
        rootCalls++;
        if (rootCalls === 1) {
          writeFileSync(join(f.root, 'source.txt'), 'parent remainder\n');
          return { result: { kind: 'tool_calls', tool_calls: [{ id: 'native-child', type: 'function',
            function: { name: 'activate_card', arguments: JSON.stringify({ card_id: child.id, instructions: 'Bounded child work.' }) } }] },
            provider_exchanges: [] };
        }
        expect(f.store.read(child.id)!.lifecycle.status).toBe('failed');
        expect(git(f.root, 'symbolic-ref', 'HEAD')).toBe(f.branch);
        expect(readFileSync(join(f.root, 'source.txt'), 'utf8')).toBe('parent remainder\n');
        expect(git(f.root, 'status', '--porcelain')).toBe('');
        throw new Error('finish parent fixture');
      }
      childCalls++;
      const current = f.store.read(child.id)!;
      expect(current.lifecycle.status).toBe('running');
      expect(current.git!.parent.observed_tip).toBe(f.store.read('project')!.git!.observed_tip);
      expect(current.git!.base_oid).not.toBe(f.tip);
      expect(git(f.root, 'symbolic-ref', 'HEAD')).toBe(current.git!.branch_ref);
      writeFileSync(join(f.root, 'source.txt'), 'unfinished child work\n');
      throw new Error('synthetic child provider failure');
    }) });
  try {
    await supervisor.startProject();
    await settled;
    expect(rootCalls).toBe(2); expect(childCalls).toBe(1);
    const current = f.store.read(child.id)!;
    expect(git(f.root, 'show', `${current.git!.observed_tip}:source.txt`)).toBe('unfinished child work');
    expect(git(f.root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(readCardExecutions(f.root, child.id).filter(row => row.kind === 'native_finished').map(row => row.outcome))
      .toEqual(['entered', 'returned']);
  } finally { await supervisor.cleanupForApplicationStop(); }
}, 180000);

test('Stop takes over the saved real native command settlement before root provider admission', async () => {
  const f = fixture();
  let stop: Promise<unknown> | undefined;
  let calls = 0;
  const supervisor = createSupervisorRuntimeApi({ ...testAutonomousCompaction, workflows: f.workflows,
    retrieval: createObservedCollections(f.root), projectRoot: f.root, actorStore: f.store,
    conversations: { projectRoot: f.root }, runtimeGate: new RuntimeGate(),
    processRunner: f.processes.processRunner, runtimeProcessRootScope: f.processes.runtimeProcessRootScope,
    processIdentity: { pid: 1, startedAt: '2026-10-26T00:00:00.000Z' },
    promptTemplates: createTestPromptTemplateRegistry(), fatalPort: testApplicationFatalPort, freshness: NO_FRESHNESS_EFFECTS,
    provider: scriptedAdmissionProvider(async () => { calls++; throw new Error('Provider must not be admitted.'); }) });
  const spawn = f.processes.processRunner.spawnCaptured.bind(f.processes.processRunner);
  const commands: readonly string[][] = [];
  const trace = commands as string[][];
  jest.spyOn(f.processes.processRunner, 'spawnCaptured').mockImplementation(spec => {
    trace.push([...spec.args]);
    return spawn({ ...spec, onSpawn(record) {
      spec.onSpawn(record);
      if (spec.args[0] === 'switch') stop = supervisor.stopProject();
    } });
  });
  try {
    await expect(supervisor.startProject()).rejects.toThrow(/stopped/);
    expect(stop).toBeDefined(); await stop;
    expect(calls).toBe(0);
    expect(trace.at(-1)?.[0]).toBe('switch');
    expect(supervisor.getStatus().status).toBe('stopped');
    expect(f.processes.processRunner.list()).toEqual([]);
    expect(f.store.read('project')!.lifecycle.status).toBe('backlog');
  } finally { await supervisor.cleanupForApplicationStop(); }
}, 120000);

test.each(['cancel', 'urgent-root', 'urgent-held'] as const)('%s joins native source leaf-to-root before continuation', async mode => {
  const f = fixture();
  const child = f.store.create({ type: 'code', parent: 'project', title: 'Interrupted native child', bootstrap_content: 'Scoped work',
    priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
  let entered!: () => void, resumed!: () => void;
  const active = new Promise<void>(resolve => { entered = resolve; });
  const continuation = new Promise<void>(resolve => { resumed = resolve; });
  let rootCalls = 0;
  const wait = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const supervisor = createSupervisorRuntimeApi({ ...testAutonomousCompaction, workflows: f.workflows,
    retrieval: createObservedCollections(f.root), projectRoot: f.root, actorStore: f.store,
    conversations: { projectRoot: f.root }, runtimeGate: new RuntimeGate(),
    processRunner: f.processes.processRunner, runtimeProcessRootScope: f.processes.runtimeProcessRootScope,
    processIdentity: { pid: 1, startedAt: '2026-10-26T00:00:00.000Z' },
    promptTemplates: createTestPromptTemplateRegistry(), fatalPort: testApplicationFatalPort, freshness: NO_FRESHNESS_EFFECTS,
    provider: scriptedAdmissionProvider(async (input, signal) => {
      if (input.sessionId === 'agent:planner:project') {
        rootCalls++;
        if (rootCalls === 1) {
          writeFileSync(join(f.root, 'source.txt'), 'parent remainder\n');
          return { result: { kind: 'tool_calls', tool_calls: [{ id: 'interrupted-native-child', type: 'function',
            function: { name: 'activate_card', arguments: JSON.stringify({ card_id: child.id, instructions: 'Scoped child.' }) } }] }, provider_exchanges: [] };
        }
        expect(git(f.root, 'symbolic-ref', 'HEAD')).toBe(f.branch);
        expect(readFileSync(join(f.root, 'source.txt'), 'utf8')).toBe('parent remainder\n');
        resumed(); return wait(signal);
      }
      writeFileSync(join(f.root, 'source.txt'), 'interrupted child bytes\n');
      if (mode === 'urgent-held') {
        mkdirSync(join(f.root, 'excluded')); writeFileSync(join(f.root, 'excluded/data'), 'uncaptured source');
      }
      entered(); return wait(signal);
    }) });
  try {
    await supervisor.startProject(); await active;
    if (mode === 'cancel') await supervisor.cancelCard(child.id, 'fixture cancellation');
    else {
      const result = await supervisor.submitNotification('project', { id: randomUUID(), content: 'Reconsider current work',
        created_at: new Date().toISOString(), source: 'fixture' }, 'urgent');
      expect(result).toMatchObject({ queued: true, interruption: mode === 'urgent-held'
        ? { status: 'suppressed', reason: 'runtime_ineligible', stopped_card_ids: [] }
        : { status: 'interrupted', stopped_card_ids: [child.id, 'project'] } });
      if (mode === 'urgent-held') {
        // Held-source halt may retain the interrupted actor's rejected join;
        // this is fail-closed runtime error, not a successful source return.
        await supervisor.stopProject().catch(error => { expect(String(error)).toMatch(/stopped/); });
        expect(rootCalls).toBe(1);
        expect(readFileSync(join(f.root, 'excluded/data'), 'utf8')).toBe('uncaptured source');
        expect(f.store.read(child.id)!.lifecycle.status).toBe('running');
        expect(readCardExecutions(f.root, child.id).some(row => row.kind === 'native_finished' && row.outcome === 'returned')).toBe(false);
        expect(f.processes.processRunner.list()).toEqual([]);
        return;
      }
    }
    await continuation;
    expect(f.store.read(child.id)!.lifecycle.status).toBe(mode === 'cancel' ? 'cancelled' : 'stopped');
    const facts = f.store.read(child.id)!.git!;
    expect(git(f.root, 'show', `${facts.observed_tip}:source.txt`)).toBe('interrupted child bytes');
    expect(readCardExecutions(f.root, child.id).filter(row => row.kind === 'native_finished' && row.outcome === 'returned')).toHaveLength(1);
    const rootReturns = readCardExecutions(f.root, 'project').filter(row => row.kind === 'native_finished' && row.outcome === 'returned');
    expect(rootReturns).toHaveLength(mode === 'urgent-root' ? 1 : 0);
  } finally {
    if (mode === 'urgent-held') {
      await supervisor.stopProject().catch(error => { expect(String(error)).toMatch(/stopped/); });
      await supervisor.cleanupForApplicationStop().catch(error => {
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe('Runtime application cleanup failed.');
        expect(String(error.cause)).toMatch(/stopped/);
      });
    } else { await supervisor.stopProject(); await supervisor.cleanupForApplicationStop(); }
  }
}, 180000);
