import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService } from '../../../src/cards/card-service.js';
import { RuntimeInterventionBinding } from '../../../src/application/intervention-readiness.js';
import { ReadModelChangeBroadcaster } from '../../../src/application/read-model-changes.js';
import { CardsReadModelService } from '../../../src/application/read-models/cards-read-model.js';
import { ManagedProcessGroupRegistry } from '../../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../../src/runtime/process-runner.js';
import type { CardActor } from '../../../src/runtime/actors/card-actor.js';
import type { ActiveCardLeaf } from '../../../src/runtime/active-card-leaf.js';
import { SupervisorRuntimeApi } from '../../../src/runtime/actors/supervisor-runtime-api.js';
import { RuntimeContainmentError, RuntimeStoppedInterruption } from '../../../src/runtime/actors/runtime-stopped-interruption.js';
import type { InvocationJoinOutcome } from '../../../src/runtime/actors/invocation-lifecycle.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import type { LlmCompleteResult, ProviderTurnCompletion } from '../../../src/agents/llm-contracts.js';
import { initProjectTree } from '../../helpers/canonical-project.js';
import { EventBus, type DomainEvent } from '../../../src/events/index.js';
import { testAutonomousCompaction } from '../../helpers/llm-test-helpers.js';
import { appendConversationBatch, readConversation } from '../../../src/persistence/conversation-file.js';
import { ReconstructedActivationResultAppendError } from '../../../src/runtime/actors/conversation-recovery.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function complete(result: LlmCompleteResult): ProviderTurnCompletion { return { result, provider_exchanges: [] }; }
function tool(id: string, name: string, args: object): LlmCompleteResult { return { kind: 'tool_calls', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }; }
async function waitUntil(predicate: () => boolean): Promise<void> { for (let attempt = 0; attempt < 500; attempt += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } throw new Error('condition not reached'); }

function appendInterruptedCall(projectRoot: string, cardId: string, childCardId: string, ordinal: string): void {
  const sessionId = `planner:${cardId}` as const;
  const sourceInputId = `${ordinal.repeat(8)}-${ordinal.repeat(4)}-4${ordinal.repeat(3)}-8${ordinal.repeat(3)}-${ordinal.repeat(12)}`;
  const callId = `activate-${childCardId}`;
  appendConversationBatch(projectRoot, [
    { id: `${sessionId}:activation:old`, session_id: sessionId, role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', role: 'planner', card_id: cardId, input_id: sourceInputId, timestamp: '2026-07-18T00:00:00.000Z' }), round_id: `r-pre-${ordinal.repeat(32)}`, message_index: 0, block_index: 0, timestamp: '2026-07-18T00:00:00.000Z' },
    { id: `${sourceInputId}:tool-call:${callId}`, session_id: sessionId, role: 'assistant', kind: 'tool_call', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childCardId }) } }] }), tool: 'activate_card', tool_call_id: callId, round_id: `r-assistant-${ordinal.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-07-18T00:00:00.001Z' },
  ]);
}

type SupervisorInternals = {
  runIdentity: object | null;
  currentness: ActiveCardLeaf;
  liveCardActors: Map<string, CardActor>;
  cardActors: Map<string, CardActor>;
};

type ProjectionSnapshot = {
  status: ReturnType<SupervisorRuntimeApi['getStatus']>;
  runtimeCardId: string | null;
  cards: string[];
  agents: Array<{ agentId: string; phase: string }>;
  index: { total: number; byStatus: Record<string, number>; byType: Record<string, number> };
  readiness: string;
};

function projectionSnapshot(projectRoot: string, cards: CardService, supervisor: SupervisorRuntimeApi, intervention: RuntimeInterventionBinding): ProjectionSnapshot {
  const actorRuntime = supervisor.getActorRuntimeReadModel();
  const index = new CardsReadModelService(projectRoot, cards, supervisor).getRuntimeState().body.cardIndex;
  return {
    status: supervisor.getStatus(),
    runtimeCardId: supervisor.getRuntimeState()?.active_card_run?.card_id ?? null,
    cards: actorRuntime.cards.map(({ cardId }) => cardId),
    agents: actorRuntime.agents.map(({ agentId, phase }) => ({ agentId, phase })),
    index,
    readiness: intervention.interventionReadiness(),
  };
}

async function startRunningRoot(projectRoot: string) {
  initProjectTree(projectRoot);
  const cards = new CardService(projectRoot);
  cards.setStatus('project', 'running');
  const intervention = new RuntimeInterventionBinding();
  const provider = {
    completeTurn: (_input: LlmInvocationInput, signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  };
  const processRunner = new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry());
  jest.spyOn(processRunner, 'terminateScopeTree').mockResolvedValue({ selected: [], stopped: [], failed: [] });
  const changes = new ReadModelChangeBroadcaster();
  const supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction,
    projectRoot, actorStore: cards, interventionBinding: intervention, provider,
    conversations: { projectRoot }, appLogs: { projectRoot },
    readModelChanges: changes,
    processRunner, promptTemplates: { render: () => 'test prompt' },
  });
  const prepared = await supervisor.beginStartProject();
  if (!prepared.accepted) throw new Error('runtime start was not accepted');
  supervisor.launchStartedProject(prepared.state);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const internals = supervisor as unknown as SupervisorInternals;
  const identity = internals.runIdentity;
  const owner = internals.liveCardActors.get('project');
  const processor = owner?.processor;
  if (!identity || !owner || !processor) throw new Error('running root ownership was not installed');
  return { cards, intervention, supervisor, internals, identity, owner, processor, changes };
}

describe('Supervisor running-chain and non-domain Stop', () => {
  let projectRoot: string;
  afterEach(() => { if (projectRoot) rmSync(projectRoot, { recursive: true, force: true }); });

  it('publishes launch ownership boundaries in exact synchronous projection order and Stop only after complete clearing', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-projection-order-'));
    initProjectTree(projectRoot);
    const changes = new ReadModelChangeBroadcaster();
    const cards = new CardService(projectRoot, undefined, changes);
    cards.setStatus('project', 'running');
    const intervention = new RuntimeInterventionBinding();
    const processRunner = new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry());
    jest.spyOn(processRunner, 'terminateScopeTree').mockResolvedValue({ selected: [], stopped: [], failed: [] });
    let supervisor!: SupervisorRuntimeApi;
    const snapshots: ProjectionSnapshot[] = [];
    changes.subscribe({
      runtimeChanged: () => snapshots.push(projectionSnapshot(projectRoot, cards, supervisor, intervention)),
      cardStateChanged: () => undefined,
      agentsChanged: () => undefined,
      conversationChanged: () => undefined,
    });
    supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction,
      projectRoot, actorStore: cards, interventionBinding: intervention,
      provider: { completeTurn: (_input, signal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) },
      conversations: { projectRoot }, appLogs: { projectRoot }, readModelChanges: changes,
      processRunner, promptTemplates: { render: () => 'test prompt' },
    });
    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('runtime start was not accepted');
    snapshots.length = 0;

    supervisor.launchStartedProject(prepared.state);
    expect(snapshots.slice(0, 3)).toMatchObject([
      { status: { status: 'running', currentCardId: null }, runtimeCardId: null, cards: [], agents: [], readiness: 'not_ready' },
      { status: { status: 'running', currentCardId: null }, runtimeCardId: null, cards: ['project'], agents: [], readiness: 'not_ready' },
      { status: { status: 'running', currentCardId: 'project' }, runtimeCardId: 'project', cards: ['project'], agents: [], readiness: 'not_ready' },
    ]);

    await waitUntil(() => snapshots.some(({ agents }) => agents.length === 1));
    const insertion = snapshots.find(({ agents }) => agents.length === 1)!;
    expect(insertion.agents[0]?.phase).toBe('idle');
    await waitUntil(() => snapshots.some(({ agents }) => agents[0]?.phase === 'calling_provider'));

    snapshots.length = 0;
    await expect(supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
    expect(snapshots[0]).toMatchObject({ status: { status: 'closing', currentCardId: 'project' }, runtimeCardId: 'project', cards: ['project'] });
    expect(snapshots.some(({ status, cards, agents }) => status.status === 'closing' && cards.includes('project') && agents.length === 0)).toBe(true);
    expect(snapshots.at(-1)).toMatchObject({ status: { status: 'stopped', currentCardId: null }, runtimeCardId: null, cards: [], agents: [], readiness: 'stopped' });
  });

  it('publishes root admission through CardService before a later launch failure', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-root-admission-order-'));
    initProjectTree(projectRoot);
    const changes = new ReadModelChangeBroadcaster();
    const cards = new CardService(projectRoot, undefined, changes);
    const intervention = new RuntimeInterventionBinding();
    let supervisor!: SupervisorRuntimeApi;
    const snapshots: ProjectionSnapshot[] = [];
    changes.subscribe({
      runtimeChanged: () => snapshots.push(projectionSnapshot(projectRoot, cards, supervisor, intervention)),
      cardStateChanged: () => undefined,
      agentsChanged: () => undefined,
      conversationChanged: () => undefined,
    });
    supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction,
      projectRoot, actorStore: cards, interventionBinding: intervention,
      provider: { completeTurn: async () => { throw new Error('not reached'); } }, conversations: { projectRoot }, appLogs: { projectRoot },
      readModelChanges: changes, processRunner: new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry()), promptTemplates: { render: () => 'test prompt' },
    });

    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('runtime start was not accepted');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      status: { status: 'stopped', currentCardId: null },
      runtimeCardId: null,
      index: { total: 1, byStatus: { running: 1 }, byType: { project: 1 } },
    });
    const internals = supervisor as unknown as SupervisorInternals;
    internals.liveCardActors.set('unprojected-extra', { cardId: 'unprojected-extra' } as CardActor);

    expect(() => supervisor.launchStartedProject(prepared.state)).toThrow('ownership installation is incomplete');
    expect(snapshots.slice(1)).toMatchObject([
      { status: { status: 'running', currentCardId: null }, runtimeCardId: null, cards: [] },
      { status: { status: 'running', currentCardId: null }, runtimeCardId: null, cards: ['project'] },
    ]);
    expect(supervisor.getStatus()).toMatchObject({ status: 'running', currentCardId: null });
    expect(supervisor.getRuntimeState()).toBeNull();
    expect(supervisor.getActorRuntimeReadModel().cards.map(({ cardId }) => cardId)).toEqual(['project']);
  });

  it('publishes closing before synchronous Stop owner validation failure and never publishes stopped', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-stop-setup-failure-'));
    const { supervisor, internals, owner, changes } = await startRunningRoot(projectRoot);
    const snapshots: Array<ReturnType<SupervisorRuntimeApi['getStatus']>> = [];
    changes.subscribe({
      runtimeChanged: () => snapshots.push(supervisor.getStatus()), cardStateChanged: () => undefined, agentsChanged: () => undefined, conversationChanged: () => undefined,
    });
    internals.liveCardActors.set('duplicate-owner', owner);

    expect(() => supervisor.stopProject()).toThrow('duplicate card ownership');
    expect(snapshots).toEqual([expect.objectContaining({ status: 'closing', currentCardId: 'project' })]);
    expect(snapshots.some(({ status }) => status === 'stopped')).toBe(false);
  });

  it('replaces the continuation leaf without publishing an intermediate null', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-continuation-currentness-'));
    initProjectTree(projectRoot);
    const changes = new ReadModelChangeBroadcaster();
    const cards = new CardService(projectRoot, undefined, changes);
    const child = cards.create({ type: 'code', parent: 'project', title: 'next leaf', brief: 'continue', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    cards.setStatus('project', 'running');
    const intervention = new RuntimeInterventionBinding();
    let supervisor!: SupervisorRuntimeApi;
    const snapshots: ProjectionSnapshot[] = [];
    changes.subscribe({ runtimeChanged: () => snapshots.push(projectionSnapshot(projectRoot, cards, supervisor, intervention)), cardStateChanged: () => undefined, agentsChanged: () => undefined, conversationChanged: () => undefined });
    supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction,
      projectRoot, actorStore: cards, interventionBinding: intervention,
      provider: { completeTurn: (_input, signal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) },
      conversations: { projectRoot }, appLogs: { projectRoot }, readModelChanges: changes,
      processRunner: new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry()), promptTemplates: { render: () => 'test prompt' },
    });
    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('runtime start was not accepted');
    supervisor.launchStartedProject(prepared.state);
    const internals = supervisor as unknown as SupervisorInternals;
    const rootOwner = internals.cardActors.get('project')!;
    (supervisor as unknown as { releaseSettledActor(actor: CardActor): void }).releaseSettledActor(rootOwner);
    cards.setStatus(child.id, 'running');
    snapshots.length = 0;

    (supervisor as unknown as { continueRunningChain(identity: object): void }).continueRunningChain(internals.runIdentity!);
    expect(snapshots.slice(0, 2)).toMatchObject([
      { status: { currentCardId: 'project' }, runtimeCardId: 'project', cards: [child.id] },
      { status: { currentCardId: child.id }, runtimeCardId: child.id, cards: [child.id] },
    ]);
    expect(snapshots.some(({ status }) => status.currentCardId === null)).toBe(false);
  });

  it('publishes pausing, paused, and completed resume boundaries after each owned mutation', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-pause-resume-order-'));
    const { supervisor, changes } = await startRunningRoot(projectRoot);
    const statuses: string[] = [];
    changes.subscribe({ runtimeChanged: () => statuses.push(supervisor.getStatus().status), cardStateChanged: () => undefined, agentsChanged: () => undefined, conversationChanged: () => undefined });

    expect(supervisor.beginPause()).toMatchObject({ settled: false, patch: { status: 'pausing' } });
    const gate = (supervisor as unknown as { runtimeGate: import('../../../src/runtime/runtime-gate.js').RuntimeGate }).runtimeGate;
    const parked = gate.waitUntilOpen(new AbortController().signal);
    expect(statuses).toEqual(['pausing', 'paused']);
    const current = supervisor.getRuntimeState();
    if (!current) throw new Error('paused runtime state is missing');
    supervisor.beginResume(current);
    supervisor.finishResume();
    await parked;
    expect(statuses).toEqual(['pausing', 'paused', 'running']);
    await expect(supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
  });

  it('releases a naturally completed actor from both ownership maps and the actor read model', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-natural-settlement-'));
    initProjectTree(projectRoot);
    const changes = new ReadModelChangeBroadcaster();
    const cards = new CardService(projectRoot, undefined, changes);
    const intervention = new RuntimeInterventionBinding();
    let call = 0;
    let releaseTerminal!: () => void;
    const provider = { completeTurn: jest.fn(async () => {
      call += 1;
      if (call === 1) return complete(tool('write-status', 'write', { path: 'record:///status.md?v=next', content: 'Ready.' }));
      return new Promise<ProviderTurnCompletion>((resolve) => { releaseTerminal = () => resolve(complete(tool('emit-done', 'emit_result', { status: 'done', summary: 'Complete.' }))); });
    }) };
    let supervisor!: SupervisorRuntimeApi;
    const snapshots: ProjectionSnapshot[] = [];
    changes.subscribe({ runtimeChanged: () => snapshots.push(projectionSnapshot(projectRoot, cards, supervisor, intervention)), cardStateChanged: () => undefined, agentsChanged: () => undefined, conversationChanged: () => undefined });
    supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction,
      projectRoot, actorStore: cards, interventionBinding: intervention, provider,
      conversations: { projectRoot }, appLogs: { projectRoot },
      readModelChanges: changes,
      processRunner: new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry()), promptTemplates: { render: () => 'test prompt' },
    });
    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('runtime start was not accepted');
    supervisor.launchStartedProject(prepared.state);
    const runningVersion = cards.read('project')!.version_seq;
    await waitUntil(() => releaseTerminal !== undefined);
    const internals = supervisor as unknown as SupervisorInternals;
    const owner = internals.cardActors.get('project');
    if (!owner) throw new Error('root actor ownership was not installed');
    expect(internals.liveCardActors.get('project')).toBe(owner);
    expect(supervisor.getActorRuntimeReadModel()).toMatchObject({ cards: [{ cardId: 'project' }], agents: [{ cardId: 'project', role: 'planner' }] });

    releaseTerminal();
    await waitUntil(() => supervisor.getStatus().status === 'stopped');

    expect(cards.read('project')).toMatchObject({ status: 'done', version_seq: runningVersion + 1, lifecycle: { result: { kind: 'done', summary: 'Complete.' } } });
    expect(cards.listCardHistory('project').filter((entry) => entry.change_reason === 'terminal lifecycle commit')).toHaveLength(1);
    expect(internals.liveCardActors.has('project')).toBe(false);
    expect(internals.cardActors.has('project')).toBe(false);
    expect(supervisor.getActorRuntimeReadModel()).toMatchObject({ cards: [], agents: [] });
    expect(supervisor.getStatus()).toMatchObject({ status: 'stopped', currentCardId: null });
    expect(intervention.interventionReadiness()).toBe('stopped');
    expect(snapshots.at(-1)).toMatchObject({ status: { status: 'stopped', currentCardId: null }, runtimeCardId: null, cards: [], agents: [], readiness: 'stopped' });
  });

  it('publishes natural failed completion only after failed status and empty ownership are visible', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-natural-failure-'));
    initProjectTree(projectRoot);
    const changes = new ReadModelChangeBroadcaster();
    const cards = new CardService(projectRoot, undefined, changes);
    const intervention = new RuntimeInterventionBinding();
    let call = 0;
    const provider = { completeTurn: jest.fn(async () => {
      call += 1;
      return call === 1
        ? complete(tool('write-status', 'write', { path: 'record:///status.md?v=next', content: 'Failed.' }))
        : complete(tool('emit-failed', 'emit_result', { status: 'failed', summary: 'Failed.' }));
    }) };
    let supervisor!: SupervisorRuntimeApi;
    const snapshots: ProjectionSnapshot[] = [];
    changes.subscribe({ runtimeChanged: () => snapshots.push(projectionSnapshot(projectRoot, cards, supervisor, intervention)), cardStateChanged: () => undefined, agentsChanged: () => undefined, conversationChanged: () => undefined });
    supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction,
      projectRoot, actorStore: cards, interventionBinding: intervention, provider,
      conversations: { projectRoot }, appLogs: { projectRoot }, readModelChanges: changes,
      processRunner: new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry()), promptTemplates: { render: () => 'test prompt' },
    });
    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('runtime start was not accepted');
    supervisor.launchStartedProject(prepared.state);
    const runningVersion = cards.read('project')!.version_seq;
    await waitUntil(() => supervisor.getStatus().status === 'stopped');

    expect(cards.read('project')).toMatchObject({ status: 'failed', version_seq: runningVersion + 1 });
    expect(cards.listCardHistory('project').filter((entry) => entry.change_reason === 'terminal lifecycle commit')).toHaveLength(1);
    expect(snapshots.at(-1)).toMatchObject({ status: { status: 'stopped', currentCardId: null }, runtimeCardId: null, cards: [], agents: [], readiness: 'stopped', index: { byStatus: { failed: 1 } } });
  });

  it('rejects stale settled-actor release without changing current ownership', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-stale-settlement-'));
    const { supervisor, internals, owner } = await startRunningRoot(projectRoot);
    const stale = { cardId: 'project' } as CardActor;
    const release = (supervisor as unknown as { releaseSettledActor(actor: CardActor): void }).releaseSettledActor.bind(supervisor);

    expect(() => release(stale)).toThrow("Card 'project' settled actor ownership changed unexpectedly.");
    expect(internals.liveCardActors.get('project')).toBe(owner);
    expect(internals.cardActors.get('project')).toBe(owner);
    await expect(supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
  });

  it('replaces every running-chain owner on Stop then Run while reusing only the stable executor session', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-lifecycle-'));
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const goal = cards.create({
      type: 'goal', parent: 'project', title: 'goal', brief: 'plan', status: 'backlog', tags: [], priority: 0,
      urgency: 'normal', created_by: 'analyst', depends_on: [], related: [],
    });
    const terminal = cards.create({
      type: 'code', parent: goal.id, title: 'deepest', brief: 'execute', status: 'backlog', tags: [], priority: 0,
      urgency: 'normal', created_by: 'analyst', depends_on: [], related: [],
    });
    cards.setStatus('project', 'running');
    cards.setStatus(goal.id, 'running');
    cards.setStatus(terminal.id, 'running');
    const invocations: LlmInvocationInput[] = [];
    const provider = {
      completeTurn: jest.fn((input: LlmInvocationInput, signal: AbortSignal) => {
        invocations.push(input);
        return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }),
    };
    const processRunner = new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry());
    const supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction,
      projectRoot,
      actorStore: cards,
      interventionBinding: new RuntimeInterventionBinding(),
      provider,
      conversations: { projectRoot },
      appLogs: { projectRoot },
      readModelChanges: { runtimeChanged() {}, cardStateChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) },
      processRunner,
      promptTemplates: { render: () => 'test prompt' },
    });

    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('runtime start was not accepted');
    supervisor.launchStartedProject(prepared.state);
    await waitUntil(() => invocations.length === 1);

    const internals = supervisor as unknown as SupervisorInternals;
    const chainIds = ['project', goal.id, terminal.id];
    const beforeCardActors = new Map(internals.cardActors);
    const beforeLiveCardActors = new Map(internals.liveCardActors);
    expect([...beforeCardActors.keys()].sort()).toEqual([...chainIds].sort());
    expect([...beforeLiveCardActors.keys()].sort()).toEqual([...chainIds].sort());
    for (const cardId of chainIds) {
      expect(beforeCardActors.get(cardId)).toBe(beforeLiveCardActors.get(cardId));
    }
    expect(beforeCardActors.get('project')?.processor).toBeNull();
    expect(beforeCardActors.get(goal.id)?.processor).toBeNull();
    expect(beforeCardActors.get(terminal.id)?.processor).not.toBeNull();
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.role).toBe('executor');
    expect(invocations[0]?.sessionId).toBe(`executor:${terminal.id}`);
    expect(supervisor.getActorRuntimeReadModel().agents).toEqual([expect.objectContaining({ role: 'executor', cardId: terminal.id })]);

    await expect(supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
    expect(internals.cardActors.size).toBe(0);
    expect(internals.liveCardActors.size).toBe(0);
    expect(cards.read('project')?.status).toBe('running');
    expect(cards.read(goal.id)?.status).toBe('running');
    expect(cards.read(terminal.id)?.status).toBe('running');
    expect(supervisor.getStatus().status).toBe('stopped');
    expect(supervisor.getActorRuntimeReadModel().cards).toEqual([]);

    const restarted = await supervisor.beginStartProject();
    if (!restarted.accepted) throw new Error('runtime restart was not accepted');
    supervisor.launchStartedProject(restarted.state);
    await waitUntil(() => invocations.length === 2);

    const afterCardActors = new Map(internals.cardActors);
    const afterLiveCardActors = new Map(internals.liveCardActors);
    expect([...afterCardActors.keys()].sort()).toEqual([...chainIds].sort());
    expect([...afterLiveCardActors.keys()].sort()).toEqual([...chainIds].sort());
    for (const cardId of chainIds) {
      const owner = afterCardActors.get(cardId);
      expect(owner).toBe(afterLiveCardActors.get(cardId));
      expect(owner).not.toBe(beforeCardActors.get(cardId));
    }
    expect(afterCardActors.get('project')?.processor).toBeNull();
    expect(afterCardActors.get(goal.id)?.processor).toBeNull();
    expect(afterCardActors.get(terminal.id)?.processor).not.toBeNull();
    expect(invocations).toHaveLength(2);
    expect(invocations[1]?.role).toBe('executor');
    expect(invocations[1]?.sessionId).toBe(invocations[0]?.sessionId);
    expect(invocations[1]?.inputId).not.toBe(invocations[0]?.inputId);
    expect(supervisor.getActorRuntimeReadModel().agents).toEqual([expect.objectContaining({ role: 'executor', cardId: terminal.id })]);
    await expect(supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
  });

  it('settles the reconstructed immediate-child barrier with its real result before parent provider work', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-reconstructed-barrier-'));
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const child = cards.create({ type: 'code', parent: 'project', title: 'child', brief: 'finish', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running');
    cards.setStatus(child.id, 'running');
    const sourceInputId = '11111111-1111-4111-8111-111111111111';
    appendConversationBatch(projectRoot, [
      { id: 'planner:project:activation:old', session_id: 'planner:project', role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', role: 'planner', card_id: 'project', input_id: sourceInputId, timestamp: '2026-07-18T00:00:00.000Z' }), round_id: 'r-pre-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', message_index: 0, block_index: 0, timestamp: '2026-07-18T00:00:00.000Z' },
      { id: `${sourceInputId}:tool-call:activate-child`, session_id: 'planner:project', role: 'assistant', kind: 'tool_call', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'activate-child', type: 'function', function: { name: 'activate_card', arguments: JSON.stringify({ card_id: child.id }) } }] }), tool: 'activate_card', tool_call_id: 'activate-child', round_id: 'r-assistant-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', message_index: 1, block_index: 0, timestamp: '2026-07-18T00:00:00.001Z' },
    ]);
    let executorCalls = 0;
    let parentInput: LlmInvocationInput | null = null;
    const provider = { completeTurn: jest.fn(async (input: LlmInvocationInput, signal: AbortSignal): Promise<ProviderTurnCompletion> => {
      if (input.role === 'executor') return complete(++executorCalls === 1
        ? tool('write-status', 'write', { path: 'record:///status.md?v=next', content: 'Complete.' })
        : tool('emit-done', 'emit_result', { status: 'done', summary: 'Child complete.' }));
      parentInput = input;
      return new Promise<ProviderTurnCompletion>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }) };
    const processRunner = new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry());
    jest.spyOn(processRunner, 'terminateScopeTree').mockResolvedValue({ selected: [], stopped: [], failed: [] });
    const supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction,
      projectRoot, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(), provider,
      conversations: { projectRoot }, appLogs: { projectRoot },
      readModelChanges: { runtimeChanged() {}, cardStateChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) },
      processRunner, promptTemplates: { render: () => 'test prompt' },
    });

    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('runtime start was not accepted');
    supervisor.launchStartedProject(prepared.state);
    await waitUntil(() => parentInput !== null);

    const rows = readConversation(projectRoot, 'planner:project').physicalRows;
    const resultIndex = rows.findIndex((row) => row.kind === 'tool_result' && row.tool_call_id === 'activate-child');
    const markerIndex = rows.findIndex((row, index) => index > 1 && row.kind === 'activity');
    const noticeIndex = rows.findIndex((row) => row.kind === 'model_recovered');
    expect(resultIndex).toBe(2);
    expect(markerIndex).toBeGreaterThan(resultIndex);
    expect(noticeIndex).toBeGreaterThan(markerIndex);
    expect(JSON.parse(rows[resultIndex]!.content)).toEqual({ success: true, data: { card_id: child.id, outcome: 'done', summary: 'Child complete.', result: { kind: 'done', summary: 'Child complete.' } } });
    expect(rows[noticeIndex]!.content).toBe('The interrupted child barrier completed, and its matching activate_card result was durably recorded before this activation resumed.');
    expect(parentInput!.providerConversation.messages.find((row) => row.tool_call_id === 'activate-child' && row.kind === 'tool_result')).toEqual(rows[resultIndex]);
    expect(cards.read(child.id)?.status).toBe('done');
    await expect(supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
  });

  it('strict reconstructed association failure reaches no parent marker, result, notice, or provider', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-reconstructed-mismatch-'));
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const child = cards.create({ type: 'code', parent: 'project', title: 'child', brief: 'finish', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running'); cards.setStatus(child.id, 'running');
    const source = '88888888-8888-4888-8888-888888888888';
    appendConversationBatch(projectRoot, [
      { id: 'planner:project:activation:old', session_id: 'planner:project', role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', role: 'planner', card_id: 'project', input_id: source, timestamp: '2026-07-18T00:00:00.000Z' }), round_id: 'r-pre-88888888888888888888888888888888', message_index: 0, block_index: 0, timestamp: '2026-07-18T00:00:00.000Z' },
      { id: `${source}:tool-call:activate-mismatch`, session_id: 'planner:project', role: 'assistant', kind: 'tool_call', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'different-id', type: 'function', function: { name: 'activate_card', arguments: JSON.stringify({ card_id: child.id }) } }] }), tool: 'activate_card', tool_call_id: 'activate-mismatch', round_id: 'r-assistant-88888888888888888888888888888888', message_index: 1, block_index: 0, timestamp: '2026-07-18T00:00:00.001Z' },
    ]);
    let executorCalls = 0; let parentCalls = 0;
    const supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction, projectRoot, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(), provider: { completeTurn: async (input: LlmInvocationInput) => { if (input.role === 'executor') return complete(++executorCalls === 1 ? tool('write-status', 'write', { path: 'record:///status.md?v=next', content: 'Complete.' }) : tool('emit-done', 'emit_result', { status: 'done', summary: 'Child complete.' })); parentCalls += 1; throw new Error('parent provider must not run'); } }, conversations: { projectRoot }, appLogs: { projectRoot }, readModelChanges: { runtimeChanged() {}, cardStateChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) }, processRunner: new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry()), promptTemplates: { render: () => 'test prompt' } });
    const prepared = await supervisor.beginStartProject(); if (!prepared.accepted) throw new Error('Run rejected'); supervisor.launchStartedProject(prepared.state);
    await waitUntil(() => supervisor.getStatus().status === 'stopped');
    expect(parentCalls).toBe(0);
    expect(readConversation(projectRoot, 'planner:project').physicalRows).toHaveLength(2);
    expect(cards.read('project')?.status).toBe('failed');
  });

  it('fresh explicit Run reconstructs a nested chain one immediate edge at a time', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-nested-reconstruction-'));
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const goal = cards.create({ type: 'goal', parent: 'project', title: 'goal', brief: 'plan', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const terminal = cards.create({ type: 'code', parent: goal.id, title: 'terminal', brief: 'execute', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running'); cards.setStatus(goal.id, 'running'); cards.setStatus(terminal.id, 'running');
    appendInterruptedCall(projectRoot, 'project', goal.id, '1');
    appendInterruptedCall(projectRoot, goal.id, terminal.id, '2');
    const leafSession = `executor:${terminal.id}` as const;
    const leafSource = '33333333-3333-4333-8333-333333333333';
    appendConversationBatch(projectRoot, [
      { id: `${leafSession}:activation:old`, session_id: leafSession, role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', role: 'executor', card_id: terminal.id, input_id: leafSource, timestamp: '2026-07-18T00:00:00.000Z' }), round_id: 'r-pre-33333333333333333333333333333333', message_index: 0, block_index: 0, timestamp: '2026-07-18T00:00:00.000Z' },
      { id: `${leafSource}:tool-call:glob-old`, session_id: leafSession, role: 'assistant', kind: 'tool_call', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'glob-old', type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: '**/*' }) } }] }), tool: 'glob', tool_call_id: 'glob-old', round_id: 'r-assistant-33333333333333333333333333333333', message_index: 1, block_index: 0, timestamp: '2026-07-18T00:00:00.001Z' },
    ]);
    const initialRows = [readConversation(projectRoot, 'planner:project').physicalRows.length, readConversation(projectRoot, `planner:${goal.id}`).physicalRows.length, readConversation(projectRoot, leafSession).physicalRows.length];
    const order: string[] = [];
    const processRunner = new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry());
    jest.spyOn(processRunner, 'terminateScopeTree').mockResolvedValue({ selected: [], stopped: [], failed: [] });
    let supervisor!: SupervisorRuntimeApi;
    let executorCalls = 0;
    let goalCalls = 0;
    let reviewerCalls = 0;
    const plannerInputs = new Map<string, LlmInvocationInput>();
    let terminalReleasedBeforeGoal = false;
    const provider = { completeTurn: jest.fn(async (input: LlmInvocationInput, signal: AbortSignal): Promise<ProviderTurnCompletion> => {
      order.push(`${input.role}:${input.sessionId}`);
      if (input.role === 'executor') return complete(++executorCalls === 1 ? tool('write-status', 'write', { path: 'record:///status.md?v=next', content: 'Complete.' }) : tool('leaf-done', 'emit_result', { status: 'done', summary: 'Leaf done.' }));
      if (input.role === 'reviewer') return complete(++reviewerCalls === 1
        ? tool('review-status', 'write', { path: 'record:///review.md?v=next', content: 'Approved.' })
        : tool('review-done', 'emit_result', { status: 'done', summary: 'Approved.' }));
      plannerInputs.set(input.sessionId, input);
      if (input.sessionId === `planner:${goal.id}`) {
        const internals = supervisor as unknown as SupervisorInternals;
        terminalReleasedBeforeGoal = !internals.cardActors.has(terminal.id);
        goalCalls += 1;
        return complete(goalCalls === 1
          ? tool('goal-status', 'write', { path: 'record:///status.md?v=next', content: 'Goal complete.' })
          : tool('goal-done', 'emit_result', { status: 'done', summary: 'Goal done.' }));
      }
      return new Promise<ProviderTurnCompletion>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }) };
    const changes = { runtimeChanged() {}, cardStateChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) };
    supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction, projectRoot, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(), provider, conversations: { projectRoot }, appLogs: { projectRoot }, readModelChanges: changes, processRunner, promptTemplates: { render: () => 'test prompt' } });
    await supervisor.start();
    expect(provider.completeTurn).not.toHaveBeenCalled();
    expect([readConversation(projectRoot, 'planner:project').physicalRows.length, readConversation(projectRoot, `planner:${goal.id}`).physicalRows.length, readConversation(projectRoot, leafSession).physicalRows.length]).toEqual(initialRows);
    const prepared = await supervisor.beginStartProject(); if (!prepared.accepted) throw new Error('Run rejected'); supervisor.launchStartedProject(prepared.state);
    await waitUntil(() => order.some((entry) => entry === 'planner:planner:project'));
    expect(order[0]).toBe(`executor:${leafSession}`);
    expect(order.findIndex((entry) => entry === `planner:planner:${goal.id}`)).toBeGreaterThan(order.lastIndexOf(`executor:${leafSession}`));
    expect(order.findIndex((entry) => entry === 'planner:planner:project')).toBeGreaterThan(order.findIndex((entry) => entry === `planner:planner:${goal.id}`));
    expect(terminalReleasedBeforeGoal).toBe(true);
    for (const [parentId, childId] of [['project', goal.id], [goal.id, terminal.id]] as const) {
      const input = plannerInputs.get(`planner:${parentId}`)!;
      expect(JSON.parse(input.providerConversation.messages.find((row) => row.tool_call_id === `activate-${childId}` && row.kind === 'tool_result')!.content)).toMatchObject({ success: true, data: { card_id: childId, outcome: 'done' } });
    }
    const leafRows = readConversation(projectRoot, leafSession).physicalRows;
    expect(leafRows.filter((row) => row.tool_call_id === 'glob-old' && row.kind === 'tool_result')).toHaveLength(1);
    expect(JSON.parse(leafRows.find((row) => row.tool_call_id === 'glob-old' && row.kind === 'tool_result')!.content)).toMatchObject({ success: false, data: { outcome_unknown: true } });
    for (const [parentId, childId] of [['project', goal.id], [goal.id, terminal.id]] as const) {
      const rows = readConversation(projectRoot, `planner:${parentId}`);
      const callId = `activate-${childId}`;
      expect(rows.physicalRows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === callId)).toHaveLength(1);
      const resultIndex = rows.physicalRows.findIndex((row) => row.kind === 'tool_result' && row.tool_call_id === callId);
      expect(rows.physicalRows.findIndex((row, index) => index > resultIndex && row.kind === 'activity')).toBeGreaterThan(resultIndex);
      expect(rows.physicalRows[resultIndex]!.timestamp).not.toBe('2026-07-18T00:00:00.001Z');
    }
    await expect(supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
  });

  it('propagates reconstructed-result publication uncertainty into the fatal retained owner without later effects', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-reconstructed-append-error-'));
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const goal = cards.create({ type: 'goal', parent: 'project', title: 'goal', brief: 'plan', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const child = cards.create({ type: 'code', parent: goal.id, title: 'child', brief: 'finish', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running'); cards.setStatus(goal.id, 'running'); cards.setStatus(child.id, 'running');
    cards.enqueueNotification(goal.id, { id: 'fatal-retained-notification', content: 'must not be selected', created_at: '2026-07-18T00:00:00.000Z' });
    appendInterruptedCall(projectRoot, goal.id, child.id, '4');
    let executorCalls = 0;
    let plannerCalls = 0;
    const terminal = deferred<ProviderTurnCompletion>();
    const provider = { completeTurn: jest.fn(async (input: LlmInvocationInput): Promise<ProviderTurnCompletion> => {
      if (input.role === 'executor') { executorCalls += 1; return executorCalls === 1 ? complete(tool('write-status', 'write', { path: 'record:///status.md?v=next', content: 'Complete.' })) : terminal.promise; }
      plannerCalls += 1;
      throw new Error('parent provider must not be invoked');
    }) };
    const publicationError = new Error('conversation publication failed after append');
    let cardReadCountAtFailure = -1;
    let cardRead: ReturnType<typeof jest.spyOn>;
    const conversationChanged = jest.fn((sessionId: string) => { if (sessionId === `planner:${goal.id}`) { cardReadCountAtFailure = cardRead.mock.calls.length; throw publicationError; } });
    const changes = { runtimeChanged: jest.fn(), cardStateChanged() {}, agentsChanged() {}, conversationChanged, subscribe: () => ({ unsubscribe() {} }) };
    const processRunner = new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry());
    jest.spyOn(processRunner, 'terminateOwnedRoot').mockResolvedValue({ selected: [], stopped: [], failed: [] });
    const intervention = new RuntimeInterventionBinding();
    const bus = new EventBus();
    const published = jest.fn((_event: DomainEvent<'conversation_changed'>) => undefined);
    bus.subscribe('conversation_changed', published);
    const supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction,
      projectRoot, eventBus: bus, actorStore: cards, interventionBinding: intervention, provider,
      conversations: { projectRoot, changes }, appLogs: { projectRoot }, readModelChanges: changes,
      processRunner, promptTemplates: { render: () => 'test prompt' },
    });

    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('runtime start was not accepted');
    supervisor.launchStartedProject(prepared.state);
    await waitUntil(() => executorCalls === 2);
    const internals = supervisor as unknown as SupervisorInternals & { preparedLeaf: unknown; runtimeGate: { isOpen: boolean } };
    const identity = internals.runIdentity;
    const rootOwner = internals.cardActors.get('project')!;
    const goalOwner = internals.cardActors.get(goal.id)!;
    const rootCanClaim = jest.spyOn(rootOwner, 'canClaimCancellation');
    const rootClaim = jest.spyOn(rootOwner, 'claimCancellation');
    const rootSettle = jest.spyOn(rootOwner, 'settleClaimedCancellation');
    const goalCanClaim = jest.spyOn(goalOwner, 'canClaimCancellation');
    const goalClaim = jest.spyOn(goalOwner, 'claimCancellation');
    const goalSettle = jest.spyOn(goalOwner, 'settleClaimedCancellation');
    const selectNotifications = jest.spyOn(goalOwner, 'listPendingNotifications');
    const removeNotifications = jest.spyOn(cards, 'removeNotifications');
    const rootHistoryBefore = cards.listCardHistory('project').length;
    const goalHistoryBefore = cards.listCardHistory(goal.id).length;
    const propagation = jest.spyOn(supervisor as unknown as { handleRootRejection(identity: object, error: unknown): void }, 'handleRootRejection');
    cardRead = jest.spyOn(cards, 'read');
    published.mockClear(); conversationChanged.mockClear(); changes.runtimeChanged.mockClear();
    terminal.resolve(complete(tool('emit-done', 'emit_result', { status: 'done', summary: 'Child complete.' })));
    await waitUntil(() => supervisor.getStatus().status === 'error');

    expect(propagation).toHaveBeenCalledTimes(1);
    expect(propagation.mock.calls[0]![0]).toBe(identity);
    expect(propagation.mock.calls[0]![1]).toBeInstanceOf(ReconstructedActivationResultAppendError);
    expect((propagation.mock.calls[0]![1] as ReconstructedActivationResultAppendError).cause).toBe(publicationError);
    expect(cardReadCountAtFailure).toBeGreaterThanOrEqual(0);
    expect(cardRead.mock.calls).toHaveLength(cardReadCountAtFailure);
    const rows = readConversation(projectRoot, `planner:${goal.id}`).physicalRows;
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ kind: 'tool_result', tool: 'activate_card', tool_call_id: `activate-${child.id}` });
    expect(plannerCalls).toBe(0);
    expect(published.mock.calls.filter(([event]) => event.payload.session_id === `planner:${goal.id}`)).toHaveLength(0);
    expect(selectNotifications).not.toHaveBeenCalled();
    expect(removeNotifications).not.toHaveBeenCalled();
    expect(cards.read(goal.id)!.pending_notifications.map(({ id }) => id)).toContain('fatal-retained-notification');
    expect(cards.listCardHistory('project')).toHaveLength(rootHistoryBefore);
    expect(cards.listCardHistory(goal.id)).toHaveLength(goalHistoryBefore);
    expect(internals.runIdentity).toBe(identity);
    expect(internals.cardActors.get('project')).toBe(rootOwner); expect(internals.liveCardActors.get('project')).toBe(rootOwner);
    expect(internals.cardActors.get(goal.id)).toBe(goalOwner); expect(internals.liveCardActors.get(goal.id)).toBe(goalOwner);
    expect(internals.cardActors.has(child.id)).toBe(false);
    expect(internals.liveCardActors.has(child.id)).toBe(false);
    expect(supervisor.getStatus()).toMatchObject({ status: 'error', currentCardId: goal.id });
    expect(supervisor.getRuntimeState()).toMatchObject({ status: 'error', active_card_run: null });
    expect(supervisor.getActorRuntimeReadModel()).toMatchObject({ pauseMode: 'idle', cards: expect.arrayContaining([{ cardId: 'project', actorState: 'running' }, { cardId: goal.id, actorState: 'running' }]) });
    expect(intervention.interventionReadiness()).toBe('not_ready');
    expect(internals.runtimeGate.isOpen).toBe(false);

    const read = cardRead; const list = jest.spyOn(cards, 'list'); const listChildren = jest.spyOn(cards, 'listChildren'); const setStatus = jest.spyOn(cards, 'setStatus'); const commit = jest.spyOn(cards, 'commitTerminalLifecyclePatch');
    for (const target of [goal.id, 'project']) {
      read.mockClear(); list.mockClear(); listChildren.mockClear(); setStatus.mockClear(); commit.mockClear();
      rootCanClaim.mockClear(); rootClaim.mockClear(); rootSettle.mockClear(); goalCanClaim.mockClear(); goalClaim.mockClear(); goalSettle.mockClear();
      const beforeCards = new Map(internals.cardActors); const beforeLive = new Map(internals.liveCardActors);
      await expect(supervisor.cancelCard(target, 'must reject')).rejects.toEqual(expect.objectContaining({ code: 'runtime_control_conflict', message: 'Runtime owner cannot cancel cards after reconstructed activation result append outcome became unknown; restart the server process.' }));
      expect(read).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); expect(listChildren).not.toHaveBeenCalled(); expect(setStatus).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
      expect(rootCanClaim).not.toHaveBeenCalled(); expect(rootClaim).not.toHaveBeenCalled(); expect(rootSettle).not.toHaveBeenCalled(); expect(goalCanClaim).not.toHaveBeenCalled(); expect(goalClaim).not.toHaveBeenCalled(); expect(goalSettle).not.toHaveBeenCalled();
      expect([...internals.cardActors.entries()]).toEqual([...beforeCards.entries()]); expect([...internals.liveCardActors.entries()]).toEqual([...beforeLive.entries()]);
    }
    await expect(supervisor.stopProject()).rejects.toEqual(expect.objectContaining({ code: 'runtime_control_conflict', message: 'Runtime owner cannot be stopped after reconstructed activation result append outcome became unknown; restart the server process.' }));
    read.mockClear(); list.mockClear(); setStatus.mockClear(); changes.runtimeChanged.mockClear();
    const restarted = await supervisor.beginStartProject();
    expect(restarted).toMatchObject({ accepted: false, result: { status: 'error', started: false, stopped: false, error: 'Runtime owner cannot Run again after reconstructed activation result append outcome became unknown; restart the server process.', runtime: { status: 'error', active_card_run: null } } });
    expect(read).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); expect(setStatus).not.toHaveBeenCalled(); expect(changes.runtimeChanged).not.toHaveBeenCalled(); expect(internals.preparedLeaf).toBeNull(); expect(internals.runIdentity).toBe(identity);
    await expect(supervisor.cleanupForApplicationStop()).resolves.toBeUndefined();
  });

  it('synchronous Stop from real reconstructed-result publication leaves only that result and Run 2 does not duplicate it', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-reconstructed-publication-stop-'));
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const child = cards.create({ type: 'code', parent: 'project', title: 'child', brief: 'finish', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running'); cards.setStatus(child.id, 'running');
    appendInterruptedCall(projectRoot, 'project', child.id, '5');
    cards.enqueueNotification('project', { id: 'retained-notification', content: 'must remain', created_at: '2026-07-18T00:00:00.000Z' });
    let executorCalls = 0; let plannerCalls = 0; let stopped: Promise<unknown> | null = null; let exactReason: unknown;
    const processRunner = new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry());
    jest.spyOn(processRunner, 'terminateScopeTree').mockResolvedValue({ selected: [], stopped: [], failed: [] });
    const bus = new EventBus(); const published = jest.fn((_event: DomainEvent<'conversation_changed'>) => undefined); bus.subscribe('conversation_changed', published);
    let supervisor!: SupervisorRuntimeApi;
    const changes = { runtimeChanged() {}, cardStateChanged() {}, agentsChanged() {}, conversationChanged(sessionId: string) { if (sessionId === 'planner:project' && !stopped) { stopped = supervisor.stopProject(); exactReason = (supervisor as unknown as { closingInterruption: unknown }).closingInterruption; } }, subscribe: () => ({ unsubscribe() {} }) };
    const provider = { completeTurn: jest.fn(async (input: LlmInvocationInput): Promise<ProviderTurnCompletion> => {
      if (input.role === 'executor') return complete(++executorCalls === 1 ? tool('write-status', 'write', { path: 'record:///status.md?v=next', content: 'Complete.' }) : tool('emit-done', 'emit_result', { status: 'done', summary: 'Child complete.' }));
      plannerCalls += 1; throw new Error('parent provider must not run after synchronous Stop');
    }) };
    supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction, projectRoot, eventBus: bus, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(), provider, conversations: { projectRoot, changes }, appLogs: { projectRoot }, readModelChanges: changes, processRunner, promptTemplates: { render: () => 'test prompt' } });
    const propagation = jest.spyOn(supervisor as unknown as { handleRootRejection(identity: object, error: unknown): void }, 'handleRootRejection');
    const prepared = await supervisor.beginStartProject(); if (!prepared.accepted) throw new Error('Run 1 rejected'); supervisor.launchStartedProject(prepared.state);
    await waitUntil(() => stopped !== null);
    await expect(stopped!).resolves.toEqual({ status: 'stopped', contained: true });
    await waitUntil(() => propagation.mock.calls.some(([, error]) => error === exactReason));
    expect(exactReason).toBeInstanceOf(RuntimeStoppedInterruption);
    const rowsAfterRun1 = readConversation(projectRoot, 'planner:project').physicalRows;
    const callId = `activate-${child.id}`;
    expect(rowsAfterRun1.filter((row) => row.kind === 'tool_result' && row.tool_call_id === callId)).toHaveLength(1);
    expect(rowsAfterRun1).toHaveLength(3);
    expect(rowsAfterRun1.some((row) => row.kind === 'model_recovered')).toBe(false);
    expect(published.mock.calls.filter(([event]) => event.payload.session_id === 'planner:project')).toHaveLength(0);
    expect(plannerCalls).toBe(0);
    expect(cards.read('project')!.pending_notifications.map(({ id }) => id)).toContain('retained-notification');

    let run2Input: LlmInvocationInput | null = null;
    const run2ProcessRunner = new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry());
    jest.spyOn(run2ProcessRunner, 'terminateScopeTree').mockResolvedValue({ selected: [], stopped: [], failed: [] });
    const run2 = new SupervisorRuntimeApi({ ...testAutonomousCompaction, projectRoot, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(), provider: { completeTurn: (input: LlmInvocationInput, signal: AbortSignal) => { run2Input = input; return new Promise<ProviderTurnCompletion>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } }, conversations: { projectRoot }, appLogs: { projectRoot }, readModelChanges: { runtimeChanged() {}, cardStateChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) }, processRunner: run2ProcessRunner, promptTemplates: { render: () => 'test prompt' } });
    const prepared2 = await run2.beginStartProject(); if (!prepared2.accepted) throw new Error('Run 2 rejected'); run2.launchStartedProject(prepared2.state);
    await waitUntil(() => run2Input !== null);
    expect(readConversation(projectRoot, 'planner:project').physicalRows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === callId)).toHaveLength(1);
    expect(run2Input!.providerConversation.messages.filter((row) => row.kind === 'tool_result' && row.tool_call_id === callId)).toHaveLength(1);
    await expect(run2.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
  });

  it('Stop after child publication but before parent admission makes Run 2 recover the parent ordinarily', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-post-child-stop-'));
    initProjectTree(projectRoot);
    const bus = new EventBus();
    const cards = new CardService(projectRoot, bus);
    const child = cards.create({ type: 'code', parent: 'project', title: 'child', brief: 'finish', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running'); cards.setStatus(child.id, 'running'); appendInterruptedCall(projectRoot, 'project', child.id, '6');
    const processRunner = new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry()); jest.spyOn(processRunner, 'terminateScopeTree').mockResolvedValue({ selected: [], stopped: [], failed: [] });
    let supervisor!: SupervisorRuntimeApi; let stopped: Promise<unknown> | null = null; let executorCalls = 0; let parentCalls = 0;
    bus.subscribe('card_history_appended', (event) => { if (event.payload.card_id === child.id && cards.read(child.id)?.status === 'done' && !stopped) stopped = supervisor.stopProject(); }, { propagateErrors: true });
    supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction, projectRoot, eventBus: bus, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(), provider: { completeTurn: async (input: LlmInvocationInput) => { if (input.role === 'executor') return complete(++executorCalls === 1 ? tool('write-status', 'write', { path: 'record:///status.md?v=next', content: 'Complete.' }) : tool('emit-done', 'emit_result', { status: 'done', summary: 'Child complete.' })); parentCalls += 1; throw new Error('parent must not run'); } }, conversations: { projectRoot }, appLogs: { projectRoot }, readModelChanges: { runtimeChanged() {}, cardStateChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) }, processRunner, promptTemplates: { render: () => 'test prompt' } });
    const prepared = await supervisor.beginStartProject(); if (!prepared.accepted) throw new Error('Run 1 rejected'); supervisor.launchStartedProject(prepared.state);
    await waitUntil(() => stopped !== null); await expect(stopped!).resolves.toEqual({ status: 'stopped', contained: true });
    expect(cards.read(child.id)?.status).toBe('done'); expect(cards.read('project')?.status).toBe('running'); expect(parentCalls).toBe(0);
    const callId = `activate-${child.id}`;
    expect(readConversation(projectRoot, 'planner:project').physicalRows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === callId)).toHaveLength(0);
    let run2Input: LlmInvocationInput | null = null;
    const run2ProcessRunner = new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry()); jest.spyOn(run2ProcessRunner, 'terminateScopeTree').mockResolvedValue({ selected: [], stopped: [], failed: [] });
    const run2 = new SupervisorRuntimeApi({ ...testAutonomousCompaction, projectRoot, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(), provider: { completeTurn: (input: LlmInvocationInput, signal: AbortSignal) => { run2Input = input; return new Promise<ProviderTurnCompletion>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } }, conversations: { projectRoot }, appLogs: { projectRoot }, readModelChanges: { runtimeChanged() {}, cardStateChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) }, processRunner: run2ProcessRunner, promptTemplates: { render: () => 'test prompt' } });
    const prepared2 = await run2.beginStartProject(); if (!prepared2.accepted) throw new Error('Run 2 rejected'); run2.launchStartedProject(prepared2.state); await waitUntil(() => run2Input !== null);
    const result = readConversation(projectRoot, 'planner:project').physicalRows.find((row) => row.kind === 'tool_result' && row.tool_call_id === callId)!;
    expect(JSON.parse(result.content)).toMatchObject({ success: false, data: { outcome_unknown: true } });
    const internals2 = run2 as unknown as SupervisorInternals; expect([...internals2.cardActors.keys()]).toEqual(['project']);
    await expect(run2.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
  });

  it('Stop before child settlement leaves both running and Run 2 settles the leaf interruption before the real parent result', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-pre-child-stop-'));
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const child = cards.create({ type: 'code', parent: 'project', title: 'child', brief: 'finish', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running'); cards.setStatus(child.id, 'running'); appendInterruptedCall(projectRoot, 'project', child.id, '7');
    const mcp = deferred<unknown>(); let run1ProviderCalls = 0;
    const mcpManager = { getServerTools: () => [], findToolCapability: () => null, invokeTool: () => mcp.promise };
    const processRunner = new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry()); jest.spyOn(processRunner, 'terminateScopeTree').mockResolvedValue({ selected: [], stopped: [], failed: [] });
    const run1 = new SupervisorRuntimeApi({ ...testAutonomousCompaction, projectRoot, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(), provider: { completeTurn: async () => { run1ProviderCalls += 1; return complete(tool('mcp-pending', 'mcp_tool_call', { serverName: 'test', toolName: 'wait', args: {} })); } }, mcpManagerProvider: () => mcpManager, conversations: { projectRoot }, appLogs: { projectRoot }, readModelChanges: { runtimeChanged() {}, cardStateChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) }, processRunner, promptTemplates: { render: () => 'test prompt' } });
    const prepared = await run1.beginStartProject(); if (!prepared.accepted) throw new Error('Run 1 rejected'); run1.launchStartedProject(prepared.state);
    await waitUntil(() => readConversation(projectRoot, `executor:${child.id}`).physicalRows.some((row) => row.kind === 'tool_call' && row.tool_call_id === 'mcp-pending'));
    const stopping = run1.stopProject();
    mcp.resolve({ completed_after_stop: true });
    await expect(stopping).resolves.toEqual({ status: 'stopped', contained: true });
    expect(run1ProviderCalls).toBe(1); expect(cards.read('project')?.status).toBe('running'); expect(cards.read(child.id)?.status).toBe('running');
    expect(readConversation(projectRoot, 'planner:project').physicalRows.filter((row) => row.kind === 'tool_result')).toHaveLength(0);
    expect(readConversation(projectRoot, `executor:${child.id}`).physicalRows.filter((row) => row.tool_call_id === 'mcp-pending' && row.kind === 'tool_result')).toHaveLength(0);

    const order: string[] = []; let executorCalls = 0; let parentInput: LlmInvocationInput | null = null;
    const run2ProcessRunner = new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry()); jest.spyOn(run2ProcessRunner, 'terminateScopeTree').mockResolvedValue({ selected: [], stopped: [], failed: [] });
    const run2 = new SupervisorRuntimeApi({ ...testAutonomousCompaction, projectRoot, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(), provider: { completeTurn: async (input: LlmInvocationInput, signal: AbortSignal) => { order.push(`${input.role}:${input.sessionId}`); if (input.role === 'executor') { executorCalls += 1; if (executorCalls === 1) { const recovered = input.providerConversation.messages.find((row) => row.kind === 'tool_result' && row.tool_call_id === 'mcp-pending')!; expect(JSON.parse(recovered.content)).toMatchObject({ success: false, data: { outcome_unknown: true } }); return complete(tool('write-status', 'write', { path: 'record:///status.md?v=next', content: 'Complete.' })); } return complete(tool('emit-done', 'emit_result', { status: 'done', summary: 'Child complete.' })); } parentInput = input; return new Promise<ProviderTurnCompletion>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } }, conversations: { projectRoot }, appLogs: { projectRoot }, readModelChanges: { runtimeChanged() {}, cardStateChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) }, processRunner: run2ProcessRunner, promptTemplates: { render: () => 'test prompt' } });
    const prepared2 = await run2.beginStartProject(); if (!prepared2.accepted) throw new Error('Run 2 rejected'); run2.launchStartedProject(prepared2.state); await waitUntil(() => parentInput !== null);
    expect(order[0]).toBe(`executor:executor:${child.id}`);
    const callId = `activate-${child.id}`;
    const parentResult = parentInput!.providerConversation.messages.find((row) => row.kind === 'tool_result' && row.tool_call_id === callId)!;
    expect(JSON.parse(parentResult.content)).toMatchObject({ success: true, data: { card_id: child.id, outcome: 'done' } });
    expect(JSON.parse(parentResult.content)).not.toMatchObject({ data: { outcome_unknown: true } });
    await expect(run2.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
  });

  it('rejects persisted running siblings before installing any actor or processor ownership', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-invalid-siblings-'));
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const left = cards.create({ type: 'code', parent: 'project', title: 'left', brief: 'left', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const right = cards.create({ type: 'code', parent: 'project', title: 'right', brief: 'right', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running');
    cards.setStatus(left.id, 'running');
    cards.setStatus(right.id, 'running');
    const provider = { completeTurn: jest.fn(async () => { throw new Error('must not install a processor'); }) };
    const supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction,
      projectRoot, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(), provider,
      conversations: { projectRoot }, appLogs: { projectRoot },
      readModelChanges: { runtimeChanged() {}, cardStateChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) },
      processRunner: new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry()), promptTemplates: { render: () => 'test prompt' },
    });
    const internals = supervisor as unknown as SupervisorInternals;

    await expect(supervisor.beginStartProject()).rejects.toThrow('strict ancestor chain');
    expect(internals.runIdentity).toBeNull();
    expect(internals.liveCardActors.size).toBe(0);
    expect(internals.cardActors.size).toBe(0);
    expect(supervisor.getActorRuntimeReadModel()).toEqual({ pauseMode: 'idle', activeWork: 'none', cards: [], agents: [], diagnostics: [] });
    expect(provider.completeTurn).not.toHaveBeenCalled();
  });

  it.each([false, true])('contains a real result winner through non-aborting tracker joins (publication callback throws=%s)', async (callbackThrows) => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-real-result-stop-'));
    initProjectTree(projectRoot);
    const bus = new EventBus();
    const cards = new CardService(projectRoot, bus);
    const child = cards.create({ type: 'code', parent: 'project', title: 'result winner', brief: 'finish', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running');
    cards.setStatus(child.id, 'running');
    const runningVersion = cards.read(child.id)!.version_seq;
    const terminal = deferred<ProviderTurnCompletion>();
    let executorCalls = 0;
    let terminalSignal: AbortSignal | null = null;
    const provider = { completeTurn: jest.fn(async (input: LlmInvocationInput, signal: AbortSignal) => {
      if (input.role !== 'executor') return new Promise<ProviderTurnCompletion>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      executorCalls += 1;
      if (executorCalls === 1) return complete(tool('write', 'write', { path: 'record:///status.md?v=next', content: 'Ready.' }));
      terminalSignal = signal;
      return terminal.promise;
    }) };
    const processRunner = new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry());
    const cleanup = deferred<void>();
    jest.spyOn(processRunner, 'terminateScopeTree').mockImplementation(async ({ rootScope }) => {
      if (rootScope !== processRunner.runtimeRootScope) await cleanup.promise;
      return { selected: [], stopped: [], failed: [] };
    });
    const supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction,
      projectRoot, eventBus: bus, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(), provider,
      conversations: { projectRoot }, appLogs: { projectRoot },
      readModelChanges: { runtimeChanged() {}, cardStateChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) },
      processRunner, promptTemplates: { render: () => 'test prompt' },
    });
    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('runtime start was not accepted');
    supervisor.launchStartedProject(prepared.state);
    await waitUntil(() => terminalSignal !== null);
    const internals = supervisor as unknown as SupervisorInternals;
    const owner = internals.liveCardActors.get(child.id)!;
    const processor = owner.processor!;
    const llm = (processor as import('../../../src/runtime/actors/base-main-llm-card-processor-actor.js').BaseMainLLMCardProcessorActor).listLlmActors()[0]!;
    const activation = owner.awaitSettlement();
    let callerSettled = false;
    void activation.then(() => { callerSettled = true; });
    const suppress = jest.spyOn(processor, 'suppressContinuationAndPrepareJoin');
    const processorJoin = jest.spyOn(processor, 'joinActivation');
    const closeLlm = jest.spyOn(llm, 'closeInvocationAdmission');
    const llmJoin = jest.spyOn(llm, 'joinInvocationSettlement');
    const release = jest.spyOn(supervisor as unknown as { releaseSettledActor(actor: CardActor): void }, 'releaseSettledActor');
    const commit = jest.spyOn(cards, 'commitTerminalLifecyclePatch');
    const read = jest.spyOn(cards, 'read');
    let readCountAtCallback = -1;
    if (callbackThrows) bus.subscribe('card_history_appended', () => { readCountAtCallback = read.mock.calls.length; throw new Error('post-publication callback failed'); }, { propagateErrors: true });
    let stopped: Promise<unknown> | null = null;
    const originalClose = cards.closeRecord.bind(cards);
    jest.spyOn(cards, 'closeRecord').mockImplementation((...args) => {
      stopped ??= supervisor.stopProject();
      return originalClose(...args);
    });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    terminal.resolve(complete(tool('accepted', 'emit_result', { status: 'done', summary: 'Accepted result.' })));
    await waitUntil(() => stopped !== null);
    expect(supervisor.getStatus().status).toBe('closing');
    expect(owner.claim).toBe('claimed_result');
    expect(internals.liveCardActors.get(child.id)).toBe(owner);
    expect(internals.cardActors.get(child.id)).toBe(owner);
    expect(terminalSignal!.aborted).toBe(false);
    expect(callerSettled).toBe(false);
    cleanup.resolve();
    await expect(stopped!).resolves.toEqual({ status: 'stopped', contained: true });

    expect(suppress).toHaveBeenCalledTimes(1);
    expect(closeLlm).toHaveBeenCalledTimes(1);
    const suppressionReason = suppress.mock.calls[0]![0];
    expect(suppressionReason).toBeInstanceOf(RuntimeStoppedInterruption);
    expect(closeLlm).toHaveBeenCalledWith(suppressionReason);
    expect(processorJoin).toHaveBeenCalledTimes(1);
    expect(llmJoin).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(internals.liveCardActors.size).toBe(0);
    expect(internals.cardActors.size).toBe(0);
    if (callbackThrows) {
      expect(callerSettled).toBe(false);
      expect(readCountAtCallback).toBeGreaterThanOrEqual(0);
      expect(read.mock.calls.length).toBe(readCountAtCallback);
    } else {
      await expect(activation).resolves.toMatchObject({ status: 'done', summary: 'Accepted result.' });
      expect(callerSettled).toBe(true);
    }
    expect(cards.read(child.id)).toMatchObject({ status: 'done', version_seq: runningVersion + 1, lifecycle: { result: { kind: 'done', summary: 'Accepted result.' } } });
    expect(cards.listCardHistory(child.id).filter((entry) => entry.change_reason === 'terminal lifecycle commit')).toHaveLength(1);
    consoleError.mockRestore();
  });

  it('retains the full owner map and closing runtime when process containment fails', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-containment-failure-'));
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    cards.setStatus('project', 'running');
    const provider = {
      completeTurn: (_input: LlmInvocationInput, signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    };
    const processRunner = new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry());
    jest.spyOn(processRunner, 'terminateScopeTree').mockResolvedValue({ selected: ['p'], stopped: [], failed: [{ groupId: 'p', state: 'unconfirmed', diagnostic: 'private' }] });
    const supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction,
      projectRoot, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(), provider,
      conversations: { projectRoot }, appLogs: { projectRoot },
      readModelChanges: { runtimeChanged() {}, cardStateChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) },
      processRunner, promptTemplates: { render: () => 'test prompt' },
    });
    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('runtime start was not accepted');
    supervisor.launchStartedProject(prepared.state);
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(supervisor.stopProject()).rejects.toBeInstanceOf(RuntimeContainmentError);
    expect(supervisor.getStatus().status).toBe('closing');
    expect(supervisor.getActorRuntimeReadModel().cards.map((card) => card.cardId)).toEqual(['project']);
    expect(cards.read('project')?.status).toBe('running');
    await expect(supervisor.stopProject()).rejects.toMatchObject({ code: 'runtime_control_conflict' });
  });

  it.each(['result', 'cancel'] as const)('rejects a captured-runtime %s waiter before touching replacement runtime B', async (winner) => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-captured-runtime-'));
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    cards.setStatus('project', 'running');
    const processRunner = new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry());
    const supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction,
      projectRoot, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(),
      provider: { completeTurn: async () => { throw new Error('not called'); } },
      conversations: { projectRoot }, appLogs: { projectRoot },
      readModelChanges: { runtimeChanged() {}, cardStateChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) },
      processRunner, promptTemplates: { render: () => 'test prompt' },
    });
    const runtimeA = {};
    const runtimeB = {};
    const interruptionA = new RuntimeStoppedInterruption();
    let settleWinner!: () => void;
    const winnerSettlement = new Promise<never>((resolve) => { settleWinner = resolve as () => void; });
    let postWaitOwnerAccess = 0;
    const owner = {
      structuralChildId: null,
      canClaimCancellation: () => false,
      awaitSettlement: () => winnerSettlement,
      claimCancellation: () => { postWaitOwnerAccess += 1; },
      settleClaimedCancellation: () => { postWaitOwnerAccess += 1; return Promise.reject(new Error('must not settle')); },
    };
    const internals = supervisor as unknown as {
      runIdentity: object | null;
      status: string;
      closingInterruption: RuntimeStoppedInterruption | null;
      liveCardActors: Map<string, unknown>;
    };
    internals.runIdentity = runtimeA;
    internals.status = 'running';
    internals.closingInterruption = interruptionA;
    internals.liveCardActors.set('project', owner);
    const read = jest.spyOn(cards, 'read');

    const request = supervisor.cancelCard('project', `${winner} waiter`);
    await Promise.resolve();
    read.mockClear();
    internals.runIdentity = runtimeB;
    settleWinner();

    await expect(request).rejects.toBe(interruptionA);
    expect(read).not.toHaveBeenCalled();
    expect(postWaitOwnerAccess).toBe(0);
    expect(internals.runIdentity).toBe(runtimeB);
  });

  it.each([
    { winner: 'claimed_result' as const, cleanupFails: false },
    { winner: 'claimed_result' as const, cleanupFails: true },
  ])('keeps $winner authoritative through root cleanup (fails=$cleanupFails)', async ({ winner, cleanupFails }) => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-winner-cleanup-'));
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    cards.setStatus('project', 'running');
    const processRunner = new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry());
    jest.spyOn(processRunner, 'terminateScopeTree').mockResolvedValue({ selected: [], stopped: [], failed: [] });
    const supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction,
      projectRoot, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(),
      provider: { completeTurn: async () => { throw new Error('not called'); } },
      conversations: { projectRoot }, appLogs: { projectRoot },
      readModelChanges: { runtimeChanged() {}, cardStateChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) },
      processRunner, promptTemplates: { render: () => 'test prompt' },
    });
    const identity = {};
    let stopInterruption: RuntimeStoppedInterruption | null = null;
    const owner = {
      cardId: 'project',
      claim: winner,
      stop: jest.fn(async (operation: { interruption: RuntimeStoppedInterruption; reportContainmentFailure(component: string, error: unknown): void }) => {
        stopInterruption = operation.interruption;
        if (cleanupFails) operation.reportContainmentFailure('card:project', new Error('cleanup failed'));
      }),
    };
    const internals = supervisor as unknown as {
      runIdentity: object | null;
      status: string;
      currentness: ActiveCardLeaf;
      liveCardActors: Map<string, unknown>;
      cardActors: Map<string, unknown>;
    };
    internals.runIdentity = identity;
    internals.status = 'running';
    internals.currentness.setChain(['project']);
    internals.liveCardActors.set('project', owner);
    internals.cardActors.set('project', owner);

    const stopped = supervisor.stopProject();
    if (cleanupFails) await expect(stopped).rejects.toBeInstanceOf(RuntimeContainmentError);
    else await expect(stopped).resolves.toEqual({ status: 'stopped', contained: true });
    expect(owner.claim).toBe(winner);
    expect(owner.stop).toHaveBeenCalledTimes(1);
    expect(stopInterruption).toBeInstanceOf(RuntimeStoppedInterruption);
    expect(cards.read('project')?.status).toBe('running');
    if (cleanupFails) {
      expect(internals.runIdentity).toBe(identity);
      expect(internals.liveCardActors.get('project')).toBe(owner);
      expect(internals.cardActors.get('project')).toBe(owner);
      expect(supervisor.getStatus().status).toBe('closing');
    } else {
      expect(internals.runIdentity).toBeNull();
      expect(internals.liveCardActors.size).toBe(0);
      expect(internals.cardActors.size).toBe(0);
    }
  });

  it('keeps real cancellation ownership installed until publication and activation settlement complete', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-cancellation-stop-'));
    const { cards, intervention, supervisor, internals, identity, owner, processor } = await startRunningRoot(projectRoot);
    const cleanup = deferred<readonly InvocationJoinOutcome[]>();
    const joinActivation = processor.joinActivation.bind(processor);
    jest.spyOn(processor, 'joinActivation').mockImplementation(async () => [...await cleanup.promise, ...await joinActivation()]);
    const activation = owner.awaitSettlement();
    const order: string[] = [];
    void activation.then(() => order.push(`activation:${cards.read('project')?.status}:${internals.liveCardActors.get('project') === owner}:${internals.cardActors.get('project') === owner}`));

    const cancellation = supervisor.cancelCard('project', 'winning cancellation');
    expect(owner.claim).toBe('claimed_cancel');
    const stopped = supervisor.stopProject();
    void cancellation.then(() => order.push('cancellation'));
    void stopped.then(() => order.push('stop'));
    await Promise.resolve();

    expect(cards.read('project')?.status).toBe('running');
    expect(supervisor.getStatus()).toMatchObject({ status: 'closing', currentCardId: 'project' });
    expect(intervention.interventionReadiness()).toBe('not_ready');
    expect(internals.runIdentity).toBe(identity);
    expect(internals.liveCardActors.get('project')).toBe(owner);
    expect(internals.cardActors.get('project')).toBe(owner);
    expect(order).toEqual([]);

    cleanup.resolve([]);
    await expect(cancellation).resolves.toEqual({ card_id: 'project', status: 'cancelled', cancelled_card_ids: ['project'] });
    await expect(activation).resolves.toEqual({ status: 'cancelled', summary: 'winning cancellation' });
    await expect(stopped).resolves.toEqual({ status: 'stopped', contained: true });

    expect(order).toEqual(['activation:cancelled:true:true', 'cancellation', 'stop']);
    expect(cards.read('project')?.status).toBe('cancelled');
    expect(internals.runIdentity).toBeNull();
    expect(internals.currentness.activeCardId()).toBeNull();
    expect(internals.liveCardActors.size).toBe(0);
    expect(internals.cardActors.size).toBe(0);
    expect(intervention.interventionReadiness()).toBe('stopped');
  });

  it('retains real cancellation ownership when cancellation settlement rejects during Stop', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-cancellation-failure-'));
    const { cards, intervention, supervisor, internals, identity, owner, processor } = await startRunningRoot(projectRoot);
    const cleanup = deferred<readonly InvocationJoinOutcome[]>();
    const joinActivation = processor.joinActivation.bind(processor);
    jest.spyOn(processor, 'joinActivation').mockImplementation(async () => [...await cleanup.promise, ...await joinActivation()]);

    const cancellation = supervisor.cancelCard('project', 'winning cancellation');
    const stopped = supervisor.stopProject();
    const stopFailure = stopped.catch((error: unknown) => error);
    const cancellationFailure = new Error('cancellation cleanup failed');
    cleanup.reject(cancellationFailure);

    await expect(cancellation).rejects.toBe(cancellationFailure);
    const containmentFailure = await stopFailure;
    expect(containmentFailure).toBeInstanceOf(RuntimeContainmentError);
    expect(containmentFailure).toMatchObject({
      code: 'runtime_containment_error',
      failures: [{ component: 'card:project' }],
    });
    expect(cards.read('project')?.status).toBe('running');
    expect(supervisor.getStatus()).toMatchObject({ status: 'closing', currentCardId: 'project' });
    expect(intervention.interventionReadiness()).toBe('not_ready');
    expect(internals.runIdentity).toBe(identity);
    expect(internals.currentness.activeCardId()).toBe('project');
    expect(internals.liveCardActors.get('project')).toBe(owner);
    expect(internals.cardActors.get('project')).toBe(owner);
  });
});
