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
import { EventBus } from '../../../src/events/index.js';
import { testAutonomousCompaction } from '../../helpers/llm-test-helpers.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function complete(result: LlmCompleteResult): ProviderTurnCompletion { return { result, provider_exchanges: [] }; }
function tool(id: string, name: string, args: object): LlmCompleteResult { return { kind: 'tool_calls', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }; }
async function waitUntil(predicate: () => boolean): Promise<void> { for (let attempt = 0; attempt < 500; attempt += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } throw new Error('condition not reached'); }

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
    const cards = new CardService(projectRoot, undefined, changes, () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa');
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

  it('rejects persisted running siblings before installing any actor or processor ownership', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-invalid-siblings-'));
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot, undefined, undefined, (() => {
      const ids = ['aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbb'];
      let index = 0;
      return () => ids[index++]!;
    })());
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
    const cards = new CardService(projectRoot, bus, undefined, () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa');
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
