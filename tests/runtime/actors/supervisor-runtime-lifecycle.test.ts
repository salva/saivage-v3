import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService } from '../../../src/cards/card-service.js';
import { RuntimeInterventionBinding } from '../../../src/application/intervention-readiness.js';
import { ManagedProcessGroupRegistry } from '../../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../../src/runtime/process-runner.js';
import type { CardActor } from '../../../src/runtime/actors/card-actor.js';
import { SupervisorRuntimeApi } from '../../../src/runtime/actors/supervisor-runtime-api.js';
import { RuntimeContainmentError, RuntimeStoppedInterruption } from '../../../src/runtime/actors/runtime-stopped-interruption.js';
import type { InvocationJoinOutcome } from '../../../src/runtime/actors/invocation-lifecycle.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import { initProjectTree } from '../../helpers/canonical-project.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

type SupervisorInternals = {
  runIdentity: object | null;
  currentCardId: string | null;
  liveCardActors: Map<string, CardActor>;
  cardActors: Map<string, CardActor>;
};

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
  const supervisor = new SupervisorRuntimeApi({
    projectRoot, actorStore: cards, interventionBinding: intervention, provider,
    conversations: { projectRoot }, appLogs: { projectRoot },
    readModelChanges: { runtimeChanged() {}, cardStateChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) },
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
  return { cards, intervention, supervisor, internals, identity, owner, processor };
}

describe('Supervisor running-chain and non-domain Stop', () => {
  let projectRoot: string;
  afterEach(() => { if (projectRoot) rmSync(projectRoot, { recursive: true, force: true }); });

  it('installs every chain owner, activates only the deepest role, and stops without card mutation', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-supervisor-lifecycle-'));
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const child = cards.create({
      type: 'code', parent: 'project', depth: 1, title: 'deepest', brief: 'execute', status: 'backlog', tags: [], priority: 0,
      urgency: 'normal', created_by: 'analyst', depends_on: [], related: [],
    });
    cards.setStatus('project', 'running');
    cards.setStatus(child.id, 'running');
    const invocations: LlmInvocationInput[] = [];
    const provider = {
      completeTurn: jest.fn((input: LlmInvocationInput, signal: AbortSignal) => {
        invocations.push(input);
        return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }),
    };
    const processRunner = new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry());
    const supervisor = new SupervisorRuntimeApi({
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
    await new Promise<void>((resolve) => setImmediate(resolve));

    const readModel = supervisor.getActorRuntimeReadModel();
    expect(readModel.cards.map((card) => card.cardId).sort()).toEqual(['project', child.id].sort());
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.role).toBe('executor');
    expect(invocations[0]?.sessionId).toBe(`executor:${child.id}`);
    expect(readModel.agents).toHaveLength(1);

    await expect(supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
    expect(cards.read('project')?.status).toBe('running');
    expect(cards.read(child.id)?.status).toBe('running');
    expect(supervisor.getStatus().status).toBe('stopped');
    expect(supervisor.getActorRuntimeReadModel().cards).toEqual([]);
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
    const supervisor = new SupervisorRuntimeApi({
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
    const supervisor = new SupervisorRuntimeApi({
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
    const supervisor = new SupervisorRuntimeApi({
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
      currentCardId: string | null;
      liveCardActors: Map<string, unknown>;
      cardActors: Map<string, unknown>;
    };
    internals.runIdentity = identity;
    internals.status = 'running';
    internals.currentCardId = 'project';
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
    expect(internals.currentCardId).toBeNull();
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
    expect(internals.currentCardId).toBe('project');
    expect(internals.liveCardActors.get('project')).toBe(owner);
    expect(internals.cardActors.get('project')).toBe(owner);
  });
});
