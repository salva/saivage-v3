import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardActivationOwner } from '../../../src/runtime/actors/card-activation-owner.js';
import type { CardProcessActor } from '../../../src/runtime/actors/card-process-actor.js';
import { ChildInvocationLease } from '../../../src/runtime/actors/child-invocation-wait.js';
import { RuntimeStoppedInterruption } from '../../../src/runtime/actors/runtime-stopped-interruption.js';
import { SupervisorRuntimeApi } from '../../../src/runtime/actors/supervisor-runtime-api.js';
import { RuntimeInterventionBinding } from '../../../src/application/intervention-readiness.js';
import type { CardRecord } from '../../../src/schemas/index.js';
import type { CardActivationOutcome } from '../../../src/contracts/tool-api.js';
import type { ProcessStopReport } from '../../../src/runtime/managed-process-group-registry.js';
import { workflowResult } from '../../helpers/workflow-result.js';
import { AppLogPublicationError } from '../../../src/persistence/app-log.js';
import { CardService, initProjectTree } from '../../helpers/canonical-project.js';
import { createTestProcessRunner } from '../../helpers/test-process-runner.js';
import { createTestPromptTemplateRegistry } from '../../helpers/prompt-template-registry.js';
import { testAutonomousCompaction } from '../../helpers/llm-test-helpers.js';

function barrier<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const processReport: ProcessStopReport = { selected: [], stopped: [], failed: [] };
const interruptionIdentity = { sessionId: 'agent:planner:project', sourceInputId: 'input-1', toolCallId: 'call-1', toolName: 'activate_card' } as const;
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function card(id: 'project' | 'card-a', type: 'project' | 'code' = id === 'project' ? 'project' : 'code'): CardRecord {
  return { id, type, children: [], title: id, subtype: null, tags: [], priority: 0, urgency: 'normal', created_by: 'planner', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', version_seq: 1, assigned_to: null, depends_on: [], related: [], pending_notifications: [], lifecycle: { status: 'running', result: null, error: null, completed_at: null }, metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, metadata: null };
}

interface ProcessorHarness {
  actor: CardProcessActor;
  join: ReturnType<typeof barrier<readonly []>>;
  dispose: ReturnType<typeof jest.fn>;
}

function processor(): ProcessorHarness {
  const join = barrier<readonly []>();
  const dispose = jest.fn();
  let activationJoin: Promise<readonly []> | null = null;
  return {
    join,
    dispose,
    actor: {
      start() {},
      activate: async () => new Promise<never>(() => undefined),
      disposeActivation: dispose,
      suppressContinuationAndPrepareJoin: jest.fn(),
      joinActivation: jest.fn(() => activationJoin ??= join.promise),
      processPosition: () => ({ cardType: 'project', stateId: 'ready', kind: 'ready' }),
      executingLlmSnapshot: () => null,
    } as unknown as CardProcessActor,
  };
}

type HaltTrigger = 'stop' | 'application_close' | 'publication_failure' | 'runtime_failure';
interface SupervisorInternals {
  activationOwners: Map<string, CardActivationOwner>;
  started: boolean;
  runIdentity: object | null;
  currentCardId: string | null;
  status: 'running' | 'closing' | 'error' | 'stopped';
  halt: { interruption: RuntimeStoppedInterruption; owners: readonly CardActivationOwner[]; promise: Promise<void> } | null;
  beginHalt(trigger: HaltTrigger, publicationOwner?: CardActivationOwner, publicationFailure?: Error): Promise<void>;
  publish<T>(owner: CardActivationOwner, write: () => T): T | null;
  activateChild(parent: CardActivationOwner, childCardId: string, lease: ChildInvocationLease): Promise<CardActivationOutcome>;
  settleResult(owner: CardActivationOwner, outcome: Exclude<CardActivationOutcome, { status: 'cancelled' }>): Promise<void>;
}

function harness(withChild = false) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-halt-harness-')); roots.push(projectRoot); initProjectTree(projectRoot);
  const processTermination = barrier<ProcessStopReport>();
  const terminateScopeTree = jest.fn(() => processTermination.promise);
  const intervention = new RuntimeInterventionBinding();
  const lifecycle = new Map<string, CardRecord['lifecycle']['status']>([['project', 'running'], ['card-a', 'running']]);
  const store = {
    read: jest.fn((id: string) => ({ ...card(id as 'project' | 'card-a'), lifecycle: { ...card(id as 'project' | 'card-a').lifecycle, status: lifecycle.get(id)! } })),
    commitActivationOutcome: jest.fn((_id: string, outcome: Exclude<CardActivationOutcome, { status: 'cancelled' }>) => ({ ...card('project'), lifecycle: { ...card('project').lifecycle, status: outcome.status } })),
    setStatus: jest.fn(() => card('project')),
    listChildren: jest.fn((id: string) => withChild && id === 'project' ? ['card-a'] : []),
    stopRunningForRecovery: jest.fn((id: string) => { lifecycle.set(id, 'stopped'); return { ...card(id as 'project' | 'card-a'), lifecycle: { ...card(id as 'project' | 'card-a').lifecycle, status: 'stopped' as const } }; }),
    activateStopped: jest.fn((id: string) => { lifecycle.set(id, 'running'); return { ...card(id as 'project' | 'card-a'), lifecycle: { ...card(id as 'project' | 'card-a').lifecycle, status: 'running' as const } }; }),
  };
  const supervisor = new SupervisorRuntimeApi({
    ...testAutonomousCompaction,
    projectRoot,
    actorStore: store, interventionBinding: intervention,
    provider: { completeTurn: async (_input: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) },
    conversations: { projectRoot },
    freshness: { runtimeChanged() {}, agentsChanged() {}, conversationChanged() {} },
    processRunner: { terminateScopeTree }, runtimeProcessRootScope: {}, processIdentity: { pid: 1, startedAt: 'now' },
    promptTemplates: createTestPromptTemplateRegistry(),
  } as never);
  const rootProcessor = processor();
  const root = new CardActivationOwner({ card: card('project'), store: store as never, processor: rootProcessor.actor, activationId: 'root-activation', entry: 'BACKLOG', caller: { kind: 'root' }, phase: 'prepared_root' });
  root.phase = 'active';
  const internals = supervisor as unknown as SupervisorInternals;
  internals.activationOwners.set('project', root);
  internals.started = true;
  internals.runIdentity = {};
  internals.currentCardId = 'project';
  internals.status = 'running';

  let child: CardActivationOwner | null = null;
  let childProcessor: ProcessorHarness | null = null;
  let lease: ChildInvocationLease | null = null;
  if (withChild) {
    lease = new ChildInvocationLease(interruptionIdentity as never, 'card-a');
    void lease.activation.catch(() => undefined);
    lease.markAdmitted();
    childProcessor = processor();
    child = new CardActivationOwner({ card: card('card-a'), store: store as never, processor: childProcessor.actor, activationId: 'child-activation', entry: 'BACKLOG', caller: { kind: 'parent', cardId: 'project', sessionId: interruptionIdentity.sessionId }, phase: 'child_admission', parentRelationship: { parentCardId: 'project', invocation: lease } });
    child.phase = 'active';
    root.childCardId = child.cardId;
    internals.activationOwners.set(child.cardId, child);
    internals.currentCardId = child.cardId;
  }
  return { supervisor, internals, root, rootProcessor, child, childProcessor, lease, store, processTermination, terminateScopeTree };
}

async function nextTurn(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer!: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Concurrency promise did not settle.')), 1_000); });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}

describe('Supervisor singular runtime halt concurrency', () => {
  it.each([false, true])('halts a running publication whose canonical append is visible=%s, then uses normal recovery', async (canonical) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-halt-prefix-')); roots.push(projectRoot); initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const processes = createTestProcessRunner(projectRoot);
    const supervisor = new SupervisorRuntimeApi({
      ...testAutonomousCompaction,
      projectRoot,
      processIdentity: { pid: 1, startedAt: 'now' },
      actorStore: cards,
      interventionBinding: new RuntimeInterventionBinding(),
      provider: { completeTurn: async (_input: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) },
      conversations: { projectRoot },
      freshness: { runtimeChanged() {}, agentsChanged() {}, conversationChanged() {} },
      processRunner: processes.processRunner,
      runtimeProcessRootScope: processes.runtimeProcessRootScope,
      promptTemplates: createTestPromptTemplateRegistry(),
    });
    const original = cards.setStatus.bind(cards);
    const failure = new Error('publication outcome unknown');
    const write = jest.spyOn(cards, 'setStatus').mockImplementationOnce((id, status) => {
      if (canonical) original(id, status);
      throw failure;
    });

    await expect(supervisor.startProject()).rejects.toBe(failure);
    expect(write).toHaveBeenCalledTimes(1);
    expect(cards.read('project')!.lifecycle.status).toBe(canonical ? 'running' : 'backlog');
    while (supervisor.getStatus().status === 'closing') await nextTurn();
    expect(supervisor.getStatus().status).toBe('stopped');
    write.mockRestore();

    const recovered = await supervisor.startProject();
    if (!recovered.started) throw new Error('Recovery Run was rejected.');
    expect(cards.read('project')!.lifecycle.status).toBe('running');
    await expect(supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
  });

  it.each([false, true])('accepts either valid durable prefix when a terminal publication throws after canonical visibility=%s', async (canonical) => {
    const h = harness();
    const publicationFailure = new Error('terminal publication outcome unknown');
    let durableTerminal = false;
    h.store.commitActivationOutcome.mockImplementationOnce(() => {
      if (canonical) durableTerminal = true;
      throw publicationFailure;
    });
    const ownerSettlement = h.root.settlement.promise.catch((error) => error);
    const outcome = { status: 'done' as const, summary: 'done', result: workflowResult('DONE', 'done') };

    await expect(h.internals.settleResult(h.root, outcome)).resolves.toBeUndefined();
    await expect(ownerSettlement).resolves.toBe(publicationFailure);
    expect(h.store.commitActivationOutcome).toHaveBeenCalledTimes(1);
    expect(durableTerminal).toBe(canonical);
    h.rootProcessor.join.resolve([]); h.processTermination.resolve(processReport);
    await expect(h.internals.halt!.promise).resolves.toBeUndefined();
    expect(h.store.commitActivationOutcome).toHaveBeenCalledTimes(1);
  });

  it('settles every publication-failed running-child promise while joins are blocked, then Runs through existing recovery', async () => {
    const h = harness(true);
    const failure = new AppLogPublicationError('event', new Error('outcome unknown'));
    const parentSettlement = h.root.settlement.promise.catch((error) => error);
    const childSettlement = h.child!.settlement.promise.catch((error) => error);
    const leaseSettlement = h.lease!.activation.catch((error) => error);

    expect(h.internals.publish(h.child!, () => { throw failure; })).toBeNull();

    await expect(within(parentSettlement)).resolves.toBeInstanceOf(RuntimeStoppedInterruption);
    await expect(within(childSettlement)).resolves.toBe(failure);
    await expect(within(leaseSettlement)).resolves.toBe(h.internals.halt!.interruption);
    expect(h.rootProcessor.actor.joinActivation).toHaveBeenCalledTimes(1);
    expect(h.childProcessor!.actor.joinActivation).toHaveBeenCalledTimes(1);
    expect(h.supervisor.getStatus().status).toBe('closing');

    h.rootProcessor.join.resolve([]); h.childProcessor!.join.resolve([]); h.processTermination.resolve(processReport);
    await expect(h.internals.halt!.promise).resolves.toBeUndefined();
    expect(h.supervisor.getStatus().status).toBe('stopped');

    const recovered = await h.supervisor.startProject();
    expect(recovered.started).toBe(true);
    expect(h.store.stopRunningForRecovery.mock.calls.map(([id]) => id)).toEqual(['card-a', 'project']);
    expect(h.store.activateStopped).toHaveBeenCalledTimes(1);
    expect(h.store.activateStopped).toHaveBeenCalledWith('project');
    expect(h.store.read('project').lifecycle.status).toBe('running');
    expect(h.store.read('card-a').lifecycle.status).toBe('stopped');
    await expect(h.supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
  });

  it('shares one freeze, interruption, joins, and process termination across Stop and application close', async () => {
    const h = harness(true);
    const first = h.supervisor.stopProject();
    const interruption = h.internals.halt!.interruption;
    const second = h.supervisor.stopProject();
    h.supervisor.closeApplicationAdmission();
    const app = h.supervisor.cleanupForApplicationStop();

    expect(h.root.abortController.signal.reason).toBe(interruption);
    expect(h.child!.abortController.signal.reason).toBe(interruption);
    expect(h.rootProcessor.dispose).toHaveBeenCalledTimes(1);
    expect(h.childProcessor!.dispose).toHaveBeenCalledTimes(1);
    expect(h.terminateScopeTree).toHaveBeenCalledTimes(1);
    h.rootProcessor.join.resolve([]); h.childProcessor!.join.resolve([]); h.processTermination.resolve(processReport);

    await expect(within(first)).resolves.toEqual({ status: 'stopped', contained: true });
    await expect(within(second)).resolves.toEqual({ status: 'stopped', contained: true });
    await expect(within(app)).resolves.toBeUndefined();
    await expect(h.supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: false });
  });

  it('abandons a near-terminal result after its possible publication and performs no post-freeze natural release', async () => {
    const h = harness();
    const outcome = { status: 'done' as const, summary: 'done', result: workflowResult('DONE', 'done') };
    const settlement = h.internals.settleResult(h.root, outcome);
    expect(h.store.commitActivationOutcome).toHaveBeenCalledTimes(1);
    const stop = h.supervisor.stopProject();
    expect(h.internals.activationOwners.get('project')).toBe(h.root);

    h.rootProcessor.join.resolve([]); h.processTermination.resolve(processReport);
    await expect(settlement).resolves.toBeUndefined();
    await expect(stop).resolves.toEqual({ status: 'stopped', contained: true });
    expect(h.store.commitActivationOutcome).toHaveBeenCalledTimes(1);
  });

  it('fences cancellation publication after Stop freezes a joining cancellation', async () => {
    const h = harness();
    const cancellation = h.supervisor.cancelCard('project', 'cancel now');
    const stop = h.supervisor.stopProject();
    h.rootProcessor.join.resolve([]); h.processTermination.resolve(processReport);

    await expect(within(cancellation)).rejects.toBeInstanceOf(RuntimeStoppedInterruption);
    await expect(within(stop)).resolves.toEqual({ status: 'stopped', contained: true });
    expect(h.store.setStatus).not.toHaveBeenCalled();
  });

  it('interrupts a reserved child admission attempted after freeze without installing work', async () => {
    const h = harness();
    const stop = h.supervisor.stopProject();
    const lease = new ChildInvocationLease({ ...interruptionIdentity, toolCallId: 'late' } as never, 'card-a');
    const activation = h.internals.activateChild(h.root, 'card-a', lease);

    await expect(within(activation)).rejects.toBe(h.internals.halt!.interruption);
    expect(lease.phase()).toBe('rejected');
    expect(h.internals.activationOwners.has('card-a')).toBe(false);
    h.rootProcessor.join.resolve([]); h.processTermination.resolve(processReport);
    await expect(stop).resolves.toEqual({ status: 'stopped', contained: true });
  });

  it('retains a failed halt and frozen graph, rejects Run, and never starts a second cleanup', async () => {
    const h = harness();
    const joinFailure = new Error('join failed');
    const first = h.supervisor.stopProject();
    const concurrent = h.supervisor.stopProject();
    h.rootProcessor.join.reject(joinFailure); h.processTermination.resolve(processReport);
    await expect(within(first)).rejects.toBe(joinFailure);
    await expect(within(concurrent)).rejects.toBe(joinFailure);
    expect(h.supervisor.getStatus().status).toBe('error');
    expect(h.internals.activationOwners.get('project')).toBe(h.root);

    await expect(h.supervisor.stopProject()).rejects.toBe(joinFailure);
    h.supervisor.closeApplicationAdmission();
    await expect(h.supervisor.cleanupForApplicationStop()).rejects.toMatchObject({ cause: joinFailure });
    const run = await within(h.supervisor.startProject());
    expect(run).toMatchObject({ status: 'error', started: false });
    expect(h.rootProcessor.actor.joinActivation).toHaveBeenCalledTimes(1);
    expect(h.terminateScopeTree).toHaveBeenCalledTimes(1);
    await nextTurn();
  });
});
