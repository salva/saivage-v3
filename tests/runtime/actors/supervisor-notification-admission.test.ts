import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NO_FRESHNESS_EFFECTS } from '../../../src/application/freshness-effects.js';
import { ConversationLLMActor } from '../../../src/runtime/actors/llm-actor.js';
import type { LLMProviderPort } from '../../../src/runtime/actors/llm-actor.js';
import { createSupervisorRuntimeApi } from '../../../src/runtime/actors/supervisor-runtime-api.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import { cardStreamFile } from '../../../src/persistence/layout.js';
import { CardService, initProjectTree } from '../../helpers/canonical-project.js';
import { scriptedAdmissionProvider, testAutonomousCompaction } from '../../helpers/llm-test-helpers.js';
import { createTestProcessRunner } from '../../helpers/test-process-runner.js';
import { createTestPromptTemplateRegistry } from '../../helpers/prompt-template-registry.js';
import { testApplicationFatalPort } from '../../helpers/test-application-fatal-port.js';
import type { CardActivationOwner } from '../../../src/runtime/actors/card-activation-owner.js';
import { ProviderTurnFailure } from '../../../src/agents/llm-contracts.js';
import { LlmRequestError } from '../../../src/contracts/llm-failure.js';
import type { ProviderExchangeAttempt } from '../../../src/contracts/provider-exchange.js';
import { readConversation, type ConversationFileContext } from '../../../src/persistence/conversation-file.js';
import { PublicationOutcomeUnknownError } from '../../../src/contracts/publication-outcome.js';
import { testApplicationFatalDelivery } from '../../helpers/test-application-fatal-port.js';
import type { ManagedProcessPlatform } from '../../../src/runtime/managed-process-group-registry.js';
import { bindRuntimeWorkflows, compileProjectWorkflows, type CompiledRuntimeWorkflows } from '../../../src/runtime/card-process/card-process-config.js';
import { ProviderRegistry } from '../../../src/agents/provider.js';
import { ModelRouter } from '../../../src/agents/model-router.js';
import { TEST_SAIVAGE_CONFIG } from '../../helpers/test-saivage-config.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for deterministic Supervisor test barrier.');
}

const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function harness(provider: LLMProviderPort, changes?: NonNullable<ConversationFileContext['changes']>, processPlatform?: ManagedProcessPlatform, workflows?: CompiledRuntimeWorkflows) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-notification-admission-'));
  roots.push(projectRoot);
  initProjectTree(projectRoot);
  const cards = new CardService(projectRoot);
  const processes = createTestProcessRunner(projectRoot, processPlatform);
  const supervisor = createSupervisorRuntimeApi({
    ...testAutonomousCompaction,
    ...(workflows ? { workflows } : {}),
    runtimeGate: new RuntimeGate(),
    projectRoot,
    processIdentity: { pid: 1, startedAt: '2026-09-09T00:00:00.000Z' },
    actorStore: cards,
    provider,
    conversations: { projectRoot, ...(changes ? { changes } : {}) },
    freshness: NO_FRESHNESS_EFFECTS,
    processRunner: processes.processRunner,
    runtimeProcessRootScope: processes.runtimeProcessRootScope,
    promptTemplates: createTestPromptTemplateRegistry(),
    fatalPort: testApplicationFatalPort,
  });
  return { projectRoot, cards, supervisor };
}

function owner(supervisor: ReturnType<typeof createSupervisorRuntimeApi>): CardActivationOwner {
  const current = (supervisor as unknown as { activationOwners: Map<string, CardActivationOwner> }).activationOwners.get('project');
  if (!current) throw new Error('Expected current project activation owner.');
  return current;
}

function notification() {
  return { id: 'closed-notification', content: 'must not be enqueued', created_at: '2026-09-09T00:00:01.000Z', source: 'test' };
}

function unverifiableProcessPlatform(): ManagedProcessPlatform {
  const child = Object.assign(new EventEmitter(), { pid: 4242, kill: jest.fn() }) as unknown as ChildProcess;
  return {
    spawn: () => child,
    probe: () => { throw Object.assign(new Error('process ownership cannot be verified'), { code: 'EPERM' }); },
    signal: () => { throw new Error('An unverifiable process group must not be signalled.'); },
  };
}

function workflowsWithExecutorNotification(): CompiledRuntimeWorkflows {
  const config = structuredClone(TEST_SAIVAGE_CONFIG);
  config.agents.executor!.tools = [...config.agents.executor!.tools, 'queue_notification'];
  const compiled = compileProjectWorkflows(config);
  const registry = new ProviderRegistry(config);
  return bindRuntimeWorkflows(compiled, new ModelRouter(registry), registry, config.compaction.context_utilization_fraction);
}

const candidate = { provider: 'test', account: null, model: 'test-model' } as const;
function refusal(inputId: string, raw: string): ProviderTurnFailure {
  const attempt: ProviderExchangeAttempt = { contract_id: 'test.v1', contract_name: 'test', transport: 'generic', provider: 'test', model: 'test-model', source_input_id: inputId, attempt_index: 0, request_params: { endpoint: 'https://example.invalid', method: 'POST', stream: false, offered_tools_count: 0, temperature: 0, max_tokens: 10 }, started_at: '2026-09-09T00:00:00.000Z', completed_at: '2026-09-09T00:00:01.000Z', status: 'error', terminal_tool_fired: null, error: { name: 'LlmRequestError', message: 'refused' } };
  return new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: [attempt], candidate, originalFailure: new LlmRequestError({ kind: 'content_policy', provider: 'test', message: 'refused', providerResponse: raw }) });
}

describe('Supervisor notification admission at terminal ownership', () => {
  it('queues first and interrupts only the exact live child suffix with a truthful stopped result', async () => {
    const childProviderEntered = deferred();
    const rootContinued = deferred();
    let childId = '';
    let plannerCalls = 0;
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.agentName === 'planner') {
        plannerCalls += 1;
        if (plannerCalls === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-child', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
        rootContinued.resolve();
        return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      childProviderEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] }).id;
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await childProviderEntered.promise;

    const submitted = await h.supervisor.submitNotification('project', { id: 'urgent-id', content: 'urgent correction', created_at: '2026-09-09T00:00:02.000Z', source: 'test' }, 'urgent');
    expect(submitted).toEqual({ queued: true, cardId: 'project', notificationId: 'urgent-id', interruption: { status: 'interrupted', stopped_card_ids: [childId] } });
    expect(h.cards.read(childId)).toMatchObject({ lifecycle: { status: 'stopped' } });
    const versions = h.cards.listCardVersions(childId);
    if (versions.kind !== 'found') throw new Error('Expected child version stream.');
    expect(versions.value.at(-1)?.change).toMatchObject({ change_reason: 'recovery stopped lifecycle' });
    expect(owner(h.supervisor)).toMatchObject({ cardId: 'project', terminalWinner: 'open', childCardId: null });
    await rootContinued.promise;
    expect(h.cards.read('project')?.lifecycle.status).toBe('running');
    const plannerRows = readConversation(h.projectRoot, 'agent:planner:project').sourceRows;
    const activationResult = plannerRows.find((row) => row.kind === 'tool_result' && row.tool_call_id === 'activate-child');
    expect(activationResult?.content).toContain('"outcome":"stopped"');
    expect(plannerRows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'activate-child')).toHaveLength(1);
    await h.supervisor.stopProject();
  });

  it('settles an intermediate waiting Planner and its active child deepest-first', async () => {
    const leafProviderEntered = deferred();
    const rootContinued = deferred();
    let goalId = '';
    let leafId = '';
    const plannerCalls = new Map<string, number>();
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.agentName === 'planner') {
        const call = (plannerCalls.get(input.sessionId) ?? 0) + 1;
        plannerCalls.set(input.sessionId, call);
        if (call === 1) {
          const cardId = input.sessionId === 'agent:planner:project' ? goalId : leafId;
          return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: `activate-${cardId}`, type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: cardId }) } }] }, provider_exchanges: [] };
        }
        if (input.sessionId !== 'agent:planner:project') throw new Error('Interrupted intermediate Planner continued after its stopped child settled.');
        rootContinued.resolve();
        return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      leafProviderEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    goalId = h.cards.create({ type: 'goal', parent: 'project', title: 'Goal', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] }).id;
    leafId = h.cards.create({ type: 'code', parent: goalId, title: 'Leaf', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] }).id;
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await leafProviderEntered.promise;

    await expect(h.supervisor.submitNotification('project', { id: 'deep-urgent', content: 'urgent correction', created_at: '2026-09-09T00:00:02.000Z', source: 'test' }, 'urgent')).resolves.toEqual({ queued: true, cardId: 'project', notificationId: 'deep-urgent', interruption: { status: 'interrupted', stopped_card_ids: [leafId, goalId] } });
    expect(h.cards.read(leafId)).toMatchObject({ lifecycle: { status: 'stopped' } });
    expect(h.cards.read(goalId)).toMatchObject({ lifecycle: { status: 'stopped' } });
    expect(plannerCalls.get(`agent:planner:${goalId}`)).toBe(1);
    await rootContinued.promise;
    const rootRows = readConversation(h.projectRoot, 'agent:planner:project').sourceRows;
    expect(rootRows.find((row) => row.kind === 'tool_result' && row.tool_call_id === `activate-${goalId}`)?.content).toContain('"outcome":"stopped"');
    await h.supervisor.stopProject();
  });

  it('settles a persisted descendant tool call as rejected before execution when interruption wins before executor entry', async () => {
    let childId = '';
    let h!: ReturnType<typeof harness>;
    let armed = false;
    let submission: Promise<unknown> | null = null;
    let plannerCalls = 0;
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.agentName === 'planner') {
        plannerCalls += 1;
        if (plannerCalls === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-child', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
        return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'parked-write', type: 'function' as const, function: { name: 'write', arguments: JSON.stringify({ path: `record:///implementation.md?card=${childId}`, content: 'must not be written' }) } }] }, provider_exchanges: [] };
    });
    const changes = {
      conversationChanged(target: Parameters<NonNullable<ConversationFileContext['changes']>['conversationChanged']>[0]): void {
        if (!armed || target.session_id !== `agent:executor:${childId}`) return;
        const rows = readConversation(h.projectRoot, target.session_id).sourceRows;
        if (rows.at(-1)?.kind !== 'tool_call') return;
        armed = false;
        submission = h.supervisor.submitNotification('project', { id: 'parked-boundary', content: 'interrupt before tool entry', created_at: '2026-09-09T00:00:02.000Z', source: 'test' }, 'urgent');
      },
      agentMembershipChanged(): void {},
    };
    h = harness(provider, changes);
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] }).id;
    armed = true;
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await waitFor(() => submission !== null);
    await expect(submission).resolves.toMatchObject({ queued: true, interruption: { status: 'interrupted', stopped_card_ids: [childId] } });

    const rows = readConversation(h.projectRoot, `agent:executor:${childId}`).sourceRows;
    const results = rows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'parked-write');
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toContain('Tool execution was cancelled before entry.');
    expect(results[0]!.content).not.toContain('must not be written');
    await h.supervisor.stopProject();
  });

  it('suppresses stale captured urgency without interrupting after the awaited lease identity changes during enqueue', async () => {
    const childProviderEntered = deferred();
    let childId = '';
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.agentName === 'planner') return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-child', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
      childProviderEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] }).id;
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await childProviderEntered.promise;
    const childOwner = (h.supervisor as unknown as { activationOwners: Map<string, CardActivationOwner> }).activationOwners.get(childId)!;
    const interrupt = jest.spyOn(childOwner.processor, 'interruptActivationGracefully');
    const originalEnqueue = h.cards.enqueueNotification.bind(h.cards);
    jest.spyOn(h.cards, 'enqueueNotification').mockImplementation((...args) => {
      const result = originalEnqueue(...args);
      childOwner.parentRelationship!.invocation.markSettling();
      return result;
    });

    await expect(h.supervisor.submitNotification('project', { id: 'stale-capture', content: 'retain only as queued context', created_at: '2026-09-09T00:00:02.000Z', source: 'test' }, 'urgent')).resolves.toEqual({ queued: true, cardId: 'project', notificationId: 'stale-capture', interruption: { status: 'suppressed', reason: 'stale_owner', stopped_card_ids: [] } });
    expect(interrupt).not.toHaveBeenCalled();
    expect(h.cards.read('project')?.pending_notifications.map((item) => item.id)).toContain('stale-capture');
    await h.supervisor.stopProject();
  });

  it('retains confirmed enqueue but suppresses interruption when Pause wins during enqueue', async () => {
    const childProviderEntered = deferred();
    let childId = '';
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.agentName === 'planner') return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-child', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
      childProviderEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] }).id;
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await childProviderEntered.promise;
    const childOwner = (h.supervisor as unknown as { activationOwners: Map<string, CardActivationOwner> }).activationOwners.get(childId)!;
    const interrupt = jest.spyOn(childOwner.processor, 'interruptActivationGracefully');
    const originalEnqueue = h.cards.enqueueNotification.bind(h.cards);
    jest.spyOn(h.cards, 'enqueueNotification').mockImplementation((...args) => {
      const result = originalEnqueue(...args);
      h.supervisor.pause();
      return result;
    });

    await expect(h.supervisor.submitNotification('project', { id: 'pause-during-enqueue', content: 'queued before pause suppression', created_at: '2026-09-09T00:00:02.000Z', source: 'test' }, 'urgent')).resolves.toEqual({ queued: true, cardId: 'project', notificationId: 'pause-during-enqueue', interruption: { status: 'suppressed', reason: 'runtime_ineligible', stopped_card_ids: [] } });
    expect(interrupt).not.toHaveBeenCalled();
    expect(h.cards.read('project')?.pending_notifications.map((item) => item.id)).toContain('pause-during-enqueue');
    await h.supervisor.stopProject();
  });

  it('routes uncertain enqueue to the publication-fatal boundary before interruption or later effects', async () => {
    const childProviderEntered = deferred();
    let childId = '';
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.agentName === 'planner') return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-child', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
      childProviderEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] }).id;
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await childProviderEntered.promise;
    const childOwner = (h.supervisor as unknown as { activationOwners: Map<string, CardActivationOwner> }).activationOwners.get(childId)!;
    const interrupt = jest.spyOn(childOwner.processor, 'interruptActivationGracefully');
    const stopRunning = jest.spyOn(h.cards, 'stopRunning');
    jest.spyOn(h.cards, 'enqueueNotification').mockImplementation(() => { throw new PublicationOutcomeUnknownError(); });

    await expect(h.supervisor.submitNotification('project', { id: 'unknown-enqueue', content: 'uncertain', created_at: '2026-09-09T00:00:02.000Z', source: 'test' }, 'urgent')).rejects.toBe(testApplicationFatalDelivery);
    expect(interrupt).not.toHaveBeenCalled();
    expect(stopRunning).not.toHaveBeenCalled();
  });

  it('rejects urgent submission when interrupted descendant direct-scope containment fails before handoff', async () => {
    const childWaiting = deferred();
    let childId = '';
    const calls = new Map<string, number>();
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      const call = (calls.get(input.sessionId) ?? 0) + 1;
      calls.set(input.sessionId, call);
      if (input.agentName === 'planner') {
        if (call === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-process-child', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
        return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      if (call === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'start-held-process', type: 'function' as const, function: { name: 'run_command', arguments: JSON.stringify({ command: 'held child process', wait: false }) } }] }, provider_exchanges: [] };
      childWaiting.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider, undefined, unverifiableProcessPlatform());
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Process child', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] }).id;
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await childWaiting.promise;

    await expect(h.supervisor.submitNotification('project', { id: 'urgent-before-process-failure', content: 'queued but not contained', created_at: '2026-09-09T00:00:02.000Z', source: 'test' }, 'urgent')).rejects.toThrow('unverifiable: Process-group probe failed: process ownership cannot be verified');
    await waitFor(() => h.supervisor.getStatus().status === 'error');

    expect(h.cards.read('project')?.pending_notifications.map((item) => item.id)).toContain('urgent-before-process-failure');
    expect(h.cards.read(childId)?.lifecycle.status).toBe('running');
    const versions = h.cards.listCardVersions(childId);
    if (versions.kind !== 'found') throw new Error('Expected child version stream.');
    expect(versions.value.some((version) => version.change?.change_reason === 'recovery stopped lifecycle')).toBe(false);
    expect(owner(h.supervisor).childCardId).toBe(childId);
  });

  it('lets a runtime halt take over an already claimed interruption without stopped publication or target continuation', async () => {
    const childProviderEntered = deferred();
    const interruptionJoinEntered = deferred();
    const releaseInterruptionJoin = deferred();
    let childId = '';
    let plannerCalls = 0;
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.agentName === 'planner') {
        plannerCalls += 1;
        if (plannerCalls === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-child', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
        throw new Error('Target Planner continued after runtime halt takeover.');
      }
      childProviderEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] }).id;
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await childProviderEntered.promise;
    const childOwner = (h.supervisor as unknown as { activationOwners: Map<string, CardActivationOwner> }).activationOwners.get(childId);
    if (!childOwner) throw new Error('Expected child activation owner.');
    const originalJoin = childOwner.processor.joinActivation.bind(childOwner.processor);
    jest.spyOn(childOwner.processor, 'joinActivation').mockImplementation(async () => {
      const joined = originalJoin();
      interruptionJoinEntered.resolve();
      await releaseInterruptionJoin.promise;
      return joined;
    });

    const submission = h.supervisor.submitNotification('project', { id: 'halt-race', content: 'urgent correction', created_at: '2026-09-09T00:00:02.000Z', source: 'test' }, 'urgent');
    await interruptionJoinEntered.promise;
    const stopping = h.supervisor.stopProject();
    releaseInterruptionJoin.resolve();
    await expect(submission).resolves.toMatchObject({ queued: true, notificationId: 'halt-race', interruption: { status: 'suppressed', reason: 'runtime_ineligible', stopped_card_ids: [] } });
    await expect(stopping).resolves.toEqual({ status: 'stopped', contained: true });
    expect(h.cards.read(childId)?.lifecycle.status).toBe('running');
    const versions = h.cards.listCardVersions(childId);
    if (versions.kind !== 'found') throw new Error('Expected child version stream.');
    expect(versions.value.some((version) => version.change?.change_reason === 'recovery stopped lifecycle')).toBe(false);
    expect(plannerCalls).toBe(1);
  });

  it('returns exact normal and urgent-inapplicable enqueue facts without inventing interruption', async () => {
    const providerEntered = deferred();
    const provider = scriptedAdmissionProvider(async (_input, signal) => {
      providerEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await providerEntered.promise;
    await expect(h.supervisor.submitNotification('project', { id: 'normal-id', content: 'normal', created_at: '2026-09-09T00:00:01.000Z' }, 'normal')).resolves.toMatchObject({ queued: true, interruption: { status: 'not_requested' } });
    await expect(h.supervisor.submitNotification('project', { id: 'urgent-own-turn', content: 'urgent', created_at: '2026-09-09T00:00:02.000Z' }, 'urgent')).resolves.toMatchObject({ queued: true, interruption: { status: 'not_applicable' } });
    await h.supervisor.stopProject();
  });

  it('retains a card notification caller through synchronous Stop and settles its known receipt without continuation', async () => {
    const resultPublished = deferred();
    const releaseConsumer = deferred();
    const originalSettlement = ConversationLLMActor.prototype.settleToolResultWithoutContinuation;
    jest.spyOn(ConversationLLMActor.prototype, 'settleToolResultWithoutContinuation').mockImplementation(function (this: ConversationLLMActor, ...args) {
      const settlement = originalSettlement.apply(this, args);
      return settlement.then(async (facts) => {
        resultPublished.resolve();
        await releaseConsumer.promise;
        return facts;
      });
    });
    let calls = 0;
    const provider = scriptedAdmissionProvider(async () => {
      calls += 1;
      if (calls !== 1) throw new Error('Planner continued after retained notification settlement.');
      return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'notify-before-stop', type: 'function' as const, function: { name: 'queue_notification', arguments: JSON.stringify({ card_id: 'project', kind: 'correction', body: 'known queued context', urgency: 'normal' }) } }] }, provider_exchanges: [] };
    });
    const h = harness(provider);
    const enqueue = h.cards.enqueueNotification.bind(h.cards);
    let stopping: Promise<unknown> | null = null;
    jest.spyOn(h.cards, 'enqueueNotification').mockImplementation((...args) => {
      const result = enqueue(...args);
      stopping = h.supervisor.stopProject();
      void stopping.catch(() => undefined);
      return result;
    });

    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await waitFor(() => stopping !== null);
    await resultPublished.promise;

    let stopSettled = false;
    void stopping!.finally(() => { stopSettled = true; });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    const rows = readConversation(h.projectRoot, 'agent:planner:project').sourceRows;
    expect(rows.filter((row) => row.kind === 'tool_call' && row.tool_call_id === 'notify-before-stop')).toHaveLength(1);
    const results = rows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'notify-before-stop');
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain('"queued":true');
    expect(calls).toBe(1);
    releaseConsumer.resolve();
    await expect(stopping!).resolves.toEqual({ status: 'stopped', contained: true });
  });

  it('keeps a matching queued receipt while the complete Stop owns later retained-consumer failure', async () => {
    const cleanupFailure = new Error('retained notification consumer cleanup failed');
    const resultPublished = deferred();
    const originalSettlement = ConversationLLMActor.prototype.settleToolResultWithoutContinuation;
    jest.spyOn(ConversationLLMActor.prototype, 'settleToolResultWithoutContinuation').mockImplementation(function (this: ConversationLLMActor, ...args) {
      return originalSettlement.apply(this, args).then((facts) => {
        resultPublished.resolve();
        throw cleanupFailure;
      });
    });
    let calls = 0;
    const provider = scriptedAdmissionProvider(async () => {
      calls += 1;
      if (calls !== 1) throw new Error('Planner continued after retained notification settlement.');
      return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'notify-before-failed-stop', type: 'function' as const, function: { name: 'queue_notification', arguments: JSON.stringify({ card_id: 'project', kind: 'correction', body: 'truth survives failed cleanup', urgency: 'normal' }) } }] }, provider_exchanges: [] };
    });
    const h = harness(provider);
    const enqueue = h.cards.enqueueNotification.bind(h.cards);
    let stopping: Promise<unknown> | null = null;
    jest.spyOn(h.cards, 'enqueueNotification').mockImplementation((...args) => {
      const result = enqueue(...args);
      stopping = h.supervisor.stopProject();
      void stopping.catch(() => undefined);
      return result;
    });

    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await resultPublished.promise;
    await expect(stopping!).rejects.toBe(cleanupFailure);

    const rows = readConversation(h.projectRoot, 'agent:planner:project').sourceRows;
    const results = rows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'notify-before-failed-stop');
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain('"queued":true');
    expect(h.supervisor.getStatus().status).toBe('error');
    expect(calls).toBe(1);
  });

  it('keeps a matching queued receipt while real direct-scope process containment fails Stop', async () => {
    let childId = '';
    const calls = new Map<string, number>();
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      const call = (calls.get(input.sessionId) ?? 0) + 1;
      calls.set(input.sessionId, call);
      if (input.agentName === 'planner') {
        if (call === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-notifying-child', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
        return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      if (call === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'held-process', type: 'function' as const, function: { name: 'run_command', arguments: JSON.stringify({ command: 'held test process', wait: false }) } }] }, provider_exchanges: [] };
      if (call === 2) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'notify-before-process-failure', type: 'function' as const, function: { name: 'queue_notification', arguments: JSON.stringify({ card_id: 'project', kind: 'correction', body: 'queued before containment failure', urgency: 'normal' }) } }] }, provider_exchanges: [] };
      throw new Error('Executor continued after retained notification settlement.');
    });
    const h = harness(provider, undefined, unverifiableProcessPlatform(), workflowsWithExecutorNotification());
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Notifying process child', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] }).id;
    const enqueue = h.cards.enqueueNotification.bind(h.cards);
    let stopping: Promise<unknown> | null = null;
    jest.spyOn(h.cards, 'enqueueNotification').mockImplementation((...args) => {
      const result = enqueue(...args);
      stopping = h.supervisor.stopProject();
      void stopping.catch(() => undefined);
      return result;
    });

    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await waitFor(() => stopping !== null);
    await expect(stopping!).rejects.toThrow('unverifiable: Process-group probe failed: process ownership cannot be verified');

    const rows = readConversation(h.projectRoot, `agent:executor:${childId}`).sourceRows;
    expect(rows.filter((row) => row.kind === 'tool_call' && row.tool_call_id === 'notify-before-process-failure')).toHaveLength(1);
    const results = rows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'notify-before-process-failure');
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain('"queued":true');
    const queued = h.cards.read('project')?.pending_notifications;
    expect(queued).toHaveLength(1);
    expect(results[0]?.content).toContain(`"notification_id":"${queued![0]!.id}"`);
    expect(h.supervisor.getStatus().status).toBe('error');
    expect(h.cards.read('project')?.lifecycle.status).toBe('running');
    expect(h.cards.read(childId)?.lifecycle.status).toBe('running');
    expect(calls.get(`agent:executor:${childId}`)).toBe(2);
  });

  it('rejects after the real result claim while durable state is still running and performs no card append', async () => {
    const held = deferred();
    const entered = deferred();
    const original = ConversationLLMActor.prototype.settleToolResultWithoutContinuation;
    jest.spyOn(ConversationLLMActor.prototype, 'settleToolResultWithoutContinuation').mockImplementation(function (this: ConversationLLMActor, ...args) {
      const settled = original.apply(this, args);
      entered.resolve();
      return settled.then(async (facts) => { await held.promise; return facts; });
    });
    let turn = 0;
    const provider = scriptedAdmissionProvider(async () => {
      turn += 1;
      return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: `call-${turn}`, type: 'function' as const, function: turn === 1
        ? { name: 'write', arguments: JSON.stringify({ path: 'record:///status.md?card=project', content: 'done' }) }
        : { name: 'emit_result', arguments: JSON.stringify({ outcome: 'complete_direct', summary: 'done' }) } }] }, provider_exchanges: [] };
    });
    const h = harness(provider);
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await entered.promise;
    expect(owner(h.supervisor).terminalWinner).toBe('result');
    expect(h.cards.read('project')?.lifecycle.status).toBe('running');
    const versions = h.cards.listCardVersions('project');
    const bytes = readFileSync(cardStreamFile(h.projectRoot, 'project'));
    const enqueue = jest.spyOn(h.cards, 'enqueueNotification');
    expect(h.supervisor.notifyCard('project', notification())).toEqual({ ok: false, reason: 'activation_closed', cardId: 'project' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(h.cards.listCardVersions('project')).toEqual(versions);
    expect(readFileSync(cardStreamFile(h.projectRoot, 'project'))).toEqual(bytes);
    held.resolve();
    await waitFor(() => h.supervisor.getStatus().status === 'stopped');
    expect(h.cards.read('project')?.lifecycle.status).toBe('done');
  });

  it('rejects after the real cancellation claim while durable state is still running and performs no card append', async () => {
    const providerEntered = deferred();
    const provider = scriptedAdmissionProvider(async (_input: unknown, signal: AbortSignal) => {
      providerEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const held = deferred();
    const joinEntered = deferred();
    const h = harness(provider);
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await providerEntered.promise;
    const processor = owner(h.supervisor).processor;
    const originalJoin = processor.joinActivation.bind(processor);
    jest.spyOn(processor, 'joinActivation').mockImplementation(() => {
      const joined = originalJoin();
      joinEntered.resolve();
      return joined.then(async (value) => { await held.promise; return value; });
    });
    const cancellation = h.supervisor.cancelCard('project', 'cancel test');
    await joinEntered.promise;
    expect(owner(h.supervisor).terminalWinner).toBe('cancel');
    expect(h.cards.read('project')?.lifecycle.status).toBe('running');
    const versions = h.cards.listCardVersions('project');
    const bytes = readFileSync(cardStreamFile(h.projectRoot, 'project'));
    const enqueue = jest.spyOn(h.cards, 'enqueueNotification');
    expect(h.supervisor.notifyCard('project', notification())).toEqual({ ok: false, reason: 'activation_closed', cardId: 'project' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(h.cards.listCardVersions('project')).toEqual(versions);
    expect(readFileSync(cardStreamFile(h.projectRoot, 'project'))).toEqual(bytes);
    held.resolve();
    await expect(cancellation).resolves.toEqual({ card_id: 'project', status: 'cancelled', cancelled_card_ids: ['project'] });
    expect(h.cards.read('project')?.lifecycle.status).toBe('cancelled');
  });

  it('delivers an open-admission notification through accepted emit-result arbitration before a later result settles', async () => {
    const terminalCandidateHeld = deferred();
    const terminalCandidateRequested = deferred();
    const observedInputs: string[] = [];
    let turn = 0;
    const provider = scriptedAdmissionProvider(async (input) => {
      observedInputs.push(JSON.stringify(input));
      turn += 1;
      if (turn === 2) { terminalCandidateRequested.resolve(); await terminalCandidateHeld.promise; }
      return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: `call-${turn}`, type: 'function' as const, function: turn === 1
        ? { name: 'write', arguments: JSON.stringify({ path: 'record:///status.md?card=project', content: 'done' }) }
        : { name: 'emit_result', arguments: JSON.stringify({ outcome: 'complete_direct', summary: 'done' }) } }] }, provider_exchanges: [] };
    });
    const h = harness(provider);
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await terminalCandidateRequested.promise;
    expect(owner(h.supervisor).terminalWinner).toBe('open');
    expect(h.supervisor.notifyCard('project', { id: 'admitted-id', content: 'distinct admitted context', created_at: '2026-09-09T00:00:02.000Z' })).toEqual({ ok: true, notificationId: 'admitted-id' });
    terminalCandidateHeld.resolve();
    await waitFor(() => h.supervisor.getStatus().status === 'stopped');
    expect(turn).toBe(3);
    expect(observedInputs[2]).toContain('distinct admitted context');
    expect(h.cards.read('project')).toMatchObject({ lifecycle: { status: 'done' }, pending_notifications: [] });
  });

  it('keeps Planner notifications from Reviewer and conditionally repeats accepted review through the Planner handler', async () => {
    const reviewApprovalRequested = deferred();
    const releaseReviewApproval = deferred();
    const observed = new Map<string, string[]>();
    const calls = new Map<string, number>();
    const provider = scriptedAdmissionProvider(async (input) => {
      const agent = input.agentName;
      const call = (calls.get(agent) ?? 0) + 1;
      calls.set(agent, call);
      const inputs = observed.get(agent) ?? [];
      inputs.push(JSON.stringify(input));
      observed.set(agent, inputs);
      if (agent === 'reviewer' && call === 2) { reviewApprovalRequested.resolve(); await releaseReviewApproval.promise; }
      const definition = agent === 'planner'
        ? call % 2 === 1
          ? { name: 'write', arguments: JSON.stringify({ path: 'record:///status.md?card=project', content: `planner status ${call}` }) }
          : { name: 'emit_result', arguments: JSON.stringify({ outcome: 'admit_review', summary: `planner review request ${call}` }) }
        : call % 2 === 1
          ? { name: 'write', arguments: JSON.stringify({ path: 'record:///review.md?card=project', content: `review evidence ${call}` }) }
          : { name: 'emit_result', arguments: JSON.stringify({ outcome: 'approved', summary: `review approved ${call}` }) };
      return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: `${agent}-${call}`, type: 'function' as const, function: definition }] }, provider_exchanges: [] };
    });
    const h = harness(provider);
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await reviewApprovalRequested.promise;
    expect(h.supervisor.notifyCard('project', { id: 'planner-only', content: 'planner designated context', created_at: '2026-09-09T00:00:02.000Z' })).toEqual({ ok: true, notificationId: 'planner-only' });
    const closeRecord = h.cards.closeRecord.bind(h.cards);
    let injectedDuringClose = false;
    jest.spyOn(h.cards, 'closeRecord').mockImplementation((...args) => {
      const result = closeRecord(...args);
      if (!injectedDuringClose && args[1] === 'review.md' && h.cards.read('project')!.pending_notifications.length > 0) {
        injectedDuringClose = true;
        expect(h.supervisor.notifyCard('project', { id: 'during-close', content: 'context admitted during accepted record close', created_at: '2026-09-09T00:00:03.000Z' })).toEqual({ ok: true, notificationId: 'during-close' });
      }
      return result;
    });
    releaseReviewApproval.resolve();
    await waitFor(() => h.supervisor.getStatus().status === 'stopped');
    expect(calls).toEqual(new Map([['planner', 4], ['reviewer', 6]]));
    expect(observed.get('reviewer')!.join('\n')).not.toContain('planner designated context');
    expect(observed.get('planner')![2]).toContain('planner designated context');
    expect(observed.get('planner')![2]).toContain('context admitted during accepted record close');
    expect(h.cards.read('project')).toMatchObject({ lifecycle: { status: 'done' }, pending_notifications: [] });
  });

  it('allows preclaim enqueue and intentionally clears it through cancellation without delivery', async () => {
    const providerEntered = deferred();
    const observedInputs: string[] = [];
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      observedInputs.push(JSON.stringify(input));
      providerEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await providerEntered.promise;
    expect(owner(h.supervisor).terminalWinner).toBe('open');
    expect(h.supervisor.notifyCard('project', { id: 'preclaim-cancel', content: 'not delivered before cancel', created_at: '2026-09-09T00:00:03.000Z' })).toEqual({ ok: true, notificationId: 'preclaim-cancel' });
    expect(h.cards.read('project')?.pending_notifications).toHaveLength(1);
    await expect(h.supervisor.cancelCard('project', 'cancel after admission')).resolves.toMatchObject({ status: 'cancelled' });
    expect(h.cards.read('project')?.pending_notifications).toEqual([]);
    expect(observedInputs.join('\n')).not.toContain('not delivered before cancel');
  });

  it('allows preclaim enqueue and intentionally clears it on ordinary execution failure without delivery', async () => {
    const providerEntered = deferred();
    const release = deferred();
    const observedInputs: string[] = [];
    const provider = scriptedAdmissionProvider(async (input) => {
      observedInputs.push(JSON.stringify(input));
      providerEntered.resolve();
      await release.promise;
      throw new Error('ordinary execution failure');
    });
    const h = harness(provider);
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await providerEntered.promise;
    expect(h.supervisor.notifyCard('project', { id: 'preclaim-failure', content: 'not delivered before failure', created_at: '2026-09-09T00:00:04.000Z' })).toEqual({ ok: true, notificationId: 'preclaim-failure' });
    release.resolve();
    await waitFor(() => h.supervisor.getStatus().status === 'stopped');
    expect(h.cards.read('project')).toMatchObject({ lifecycle: { status: 'failed' }, pending_notifications: [] });
    expect(observedInputs.join('\n')).not.toContain('not delivered before failure');
  });

  it('allows preclaim enqueue and intentionally clears it on a real content-policy BLOCKED outcome without delivery', async () => {
    const providerEntered = deferred();
    const release = deferred();
    const observedInputs: string[] = [];
    let turn = 0;
    const provider = { ...scriptedAdmissionProvider(async (input) => {
      observedInputs.push(JSON.stringify(input));
      turn += 1;
      if (turn === 1) { providerEntered.resolve(); await release.promise; }
      throw refusal(input.inputId, turn === 1 ? 'first refusal' : 'second refusal');
    }), projectProviderExchanges() {} };
    const h = harness(provider);
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await providerEntered.promise;
    expect(h.supervisor.notifyCard('project', { id: 'preclaim-blocked', content: 'not delivered before blocked', created_at: '2026-09-09T00:00:05.000Z' })).toEqual({ ok: true, notificationId: 'preclaim-blocked' });
    release.resolve();
    await waitFor(() => h.supervisor.getStatus().status === 'stopped');
    expect(turn).toBe(2);
    expect(h.cards.read('project')).toMatchObject({ lifecycle: { status: 'blocked' }, pending_notifications: [] });
    expect(observedInputs.join('\n')).not.toContain('not delivered before blocked');
  });
});
