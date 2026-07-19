import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService } from '../../../src/cards/card-service.js';
import { RuntimeInterventionBinding } from '../../../src/application/intervention-readiness.js';
import { ReadModelChangeBroadcaster } from '../../../src/application/read-model-changes.js';
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
function history(cards: CardService, cardId: string) { const result = cards.listCardHistory(cardId); if (result.kind !== 'found') throw new Error(`missing ${cardId}`); return result.value; }


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
  readiness: string;
};

function projectionSnapshot(supervisor: SupervisorRuntimeApi, intervention: RuntimeInterventionBinding): ProjectionSnapshot {
  const actorRuntime = supervisor.getActorRuntimeReadModel();
  return {
    status: supervisor.getStatus(),
    runtimeCardId: supervisor.getRuntimeState()?.current_card_id ?? null,
    cards: actorRuntime.cards.map(({ cardId }) => cardId),
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
  supervisor.launchStartedProject(prepared.launch);
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

  it.each([
    { status: 'backlog', entry: 'BACKLOG' },
    { status: 'changed', entry: 'CHANGED' },
    { status: 'blocked', entry: 'BLOCKED' },
    { status: 'stopped', entry: 'STOPPED' },
  ] as const)('keeps fresh-root $status admission Supervisor-owned through $entry', async ({ status, entry }) => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-fresh-root-'));
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    if (status !== 'backlog') {
      cards.setStatus('project', 'running');
      if (status === 'changed') cards.setStatus('project', 'changed');
      if (status === 'blocked') cards.commitTerminalLifecyclePatch('project', { status: 'blocked', lifecycle: { status: 'blocked', result: { kind: 'blocked', summary: 'wait', resume_reason: 'test' }, error: 'wait', completed_at: null } });
      if (status === 'stopped') cards.stopRunningForRecovery('project');
    }
    const activateStopped = jest.spyOn(cards, 'activateStopped');
    const supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction,
      projectRoot, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(),
      provider: { completeTurn: async () => { throw new Error('not launched'); } },
      conversations: { projectRoot }, appLogs: { projectRoot }, readModelChanges: new ReadModelChangeBroadcaster(),
      processRunner: new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry()), promptTemplates: { render: () => 'test prompt' },
    });

    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('runtime start was not accepted');
    expect(prepared.launch).toMatchObject({ entry });
    expect(cards.read('project')?.status).toBe('running');
    expect(activateStopped).toHaveBeenCalledTimes(status === 'stopped' ? 1 : 0);
  });

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
      runtimeChanged: () => snapshots.push(projectionSnapshot(supervisor, intervention)),
      cardProjectionChanged: () => undefined,
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
    expect(Object.keys(prepared)).toEqual(['accepted', 'launch']);
    expect(supervisor.getStatus()).toMatchObject({ status: 'stopped', currentCardId: null });
    expect(supervisor.getRuntimeState()).toBeNull();
    snapshots.length = 0;

    const launched = supervisor.launchStartedProject(prepared.launch);
    expect(supervisor.getRuntimeState()).toMatchObject({
      project_id: launched.project_id,
      status: launched.status,
      current_card_id: launched.current_card_id,
      pid: launched.pid,
      started_at: launched.started_at,
    });
    expect(() => supervisor.launchStartedProject(prepared.launch)).toThrow('foreign, stale, or already consumed');
    expect(snapshots).toMatchObject([
      { status: { status: 'stopped', currentCardId: null }, runtimeCardId: null, cards: ['project'], readiness: 'stopped' },
      { status: { status: 'running', currentCardId: 'project' }, runtimeCardId: 'project', cards: ['project'], readiness: 'not_ready' },
    ]);

    await waitUntil(() => supervisor.captureAutonomousExecutingLlmSnapshots().length === 1);
    expect(supervisor.captureAutonomousExecutingLlmSnapshots()[0]).toMatchObject({ role: 'planner', cardId: 'project', activity: { mode: 'active' } });

    snapshots.length = 0;
    await expect(supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
    expect(supervisor.captureAutonomousExecutingLlmSnapshots()).toEqual([]);
    expect(snapshots[0]).toMatchObject({ status: { status: 'closing', currentCardId: 'project' }, runtimeCardId: 'project', cards: ['project'] });
    expect(snapshots.some(({ status, cards }) => status.status === 'closing' && cards.includes('project'))).toBe(true);
    expect(snapshots.at(-1)).toMatchObject({ status: { status: 'stopped', currentCardId: null }, runtimeCardId: null, cards: [], readiness: 'stopped' });
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
      runtimeChanged: () => snapshots.push(projectionSnapshot(supervisor, intervention)),
      cardProjectionChanged: () => undefined,
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
    });
    const internals = supervisor as unknown as SupervisorInternals;
    internals.liveCardActors.set('unprojected-extra', { cardId: 'unprojected-extra' } as CardActor);

    expect(() => supervisor.launchStartedProject(prepared.launch)).toThrow('ownership installation is incomplete');
    expect(snapshots.slice(1)).toMatchObject([
      { status: { status: 'stopped', currentCardId: null }, runtimeCardId: null, cards: ['project'] },
    ]);
    expect(supervisor.getStatus()).toMatchObject({ status: 'stopped', currentCardId: null });
    expect(supervisor.getRuntimeState()).toBeNull();
    expect(supervisor.getActorRuntimeReadModel().cards.map(({ cardId }) => cardId)).toEqual(['project']);
  });

  it('publishes closing before synchronous Stop owner validation failure and never publishes stopped', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-stop-setup-failure-'));
    const { supervisor, internals, owner, changes } = await startRunningRoot(projectRoot);
    const snapshots: Array<ReturnType<SupervisorRuntimeApi['getStatus']>> = [];
    changes.subscribe({
      runtimeChanged: () => snapshots.push(supervisor.getStatus()), cardProjectionChanged: () => undefined, agentsChanged: () => undefined, conversationChanged: () => undefined,
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
    changes.subscribe({ runtimeChanged: () => snapshots.push(projectionSnapshot(supervisor, intervention)), cardProjectionChanged: () => undefined, agentsChanged: () => undefined, conversationChanged: () => undefined });
    supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction,
      projectRoot, actorStore: cards, interventionBinding: intervention,
      provider: { completeTurn: (_input, signal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) },
      conversations: { projectRoot }, appLogs: { projectRoot }, readModelChanges: changes,
      processRunner: new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry()), promptTemplates: { render: () => 'test prompt' },
    });
    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('runtime start was not accepted');
    supervisor.launchStartedProject(prepared.launch);
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
    changes.subscribe({ runtimeChanged: () => statuses.push(supervisor.getStatus().status), cardProjectionChanged: () => undefined, agentsChanged: () => undefined, conversationChanged: () => undefined });

    expect(supervisor.beginPause()).toEqual({ settled: false });
    const gate = (supervisor as unknown as { runtimeGate: import('../../../src/runtime/runtime-gate.js').RuntimeGate }).runtimeGate;
    const parked = gate.waitUntilOpen(new AbortController().signal);
    expect(statuses).toEqual(['pausing', 'paused']);
    expect(supervisor.getRuntimeState()?.status).toBe('paused');
    supervisor.beginResume();
    supervisor.finishResume();
    await parked;
    expect(statuses).toEqual(['pausing', 'paused', 'running']);
    await expect(supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
  });

  it('keeps lifecycle identity stable while fresh state observations change', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-stable-identity-'));
    const { supervisor } = await startRunningRoot(projectRoot);
    const first = supervisor.getRuntimeState();
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = supervisor.getRuntimeState();
    expect(first).toMatchObject({ pid: 4242, started_at: '2026-07-18T00:00:00.000Z', current_card_id: 'project' });
    expect(second).toMatchObject({ pid: first?.pid, started_at: first?.started_at, current_card_id: 'project' });
    expect(second?.updated_at).not.toBe(first?.updated_at);
    await supervisor.stopProject();
    expect(supervisor.getStatus()).toMatchObject({ pid: 4242, startedAt: '2026-07-18T00:00:00.000Z', currentCardId: null });
  });

  it('does not enumerate durable inventory to read status or runtime state', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-read-no-enumeration-'));
    const { supervisor, cards } = await startRunningRoot(projectRoot);
    const list = jest.spyOn(cards, 'list');
    const listChildren = jest.spyOn(cards, 'listChildren');
    const ancestors = jest.spyOn(cards, 'getAncestors');
    const history = jest.spyOn(cards, 'listCardHistory');
    expect(supervisor.getStatus().currentCardId).toBe('project');
    expect(supervisor.getRuntimeState()?.current_card_id).toBe('project');
    expect(list).not.toHaveBeenCalled();
    expect(listChildren).not.toHaveBeenCalled();
    expect(ancestors).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    await supervisor.stopProject();
  });

  it('throws when runtime identity and active leaf presence disagree', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-currentness-mismatch-'));
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction, projectRoot, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(), provider: { completeTurn: async () => { throw new Error('unused'); } }, conversations: { projectRoot }, appLogs: { projectRoot }, readModelChanges: new ReadModelChangeBroadcaster(), processRunner: new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry()), promptTemplates: { render: () => 'test prompt' } });
    await supervisor.start();
    (supervisor as unknown as SupervisorInternals).currentness.setChain(['project']);
    expect(() => supervisor.getRuntimeState()).toThrow('Runtime identity and active leaf presence disagree.');
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
      return new Promise<ProviderTurnCompletion>((resolve) => { releaseTerminal = () => resolve(complete(tool('emit-done', 'emit_result', { outcome: 'complete_direct', summary: 'Complete.' }))); });
    }) };
    let supervisor!: SupervisorRuntimeApi;
    const snapshots: ProjectionSnapshot[] = [];
    changes.subscribe({ runtimeChanged: () => snapshots.push(projectionSnapshot(supervisor, intervention)), cardProjectionChanged: () => undefined, agentsChanged: () => undefined, conversationChanged: () => undefined });
    supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction,
      projectRoot, actorStore: cards, interventionBinding: intervention, provider,
      conversations: { projectRoot }, appLogs: { projectRoot },
      readModelChanges: changes,
      processRunner: new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry()), promptTemplates: { render: () => 'test prompt' },
    });
    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('runtime start was not accepted');
    supervisor.launchStartedProject(prepared.launch);
    const runningVersion = cards.read('project')!.version_seq;
    await waitUntil(() => releaseTerminal !== undefined);
    const internals = supervisor as unknown as SupervisorInternals;
    const owner = internals.cardActors.get('project');
    if (!owner) throw new Error('root actor ownership was not installed');
    expect(internals.liveCardActors.get('project')).toBe(owner);
    expect(supervisor.getActorRuntimeReadModel()).toMatchObject({ cards: [{ cardId: 'project' }] });
    expect(supervisor.getActorRuntimeReadModel()).not.toHaveProperty('agents');

    releaseTerminal();
    await waitUntil(() => supervisor.getStatus().status === 'stopped');

    expect(cards.read('project')).toMatchObject({ status: 'done', version_seq: runningVersion + 1, lifecycle: { result: { kind: 'done', summary: 'Complete.' } } });
    expect(history(cards, 'project').filter((entry) => entry.change_reason === 'terminal lifecycle commit')).toHaveLength(1);
    expect(internals.liveCardActors.has('project')).toBe(false);
    expect(internals.cardActors.has('project')).toBe(false);
    expect(supervisor.getActorRuntimeReadModel()).toMatchObject({ cards: [] });
    expect(supervisor.getStatus()).toMatchObject({ status: 'stopped', currentCardId: null });
    expect(intervention.interventionReadiness()).toBe('stopped');
    expect(snapshots.at(-1)).toMatchObject({ status: { status: 'stopped', currentCardId: null }, runtimeCardId: null, cards: [], readiness: 'stopped' });
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
    changes.subscribe({ runtimeChanged: () => snapshots.push(projectionSnapshot(supervisor, intervention)), cardProjectionChanged: () => undefined, agentsChanged: () => undefined, conversationChanged: () => undefined });
    supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction,
      projectRoot, actorStore: cards, interventionBinding: intervention, provider,
      conversations: { projectRoot }, appLogs: { projectRoot }, readModelChanges: changes,
      processRunner: new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry()), promptTemplates: { render: () => 'test prompt' },
    });
    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('runtime start was not accepted');
    supervisor.launchStartedProject(prepared.launch);
    const runningVersion = cards.read('project')!.version_seq;
    await waitUntil(() => supervisor.getStatus().status === 'stopped');

    expect(cards.read('project')).toMatchObject({ status: 'failed', version_seq: runningVersion + 1 });
    expect(history(cards, 'project').filter((entry) => entry.change_reason === 'terminal lifecycle commit')).toHaveLength(1);
    expect(snapshots.at(-1)).toMatchObject({ status: { status: 'stopped', currentCardId: null }, runtimeCardId: null, cards: [], readiness: 'stopped' });
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

  it('resets a lost running chain to a fresh top-only STOPPED activation', async () => {
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
      readModelChanges: { runtimeChanged() {}, cardProjectionChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) },
      processRunner,
      promptTemplates: { render: () => 'test prompt' },
    });

    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('runtime start was not accepted');
    supervisor.launchStartedProject(prepared.launch);
    await waitUntil(() => invocations.length === 1);

    const internals = supervisor as unknown as SupervisorInternals;
    const chainIds = ['project'];
    const beforeCardActors = new Map(internals.cardActors);
    const beforeLiveCardActors = new Map(internals.liveCardActors);
    expect([...beforeCardActors.keys()].sort()).toEqual([...chainIds].sort());
    expect([...beforeLiveCardActors.keys()].sort()).toEqual([...chainIds].sort());
    for (const cardId of chainIds) {
      expect(beforeCardActors.get(cardId)).toBe(beforeLiveCardActors.get(cardId));
    }
    expect(beforeCardActors.get('project')?.processor).not.toBeNull();
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.role).toBe('planner');
    expect(invocations[0]?.sessionId).toBe('planner:project');
    expect(supervisor.getActorRuntimeReadModel()).toEqual({ pauseMode: 'running', cards: expect.any(Array) });

    await expect(supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
    expect(internals.cardActors.size).toBe(0);
    expect(internals.liveCardActors.size).toBe(0);
    expect(cards.read('project')?.status).toBe('running');
    expect(cards.read(goal.id)?.status).toBe('stopped');
    expect(cards.read(terminal.id)?.status).toBe('stopped');
    expect(supervisor.getStatus().status).toBe('stopped');
    expect(supervisor.getActorRuntimeReadModel().cards).toEqual([]);

    const restarted = await supervisor.beginStartProject();
    if (!restarted.accepted) throw new Error('runtime restart was not accepted');
    supervisor.launchStartedProject(restarted.launch);
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
    expect(afterCardActors.get('project')?.processor).not.toBeNull();
    expect(invocations).toHaveLength(2);
    expect(invocations[1]?.role).toBe('planner');
    expect(invocations[1]?.sessionId).toBe(invocations[0]?.sessionId);
    expect(invocations[1]?.inputId).not.toBe(invocations[0]?.inputId);
    expect(supervisor.getActorRuntimeReadModel()).toEqual({ pauseMode: 'running', cards: expect.any(Array) });
    await expect(supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
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
      readModelChanges: { runtimeChanged() {}, cardProjectionChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) },
      processRunner: new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry()), promptTemplates: { render: () => 'test prompt' },
    });
    const internals = supervisor as unknown as SupervisorInternals;

    await expect(supervisor.beginStartProject()).rejects.toThrow('more than one running direct child');
    expect(internals.runIdentity).toBeNull();
    expect(internals.liveCardActors.size).toBe(0);
    expect(internals.cardActors.size).toBe(0);
    expect(supervisor.getActorRuntimeReadModel()).toEqual({ pauseMode: 'idle', cards: [] });
    expect(provider.completeTurn).not.toHaveBeenCalled();
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
      readModelChanges: { runtimeChanged() {}, cardProjectionChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) },
      processRunner, promptTemplates: { render: () => 'test prompt' },
    });
    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('runtime start was not accepted');
    supervisor.launchStartedProject(prepared.launch);
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
      readModelChanges: { runtimeChanged() {}, cardProjectionChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) },
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
      readModelChanges: { runtimeChanged() {}, cardProjectionChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) },
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
