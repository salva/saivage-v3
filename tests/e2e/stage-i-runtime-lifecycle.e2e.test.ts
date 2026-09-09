import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../helpers/canonical-project.js';
import { workflowResult } from '../helpers/workflow-result.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { createSupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import type { LlmCompleteResult, ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import { appendConversationBatch, readConversation } from '../../src/persistence/conversation-file.js';
import { type AgentMessage, MODEL_RECOVERY_NOTICE_TEXT } from '../../src/schemas/index.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { scriptedAdmissionProvider, testAutonomousCompaction } from '../helpers/llm-test-helpers.js';
import { RuntimeGate } from '../../src/runtime/runtime-gate.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY, toolRowPolicies } from '../helpers/row-policy-fixtures.js';
import { stabilizeAgentSession } from '../../src/runtime/actors/conversation-recovery.js';
import { cardStreamFile } from '../../src/persistence/layout.js';
import { CardActivationOwner } from '../../src/runtime/actors/card-activation-owner.js';
import type { CardProcessActor } from '../../src/runtime/actors/card-process-actor.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function complete(result: LlmCompleteResult): ProviderTurnCompletion { return { result, provider_exchanges: [] }; }
function tool(id: string, name: string, args: object): LlmCompleteResult { return { kind: 'tool_calls', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }; }
async function waitUntil(predicate: () => boolean): Promise<void> { for (let attempt = 0; attempt < 500; attempt += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } throw new Error('condition not reached'); }

function supervisor(projectRoot: string, cards: CardService, provider: import('../../src/runtime/actors/llm-actor.js').LLMProviderPort): ReturnType<typeof createSupervisorRuntimeApi> {
  const registry = new ManagedProcessGroupRegistry();
  const runtimeProcessRootScope = registry.createContainerScope(registry.rootScope, 'runtime-cards');
  return createSupervisorRuntimeApi({
    fatalPort: testApplicationFatalPort,
    ...testAutonomousCompaction,
    runtimeGate: new RuntimeGate(),
    projectRoot,
    actorStore: cards,
    provider,
    conversations: { projectRoot },
    freshness: { runtimeChanged() {}, agentMembershipChanged() {} },
    processRunner: new ProcessRunner(projectRoot, registry, testApplicationFatalPort),
    runtimeProcessRootScope,
    promptTemplates: { render: () => 'test prompt' },
  });
}

function appendOpenMatchedRound(projectRoot: string, cardId: string): void {
  const sessionId = `agent:executor:${cardId}` as const;
  const inputId = '22222222-2222-4222-8222-222222222222';
  const timestamp = '2026-09-01T18:45:00.000Z';
  const resultContent = JSON.stringify({ success: true, data: { cards: [] } });
  const base = { session_id: sessionId, round_id: 'r-pre-ffffffffffffffffffffffffffffffff', message_index: 0, block_index: 0, timestamp };
  appendConversationBatch({ projectRoot }, [
    { ...base, context_policy: ACTIVITY_ROW_POLICY, id: `${sessionId}:activation:one`, role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', agent_name: 'executor', card_id: cardId, input_id: inputId, timestamp }) },
    { ...base, context_policy: toolRowPolicies({ content: resultContent }).call, id: `${inputId}:tool-call:list-1`, role: 'assistant', kind: 'tool_call', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'list-1', type: 'function', function: { name: 'list_cards', arguments: '{}' } }] }), tool: 'list_cards', tool_call_id: 'list-1', message_index: 1 },
    { ...base, context_policy: toolRowPolicies({ content: resultContent }).result, id: `${inputId}:tool-result:list-1`, role: 'tool', kind: 'tool_result', content: resultContent, tool: 'list_cards', tool_call_id: 'list-1', message_index: 2 },
  ] satisfies AgentMessage[]);
}

function appendInvalidRootPlannerContinuation(projectRoot: string): void {
  appendConversationBatch({ projectRoot }, [{
    id: 'root-without-activation', session_id: 'agent:planner:project', role: 'user', kind: 'text', context_policy: TEXT_ROW_POLICY,
    content: 'invalid recovery continuation', round_id: 'r-user-11111111111111111111111111111111', message_index: 0, block_index: 0, timestamp: '2026-09-01T18:46:00.000Z',
  }]);
}

function installRootSettlementOwner(runtime: ReturnType<typeof createSupervisorRuntimeApi>, root: NonNullable<ReturnType<CardService['read']>>) {
  const processor = {
    start() {}, activate: async () => new Promise<never>(() => undefined), disposeActivation() {},
    suppressContinuationAndPrepareJoin() {}, joinActivation: async () => [],
    processPosition: () => ({ cardType: 'project', stateId: 'ready', kind: 'ready' }), executingLlmSnapshot: () => null,
  } as unknown as CardProcessActor;
  const owner = new CardActivationOwner({ card: root, processor, activationId: 'root-settlement', entry: 'BACKLOG', phase: 'prepared_root' });
  owner.phase = 'active';
  const internals = runtime as unknown as {
    activationOwners: Map<string, CardActivationOwner>; runIdentity: object | null; currentCardId: string | null; status: string;
    settleResult(owner: CardActivationOwner, outcome: ReturnType<typeof terminalOutcome>): Promise<void>;
  };
  internals.activationOwners.set('project', owner);
  internals.runIdentity = {};
  internals.currentCardId = 'project';
  internals.status = 'running';
  return { internals, owner };
}

describe('Stage-I runtime lifecycle E2E', () => {
  it('parks an admitted child at Pause, resumes once, Stops without mutation, and starts a fresh activation in the same stable session on Run', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-stage-i-lifecycle-e2e-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'Execute', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running');
    cards.setStatus(child.id, 'running');
    const inputs: LlmInvocationInput[] = [];
    let releaseFirst!: () => void;
    const provider = scriptedAdmissionProvider(jest.fn(async (input: LlmInvocationInput, signal: AbortSignal) => {
      inputs.push(input);
      if (inputs.length === 1) return new Promise<ProviderTurnCompletion>((resolve) => { releaseFirst = () => resolve(complete(tool('write-status', 'write', { path: 'record:///status.md?card=project', content: 'work started' }))); });
      return new Promise<ProviderTurnCompletion>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }));
    const runtime = supervisor(projectRoot, cards, provider);

    const started = await runtime.startProject();
    if (!started.started) throw new Error('Run was not accepted.');
    expect(() => runtime.assertInterventionReady()).toThrow('Analyst mutation requires an intervention-ready stopped or settled paused runtime.');
    await waitUntil(() => inputs.length === 1);
    expect(runtime.getActorRuntimeReadModel().cards.map((entry) => entry.cardId)).toEqual(['project']);
    expect(runtime.getActorRuntimeReadModel()).not.toHaveProperty('agents');

    runtime.pause();
    expect(() => runtime.assertInterventionReady()).toThrow('Analyst mutation requires an intervention-ready stopped or settled paused runtime.');
    releaseFirst();
    await waitUntil(() => runtime.getStatus().status === 'paused');
    expect(() => runtime.assertInterventionReady()).not.toThrow();
    expect(inputs).toHaveLength(1);
    const paused = runtime.getRuntimeState();
    if (!paused) throw new Error('Paused runtime state missing.');
    runtime.resume();
    expect(() => runtime.assertInterventionReady()).toThrow('Analyst mutation requires an intervention-ready stopped or settled paused runtime.');
    await waitUntil(() => inputs.length === 2);
    expect(inputs[1]!.inputId).not.toBe(inputs[0]!.inputId);

    const durableBeforeStop = cards.list().map((card) => ({ id: card.id, status: card.lifecycle.status, version: card.version_seq }));
    await expect(runtime.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
    expect(() => runtime.assertInterventionReady()).not.toThrow();
    expect(cards.list().map((card) => ({ id: card.id, status: card.lifecycle.status, version: card.version_seq }))).toEqual(durableBeforeStop);

    const restarted = await runtime.startProject();
    if (!restarted.started) throw new Error('Restart Run was not accepted.');
    await waitUntil(() => inputs.length === 3);
    expect(inputs[2]!.sessionId).toBe('agent:planner:project');
    expect(inputs[2]!.inputId).not.toBe(inputs[1]!.inputId);
    expect(inputs[2]!.providerConversation.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'system', kind: 'synthetic_context', origin: 'recovery_notice', content: MODEL_RECOVERY_NOTICE_TEXT })]));
    expect(readConversation(projectRoot, 'agent:planner:project').physicalRows.filter((row) => row.kind === 'model_recovered')).toHaveLength(1);
    expect(cards.read(child.id)?.lifecycle.status).toBe('stopped');
    await expect(runtime.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
  });

  it('claims a running ancestor subtree before a late terminal callback and preserves done descendants', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-stage-i-cancel-e2e-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const active = cards.create({ type: 'code', parent: 'project', title: 'Active', bootstrap_content: 'Execute', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const done = cards.create({ type: 'test', parent: 'project', title: 'Done', bootstrap_content: 'Done', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus(done.id, 'running');
    cards.commitActivationOutcome(done.id, { status: 'done', summary: 'kept', result: workflowResult('DONE','kept') }, '2026-07-16T00:00:00.000Z');
    cards.setStatus('project', 'running');
    cards.setStatus(active.id, 'running');
    let releaseTerminal!: () => void;
    let calls = 0;
    const provider = scriptedAdmissionProvider(jest.fn(async (_input: LlmInvocationInput, signal: AbortSignal) => {
      calls += 1;
      if (calls === 1) return complete(tool('write-status', 'write', { path: 'record:///status.md?card=project', content: 'candidate' }));
      return new Promise<ProviderTurnCompletion>((resolve, reject) => {
        releaseTerminal = () => resolve(complete(tool('emit-late', 'emit_result', { outcome: 'done', summary: 'late' })));
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }));
    const runtime = supervisor(projectRoot, cards, provider);
    const started = await runtime.startProject();
    if (!started.started) throw new Error('Run was not accepted.');
    await waitUntil(() => typeof releaseTerminal === 'function');

    const cancellation = runtime.cancelCard('project', 'operator cancelled subtree');
    await expect(cancellation).resolves.toMatchObject({ card_id: 'project', status: 'cancelled', cancelled_card_ids: expect.arrayContaining([active.id, 'project']) });
    expect(cards.read(active.id)?.lifecycle.status).toBe('cancelled');
    expect(cards.read('project')?.lifecycle.status).toBe('cancelled');
    expect(cards.read(done.id)?.lifecycle.status).toBe('done');
    const versions = new Map(cards.list().map((card) => [card.id, card.version_seq]));
    releaseTerminal();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(new Map(cards.list().map((card) => [card.id, card.version_seq]))).toEqual(versions);
  });

  it.each([false, true])('stops a recovered leaf before an ancestor recovery failure when its exact notice already exists=%s', async (existingNotice) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-stage-i-recovery-order-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const leaf = cards.create({ type: 'code', parent: 'project', title: 'Interrupted leaf', bootstrap_content: 'Execute', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running');
    cards.setStatus(leaf.id, 'running');
    appendOpenMatchedRound(projectRoot, leaf.id);
    if (existingNotice) {
      expect(stabilizeAgentSession({ sessionId: `agent:executor:${leaf.id}`, conversations: { projectRoot }, terminalToolNames: new Set(['emit_result']) }).disposition).toBe('ordinary_interruption');
    }
    appendInvalidRootPlannerContinuation(projectRoot);
    const stop = jest.spyOn(cards, 'stopRunningForRecovery');
    const provider = scriptedAdmissionProvider(jest.fn(async () => { throw new Error('Recovery must fail before provider dispatch.'); }));
    const runtime = supervisor(projectRoot, cards, provider);

    await expect(runtime.startProject()).rejects.toThrow("Non-clean role session 'agent:planner:project' has no activation marker.");
    expect(stop.mock.calls.map(([cardId]) => cardId)).toEqual([leaf.id]);
    expect(cards.read(leaf.id)?.lifecycle.status).toBe('stopped');
    expect(cards.read('project')?.lifecycle.status).toBe('running');
    const leafRows = readConversation(projectRoot, `agent:executor:${leaf.id}`).physicalRows;
    expect(leafRows.filter((row) => row.kind === 'model_recovered')).toHaveLength(1);
    expect(leafRows.filter((row) => row.kind === 'tool_result')).toHaveLength(1);
  });

  it('rejects discontinuous Run topology before any recovery publication or descendant dispatch', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-stage-i-run-topology-reject-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const goal = cards.create({ type: 'goal', parent: 'project', title: 'Stopped gap', bootstrap_content: 'Plan', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const leaf = cards.create({ type: 'code', parent: goal.id, title: 'Ownerless running leaf', bootstrap_content: 'Execute', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running');
    cards.setStatus(leaf.id, 'running');
    const versions = new Map(cards.list().map((card) => [card.id, card.version_seq]));
    const stop = jest.spyOn(cards, 'stopRunningForRecovery');
    const providerCall = jest.fn(async () => { throw new Error('Invalid Run topology must not dispatch.'); });
    const runtime = supervisor(projectRoot, cards, scriptedAdmissionProvider(providerCall));

    await expect(runtime.startProject()).rejects.toThrow(`Linked running card '${leaf.id}' is outside the unique project-rooted running chain.`);
    expect(stop).not.toHaveBeenCalled();
    expect(providerCall).not.toHaveBeenCalled();
    expect(new Map(cards.list().map((card) => [card.id, card.version_seq]))).toEqual(versions);
  });

  it('rejects discontinuous durable topology before natural root publication without changing root bytes, version, or status', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-stage-i-natural-root-reject-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const goal = cards.create({ type: 'goal', parent: 'project', title: 'Stopped gap', bootstrap_content: 'Plan', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const leaf = cards.create({ type: 'code', parent: goal.id, title: 'Ownerless running leaf', bootstrap_content: 'Execute', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running');
    cards.setStatus(leaf.id, 'running');
    const rootBefore = cards.read('project')!;
    const bytesBefore = readFileSync(cardStreamFile(projectRoot, 'project'));
    const runtime = supervisor(projectRoot, cards, scriptedAdmissionProvider(jest.fn(async () => { throw new Error('Provider is unused.'); })));
    await runtime.start();
    const { internals, owner } = installRootSettlementOwner(runtime, rootBefore);

    await expect(internals.settleResult(owner, terminalOutcome())).rejects.toThrow(`Linked running card '${leaf.id}' is outside the unique project-rooted running chain.`);
    expect(readFileSync(cardStreamFile(projectRoot, 'project'))).toEqual(bytesBefore);
    expect(cards.read('project')).toMatchObject({ version_seq: rootBefore.version_seq, lifecycle: { status: 'running' } });
  });

  it('naturally publishes exactly one terminal root version for the valid project-only chain', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-stage-i-natural-root-valid-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const initialVersion = cards.read('project')!.version_seq;
    cards.setStatus('project', 'running');
    const runtime = supervisor(projectRoot, cards, scriptedAdmissionProvider(jest.fn(async () => { throw new Error('Provider is unused.'); })));
    await runtime.start();
    const { internals, owner } = installRootSettlementOwner(runtime, cards.read('project')!);

    await expect(internals.settleResult(owner, terminalOutcome())).resolves.toBeUndefined();
    expect(cards.read('project')).toMatchObject({ version_seq: initialVersion + 2, lifecycle: { status: 'done' } });
    const stream = readFileSync(cardStreamFile(projectRoot, 'project'), 'utf8');
    expect(stream.match(/"kind":"terminal"/g)).toHaveLength(1);
  });
});

function terminalOutcome() {
  return { status: 'done' as const, summary: 'complete', result: workflowResult('DONE', 'complete') };
}
