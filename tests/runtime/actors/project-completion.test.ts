import { afterEach, describe, expect, it } from '@jest/globals';
import { createObservedCollections } from '../../../src/retrieval/index.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSystemTemplate } from '../../../src/config/system-templates/registry.js';
import { effectiveSaivageConfigSchema } from '../../../src/schemas/saivage-config.js';
import { compileProjectWorkflows, bindRuntimeWorkflows } from '../../../src/runtime/card-process/card-process-config.js';
import { ProviderRegistry } from '../../../src/agents/provider.js';
import { ModelRouter } from '../../../src/agents/model-router.js';
import { CardService } from '../../../src/cards/card-service.js';
import { publishInitialProjectRuntime } from '../../../src/boot/index.js';
import { createSupervisorRuntimeApi } from '../../../src/runtime/actors/supervisor-runtime-api.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import { createPromptTemplateRegistry } from '../../../src/utils/prompt-api.js';
import type { PreparedLlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import type { CardActivationOwner } from '../../../src/runtime/actors/card-activation-owner.js';
import { TEST_SAIVAGE_CONFIG } from '../../helpers/test-saivage-config.js';
import { createTestProcessRunner } from '../../helpers/test-process-runner.js';
import { scriptedAdmissionProvider, testAutonomousCompaction } from '../../helpers/llm-test-helpers.js';
import { testApplicationFatalPort } from '../../helpers/test-application-fatal-port.js';
import { appendConversationBatch, readConversation, readCurrentConversationSegment, readHistoricalConversationSegment } from '../../../src/persistence/conversation-file.js';
import { appendActivationMarker, buildUserContextMessage, providerConversationProjection } from '../../../src/runtime/actors/conversation-session.js';
import { compact, prepareCompaction } from '../../../src/runtime/actors/compaction/compactor.js';
import { buildPreparedInvocationContext, composedPreparedBlocks } from '../../../src/runtime/actors/context/context-blocks.js';
import { deterministicSummarySerialization } from '../../helpers/summary-serialization.js';
import { noCompactionProgress } from '../../helpers/executing-llm-snapshot.js';

const profiles = ['classic', 'classic-typed', 'paad-typed'] as const;
type Profile = typeof profiles[number];
type Step = { node: string; tool: string; args: object; before?: (input: PreparedLlmInvocationInput, signal: AbortSignal) => void | Promise<void> };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function capture(name: string, value: unknown) {
  const directory = process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE;
  if (directory) { mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, `project-${name}.json`), JSON.stringify(value, null, 2)); }
}
function result(node: string, outcome: string, summary = `${node}: ${outcome}`): Step { return { node, tool: 'emit_result', args: { outcome, summary } }; }
function write(node: string, content: string, record = node === 'review' ? 'review.md' : 'status.md'): Step {
  return { node, tool: 'write', args: { path: `record:///${record}?card=project`, content } };
}
function nodeOf(input: PreparedLlmInvocationInput) {
  const block = input.providerConversation.messages.find(message => 'block_identity' in message && message.block_identity.startsWith('node-activation:project:'));
  if (!block || !('block_identity' in block)) throw new Error('Missing actual current node block');
  return block.block_identity.slice('node-activation:project:'.length);
}
function fixture(profile: Profile, steps: Step[]) {
  const root = mkdtempSync(join(tmpdir(), 'project-completion-'));
  const template = resolveSystemTemplate(profile);
  const config = effectiveSaivageConfigSchema.parse({ ...structuredClone(template.config),
    models: structuredClone(TEST_SAIVAGE_CONFIG.models), providers: structuredClone(TEST_SAIVAGE_CONFIG.providers),
    compaction: structuredClone(TEST_SAIVAGE_CONFIG.compaction) });
  config.providers.test!.capabilities = { ...config.providers.test!.capabilities, transportProtocol: 'openai-responses', imageInput: true };
  const compiled = compileProjectWorkflows(config, { defaultPromptRoot: template.promptRoot });
  publishInitialProjectRuntime(root, compiled);
  const cards = new CardService(root, compiled);
  cards.acceptRecord('project', 'brief.md', 'Deliver evidenced beta; then implement the explicitly authorized post-beta accessibility work. Inventory acceptance alone is not beta acceptance.', { kind: 'agent', agent: 'analyst' });
  const registry = new ProviderRegistry(config);
  const workflows = bindRuntimeWorkflows(compiled, new ModelRouter(registry), registry, config.compaction.context_utilization_fraction, { internalAnalystEnabled: true });
  const processes = createTestProcessRunner(root);
  const requests: PreparedLlmInvocationInput[] = [];
  let started = false;
  let cursor = 0;
  let parked!: () => void;
  const atEnd = new Promise<void>(resolve => { parked = resolve; });
  const provider = scriptedAdmissionProvider(async (input: PreparedLlmInvocationInput, signal: AbortSignal) => {
    requests.push(input);
    const step = steps[cursor++];
    if (!step) {
      parked();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      throw new Error('Unreachable aborted scripted request');
    }
    expect(nodeOf(input)).toBe(step.node);
    await step.before?.(input, signal);
    return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: `step-${cursor}`, type: 'function' as const,
      function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }, provider_exchanges: [] };
  });
  const supervisor = createSupervisorRuntimeApi({ ...testAutonomousCompaction, workflows, projectRoot: root, actorStore: cards,
    retrieval: createObservedCollections(root),
    fatalPort: testApplicationFatalPort, runtimeGate: new RuntimeGate(), provider, conversations: { projectRoot: root },
    freshness: { runtimeChanged() {}, agentMembershipChanged() {} }, processRunner: processes.processRunner,
    runtimeProcessRootScope: processes.runtimeProcessRootScope, promptTemplates: createPromptTemplateRegistry(compiled) });
  cleanups.push(async () => { if (started) await supervisor.stopProject(); await processes.processRunner.terminateScopeTree({ rootScope: processes.runtimeProcessRootScope, categories: ['runtime_card'], reason: 'test cleanup', graceMs: 50 }); rmSync(root, { recursive: true, force: true }); });
  const launch = async () => {
    await supervisor.start();
    started = true;
    const internal = supervisor as unknown as { beginStartProject(): Promise<{ accepted: boolean; launch: { owner: CardActivationOwner } }>; launchStartedProject(plan: unknown): void };
    const prepared = await internal.beginStartProject();
    if (!prepared.accepted) throw new Error('Rejected project launch');
    void prepared.launch.owner.settlement.promise.catch(() => undefined);
    internal.launchStartedProject(prepared.launch);
    return prepared.launch.owner;
  };
  const record = (name: string) => { const read = cards.readRecordCurrent('project', name); if (read.kind !== 'found') throw new Error('Missing project'); return read.value.projection; };
  return { root, config, compiled, cards, supervisor, requests, atEnd, launch, record };
}

describe.each(profiles)('%s actual project objective reconciliation', profile => {
  it('compiles only reachable root closure routes while preserving goal handling, urgent recovery and leaf graphs', () => {
    const f = fixture(profile, []);
    const project = f.compiled.cardTypes.get('project')!;
    const nodes = [...project.states.values()].filter(state => state.kind === 'node');
    expect(nodes.map(node => node.nodeId).sort()).toEqual(['assess-completion', 'plan', 'recover', 'review']);
    for (const node of nodes) {
      for (const route of node.on.values()) if (route.targetStateId === 'terminal:DONE') expect(node.nodeId).toBe('assess-completion');
      expect(node.on.get('notification:interrupt')!.targetStateId).toBe('node:recover');
    }
    const goal = f.compiled.cardTypes.get('goal')!;
    expect(goal.states.has('node:handle-notifications')).toBe(true);
    expect(f.config.card_types.goal!.workflow.nodes.review!.edges.approved).toHaveProperty('pending_notifications');
    expect(f.config.card_types.project!.workflow.nodes.review!.edges.approved).toEqual({ target: { node: 'assess-completion' } });
    const leafNodes = { code: ['red', 'green', 'refactor'], test: ['diagnose', 'add-coverage', 'repair', 'verify'], doc: ['execute'], data: ['schema', 'validate', 'implement'], research: ['explore', 'assess', 'report'], ops: ['execute'], architecture: ['draft', 'component-review', 'system-review'] };
    for (const [type, expected] of Object.entries(leafNodes)) {
      const workflow = f.compiled.cardTypes.get(type)!;
      expect([...workflow.states.values()].flatMap(node => node.kind === 'node' ? [node.nodeId] : [])).toEqual(profile === 'classic' ? ['execute'] : expected);
    }
  });

  it.each(['missing-beta', 'post-beta'] as const)('keeps accepted %s report factual and returns actionable existing work to plan', async scope => {
    const report = scope === 'missing-beta' ? 'Nine missing-beta items inventoried. Product work and root R1 remain open.' : 'Beta accepted against evidence beta-A. Authorized post-beta accessibility remains open.';
    const steps = [write('plan', 'Current delivery ready for bounded review.'), result('plan', 'admit_review'),
      write('review', report), result('review', 'approved', 'Bounded report accepted; remaining objective is explicit.'),
      { node: 'assess-completion', tool: 'read', args: { path: 'record:///review.md?card=project&v=1' } },
      write('assess-completion', `${report} Continue existing [[card:card-a]]; do not create a duplicate.`), result('assess-completion', 'replan'),
      { node: 'plan', tool: 'activate_card', args: { card_id: 'card-a', instructions: 'Continue the existing authorized beta/accessibility scope under its accepted brief; retain open root R1 and distinguish inventory evidence from product acceptance.' } }];
    const f = fixture(profile, steps);
    const child = f.cards.create({ type: 'code', parent: 'project', title: 'Existing beta/accessibility implementation', bootstrap_content: 'Implement the remaining authorized scope.', priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [] });
    expect(child.id).toBe('card-a');
    const owner = await f.launch(); await f.atEnd;
    expect(f.supervisor.getActorRuntimeReadModel().cards.find(card => card.cardId === 'project')!.processState).toMatchObject({ kind: 'node', nodeId: 'plan' });
    expect(f.requests.at(-1)!.sessionId).toBe('agent:executor:card-a');
    expect(f.cards.read('project')!.lifecycle.status).toBe('running');
    expect(f.cards.read(child.id)!.lifecycle.status).toBe('running');
    expect(f.cards.read('project')!.active_child_order).toEqual([child.id]);
    expect(f.record('review.md')!.accepted).toMatchObject({ content: report, author: { kind: 'agent', agent: 'reviewer' } });
    const readReport = f.requests.flatMap(input => input.providerConversation.messages).find(message => message.role === 'tool' && message.tool_call_id === 'step-5')!;
    expect(JSON.parse(readReport.content)).toMatchObject({ success: true, data: { content: { content: report }, content_author: { kind: 'agent', agent: 'reviewer' } } });
    expect(f.record('status.md')!.accepted!.content).toContain('card-a');
    capture(`${profile}-${scope}`, f.requests);
    await f.supervisor.stopProject(); await expect(owner.settlement.promise).rejects.toThrow('stopped');
  });

  it('promotes real Reviewer acceptance but exports new Planner status with immutable review citation', async () => {
    const f = fixture(profile, [write('plan', 'Finite objective delivered with evidence build-A.'), result('plan', 'admit_review'),
      write('review', 'Independent product acceptance of complete finite objective on build-A.'), result('review', 'approved', 'Independent complete-objective verdict.'),
      { node: 'assess-completion', tool: 'read', args: { path: 'record:///review.md?card=project&v=1' } },
      write('assess-completion', 'Finite objective fulfilled on build-A; independent acceptance record:///review.md?card=project&v=1 applies. No continuing obligation.'), result('assess-completion', 'complete_reviewed')]);
    f.cards.acceptRecord('project', 'brief.md', 'Deliver the finite build-A objective, with independent product acceptance. No continuing work.', { kind: 'agent', agent: 'analyst' });
    const owner = await f.launch();
    await expect(owner.settlement.promise).resolves.toMatchObject({ status: 'done', result: { executor: { kind: 'agent', agent: 'reviewer' }, node_id: 'review', outcome: 'approved', summary: 'Independent complete-objective verdict.', records: [{ name: 'status.md', version: 2 }] } });
    expect(f.record('status.md')!.accepted).toMatchObject({ author: { kind: 'agent', agent: 'planner' }, source_version: 2 });
    expect(f.record('review.md')!.accepted).toMatchObject({ author: { kind: 'agent', agent: 'reviewer' }, source_version: 1 });
    const assessment = f.requests.find(input => nodeOf(input) === 'assess-completion')!;
    expect(JSON.stringify(assessment.providerConversation)).toContain('record:///review.md?card=project&v=1');
    expect(JSON.stringify(assessment.providerConversation)).toContain('Independent complete-objective verdict.');
    const readResult = f.requests.flatMap(input => input.providerConversation.messages).find(message => message.role === 'tool' && message.tool_call_id === 'step-5')!;
    expect(JSON.parse(readResult.content)).toMatchObject({ success: true, data: { version: 1, content_author: { kind: 'agent', agent: 'reviewer' }, content: { content: 'Independent product acceptance of complete finite objective on build-A.' } } });
    const history = f.cards.readRecordHistory('project', 'review.md');
    expect(history.kind === 'found' && history.value.catalog.versions).toHaveLength(1);
    capture(`${profile}-reviewed`, f.requests);
  });

  it.each(['complete_direct', 'blocked'] as const)('handles %s through one authored assessment without requiring review', async outcome => {
    const text = outcome === 'blocked' ? 'Beta accomplished on evidence B. Owner must choose the next authorized product direction; no meaningful scoped improvement is specified.' : 'Finite evidence-only objective fulfilled by source E; independent review is not required and no work remains.';
    const f = fixture(profile, [write('plan', 'Candidate closure: ' + text), result('plan', 'assess_completion'), write('assess-completion', text), result('assess-completion', outcome)]);
    f.cards.acceptRecord('project', 'brief.md', outcome === 'blocked' ? 'Evidence-backed beta then continue improving; next product direction requires owner choice.' : 'Assess the finite source E evidence only; no independent acceptance required.', { kind: 'agent', agent: 'analyst' });
    const owner = await f.launch();
    await expect(owner.settlement.promise).resolves.toMatchObject({ status: outcome === 'blocked' ? 'blocked' : 'done', result: { executor: { kind: 'agent', agent: 'planner' }, node_id: 'assess-completion', outcome, records: [{ name: 'status.md' }] } });
    expect(f.requests.map(nodeOf)).toEqual(['plan', 'plan', 'assess-completion', 'assess-completion']);
    expect(f.record('review.md')).toBeNull(); expect(f.record('status.md')!.accepted!.content).toBe(text);
    capture(`${profile}-${outcome}`, f.requests);
  });

  it('delivers review-time pending owner context to assessment, requires changed status and denies Planner review authorship', async () => {
    const steps = [write('plan', 'Ready for independent finite review.'), result('plan', 'admit_review'), write('review', 'Bounded review accepted.'),
      result('review', 'approved'), write('review', 'Bounded review accepted after refreshed notification-bearing snapshot.'), result('review', 'approved'), result('assess-completion', 'complete_reviewed'),
      write('assess-completion', 'Planner must not replace independent verdict.', 'review.md'),
      write('assess-completion', 'Accepted bounded review retained. New owner context leaves explicit authorized work; continue planning.'), result('assess-completion', 'replan')];
    const f = fixture(profile, steps);
    steps[3]!.before = async () => { await f.supervisor.submitNotification('project', { id: '11111111-1111-4111-8111-111111111111', content: 'Owner clarification: accepted inventory is not beta; accessibility remains authorized.', created_at: new Date().toISOString() }, 'normal'); };
    const owner = await f.launch(); await Promise.race([f.atEnd, owner.settlement.promise.then(outcome => { capture(`${profile}-pending-failure`, { outcome, requests: f.requests }); throw new Error(JSON.stringify(outcome)); })]);
    const assessments = f.requests.filter(input => nodeOf(input) === 'assess-completion');
    expect(JSON.stringify(assessments[0]!.providerConversation)).toContain('Owner clarification: accepted inventory is not beta');
    const tools = assessments.flatMap(input => input.providerConversation.messages.filter(row => row.role === 'tool').map(row => JSON.parse(row.content)));
    expect(tools.some(tool => tool.success === false)).toBe(true);
    expect(JSON.stringify(tools)).toContain('review.md');
    const toolResult = (id: string) => JSON.parse(assessments.flatMap(input => input.providerConversation.messages).find(message => message.role === 'tool' && message.tool_call_id === id)!.content);
    expect(toolResult('step-7')).toMatchObject({ success: false, error: 'Record validation failed.' });
    expect(toolResult('step-8')).toMatchObject({ success: false, data: { code: 'record_mutation_denied', reason: 'writer_not_authorized', name: 'review.md' } });
    expect(f.record('review.md')!.accepted!.content).toBe('Bounded review accepted after refreshed notification-bearing snapshot.');
    expect(f.record('review.md')!.draft).toBeNull();
    expect(nodeOf(f.requests.at(-1)!)).toBe('plan');
    capture(`${profile}-pending-and-permissions`, f.requests);
    await f.supervisor.stopProject(); await expect(owner.settlement.promise).rejects.toThrow('stopped');
  });

  it('rejects historical latest-review promotion after actual STOPPED entry and retains current obligations', async () => {
    const f = fixture(profile, [write('recover', 'Recovered current obligations; old verdict remains historical.'), result('recover', 'assess_completion'),
      write('assess-completion', 'Old inventory verdict is not applicable product acceptance; owner scope decision unavailable.'), result('assess-completion', 'complete_reviewed'),
    ]);
    const prior = f.cards.acceptRecord('project', 'review.md', 'Historical bounded inventory review, not current activation acceptance.', { kind: 'agent', agent: 'reviewer' }).accepted;
    f.cards.setStatus('project', 'running'); f.cards.stopRunning('project');
    const owner = await f.launch();
    await expect(owner.settlement.promise).resolves.toMatchObject({ status: 'failed', result: { kind: 'runtime-failure', summary: "Promoted node 'review' has no accepted result." } });
    expect(nodeOf(f.requests[0]!)).toBe('recover');
    expect(f.record('review.md')!.accepted).toEqual(prior);
    const last = JSON.stringify(f.requests.at(-1)!.providerConversation);
    expect(last).toContain('review'); expect(last).toContain('accepted');
    capture(`${profile}-stopped-reentry`, f.requests);
  });

  it('retains incomplete-descendant DONE rejection at the actual assessment boundary', async () => {
    const f = fixture(profile, [write('plan', 'Candidate direct closure.'), result('plan', 'assess_completion'),
      write('assess-completion', 'No delivery for existing child; closure attempt must be rejected.'), result('assess-completion', 'complete_direct'),
      result('assess-completion', 'replan')]);
    f.cards.create({ type: 'code', parent: 'project', title: 'Unfinished child', bootstrap_content: 'Required implementation.', priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [] });
    const owner = await f.launch(); await f.atEnd;
    expect(nodeOf(f.requests.at(-1)!)).toBe('plan');
    expect(f.cards.read('project')!.lifecycle.status).toBe('running');
    const corrected = f.requests.filter(input => nodeOf(input) === 'assess-completion').at(-1)!;
    expect(JSON.stringify(corrected.providerConversation)).toContain("Completion gate failed: descendant 'card-a' is 'backlog'.");
    capture(`${profile}-incomplete-descendants`, f.requests);
    await f.supervisor.stopProject(); await expect(owner.settlement.promise).rejects.toThrow('stopped');
  });

  it('uses actual urgent interruption to recover rather than the removed root handler', async () => {
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const f = fixture(profile, [{ ...write('plan', 'This aborted write is never executed.'), before: async (_input, signal) => {
      enter(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } }, write('recover', 'Urgent descendant correction received; investigate existing scope.'), result('recover', 'assess_completion'),
      write('assess-completion', 'Urgent correction requires existing child work; return to plan.'), result('assess-completion', 'replan')]);
    const child = f.cards.create({ type: 'code', parent: 'project', title: 'Urgent recipient', bootstrap_content: 'Existing work.', priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [] });
    const owner = await f.launch(); await entered;
    await f.supervisor.submitNotification(child.id, { id: '22222222-2222-4222-8222-222222222222', content: 'Urgent beta evidence correction.', created_at: new Date().toISOString() }, 'urgent');
    await f.atEnd;
    expect(f.requests.map(nodeOf)).toEqual(['plan', 'recover', 'recover', 'assess-completion', 'assess-completion', 'plan']);
    expect(JSON.stringify(f.requests[1]!.providerConversation)).toContain(`for descendant '${child.id}'`);
    expect(JSON.stringify(f.requests[1]!.providerConversation)).toContain('previous process node was interrupted');
    capture(`${profile}-urgent-recover`, f.requests);
    await f.supervisor.stopProject(); await expect(owner.settlement.promise).rejects.toThrow('stopped');
  });

  it('retains the actual assessment task and current requirement snapshot across a strict compaction successor without promising review body recall', async () => {
    const f = fixture(profile, [write('plan', 'Candidate objective closure.'), result('plan', 'assess_completion'),
      write('assess-completion', 'Need independent acceptance of the whole current objective.'), result('assess-completion', 'admit_review'),
      write('review', 'Independent inventory-only acceptance; underlying product evidence remains unavailable.'), result('review', 'approved', 'Inventory accepted, not product beta.'),
      write('assess-completion', 'Inventory accepted under record:///review.md?card=project&v=1; owner must supply unavailable product authority.'), result('assess-completion', 'blocked')]);
    const owner = await f.launch(); await owner.settlement.promise;
    const prepared = f.requests.filter(input => nodeOf(input) === 'assess-completion').at(-1)!;
    const session = prepared.sessionId;
    const handoff = readConversation(f.root, session).sourceRows.find(row => row.content.startsWith('Previous process node: review'))!;
    expect(handoff.content).toContain('record:///review.md?card=project&v=1');
    for (let ordinal = 1; ordinal <= 4; ordinal++) {
      const inputId = `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
      appendActivationMarker({ projectRoot: f.root }, session, { event: 'activation_open', instructions: { kind: 'unavailable', reason: 'not_recorded' }, agent_name: 'planner', card_id: 'project', input_id: inputId });
      appendConversationBatch({ projectRoot: f.root }, [buildUserContextMessage(session, inputId, 'process_transition', 0, { role: 'user', content: 'Later ordinary historical narrative. '.repeat(700) })]);
    }
    const source = readCurrentConversationSegment(f.root, session)!;
    const preparedCompaction = prepareCompaction({ ...testAutonomousCompaction.compactionConfig, tail_fraction: 0.05 }, prepared.systemPrompt, prepared.tools, 24_000, 200);
    const preparedContext = buildPreparedInvocationContext({ ...prepared.preparedContext, instructionText: prepared.systemPrompt, terminalToolNames: prepared.terminalToolNames, compiledTools: prepared.compiledToolContracts, preparedCompaction });
    const input = { ...prepared, preparedCompaction, preparedContext, providerConversation: providerConversationProjection(source.conversation, composedPreparedBlocks(preparedContext)) };
    const summaryRequests: unknown[] = [];
    const compacted = await compact({ strategy: 'preventive', summaryRefusal: null, conversations: { projectRoot: f.root }, input,
      summarizerProvider: { candidate: { provider: 'test', account: null, model: 'test-model' }, contextWindowTokens: 100_000, maxOutputTokens: 10_000,
        materializeImage: async () => { throw new Error('No images'); }, serializeSummaryRequest: deterministicSummarySerialization,
        completeTurn: async request => { summaryRequests.push(request); return { result: { kind: 'message', content: 'Historical narrative summarized. Read actual accepted evidence for objective reconciliation.' }, provider_exchanges: [] }; }, projectProviderExchanges: () => undefined },
      signal: new AbortController().signal, progress: noCompactionProgress });
    expect(compacted.kind).toBe('compacted');
    const successor = readCurrentConversationSegment(f.root, session)!;
    expect(successor.index.format_version).toBe(12); expect(successor.entry.version).toBe(source.entry.version + 1);
    expect(readHistoricalConversationSegment(f.root, session, source.entry.version).rows).toEqual(source.rows);
    const primary = providerConversationProjection(successor.conversation, composedPreparedBlocks(preparedContext));
    const successorRequest = { ...input, providerConversation: primary };
    expect(nodeOf(successorRequest)).toBe('assess-completion');
    expect(primary.messages.some(message => message.content === handoff.content)).toBe(false);
    expect(JSON.stringify(summaryRequests)).toContain(handoff.content.split('\n')[0]!);
    expect(primary.messages.some(message => 'block_identity' in message && message.block_identity === 'current-bootstrap:project')).toBe(true);
    expect(JSON.stringify(primary)).toContain('Deliver evidenced beta');
    const generated = prepared.tools.find(tool => tool.function.name === 'emit_result')!.function.parameters as { properties: { outcome: { enum: string[] } } };
    expect([...generated.properties.outcome.enum].sort()).toEqual(['admit_review', 'blocked', 'complete_direct', 'complete_reviewed', 'failed', 'replan']);
    capture(`${profile}-strict-compaction`, { input, summaryRequests, successor, successorRequest });
  });
});
