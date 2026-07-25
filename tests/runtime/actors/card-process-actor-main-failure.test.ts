import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAppTerminalCoordinator } from '../../../src/boot/app.js';
import { RuntimeInterventionBinding } from '../../../src/application/intervention-readiness.js';
import { SupervisorRuntimeApi } from '../../../src/runtime/actors/supervisor-runtime-api.js';
import { testApplicationFatalPort } from '../../helpers/test-application-fatal-port.js';
import type { CardActivationOwner } from '../../../src/runtime/actors/card-activation-owner.js';
import { CardProcessActor } from '../../../src/runtime/actors/card-process-actor.js';
import { ConversationLLMActor, type LLMProviderPort } from '../../../src/runtime/actors/llm-actor.js';
import { ActivationOperationTracker } from '../../../src/runtime/actors/invocation-lifecycle.js';
import { RuntimeStoppedInterruption } from '../../../src/runtime/actors/runtime-stopped-interruption.js';
import type { CardActivationOutcome } from '../../../src/contracts/tool-api.js';
import { CardService, initProjectTree } from '../../helpers/canonical-project.js';
import { createTestProcessRunner } from '../../helpers/test-process-runner.js';
import { createTestPromptTemplateRegistry } from '../../helpers/prompt-template-registry.js';
import { testAutonomousCompaction } from '../../helpers/llm-test-helpers.js';

const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

interface LaunchPlan { readonly owner: CardActivationOwner }
interface SupervisorInternals {
  activationOwners: Map<string, CardActivationOwner>;
  halt: { interruption: RuntimeStoppedInterruption; promise: Promise<void> } | null;
  beginStartProject(): Promise<{ accepted: true; launch: LaunchPlan } | { accepted: false }>;
  launchStartedProject(launch: LaunchPlan): unknown;
}

function harness(provider: LLMProviderPort = { completeTurn: async (_input: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-actor-main-failure-'));
  roots.push(projectRoot);
  initProjectTree(projectRoot);
  const cards = new CardService(projectRoot);
  const processes = createTestProcessRunner(projectRoot);
  const actorFailure = new Error('actor-main invariant failure');
  let armed = false;
  let failureDelivered = false;
  const supervisor = new SupervisorRuntimeApi({
    fatalPort: testApplicationFatalPort,
    ...testAutonomousCompaction,
    projectRoot,
    actorStore: cards,
    interventionBinding: new RuntimeInterventionBinding(),
    provider,
    conversations: { projectRoot },
    freshness: { runtimeChanged() { if (armed && !failureDelivered && new Error().stack?.includes('card-process-actor.')) { failureDelivered = true; throw actorFailure; } } },
    processRunner: processes.processRunner,
    runtimeProcessRootScope: processes.runtimeProcessRootScope,
    promptTemplates: createTestPromptTemplateRegistry(),
  });
  const terminate = jest.spyOn(processes.processRunner, 'terminateScopeTree');
  return { supervisor, cards, actorFailure, terminate, armActorTransitionFailure() { armed = true; failureDelivered = false; } };
}

async function launchCapturingActivation(h: ReturnType<typeof harness>) {
  await h.supervisor.start();
  const internals = h.supervisor as unknown as SupervisorInternals;
  const prepared = await internals.beginStartProject();
  if (!prepared.accepted) throw new Error('test launch was rejected');
  const owner = prepared.launch.owner;
  void owner.settlement.promise.catch(() => undefined);
  const original = owner.processor.activate.bind(owner.processor);
  let activation!: Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>>;
  jest.spyOn(owner.processor, 'activate').mockImplementation((input, signal) => activation = original(input, signal));
  internals.launchStartedProject(prepared.launch);
  return { owner, activation };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer!: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Actor-main regression promise did not settle.')), 1_000); });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}

async function waitForError(supervisor: SupervisorRuntimeApi): Promise<void> {
  await within((async () => {
    while (supervisor.getStatus().status !== 'error') await new Promise((resolve) => setTimeout(resolve, 5));
  })());
}

function fatalNotificationSpy(supervisor: SupervisorRuntimeApi) {
  return jest.spyOn(supervisor as never, 'onProcessorActorMainFailure' as never);
}

describe('real CardProcess actor-main fatal containment', () => {
  it('rejects an actor-first root activation exactly, publishes no ordinary result, and retains one failed halt', async () => {
    const h = harness();
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const notification = fatalNotificationSpy(h.supervisor);
    await h.supervisor.start();
    const internals = h.supervisor as unknown as SupervisorInternals;
    const prepared = await internals.beginStartProject();
    if (!prepared.accepted) throw new Error('test launch was rejected');
    const commit = jest.spyOn(h.cards, 'commitActivationOutcome');
    const owner = prepared.launch.owner;
    void owner.settlement.promise.catch(() => undefined);
    const original = owner.processor.activate.bind(owner.processor);
    let activation!: Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>>;
    jest.spyOn(owner.processor, 'activate').mockImplementation((input, signal) => activation = original(input, signal));
    h.armActorTransitionFailure();

    internals.launchStartedProject(prepared.launch);

    await expect(within(activation)).rejects.toBe(h.actorFailure);
    expect(log.mock.calls).toEqual(expect.not.arrayContaining([expect.arrayContaining(['BaseActor main-loop failure hook failed'])]));
    expect(h.supervisor.getStatus().status).not.toBe('running');
    await waitForError(h.supervisor);
    expect(commit).not.toHaveBeenCalled();
    expect(h.terminate).toHaveBeenCalledTimes(1);
    expect(notification).toHaveBeenCalledTimes(1);
    expect(notification).toHaveBeenCalledWith('project', owner.activationId, h.actorFailure);
    expect(log.mock.calls.filter(([message, error]) => message === 'BaseActor main loop failed' && error === h.actorFailure)).toHaveLength(1);
    await expect(h.supervisor.stopProject()).rejects.toBe(h.actorFailure);
  });

  it.each(['cancel', 'stop', 'application-close'] as const)('%s-first settles activation first, then the callback joins one halt with no pending lane', async (race) => {
    const h = harness();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const notification = fatalNotificationSpy(h.supervisor);
    const { owner, activation } = await launchCapturingActivation(h);
    h.armActorTransitionFailure();

    let coordinator: ReturnType<typeof createAppTerminalCoordinator> | null = null;
    let operation: Promise<unknown>;
    if (race === 'cancel') operation = h.supervisor.cancelCard('project', 'cancel first');
    else if (race === 'stop') operation = h.supervisor.stopProject();
    else {
      coordinator = createAppTerminalCoordinator();
      coordinator.registerAdmissionCloser('runtime', () => h.supervisor.closeApplicationAdmission());
      coordinator.registerCleanupLeaf('runtime', () => h.supervisor.cleanupForApplicationStop());
      operation = coordinator.stop();
    }

    await expect(within(activation)).rejects.not.toBe(h.actorFailure);
    if (race === 'application-close') await expect(within(operation)).resolves.toEqual({ warnings: [{ component: 'runtime', code: 'cleanup_failed' }] });
    else await expect(within(operation)).rejects.toBe(h.actorFailure);
    await waitForError(h.supervisor);
    expect(h.terminate).toHaveBeenCalledTimes(1);
    expect(notification).toHaveBeenCalledTimes(1);
    expect(notification).toHaveBeenCalledWith('project', owner.activationId, h.actorFailure);
    await expect(h.supervisor.stopProject()).rejects.toBe(h.actorFailure);
  });

  it('keeps actor-first identity locally while a structurally earlier pre-join cleanup failure is retained by the halt', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const provider: LLMProviderPort = { completeTurn: async () => {
      calls += 1;
      if (calls === 1) await first;
      return { result: { kind: 'tool_calls', tool_calls: [{ id: String(calls), type: 'function', function: { name: calls === 1 ? 'write' : 'emit_result', arguments: calls === 1 ? JSON.stringify({ path: 'record:///status.md?v=next', content: 'done' }) : JSON.stringify({ outcome: 'complete_direct', summary: 'done' }) } }] }, provider_exchanges: [] };
    } };
    const h = harness(provider);
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const notification = fatalNotificationSpy(h.supervisor);
    const { owner, activation } = await launchCapturingActivation(h);
    for (let index = 0; index < 100 && calls === 0; index++) await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
    const cleanupFailure = new Error('pre-join cleanup failure B');
    const llmFailure = new Error('later LLM join failure');
    const trackerFailure = new Error('later tracker join failure');
    const originalDispose = ConversationLLMActor.prototype.dispose;
    jest.spyOn(ConversationLLMActor.prototype, 'dispose').mockImplementation(function (this: ConversationLLMActor, reason) {
      originalDispose.call(this, reason);
      throw cleanupFailure;
    });
    const llmJoin = jest.spyOn(ConversationLLMActor.prototype, 'join').mockRejectedValue(llmFailure);
    const originalTrackerJoin = ActivationOperationTracker.prototype.join;
    const trackerJoin = jest.spyOn(ActivationOperationTracker.prototype, 'join').mockImplementation(async function (this: ActivationOperationTracker) {
      await originalTrackerJoin.call(this);
      throw trackerFailure;
    });
    h.armActorTransitionFailure();
    releaseFirst();

    await expect(within(activation)).rejects.toBe(h.actorFailure);
    await waitForError(h.supervisor);
    await expect(h.supervisor.stopProject()).rejects.toBe(cleanupFailure);
    expect(log.mock.calls.filter(([message, error]) => message === 'BaseActor main loop failed' && error === h.actorFailure)).toHaveLength(1);
    expect(h.terminate).toHaveBeenCalledTimes(1);
    expect(llmJoin).toHaveBeenCalledTimes(1);
    expect(trackerJoin).toHaveBeenCalledTimes(1);
    expect(notification).toHaveBeenCalledTimes(1);
    expect(notification).toHaveBeenCalledWith('project', owner.activationId, h.actorFailure);
  });

  it('keeps a completed normal result authoritative when a later Stop observes no live runtime', async () => {
    let calls = 0;
    const provider: LLMProviderPort = { completeTurn: async () => {
      calls += 1;
      return { result: { kind: 'tool_calls', tool_calls: [{ id: String(calls), type: 'function', function: { name: calls === 1 ? 'write' : 'emit_result', arguments: calls === 1 ? JSON.stringify({ path: 'record:///status.md?v=next', content: 'done' }) : JSON.stringify({ outcome: 'complete_direct', summary: 'normal result wins' }) } }] }, provider_exchanges: [] };
    } };
    const h = harness(provider);
    const notification = fatalNotificationSpy(h.supervisor);
    const { activation } = await launchCapturingActivation(h);

    await expect(within(activation)).resolves.toMatchObject({ status: 'done', summary: 'normal result wins' });
    for (let index = 0; index < 100 && h.supervisor.getStatus().status !== 'stopped'; index++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.supervisor.getStatus().status).toBe('stopped');
    await expect(h.supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: false });
    expect(h.cards.read('project')).toMatchObject({ lifecycle: { status: 'done', result: { summary: 'normal result wins' } } });
    expect(notification).not.toHaveBeenCalled();
  });

  it('rejects a real child actor-first activation exactly and interrupts its real lease/owners without ordinary publication', async () => {
    let releaseRoot!: () => void;
    const rootBarrier = new Promise<void>((resolve) => { releaseRoot = resolve; });
    let rootStarted = false;
    let childId = '';
    const provider: LLMProviderPort = { completeTurn: async (input) => {
      if (input.sessionId !== 'agent:planner:project') throw new Error(`Unexpected child-fatal provider session '${input.sessionId}'.`);
      rootStarted = true;
      await rootBarrier;
      return { result: { kind: 'tool_calls', tool_calls: [{ id: 'activate-child', type: 'function', function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
    } };
    const h = harness(provider);
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Fatal child', bootstrap_content: 'Fail in actor callback', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] }).id;
    const commit = jest.spyOn(h.cards, 'commitActivationOutcome');
    const notification = fatalNotificationSpy(h.supervisor);
    const internals = h.supervisor as unknown as SupervisorInternals;
    const originalCreateOwner = (h.supervisor as any).createOwner.bind(h.supervisor);
    jest.spyOn(h.supervisor as any, 'createOwner').mockImplementation((...args: unknown[]) => {
      const owner = originalCreateOwner(...args) as CardActivationOwner;
      void owner.settlement.promise.catch(() => undefined);
      return owner;
    });
    const originalActivate = CardProcessActor.prototype.activate;
    let childActivation!: Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>>;
    jest.spyOn(CardProcessActor.prototype, 'activate').mockImplementation(function (this: CardProcessActor, input, signal) {
      const activation = originalActivate.call(this, input, signal);
      if (this.cardId === childId) childActivation = activation;
      return activation;
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('child-fatal Run was rejected');
    for (let index = 0; index < 100 && !rootStarted; index++) await new Promise((resolve) => setImmediate(resolve));
    expect(rootStarted).toBe(true);
    h.armActorTransitionFailure();
    releaseRoot();
    for (let index = 0; index < 100 && !childActivation; index++) await new Promise((resolve) => setImmediate(resolve));
    const childOwner = internals.activationOwners.get(childId);
    const rootOwner = internals.activationOwners.get('project');
    if (!childOwner?.parentRelationship) throw new Error('real child owner was not retained by fatal halt');
    if (!rootOwner) throw new Error('real root owner was not retained by child-fatal halt');
    const lease = childOwner.parentRelationship.invocation;

    await expect(within(childActivation)).rejects.toBe(h.actorFailure);
    await expect(within(childOwner.settlement.promise)).rejects.toBe(internals.halt!.interruption);
    await expect(within(rootOwner.settlement.promise)).rejects.toBe(internals.halt!.interruption);
    await expect(within(lease.activation)).rejects.toBe(internals.halt!.interruption);
    await waitForError(h.supervisor);
    await expect(within(internals.halt!.promise)).rejects.toBe(h.actorFailure);
    expect(notification).toHaveBeenCalledTimes(1);
    expect(notification).toHaveBeenCalledWith(childId, childOwner.activationId, h.actorFailure);
    expect(commit).not.toHaveBeenCalled();
    expect(h.cards.read('project')!.lifecycle.status).toBe('running');
    expect(h.cards.read(childId)!.lifecycle.status).toBe('running');
    expect(h.terminate).toHaveBeenCalledTimes(1);
  });

  it.each(['llm-order', 'tracker', 'lifecycle'] as const)('selects CardProcess %s precedence while observing both LLMs, tracker, and lifecycle', async (winner) => {
    let reviewerStarted = false;
    let calls = 0;
    const provider: LLMProviderPort = { completeTurn: async (input, signal) => {
      if (input.sessionId === 'agent:planner:project') {
        calls += 1;
        if (calls === 1) return { result: { kind: 'tool_calls', tool_calls: [{ id: 'write-plan', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'record:///status.md?v=next', content: 'plan' }) } }] }, provider_exchanges: [] };
        return { result: { kind: 'tool_calls', tool_calls: [{ id: 'review-plan', type: 'function', function: { name: 'emit_result', arguments: JSON.stringify({ outcome: 'admit_review', summary: 'review' }) } }] }, provider_exchanges: [] };
      }
      if (input.sessionId === 'agent:reviewer:project') {
        reviewerStarted = true;
        return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      throw new Error(`Unexpected precedence provider session '${input.sessionId}'.`);
    } };
    const h = harness(provider);
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const notification = fatalNotificationSpy(h.supervisor);
    await launchCapturingActivation(h);
    for (let index = 0; index < 200 && !reviewerStarted; index++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(reviewerStarted).toBe(true);
    const plannerFailure = new Error('frozen planner join failure');
    const reviewerFailure = new Error('frozen reviewer join failure');
    const trackerFailure = new Error('tracker join failure');
    const joined: string[] = [];
    let releasePlanner!: () => void;
    let releaseReviewer!: () => void;
    const plannerJoin = new Promise<never>((_resolve, reject) => { releasePlanner = () => reject(plannerFailure); });
    const reviewerJoin = new Promise<never>((_resolve, reject) => { releaseReviewer = () => reject(reviewerFailure); });
    jest.spyOn(ConversationLLMActor.prototype, 'join').mockImplementation(function (this: ConversationLLMActor) {
      joined.push(this.agentId);
      if (winner !== 'llm-order') return Promise.resolve({ status: 'joined' });
      return this.agentId === 'agent:planner:project' ? plannerJoin : reviewerJoin;
    });
    const originalTrackerJoin = ActivationOperationTracker.prototype.join;
    const trackerJoin = jest.spyOn(ActivationOperationTracker.prototype, 'join').mockImplementation(async function (this: ActivationOperationTracker) {
      const outcome = await originalTrackerJoin.call(this);
      if (winner === 'tracker' || winner === 'llm-order') throw trackerFailure;
      return outcome;
    });
    h.armActorTransitionFailure();
    const stop = h.supervisor.stopProject();
    if (winner === 'llm-order') {
      for (let index = 0; index < 100 && joined.length < 2; index++) await new Promise((resolve) => setImmediate(resolve));
      releaseReviewer();
      await new Promise((resolve) => setImmediate(resolve));
      releasePlanner();
    }
    const expected = winner === 'llm-order' ? plannerFailure : winner === 'tracker' ? trackerFailure : h.actorFailure;

    await expect(within(stop)).rejects.toBe(expected);
    expect(joined).toEqual(['agent:planner:project', 'agent:reviewer:project']);
    expect(trackerJoin).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.some(([message, error]) => message === 'BaseActor main loop failed' && error === h.actorFailure)).toBe(true);
    expect(notification).toHaveBeenCalledTimes(1);
    expect(h.supervisor.getStatus().status).toBe('error');
  });
});
