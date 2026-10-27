import { afterEach, expect, jest, test } from '@jest/globals';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createSupervisorRuntimeApi } from '../../../src/runtime/actors/supervisor-runtime-api.js';
import { ConversationLLMActor } from '../../../src/runtime/actors/llm-actor.js';
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
const identity = { GIT_AUTHOR_NAME: 'Acceptance fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Acceptance fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
const prior = Object.fromEntries(Object.keys(identity).map(key => [key, process.env[key]]));
afterEach(async () => {
  jest.restoreAllMocks();
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
  const parent = '/home/salva/g/ml/tmp/2026-10-25-native-hybrid-git-attempt5-acceptance';
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'source-')); roots.push(root);
  git(root, 'init', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), '.saivage/\n'); writeFileSync(join(root, 'source.txt'), 'delivery\n');
  git(root, 'add', '--all'); git(root, 'commit', '-m', 'fixture delivery');
  const tip = git(root, 'rev-parse', 'HEAD'); initProjectTree(root);
  const store = new CardService(root);
  const namespace = 'refs/saivage/acceptance';
  const branch = nativeGitRefs({ namespace, card_id: 'project' }, randomUUID()).branch_ref;
  git(root, 'branch', branch.slice('refs/heads/'.length));
  store.publishGitFacts('project', { kind: 'root', policy_digest: 'a'.repeat(64), branch_ref: branch, observed_tip: tip, base_oid: tip,
    parent: { branch_ref: 'refs/heads/main', observed_tip: tip }, candidate: null, last_delivery: null, correction: null });
  const gitPolicy: GitWorkflowPolicy = { enabled: true, format_version: 1, delivery_branch: 'main', private_ref_namespace: namespace,
    source_roots: ['.'], excluded_paths: ['.git', '.saivage'], integration: 'squash',
    preservation: { source_checkpoint: 'eligible-worktree', interrupted_rebase: 'preserve-source-before-abort' },
    correction: { agent: 'executor', prompt: { reference: 'unused', compactable: true }, correction_prompt: { reference: 'unused', compactable: true } },
    review_bindings: Object.fromEntries([...TEST_RUNTIME_WORKFLOWS.cardTypes].map(([type, workflow]) => [type, workflow.states.has('node:review') ? { node: 'review', approved_outcome: 'approved' } : null])) };
  return { root, store, tip, branch, workflows: { ...TEST_RUNTIME_WORKFLOWS, gitPolicy }, processes: createTestProcessRunner(root) };
}
function call(id: string, name: string, args: object) {
  return { result: { kind: 'tool_calls' as const, tool_calls: [{ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] }, provider_exchanges: [] };
}

test.each(['direct', 'reviewed', 'handler', 'no-change'] as const)('%s delivers real leaf/aggregate/root source before DONE with correct promotion', async mode => {
  const f = fixture();
  const goal = f.store.create({ type: 'goal', parent: 'project', title: 'Aggregate', bootstrap_content: 'Scoped aggregate', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
  const leaf = f.store.create({ type: 'code', parent: goal.id, title: 'Leaf', bootstrap_content: 'Scoped leaf', priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [] });
  const counts = new Map<string, number>();
  const reviewed = mode === 'reviewed' || mode === 'handler';
  let finish!: () => void, running = false, queued = false, staleApprovalRejected = false;
  const stopped = new Promise<void>(resolve => { finish = resolve; });
  const supervisor = createSupervisorRuntimeApi({ ...testAutonomousCompaction, workflows: f.workflows,
    retrieval: createObservedCollections(f.root), projectRoot: f.root, actorStore: f.store, conversations: { projectRoot: f.root }, runtimeGate: new RuntimeGate(),
    processRunner: f.processes.processRunner, runtimeProcessRootScope: f.processes.runtimeProcessRootScope,
    processIdentity: { pid: 1, startedAt: '2026-10-26T00:00:00.000Z' }, promptTemplates: createTestPromptTemplateRegistry(), fatalPort: testApplicationFatalPort,
    freshness: NO_FRESHNESS_EFFECTS, runtimeStatusChanged: status => { if (status === 'running') running = true; if (status === 'stopped' && running) finish(); },
    provider: scriptedAdmissionProvider(async input => {
      if (input.providerConversation.messages.some(message => message.kind === 'tool_result' && message.tool_call_id === `${goal.id}:review-2` && JSON.parse(message.content).success === false)) staleApprovalRejected = true;
      const block = input.providerConversation.messages.find(message => message.kind === 'synthetic_context' && message.block_identity.startsWith('node-activation:'));
      if (!block || block.kind !== 'synthetic_context') throw new Error('Missing actual prepared node.');
      const [, card, node] = block.block_identity.split(':');
      const key = `${card}:${node}`, n = (counts.get(key) ?? 0) + 1; counts.set(key, n);
      const id = `${key}-${n}`;
      if (node === 'plan' && n === 1) {
        if (mode !== 'no-change') writeFileSync(join(f.root, `${card}.txt`), `${card} remainder\n`);
        return call(id, 'activate_card', { card_id: card === 'project' ? goal.id : leaf.id, instructions: 'Complete the scoped work.' });
      }
      if (node === 'execute' && n === 1 && mode !== 'no-change') writeFileSync(join(f.root, 'leaf.txt'), 'leaf source\n');
      if (node === 'review') {
        expect(f.store.read(card!)!.git!.candidate).not.toBeNull();
        if (n % 2 === 1) return call(id, 'write', { path: `record:///review.md?card=${card}`, content: `Independent ${card} review ${n}` });
        if (mode === 'handler' && card === goal.id && !queued) {
          queued = true; expect(supervisor.notifyCard(goal.id, { id: randomUUID(), content: 'Reconsider before delivery.', source: 'fixture', created_at: new Date().toISOString() }).ok).toBe(true);
        }
        return call(id, 'emit_result', { outcome: 'approved', summary: `Independent ${card} approval` });
      }
      const writes = node === 'plan' ? n === 2 : n % 2 === 1;
      if (writes) return call(id, 'write', { path: `record:///status.md?card=${card}`, content: `Closing ${card}/${node} status ${n}` });
      const outcome = node === 'execute' ? 'done' : node === 'plan'
        ? card === 'project' ? 'assess_completion' : reviewed ? 'admit_review' : 'complete_direct'
        : node === 'handle-notifications' ? 'admit_review'
        : reviewed ? n === 2 ? 'admit_review' : 'complete_reviewed' : 'complete_direct';
      return call(id, 'emit_result', { outcome, summary: `Closing ${card}/${node} summary` });
    }) });
  const commit = f.store.commitActivationOutcome.bind(f.store);
  const committed: string[] = [];
  jest.spyOn(f.store, 'commitActivationOutcome').mockImplementation((id, outcome, at) => {
    if (outcome.status === 'done') {
      const facts = f.store.read(id)!.git!;
      expect(facts.last_delivery).not.toBeNull();
      expect(git(f.root, 'symbolic-ref', 'HEAD')).toBe(facts.parent.branch_ref);
      expect(git(f.root, 'rev-parse', 'HEAD')).toBe(facts.last_delivery!.parent_after);
      expect(git(f.root, 'status', '--porcelain')).toBe('');
      committed.push(id);
    }
    return commit(id, outcome, at);
  });
  try {
    await supervisor.startProject(); await stopped;
    expect(committed).toEqual([leaf.id, goal.id, 'project']);
    const root = f.store.read('project')!;
    expect(root.lifecycle.status).toBe('done');
    expect(root.lifecycle.result).toMatchObject({ kind: 'workflow-result', executor: { kind: 'agent', agent: reviewed ? 'reviewer' : 'planner' },
      summary: reviewed ? 'Independent project approval' : 'Closing project/assess-completion summary', records: [{ name: 'status.md' }] });
    expect(git(f.root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    if (mode === 'no-change') expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.tip);
    else for (const path of ['project.txt', `${goal.id}.txt`, 'leaf.txt']) expect(readFileSync(join(f.root, path), 'utf8')).not.toBe('');
    if (mode === 'handler') {
      expect(staleApprovalRejected).toBe(true);
      expect(counts.get(`${goal.id}:handle-notifications`)).toBe(2);
      expect(counts.get(`${goal.id}:review`)).toBe(6);
    }
    for (const id of [leaf.id, goal.id, 'project']) expect(readCardExecutions(f.root, id).filter(row => row.kind === 'native_finished' && row.outcome === 'delivered')).toHaveLength(1);
  } finally { await supervisor.cleanupForApplicationStop(); }
}, 240000);

test.each(['record', 'notification', 'descendant', 'interruption', 'dirty-reviewed', 'dirty-emitted'] as const)(
  '%s invalidates acceptance at the actual native await/delivery frontier', async mode => {
    const f = fixture();
    const counts = new Map<string, number>();
    let running = false, finish!: () => void, injected = false, rejected = false, terminalClosed = false;
    let halt: Promise<unknown> | undefined;
    const stopped = new Promise<void>(resolve => { finish = resolve; });
    const supervisor = createSupervisorRuntimeApi({ ...testAutonomousCompaction, workflows: f.workflows,
      retrieval: createObservedCollections(f.root), projectRoot: f.root, actorStore: f.store, conversations: { projectRoot: f.root }, runtimeGate: new RuntimeGate(),
      processRunner: f.processes.processRunner, runtimeProcessRootScope: f.processes.runtimeProcessRootScope,
      processIdentity: { pid: 1, startedAt: '2026-10-26T00:00:00.000Z' }, promptTemplates: createTestPromptTemplateRegistry(), fatalPort: testApplicationFatalPort,
      freshness: NO_FRESHNESS_EFFECTS, runtimeStatusChanged: status => { if (status === 'running') running = true; if (status === 'stopped' && running) finish(); },
      provider: scriptedAdmissionProvider(async input => {
        const block = input.providerConversation.messages.find(message => message.kind === 'synthetic_context' && message.block_identity.startsWith('node-activation:'));
        if (!block || block.kind !== 'synthetic_context') throw new Error('Missing prepared node.');
        const node = block.block_identity.split(':')[2]!;
        const n = (counts.get(node) ?? 0) + 1; counts.set(node, n);
        const id = `${node}-${n}`;
        const failed = input.providerConversation.messages.find(message => message.kind === 'tool_result' && message.tool_call_id === 'assess-completion-' + (mode === 'dirty-reviewed' ? '4' : '2') && JSON.parse(message.content).success === false);
        if (failed) {
          rejected = true;
          if (mode === 'notification') expect(JSON.stringify(input.providerConversation)).toContain('Fresh await notification');
          return call(id, 'emit_result', { outcome: 'blocked', summary: 'Fresh acceptance invalidated.' });
        }
        if (node === 'review') return n === 1
          ? call(id, 'write', { path: 'record:///review.md?card=project', content: 'Independent source review' })
          : call(id, 'emit_result', { outcome: 'approved', summary: 'Reviewed exact source' });
        if (n % 2 === 1) {
          if (node === 'assess-completion' && n === 3 && mode === 'dirty-reviewed') {
            writeFileSync(join(f.root, 'later.txt'), 'not reviewed\n'); injected = true;
          }
          return call(id, 'write', { path: 'record:///status.md?card=project', content: `${node} current status ${n}` });
        }
        return call(id, 'emit_result', { outcome: node === 'plan' ? 'assess_completion' : mode === 'dirty-reviewed' ? n === 2 ? 'admit_review' : 'complete_reviewed' : 'complete_direct', summary: 'Tentative completion' });
      }) });
    const publish = f.store.publishGitFacts.bind(f.store);
    jest.spyOn(f.store, 'publishGitFacts').mockImplementation((id, facts) => {
      const result = publish(id, facts);
      if (facts.candidate && !injected && ['record', 'notification', 'descendant', 'interruption'].includes(mode)) {
        injected = true;
        if (mode === 'record') f.store.editRecord('project', 'status.md', 'Changed while native preparation was awaited');
        if (mode === 'notification') expect(supervisor.notifyCard('project', { id: randomUUID(), content: 'Fresh await notification', source: 'fixture', created_at: new Date().toISOString() }).ok).toBe(true);
        if (mode === 'descendant') f.store.create({ type: 'goal', parent: 'project', title: 'Incomplete descendant', bootstrap_content: 'Still required', priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [] });
        if (mode === 'interruption') halt = supervisor.stopProject().catch(error => { expect(String(error)).toMatch(/stopped/); });
      }
      return result;
    });
    const closeRecord = f.store.closeRecord.bind(f.store);
    jest.spyOn(f.store, 'closeRecord').mockImplementation((...args) => {
      const result = closeRecord(...args);
      if (f.store.read('project')!.git!.candidate) terminalClosed = true;
      return result;
    });
    const settle = ConversationLLMActor.prototype.settleToolResultWithoutContinuation;
    jest.spyOn(ConversationLLMActor.prototype, 'settleToolResultWithoutContinuation').mockImplementation(async function (this: ConversationLLMActor, ...args) {
      const result = await settle.apply(this, args);
      if (mode === 'dirty-emitted' && args[0] === 'assess-completion-2' && terminalClosed && !injected) {
        injected = true; writeFileSync(join(f.root, 'later.txt'), 'after accepted emission\n');
      }
      return result;
    });
    try {
      await supervisor.startProject(); await stopped;
      expect(injected).toBe(true);
      expect(f.store.read('project')!.lifecycle.status).not.toBe('done');
      expect(git(f.root, 'rev-parse', 'refs/heads/main')).toBe(f.tip);
      const executions = readCardExecutions(f.root, 'project');
      expect(executions.filter(row => row.kind === 'native_finished' && row.outcome === 'delivered')).toHaveLength(0);
      if (mode === 'dirty-emitted') {
        expect(terminalClosed).toBe(true);
        expect(git(f.root, 'symbolic-ref', 'HEAD')).toBe(f.branch);
        expect(readFileSync(join(f.root, 'later.txt'), 'utf8')).toBe('after accepted emission\n');
      } else if (mode === 'interruption') {
        await halt;
        expect(terminalClosed).toBe(false);
        expect(counts.get('assess-completion')).toBe(2);
      } else {
        expect(rejected).toBe(true);
        expect(f.store.read('project')!.lifecycle.status).toBe('blocked');
        expect(git(f.root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
      }
    } finally {
      if (mode === 'dirty-emitted' || mode === 'interruption') {
        await supervisor.cleanupForApplicationStop().catch(error => {
          expect(String(error)).toMatch(/Runtime application cleanup failed/);
        });
      } else await supervisor.cleanupForApplicationStop();
    }
  }, 180000);
