import { expect } from 'expect';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { nativeIdentity, nativeOptions, publicNativeCli, publicNativeProject, fixtureGit } from '../helpers/public-native-project.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { compileProjectWorkflows, bindRuntimeWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { ModelRouter } from '../../src/agents/model-router.js';
import { CardService } from '../../src/cards/card-service.js';
import { NO_FRESHNESS_EFFECTS } from '../../src/contracts/index.js';
import { createSupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import { createObservedCollections } from '../../src/retrieval/index.js';
import { RuntimeGate } from '../../src/runtime/runtime-gate.js';
import { createPromptTemplateRegistry } from '../../src/utils/prompt-api.js';
import { createTestProcessRunner, cleanupTestProcessRunners } from '../helpers/test-process-runner.js';
import { scriptedAdmissionProvider, testAutonomousCompaction } from '../helpers/llm-test-helpers.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import type { PreparedLlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { cardAgentSessionId } from '../../src/schemas/conversation-session-id.js';
import { NodeExecution } from '../../src/runtime/actors/node-execution.js';
import { randomUUID } from 'node:crypto';
import { readCardExecutions } from '../../src/persistence/card-execution-log.js';

type Call = { name: string; args: object };
type EffectiveSaivageConfig = ReturnType<typeof effectiveSaivageConfigSchema.parse>;
// Test-only stage receipts survive a parent timeout without dumping prompts,
// environments or provider configuration. stdout remains the success contract.
const diagnosticStart = performance.now();
function stage(name: string, detail: object = {}) {
  process.stderr.write(`${JSON.stringify({ stage: name, elapsed_ms: Math.round(performance.now() - diagnosticStart), ...detail })}\n`);
}
stage('entry');
const call = (name: string, args: object): Call => ({ name, args });
const write = (card: string, record: string, content: string) => call('write', { path: `record:///${record}?card=${card}`, content });
const emit = (outcome: string) => call('emit_result', { outcome, summary: `Bounded fixture ${outcome}` });
const activate = () => call('activate_card', { card_id: 'card-a', instructions: 'Use the current accepted assignment and retain actual evidence.' });
const create = () => call('create_card', { type: 'code', title: 'Same child', bootstrap_content: 'Original bounded requirement', priority: 0, urgency: 'normal', depends_on: [] });

// Commission the actual selected bundle and dispatch every model call through its
// admitted tool/actor surface. No handcrafted accepted result or native-source port.
async function run(native: boolean, configure: (config: EffectiveSaivageConfig) => void,
  script: (input: PreparedLlmInvocationInput, cards: CardService, root: string) => Call | Promise<Call>,
  options: { resumeStopped?: boolean; observe?: (supervisor: ReturnType<typeof createSupervisorRuntimeApi>, cards: CardService, root: string) => () => void } = {}) {
  const root = publicNativeProject();
  stage('project-created', { root });
  const init = publicNativeCli(root, 'init', ...(native ? nativeOptions : ['--profile', 'classic']));
  stage('cli-init-returned', { status: init.status, error: init.error?.message });
  if (init.status !== 0) throw new Error(init.stderr);
  const config = effectiveSaivageConfigSchema.parse(parse(readFileSync(join(root, '.saivage/saivage.yaml'), 'utf8')));
  config.models = structuredClone(TEST_SAIVAGE_CONFIG.models);
  config.providers = structuredClone(TEST_SAIVAGE_CONFIG.providers);
  config.compaction = structuredClone(TEST_SAIVAGE_CONFIG.compaction);
  for (const agent of Object.values(config.agents)) agent.capabilities.grants = agent.capabilities.grants
    .map(grant => ({ ...grant, tools: grant.tools.filter(tool => tool !== 'view_image') })).filter(grant => grant.tools.length);
  configure(config);
  const compiled = compileProjectWorkflows(config, { projectRoot: root });
  const registry = new ProviderRegistry(config);
  const workflows = bindRuntimeWorkflows(compiled, new ModelRouter(registry), registry, config.compaction.context_utilization_fraction, { internalAnalystEnabled: true });
  stage('workflows-bound');
  const cards = new CardService(root, compiled, NO_FRESHNESS_EFFECTS);
  const processes = createTestProcessRunner(root);
  const prior = Object.fromEntries(Object.keys(nativeIdentity).map(key => [key, process.env[key]]));
  Object.assign(process.env, nativeIdentity);
  let error: unknown, turns = 0, started = false, finish!: () => void;
  const trace: string[] = [];
  let stopped = new Promise<void>(resolve => { finish = resolve; });
  let stopping: Promise<unknown> | undefined;
  const supervisor = createSupervisorRuntimeApi({ ...testAutonomousCompaction, workflows, projectRoot: root,
    actorStore: cards, conversations: { projectRoot: root }, retrieval: createObservedCollections(root), runtimeGate: new RuntimeGate(),
    processRunner: processes.processRunner, runtimeProcessRootScope: processes.runtimeProcessRootScope,
    promptTemplates: createPromptTemplateRegistry(workflows), fatalPort: testApplicationFatalPort, freshness: NO_FRESHNESS_EFFECTS,
    runtimeStatusChanged: status => { if (status === 'running') started = true; if (status === 'stopped' && started) finish(); },
    provider: scriptedAdmissionProvider<PreparedLlmInvocationInput>(async (input, signal) => {
      try {
        if (++turns > 65) throw new Error('Script exceeded its finite action sequence');
        const next = await script(input, cards, root);
        stage('script-call', { turn: turns, agent: input.agentName, tool: next.name });
        trace.push(`${input.agentName}:${next.name}:${JSON.stringify(next.args)}`);
        if (next.name === 'fixture-operator-stop') {
          queueMicrotask(() => { stopping = supervisor.stopProject(); });
          return await new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        }
        return { result: { kind: 'tool_calls', tool_calls: [{ id: `public-${turns}`, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, provider_exchanges: [] };
      } catch (failure) { error = failure; throw failure; }
    }),
  });
  const restore = options.observe?.(supervisor, cards, root);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    stage('start-project');
    expect((await supervisor.startProject()).started).toBe(true);
    stage('start-project-returned');
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Public assignment flow did not settle: ${String(error)}; ${root}; ${JSON.stringify(trace)}; ${JSON.stringify(supervisor.getStatus())}`)), 50000); });
    await Promise.race([stopped, deadline]);
    stage('scenario-stopped');
    if (options.resumeStopped) {
      await stopping;
      // Ordinary Stop contains owners; the next explicit Run owns canonical
      // leaf-to-root settlement before fresh root recovery activation.
      expect(cards.read('project')!.lifecycle.status).toBe('running');
      expect(cards.read('card-a')!.lifecycle.status).toBe('running');
      error = undefined; // The held provider was deliberately cancelled by Stop.
      stopped = new Promise<void>(resolve => { finish = resolve; });
      if (native) {
        // Native Stop deliberately promises containment, not checkout cleanup.
        // Preserve strict refusal rather than inventing a source-return repair.
        const before = turns;
        await expect(supervisor.startProject()).rejects.toThrow('Selected branch does not match its owner');
        expect(turns).toBe(before);
      } else {
        expect((await supervisor.startProject()).started).toBe(true);
        await Promise.race([stopped, deadline]);
      }
    }
    if (error) throw error;
    return { cards, root, turns };
  } finally {
    clearTimeout(timer);
    stage('supervisor-cleanup');
    await supervisor.cleanupForApplicationStop();
    stage('process-cleanup');
    await cleanupTestProcessRunners(root);
    stage('cleanup-complete');
    restore?.();
    for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
}

function accepted(cards: CardService, card: string, name: string) {
  const current = cards.readRecordCurrent(card, name);
  if (current.kind !== 'found' || !current.value.projection?.accepted) throw new Error(`Missing accepted ${card}/${name}`);
  return current.value.projection.accepted;
}

async function lifecycle(mode: string, outcome: string) {
    let parentTurn = 0, childTurn = 0, priorTerminalVersion = 0;
    const parent = [create(), activate(), ...(outcome === 'failed' ? [call('reopen_card', { card_id: 'card-a' })] : []),
      write('card-a', 'brief.md', 'Accepted amended requirement'), activate(), write('project', 'status.md', 'Same child completed the accepted amended requirement.'), emit('blocked')];
    const result = await run(mode === 'on', () => {}, (input, cards) => {
      if (input.agentName === 'executor') {
        childTurn++;
        if (outcome === 'stopped' && childTurn === 2) return call('fixture-operator-stop', {});
        if (childTurn === 3) {
          expect(accepted(cards, 'card-a', 'brief.md')).toMatchObject({ content: 'Accepted amended requirement', author: { kind: 'card-agent', agent: 'planner', card_id: 'project' } });
          expect(JSON.stringify(input.providerConversation)).toContain('Accepted amended requirement');
        }
        return childTurn % 2 ? write('card-a', 'status.md', childTurn === 1 ? 'Proposal: amend the bounded requirement before proceeding.' : 'Completed current accepted amended requirement.') : emit(childTurn === 2 ? outcome : 'done');
      }
      expect(input.agentName).toBe('planner');
      if (parentTurn === 2) {
        expect(cards.read('card-a')!.lifecycle.status).toBe(outcome);
        priorTerminalVersion = cards.read('card-a')!.version_seq;
      }
      if (outcome === 'failed' && parentTurn === 3) expect(cards.read('card-a')!.lifecycle.status).toBe('changed');
      if (parentTurn === (outcome === 'failed' ? 4 : 3)) expect(cards.read('card-a')!.lifecycle.status).toBe(outcome === 'stopped' ? 'stopped' : 'changed');
      if (outcome === 'stopped' && parentTurn === 2) expect(JSON.stringify(input.providerConversation)).toContain("Current workflow node 'recover'");
      const next = parent[parentTurn++];
      if (!next) throw new Error('Unexpected parent continuation');
      return next;
    }, { resumeStopped: outcome === 'stopped' });
    if (mode === 'on' && outcome === 'stopped') {
      expect(childTurn).toBe(2);
      expect(result.cards.read('card-a')!.lifecycle.status).toBe('stopped');
      expect(result.cards.read('project')!.lifecycle.status).toBe('stopped');
      return;
    }
    expect(childTurn).toBe(4);
    expect(result.cards.read('card-a')!.lifecycle.status).toBe('done');
    expect(result.cards.listChildren('project')).toEqual(['card-a']);
    const original = result.cards.readRecordVersion('card-a', 'brief.md', 1);
    expect(original).toMatchObject({ kind: 'found', value: { projection: { accepted: { content: 'Original bounded requirement', author: { kind: 'card-agent', agent: 'planner', card_id: 'project' } } } } });
    const history = result.cards.readRecordHistory('card-a', 'status.md');
    expect(JSON.stringify(history)).toContain('card-agent');
    expect(result.cards.readCardVersion('card-a', priorTerminalVersion)).toMatchObject({ kind: 'found', value: { card: { lifecycle: { status: outcome } } } });
    if (outcome !== 'stopped') expect(result.cards.readRecordVersion('card-a', 'status.md', 1)).toMatchObject({ kind: 'found', value: { projection: { accepted: {
      content: 'Proposal: amend the bounded requirement before proceeding.', author: { kind: 'card-agent', agent: 'executor', card_id: 'card-a' },
    } } } });
    const conversation = readConversation(result.root, cardAgentSessionId('executor', 'card-a'));
    expect(conversation.sourceRows.filter(row => row.kind === 'tool_call' && row.tool === 'emit_result')).toHaveLength(outcome === 'stopped' ? 1 : 2);
}

async function review(mode: string, record: string) {
    let plan = 0, assessment = 0, reviews = 0, executions = 0;
    let brief: unknown, source: unknown;
    let sawViolation = false;
    const result = await run(mode === 'on', config => {
      config.agents.planner!.capabilities.grants.find(grant => grant.tools.includes('write'))!.resources!.push({ kind: 'record', scopes: ['children'], patterns: [record] });
      if (record !== 'status.md') {
        for (const type of Object.values(config.card_types)) type.records[record] = { ...type.records['status.md']!, initialization: undefined };
        config.card_types.project!.workflow.nodes.review!.descendant_context!.records = [record];
      }
    }, (input, cards, root) => {
      const block = input.providerConversation.messages.find(message => message.kind === 'synthetic_context' && message.block_identity.startsWith('node-activation:'));
      if (!block || block.kind !== 'synthetic_context') throw new Error('Missing node context');
      const node = block.block_identity.split(':')[2];
      if (input.agentName === 'executor') {
        executions++;
        return executions % 2 ? write('card-a', 'status.md', `Actual completion ${executions}`) : emit('done');
      }
      if (node === 'plan') {
        const steps = [create(), activate(), write('project', 'status.md', 'Bounded child complete; assessing the owner objective.'), emit('assess_completion')];
        const next = steps[plan++]; if (!next) throw new Error('Unexpected planning continuation'); return next;
      }
      if (node === 'review') {
        reviews++;
        if (reviews === 1) {
          brief = accepted(cards, 'card-a', 'brief.md');
          source = mode === 'on' ? { head: fixtureGit(root, 'rev-parse', 'HEAD'), child: cards.read('card-a')!.git!.observed_tip, parent: cards.read('project')!.git!.observed_tip } : null;
        }
        if (reviews === 3) {
          expect(JSON.stringify(input.providerConversation)).toContain(`record:///${record}?card=card-a&v=${record === 'status.md' ? 3 : 1}`);
          return call('read', { path: `record:///${record}?card=card-a` });
        }
        if (reviews === 4) {
          const results = input.providerConversation.messages.filter(message => message.kind === 'tool_result' && message.tool === 'read');
          expect(results.at(-1)!.content).toContain(record === 'status.md' ? 'Actual completion 3' : 'New permitted reviewed evidence');
        }
        return [1, 4].includes(reviews) ? write('project', 'review.md', `Independent current reviewed-input judgment ${reviews}`) : emit('approved');
      }
      expect(node).toBe('assess-completion');
      assessment++;
      const steps = [write('project', 'status.md', 'Ready for independent review.'), emit('admit_review'),
        call('reopen_card', { card_id: 'card-a' }), write('card-a', record, 'New permitted reviewed evidence'), activate(),
        write('project', 'status.md', 'Recompleted same child; an old review is not a current verdict.'), emit('complete_reviewed'), emit('admit_review'),
        write('project', 'status.md', 'Fresh independent review now covers current child evidence.'), emit('complete_reviewed')];
      if (assessment === 7) {
        expect(accepted(cards, 'card-a', 'brief.md')).toEqual(brief);
        if (mode === 'on') expect({ head: fixtureGit(root, 'rev-parse', 'HEAD'), child: cards.read('card-a')!.git!.observed_tip, parent: cards.read('project')!.git!.observed_tip }).toEqual(source);
      }
      if (assessment === 8) {
        expect(JSON.stringify(input.providerConversation)).toContain("Review 'review' no longer applies");
        sawViolation = true;
        expect(accepted(cards, 'project', 'review.md').author).toEqual({ kind: 'card-agent', agent: 'reviewer', card_id: 'project' });
      }
      const next = steps[assessment - 1]; if (!next) throw new Error('Unexpected assessment continuation'); return next;
    });
    expect(sawViolation).toBe(true);
    expect(reviews).toBe(5);
    expect(executions).toBe(4);
    expect(result.cards.read('project')!.lifecycle.status).toBe('done');
    expect(result.cards.listChildren('project')).toEqual(['card-a']);
    expect(result.cards.readRecordHistory('project', 'review.md')).toMatchObject({ kind: 'found', value: { catalog: { versions: expect.any(Array) } } });
}

async function boundary(detail: string) {
  let plan = 0, assessment = 0, reviews = 0, executions = 0;
  let addedChild = '';
  let armed = false, injected = false, closeCount = 0, closesAtInjection = 0, verifies = 0, verifiesAtInjection = 0;
  const queue = detail === 'verify-queue';
  const result = await run(true, config => {
    config.agents.planner!.capabilities.grants.find(grant => grant.tools.includes('write'))!.resources!.push({ kind: 'record', scopes: ['children'], patterns: ['evidence.md'] });
    for (const type of Object.values(config.card_types)) type.records['evidence.md'] = { ...type.records['status.md']!, initialization: undefined };
    config.card_types.project!.workflow.nodes.review!.descendant_context!.records = ['evidence.md'];
  }, input => {
    const block = input.providerConversation.messages.find(message => message.kind === 'synthetic_context' && message.block_identity.startsWith('node-activation:'));
    if (!block || block.kind !== 'synthetic_context') throw new Error('Missing actual node context');
    const node = block.block_identity.split(':')[2];
    if (input.agentName === 'executor') return ++executions % 2 ? write(block.block_identity.split(':')[1]!, 'status.md', 'Actual bounded completion') : emit('done');
    if (node === 'plan') return [create(), write('card-a', 'evidence.md', 'Original configured evidence'), activate(),
      ...(detail === 'verify-order' ? [create(), call('activate_card', { card_id: 'card-b', instructions: 'Complete current bounded assignment.' })] : []),
      write('project', 'status.md', 'Completed bounded child.'), emit('assess_completion')][plan++]!;
    if (node === 'review') return ++reviews % 2 ? write('project', 'review.md', `Actual independent review ${reviews}`) : emit('approved');
    assessment++;
    if (assessment === 1) return write('project', 'status.md', 'Ready for independent review.');
    if (assessment === 2) return emit('admit_review');
    if (assessment === 3) return write('project', 'status.md', 'Current bounded delivery ready.');
    if (assessment === 4) { armed = true; return emit('complete_reviewed'); }
    if (assessment === 5) {
      expect(queue).toBe(false);
      expect(JSON.stringify(input.providerConversation)).toContain("Review 'review' no longer applies");
      expect(closeCount).toBe(closesAtInjection);
      expect(verifies).toBe(verifiesAtInjection);
      return addedChild ? call('activate_card', { card_id: addedChild, instructions: 'Complete the newly reached bounded assignment.' }) : emit('admit_review');
    }
    if (addedChild && assessment === 6) return emit('admit_review');
    if (assessment === (addedChild ? 7 : 6)) return write('project', 'status.md', 'Fresh review covers changed configured evidence.');
    if (assessment === (addedChild ? 8 : 7)) return emit('complete_reviewed');
    throw new Error('Unexpected boundary continuation');
  }, { observe: (supervisor, cards, root) => {
    // Controlled interleavings wrap, await and retain the actual native operation.
    // Injection uses exact canonical owners, not a fabricated source verdict.
    const native = supervisor as unknown as { verifyCandidate: (...args: unknown[]) => Promise<string | null> };
    const verify = native.verifyCandidate;
    const settle = NodeExecution.prototype.settleSourceWriters;
    const close = cards.closeRecord;
    cards.closeRecord = function(...args) { closeCount++; return close.apply(this, args); };
    const inject = () => {
      const old = cards.readCardInspectionTree('project', 12);
      if (old.kind !== 'found') throw new Error('Missing root tree');
      if (queue) {
        const id = randomUUID();
        cards.enqueueNotification('project', { id, content: 'Queue-only verification context', created_at: new Date().toISOString() });
        cards.removeNotifications('project', [id]);
        const fresh = cards.readCardInspectionTree('project', 12);
        if (fresh.kind !== 'found') throw new Error('Missing root tree');
        expect(fresh.value[0]!.ordinary).toEqual(old.value[0]!.ordinary);
        expect(fresh.value[0]!.headId).not.toBe(old.value[0]!.headId);
      } else if (detail === 'verify-order') expect(cards.reorderChildren('project', ['card-b', 'card-a'])).toMatchObject({ ok: true });
      else if (detail === 'verify-membership') addedChild = cards.create({ parent: 'project', type: 'code', title: 'New reached child', priority: 0, urgency: 'normal', depends_on: [], bootstrap_content: 'New bounded assignment', created_by: 'planner', bootstrap_author: { kind: 'card-agent', agent: 'planner', card_id: 'project' } }).id;
      else if (detail === 'verify-same-text') {
        const before = accepted(cards, 'card-a', 'evidence.md');
        cards.acceptRecord('card-a', 'evidence.md', 'Intervening evidence', { kind: 'agent', agent: 'analyst' });
        cards.acceptRecord('card-a', 'evidence.md', before.content, { kind: 'agent', agent: 'analyst' });
        const after = accepted(cards, 'card-a', 'evidence.md');
        expect(after.content).toBe(before.content);
        expect(after.source_entry_id).not.toBe(before.source_entry_id);
      } else cards.acceptRecord('card-a', 'evidence.md', 'New exact configured reviewed input', { kind: 'agent', agent: 'analyst' });
      injected = true; armed = false;
      closesAtInjection = closeCount;
      verifiesAtInjection = verifies;
    };
    NodeExecution.prototype.settleSourceWriters = async function() {
      await settle.call(this);
      if (armed && detail === 'writers-record') inject();
    };
    native.verifyCandidate = async function(...args) {
      const before = readCardExecutions(root, 'project').filter(row => row.kind === 'native_started' && row.step === 'inspect').length;
      const verdict = await verify.apply(this, args);
      verifies++;
      const after = readCardExecutions(root, 'project').filter(row => row.kind === 'native_started' && row.step === 'inspect').length;
      expect(after).toBe(before + 1);
      expect(verdict).toBeNull();
      if (armed && detail !== 'writers-record') inject();
      return verdict;
    };
    return () => { native.verifyCandidate = verify; NodeExecution.prototype.settleSourceWriters = settle; cards.closeRecord = close; };
  } });
  expect(injected).toBe(true);
  expect(result.cards.read('project')!.lifecycle.status).toBe('done');
  expect(reviews).toBe(queue ? 2 : 4);
  expect(assessment).toBe(queue ? 4 : addedChild ? 8 : 7);
}

async function notifications(mode: string) {
  const calls = new Map<string, number>(), observed = new Map<string, string[]>();
  let notify!: (content: string) => void;
  let duringClose = false;
  const result = await run(mode === 'on', () => {}, async input => {
    const agent = input.agentName, turn = (calls.get(agent) ?? 0) + 1;
    calls.set(agent, turn);
    observed.set(agent, [...(observed.get(agent) ?? []), JSON.stringify(input.providerConversation)]);
    if (agent === 'reviewer' && turn === 2) {
      await Promise.resolve(); // Provider approval is still held and not accepted.
      notify('planner designated context');
    }
    if (turn > 4) throw new Error('Notification-only selectors caused an assessment/review loop');
    return turn % 2 ? write('project', agent === 'reviewer' ? 'review.md' : 'status.md', `${agent} evidence ${turn}`)
      : emit(agent === 'reviewer' ? 'approved' : turn === 2 ? 'admit_review' : 'complete_reviewed');
  }, { observe: (supervisor, cards) => {
    notify = content => {
      const id = randomUUID();
      expect(supervisor.notifyCard('project', { id, content, created_at: new Date().toISOString() })).toEqual({ ok: true, notificationId: id });
    };
    const close = cards.closeRecord;
    cards.closeRecord = function(...args) {
      const result = close.apply(this, args);
      if (!duringClose && args[1] === 'review.md' && cards.read('project')!.pending_notifications.length) {
        duringClose = true;
        notify('context admitted during accepted record close');
      }
      return result;
    };
    return () => { cards.closeRecord = close; };
  } });
  expect(duringClose).toBe(true);
  expect(calls).toEqual(new Map([['planner', 4], ['reviewer', 4]]));
  expect(observed.get('reviewer')!.join('\n')).not.toContain('planner designated context');
  expect(observed.get('reviewer')!.join('\n')).not.toContain('context admitted during accepted record close');
  expect(observed.get('planner')![2]).toContain('planner designated context');
  expect(observed.get('planner')![2]).toContain('context admitted during accepted record close');
  expect(result.cards.read('project')).toMatchObject({ lifecycle: { status: 'done' }, pending_notifications: [] });
}

async function pausedRecordSettlement(detail: string) {
  const self = detail === 'self';
  let turns = 0, release!: () => void, held = false, parked = false, failure: unknown;
  const response = new Promise<void>(resolve => { release = resolve; });
  const result = await run(false, () => {}, async input => {
    expect(input.agentName).toBe('planner');
    turns++;
    if (turns === 1) return create();
    if (turns === 2) {
      held = true;
      await response;
      return write(self ? 'project' : 'card-a', self ? 'status.md' : 'brief.md', 'Already admitted paused response');
    }
    expect(parked).toBe(true);
    if (turns === 3) {
      const results = input.providerConversation.messages.filter(message => message.kind === 'tool_result' && message.tool === 'write');
      expect(results).toHaveLength(1);
      expect(JSON.parse(results[0]!.content)).toMatchObject({ success: self });
    }
    if (!self && turns === 3) return write('project', 'status.md', 'Nonself acceptance correctly refused during Pause');
    return emit('blocked');
  }, { observe(supervisor, cards) {
    let paused = false;
    const timer = setInterval(() => {
      if (held && !paused) {
        paused = true;
        supervisor.pause();
        expect(supervisor.getStatus().status).toBe('pausing');
        release();
      }
      if (supervisor.getStatus().status !== 'paused' || parked) return;
      parked = true;
      try {
        expect(turns).toBe(2); // No next provider dispatch while paused.
        if (self) expect(cards.readRecordCurrent('project', 'status.md')).toMatchObject({ kind: 'found', value: { projection: { state: 'open', draft: { content: 'Already admitted paused response' } } } });
        expect(accepted(cards, 'card-a', 'brief.md').content).toBe('Original bounded requirement');
      } catch (error) { failure = error; }
      supervisor.resume();
    }, 5);
    return () => clearInterval(timer);
  } });
  if (failure) throw failure;
  expect(parked).toBe(true);
  expect(result.cards.read('project')!.lifecycle.status).toBe('blocked');
  expect(accepted(result.cards, 'project', 'status.md').content).toBe(self ? 'Already admitted paused response' : 'Nonself acceptance correctly refused during Pause');
}

const [mode, scenario, detail] = process.argv.slice(2);
if (!mode || !detail) throw new Error('Expected mode, scenario and detail');
if (scenario === 'lifecycle') await lifecycle(mode, detail);
else if (scenario === 'review') await review(mode, detail);
else if (scenario === 'boundary') await boundary(detail);
else if (scenario === 'stop-refusal') await lifecycle(mode, 'stopped');
else if (scenario === 'notifications') await notifications(mode);
else if (scenario === 'pause') await pausedRecordSettlement(detail);
else throw new Error('Unknown public assignment scenario');
console.log(JSON.stringify({ mode, scenario, detail, passed: true }));
