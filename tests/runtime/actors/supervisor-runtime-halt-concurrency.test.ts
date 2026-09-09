import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardActivationOwner } from '../../../src/runtime/actors/card-activation-owner.js';
import type { CardProcessActor } from '../../../src/runtime/actors/card-process-actor.js';
import { ChildInvocationLease } from '../../../src/runtime/actors/child-invocation-wait.js';
import { RuntimeStoppedInterruption } from '../../../src/runtime/actors/runtime-stopped-interruption.js';
import { createSupervisorRuntimeApi } from '../../../src/runtime/actors/supervisor-runtime-api.js';
import type { CardRecord, ConversationSessionId } from '../../../src/schemas/index.js';
import type { CardActivationOutcome } from '../../../src/contracts/tool-api.js';
import type { ProcessStopReport } from '../../../src/runtime/managed-process-group-registry.js';
import { workflowResult } from '../../helpers/workflow-result.js';
import { PublicationOutcomeUnknownError } from '../../../src/contracts/publication-outcome.js';
import { testApplicationFatalDelivery, testApplicationFatalPort } from '../../helpers/test-application-fatal-port.js';
import { CardService, initProjectTree } from '../../helpers/canonical-project.js';
import { createTestProcessRunner } from '../../helpers/test-process-runner.js';
import { createTestPromptTemplateRegistry } from '../../helpers/prompt-template-registry.js';
import { scriptedAdmissionProvider, testAutonomousCompaction } from '../../helpers/llm-test-helpers.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import type { AgentMembershipFreshnessTarget } from '../../../src/application/freshness-effects.js';

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

function card(id: string, type: 'project' | 'code' = id === 'project' ? 'project' : 'code'): CardRecord {
  return { id, type, child_membership: [], active_child_order: [], title: id, subtype: null, tags: [], priority: 0, urgency: 'normal', created_by: 'planner', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', version_seq: 1, assigned_to: null, depends_on: [], related: [], pending_notifications: [], lifecycle: { status: 'running', result: null, error: null, completed_at: null }, metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, metadata: null };
}

interface ProcessorHarness {
  actor: CardProcessActor;
  join: ReturnType<typeof barrier<readonly []>>;
  dispose: ReturnType<typeof jest.fn>;
}

function processor(snapshot: ReturnType<CardProcessActor['executingLlmSnapshot']> = null): ProcessorHarness {
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
      executingLlmSnapshot: () => snapshot,
    } as unknown as CardProcessActor,
  };
}

type HaltTrigger = 'stop' | 'application_close' | 'publication_failure' | 'runtime_failure';
interface SupervisorInternals {
  activationOwners: Map<string, CardActivationOwner>;
  runIdentity: object | null;
  currentCardId: string | null;
  status: 'running' | 'closing' | 'error' | 'stopped';
  halt: { interruption: RuntimeStoppedInterruption; owners: readonly CardActivationOwner[]; promise: Promise<void> } | null;
  beginHalt(trigger: HaltTrigger, publicationOwner?: CardActivationOwner, publicationFailure?: Error): Promise<void>;
  publish<T>(owner: CardActivationOwner, write: () => T): T | null;
  activateChild(parent: CardActivationOwner, childCardId: string, lease: ChildInvocationLease): Promise<CardActivationOutcome>;
  createOwner(...args: never[]): CardActivationOwner;
  settleResult(owner: CardActivationOwner, outcome: Exclude<CardActivationOutcome, { status: 'cancelled' }>): Promise<void>;
  onProcessorActorMainFailure(cardId: string, activationId: string, error: unknown): void;
}

function harness(withChild = false) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-halt-harness-')); roots.push(projectRoot); initProjectTree(projectRoot);
  const processTermination = barrier<ProcessStopReport>();
  const terminateScopeTree = jest.fn(() => processTermination.promise);
  const lifecycle = new Map<string, CardRecord['lifecycle']['status']>([['project', 'running'], ['card-a', 'running']]);
  const store = {
    read: jest.fn((id: string) => ({ ...card(id), lifecycle: { ...card(id).lifecycle, status: lifecycle.get(id) ?? 'running' } })),
    readActivationAdmission: jest.fn((id: string) => id === 'card-a' ? { child: { ...card('card-a'), lifecycle: { ...card('card-a').lifecycle, status: lifecycle.get(id)! } }, dependencies: [] } : null),
    commitActivationOutcome: jest.fn((_id: string, outcome: Exclude<CardActivationOutcome, { status: 'cancelled' }>) => ({ ...card('project'), lifecycle: { ...card('project').lifecycle, status: outcome.status } })),
    setStatus: jest.fn(() => card('project')),
    listChildren: jest.fn((id: string) => withChild && id === 'project' ? ['card-a'] : []),
    stopRunningForRecovery: jest.fn((id: string) => { lifecycle.set(id, 'stopped'); return { ...card(id), lifecycle: { ...card(id).lifecycle, status: 'stopped' as const } }; }),
    activateStopped: jest.fn((id: string) => { lifecycle.set(id, 'running'); return { ...card(id), lifecycle: { ...card(id).lifecycle, status: 'running' as const } }; }),
  };
  const runtimeChanged = jest.fn();
  const membershipRecords: Array<{ target: { scope: 'card'; cardId: string }; liveIds: ConversationSessionId[]; ownersCleared: boolean }> = [];
  let supervisor!: ReturnType<typeof createSupervisorRuntimeApi>;
  supervisor = createSupervisorRuntimeApi({
    fatalPort: testApplicationFatalPort,
    ...testAutonomousCompaction,
    runtimeGate: new RuntimeGate(),
    projectRoot,
    actorStore: store,
    provider: scriptedAdmissionProvider(async (_input: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))),
    conversations: { projectRoot },
    freshness: { runtimeChanged, agentMembershipChanged: (target: AgentMembershipFreshnessTarget) => membershipRecords.push({ target: target as { scope: 'card'; cardId: string }, liveIds: [...supervisor.captureAutonomousExecutingLlmSnapshots().keys()], ownersCleared: (supervisor as unknown as SupervisorInternals).activationOwners.size === 0 }) },
    processRunner: { terminateScopeTree }, runtimeProcessRootScope: {}, processIdentity: { pid: 1, startedAt: 'now' },
    promptTemplates: createTestPromptTemplateRegistry(),
  } as never);
  const rootProcessor = processor();
  const root = new CardActivationOwner({ card: card('project'), processor: rootProcessor.actor, activationId: 'root-activation', entry: 'BACKLOG', phase: 'prepared_root' });
  root.phase = 'active';
  const internals = supervisor as unknown as SupervisorInternals;
  internals.activationOwners.set('project', root);
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
    child = new CardActivationOwner({ card: card('card-a'), processor: childProcessor.actor, activationId: 'child-activation', entry: 'BACKLOG', phase: 'child_admission', parentRelationship: { parentCardId: 'project', invocation: lease } });
    child.phase = 'active';
    root.childCardId = child.cardId;
    internals.activationOwners.set(child.cardId, child);
    internals.currentCardId = child.cardId;
  }
  return { supervisor, internals, root, rootProcessor, child, childProcessor, lease, store, lifecycle, runtimeChanged, membershipRecords, processTermination, terminateScopeTree };
}

async function nextTurn(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer!: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Concurrency promise did not settle.')), 1_000); });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}

describe('Supervisor singular runtime halt concurrency', () => {
  it('captures installed autonomous selection, handoff, and ordinary release exactly', () => {
    const h = harness();
    const snapshot = jest.spyOn(h.rootProcessor.actor, 'executingLlmSnapshot');
    snapshot.mockReturnValueOnce({ sessionId: 'agent:planner:project' } as never);
    expect([...h.supervisor.captureAutonomousExecutingLlmSnapshots().keys()]).toEqual(['agent:planner:project']);
    snapshot.mockReturnValueOnce({ sessionId: 'agent:reviewer:project' } as never);
    expect([...h.supervisor.captureAutonomousExecutingLlmSnapshots().keys()]).toEqual(['agent:reviewer:project']);
    snapshot.mockReturnValueOnce(null);
    expect(h.supervisor.captureAutonomousExecutingLlmSnapshots().size).toBe(0);
  });

  it('reports a blocked durable parent before rejecting a durable running child as non-activatable and installs no work', () => {
    const h = harness();
    h.lifecycle.set('project', 'blocked');
    const snapshot = { sessionId: interruptionIdentity.sessionId, sourceInputId: interruptionIdentity.sourceInputId, toolCallId: interruptionIdentity.toolCallId, toolName: interruptionIdentity.toolName } as never;
    jest.spyOn(h.rootProcessor.actor, 'executingLlmSnapshot').mockReturnValue(snapshot);
    const createOwner = jest.spyOn(h.internals, 'createOwner');
    const lease = new ChildInvocationLease(interruptionIdentity as never, 'card-a');
    void lease.activation.catch(() => undefined);

    expect(() => h.internals.activateChild(h.root, 'card-a', lease)).toThrow(new Error('Runtime invariant failed: operation=activate_child parent=project parent_status=blocked child=card-a child_status=running parent_activation=root-activation.'));
    expect(h.store.readActivationAdmission).toHaveBeenCalledTimes(1);
    expect(h.internals.activationOwners.has('card-a')).toBe(false);
    expect(createOwner).not.toHaveBeenCalled();
    expect(h.root.childCardId).toBeNull();
    expect(lease.phase()).toBe('reserved');
    expect(h.store.activateStopped).not.toHaveBeenCalled();
    expect(h.store.setStatus).not.toHaveBeenCalled();
    expect(h.runtimeChanged).not.toHaveBeenCalled();
  });

  it('reports exact durable owner and child statuses before result settlement effects', async () => {
    const h = harness(true);
    h.root.cachedStatus = 'blocked';
    const outcome = { status: 'done' as const, summary: 'done', result: workflowResult('DONE', 'done') };

    await expect(h.internals.settleResult(h.root, outcome)).rejects.toThrow(new Error('Runtime invariant failed: operation=settle_result card=project card_status=running activation=root-activation child=card-a child_status=running.'));
    expect(h.root.phase).toBe('active');
    expect(h.root.terminalWinner).toBe('open');
    expect(h.lease!.phase()).toBe('admitted');
    expect(h.store.read).toHaveBeenNthCalledWith(1, 'project');
    expect(h.store.read).toHaveBeenNthCalledWith(2, 'card-a');
    expect(h.store.read).toHaveBeenCalledTimes(2);
    expect(h.store.commitActivationOutcome).not.toHaveBeenCalled();
  });

  it('reports a missing recorded child without inventing a status before result settlement effects', async () => {
    const h = harness(true);
    h.store.read.mockImplementation((id: string) => id === 'card-a' ? null as never : card('project'));
    const outcome = { status: 'done' as const, summary: 'done', result: workflowResult('DONE', 'done') };

    await expect(h.internals.settleResult(h.root, outcome)).rejects.toThrow(new Error("Runtime invariant failed: operation=settle_result card=project activation=root-activation; owned child card 'card-a' not found."));
    expect(h.root.phase).toBe('active');
    expect(h.root.terminalWinner).toBe('open');
    expect(h.lease!.phase()).toBe('admitted');
    expect(h.store.commitActivationOutcome).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'missing linked membership',
      configure: (h: ReturnType<typeof harness>) => {
        h.store.listChildren.mockImplementation((id: string) => id === 'project' ? ['card-a'] : []);
        h.store.read.mockImplementation((id: string) => id === 'card-a' ? null as never : card('project'));
      },
      error: "Linked child 'card-a' of 'project' is missing.",
    },
    {
      name: 'branching running children',
      configure: (h: ReturnType<typeof harness>) => {
        h.store.listChildren.mockImplementation((id: string) => id === 'project' ? ['card-a', 'card-b'] : []);
      },
      error: "Running card 'project' has more than one running direct child.",
    },
    {
      name: 'discontinuous running descendant',
      configure: (h: ReturnType<typeof harness>) => {
        h.lifecycle.set('card-a', 'stopped');
        h.store.listChildren.mockImplementation((id: string) => id === 'project' ? ['card-a'] : id === 'card-a' ? ['card-a-b'] : []);
      },
      error: "Linked running card 'card-a-b' is outside the unique project-rooted running chain.",
    },
    {
      name: 'additional card in a valid running chain',
      configure: (h: ReturnType<typeof harness>) => {
        h.store.listChildren.mockImplementation((id: string) => id === 'project' ? ['card-a'] : []);
      },
      error: "Natural root settlement requires the durable running chain to be exactly ['project'].",
    },
    {
      name: 'empty durable running chain',
      configure: (h: ReturnType<typeof harness>) => {
        h.lifecycle.set('project', 'stopped');
      },
      error: "Natural root settlement requires the durable running chain to be exactly ['project'].",
    },
  ])('rejects natural root settlement before publication for $name', async ({ configure, error }) => {
    const h = harness();
    configure(h);
    const outcome = { status: 'done' as const, summary: 'done', result: workflowResult('DONE', 'done') };

    await expect(h.internals.settleResult(h.root, outcome)).rejects.toThrow(error);
    expect(h.store.commitActivationOutcome).not.toHaveBeenCalled();
    expect(h.root.phase).toBe('active');
    expect(h.root.terminalWinner).toBe('open');
  });

  it.each([false, true])('halts a running publication whose canonical append is visible=%s, then uses normal recovery', async (canonical) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-halt-prefix-')); roots.push(projectRoot); initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const processes = createTestProcessRunner(projectRoot);
    const supervisor = createSupervisorRuntimeApi({
      fatalPort: testApplicationFatalPort,
      ...testAutonomousCompaction,
      runtimeGate: new RuntimeGate(),
      projectRoot,
      processIdentity: { pid: 1, startedAt: 'now' },
      actorStore: cards,
      provider: scriptedAdmissionProvider(async (_input: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))),
      conversations: { projectRoot },
      freshness: { runtimeChanged() {}, agentMembershipChanged() {} },
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

  it('delivers publication uncertainty before installing the ordinary halt', () => {
    const h = harness(true);
    const failure = new PublicationOutcomeUnknownError();
    expect(() => h.internals.publish(h.child!, () => { throw failure; })).toThrow(testApplicationFatalDelivery);
    expect(h.internals.halt).toBeNull();
    expect(h.supervisor.getStatus().status).toBe('running');
    expect(h.rootProcessor.actor.joinActivation).not.toHaveBeenCalled();
    expect(h.childProcessor!.actor.joinActivation).not.toHaveBeenCalled();
    expect(h.terminateScopeTree).not.toHaveBeenCalled();
  });

  it('shares one freeze, interruption, joins, and process termination across Stop and application close', async () => {
    const h = harness(true);
    const first = h.supervisor.stopProject();
    expect(() => h.supervisor.assertInterventionReady()).toThrow('Analyst mutation requires an intervention-ready stopped or settled paused runtime.');
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
    expect(() => h.supervisor.assertInterventionReady()).not.toThrow();
    await expect(h.supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: false });
  });

  it('publishes every frozen owner membership target only after authoritative halt removal', async () => {
    const h = harness(true);
    const rootSession = 'agent:planner:project' as const;
    const childSession = 'agent:executor:card-a' as const;
    jest.spyOn(h.rootProcessor.actor, 'executingLlmSnapshot').mockReturnValue({ sessionId: rootSession } as never);
    jest.spyOn(h.childProcessor!.actor, 'executingLlmSnapshot').mockReturnValue({ sessionId: childSession } as never);
    expect([...h.supervisor.captureAutonomousExecutingLlmSnapshots().keys()].sort()).toEqual([childSession, rootSession].sort());

    const stop = h.supervisor.stopProject();
    expect(h.internals.activationOwners.size).toBe(2);
    expect(h.membershipRecords).toEqual([]);

    h.rootProcessor.join.resolve([]);
    h.childProcessor!.join.resolve([]);
    h.processTermination.resolve(processReport);
    await expect(stop).resolves.toEqual({ status: 'stopped', contained: true });

    expect(h.membershipRecords).toHaveLength(2);
    expect(h.membershipRecords.map(({ target }) => target).sort((a, b) => a.cardId.localeCompare(b.cardId))).toEqual([
      { scope: 'card', cardId: 'card-a' },
      { scope: 'card', cardId: 'project' },
    ]);
    for (const record of h.membershipRecords) {
      expect(record.ownersCleared).toBe(true);
      expect(record.liveIds).not.toContain(rootSession);
      expect(record.liveIds).not.toContain(childSession);
    }
    expect(h.supervisor.captureAutonomousExecutingLlmSnapshots().size).toBe(0);
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
    expect(() => h.supervisor.assertInterventionReady()).toThrow('Analyst mutation requires an intervention-ready stopped or settled paused runtime.');
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

  it('routes an exact child actor-main notification through the singular frozen halt with every join observed', async () => {
    const h = harness(true);
    const failure = new Error('child actor-main failure');
    const rootSettlement = h.root.settlement.promise.catch((error) => error);
    const childSettlement = h.child!.settlement.promise.catch((error) => error);
    const leaseSettlement = h.lease!.activation.catch((error) => error);

    h.internals.onProcessorActorMainFailure(h.child!.cardId, h.child!.activationId, failure);
    h.rootProcessor.join.resolve([]);
    h.childProcessor!.join.reject(failure);
    h.processTermination.resolve(processReport);

    await expect(within(rootSettlement)).resolves.toBe(h.internals.halt!.interruption);
    await expect(within(childSettlement)).resolves.toBe(h.internals.halt!.interruption);
    await expect(within(leaseSettlement)).resolves.toBe(h.internals.halt!.interruption);
    await expect(within(h.internals.halt!.promise)).rejects.toBe(failure);
    expect(h.rootProcessor.actor.joinActivation).toHaveBeenCalledTimes(1);
    expect(h.childProcessor!.actor.joinActivation).toHaveBeenCalledTimes(1);
    expect(h.terminateScopeTree).toHaveBeenCalledTimes(1);
    expect(h.store.commitActivationOutcome).not.toHaveBeenCalled();
    expect(h.supervisor.getStatus().status).toBe('error');
  });

  it('retains structurally earlier synchronous containment failure while joining later actor and process failures', async () => {
    const h = harness(true);
    const actorFailure = new Error('actor failure A');
    const cleanupFailure = new Error('cleanup failure B');
    const laterJoinFailure = new Error('later child join failure');
    const terminationFailure = new Error('later termination failure');
    h.rootProcessor.dispose.mockImplementationOnce(() => { throw cleanupFailure; });
    void h.root.settlement.promise.catch(() => undefined);
    void h.child!.settlement.promise.catch(() => undefined);

    h.internals.onProcessorActorMainFailure(h.root.cardId, h.root.activationId, actorFailure);
    h.rootProcessor.join.reject(actorFailure);
    h.childProcessor!.join.reject(laterJoinFailure);
    h.processTermination.reject(terminationFailure);

    await expect(within(h.internals.halt!.promise)).rejects.toBe(cleanupFailure);
    expect(h.rootProcessor.dispose).toHaveBeenCalledTimes(1);
    expect(h.childProcessor!.dispose).toHaveBeenCalledTimes(1);
    expect(h.rootProcessor.actor.joinActivation).toHaveBeenCalledTimes(1);
    expect(h.childProcessor!.actor.joinActivation).toHaveBeenCalledTimes(1);
    expect(h.terminateScopeTree).toHaveBeenCalledTimes(1);
    expect(h.supervisor.getStatus().status).toBe('error');
  });
});
