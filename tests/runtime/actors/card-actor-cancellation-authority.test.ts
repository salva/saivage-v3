import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../../../src/cards/card-service.js';
import type { NewCardInput } from '../../../src/cards/lifecycle.js';
import type { CardActivationOutcome } from '../../../src/contracts/tool-api.js';
import { CardActor, type CardActivationInput, type CardActorDeps, type CardProcessorActor } from '../../../src/runtime/actors/card-actor.js';
import type { InvocationJoinOutcome } from '../../../src/runtime/actors/invocation-lifecycle.js';
import { initProjectTree } from '../../helpers/canonical-project.js';
import { RuntimeStoppedInterruption } from '../../../src/runtime/actors/runtime-stopped-interruption.js';
import { ActiveCardLeaf } from '../../../src/runtime/active-card-leaf.js';
import { ReadModelChangeBroadcaster } from '../../../src/application/read-model-changes.js';
import { EventBus } from '../../../src/events/index.js';

const IDS = [
  'card-a',
  'card-b',
  'card-c',
];

function child(parent: string, title: string, type: NewCardInput['type'] = 'code'): NewCardInput {
  return { type, parent, title, brief: title, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

class ControlledProcessor implements CardProcessorActor {
  readonly outcome = deferred<Exclude<CardActivationOutcome, { status: 'cancelled' }>>();
  input: CardActivationInput | null = null;
  disposed = false;
  disposalReason: unknown;
  continuationSuppressed = false;
  suppressionReason: unknown;
  joinResult: Promise<readonly InvocationJoinOutcome[]> = Promise.resolve([]);
  activate(input: CardActivationInput): Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>> { this.input = input; return this.outcome.promise; }
  disposeActivation(reason?: unknown): void {
    this.disposed = true;
    this.disposalReason = reason;
    if (!(reason instanceof RuntimeStoppedInterruption)) this.outcome.reject(reason ?? new Error('disposed'));
  }
  suppressContinuationAndPrepareJoin(reason: unknown): void { this.continuationSuppressed = true; this.suppressionReason = reason; }
  async joinActivation(): Promise<readonly InvocationJoinOutcome[]> {
    const result = await this.joinResult;
    if (this.disposed && !(this.disposalReason instanceof RuntimeStoppedInterruption)) await this.outcome.promise.catch(() => undefined);
    return result;
  }
  pendingJoinTaskCount(): number { return 0; }
  processPosition() { return { family: 'terminal' as const, stateId: 'lifecycle:ready', kind: 'ready' as const }; }
  executingLlmSnapshot(): null { return null; }
}

describe('CardActor authoritative cancellation', () => {
  let root: string;
  let cards: CardService;
  let lookup: Map<string, CardActor>;
  let liveLookup: Map<string, CardActor>;
  let releaseSettledActor: jest.Mock<(actor: CardActor) => void>;
  let runtimeClosing: boolean;
  let cardRuntimeSnapshots: Array<Record<string, string>>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'saivage-card-cancel-'));
    initProjectTree(root);
    const changes = new ReadModelChangeBroadcaster();
    cards = new CardService(root, undefined, changes);
    cardRuntimeSnapshots = [];
    changes.subscribe({ runtimeChanged: () => cardRuntimeSnapshots.push(Object.fromEntries(cards.list().map((card) => [card.id, card.lifecycle.status]))), cardProjectionChanged: () => undefined, agentsChanged: () => undefined, conversationChanged: () => undefined });
    lookup = new Map();
    liveLookup = new Map();
    releaseSettledActor = jest.fn((settledActor: CardActor) => {
      if (lookup.get(settledActor.cardId) !== settledActor || liveLookup.get(settledActor.cardId) !== settledActor) throw new Error('settled actor ownership changed unexpectedly');
      liveLookup.delete(settledActor.cardId);
      lookup.delete(settledActor.cardId);
    });
    runtimeClosing = false;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function actor(cardId: string): { actor: CardActor; processor: ControlledProcessor } {
    const deps = {
      projectRoot: root,
      storeForCard: () => cards,
      currentness: { enterChild: jest.fn(), resumeParent: jest.fn() },
      provider: {}, processRunner: {}, promptTemplates: {}, notifyCard: () => ({ ok: true, notificationId: 'n' }),
      lookup, liveLookup, runtimeProjectionChanged: jest.fn(), releaseSettledActor, cancelCard: async (id: string, reason: string) => {
        const live = liveLookup.get(id);
        if (!live) throw new Error(`No live owner for ${id}`);
        return live.cancel({ reason });
      }, conversations: { projectRoot: root }, appLogs: { projectRoot: root }, isRuntimeClosing: () => runtimeClosing,
    } as unknown as CardActorDeps;
    const value = new CardActor({ card: cards.read(cardId)!, deps, deferProcessorStart: true });
    const processor = new ControlledProcessor();
    Object.defineProperty(value, 'processor', { value: processor });
    value.start();
    return { actor: value, processor };
  }

  function prepareBacklogRoot(owned: { actor: CardActor; processor: ControlledProcessor }): Promise<CardActivationOutcome> {
    expect(cards.read('project')?.lifecycle.status).toBe('backlog');
    cards.setStatus('project', 'running');
    const activation = owned.actor.prepareRootRunning('BACKLOG');
    owned.actor.startPreparedRootProcessor();
    return activation;
  }

  function prepareStoppedRoot(owned: { actor: CardActor; processor: ControlledProcessor }): Promise<CardActivationOutcome> {
    const activation = owned.actor.prepareRootRunning('STOPPED');
    owned.actor.startPreparedRootProcessor();
    return activation;
  }

  it('rejects a forged direct-root activation before admission or activation side effects', async () => {
    const owned = actor('project');
    const callback = jest.fn();
    const sendEvent = jest.spyOn(owned.actor as unknown as { sendEvent(name: string): void }, 'sendEvent');
    const cardBefore = cards.read('project')!;
    const projectionChanged = owned.actor.deps.runtimeProjectionChanged as jest.Mock;
    projectionChanged.mockClear();

    await expect(owned.actor.activate({ kind: 'root' } as never, callback)).rejects.toThrow("Card 'project' cannot be activated by caller 'root'.");

    expect(callback).not.toHaveBeenCalled();
    expect(cards.read('project')).toEqual(cardBefore);
    expect(owned.actor.state()).toBe('parked');
    expect(owned.actor.hasLiveActivation()).toBe(false);
    expect(liveLookup.size).toBe(0);
    expect(lookup.get('project')).toBe(owned.actor);
    expect(owned.processor.input).toBeNull();
    expect(sendEvent).not.toHaveBeenCalled();
    expect(owned.actor.deps.currentness.enterChild).not.toHaveBeenCalled();
    expect(owned.actor.deps.currentness.resumeParent).not.toHaveBeenCalled();
    expect(projectionChanged).not.toHaveBeenCalled();
    expect(releaseSettledActor).not.toHaveBeenCalled();
    await expect(owned.actor.awaitSettlement()).rejects.toThrow("Card 'project' has no in-flight activation to await.");
  });

  it('cancel-first revokes the activation, publishes once, settles the caller, and suppresses a late result', async () => {
    const owned = actor('project');
    const activation = prepareBacklogRoot(owned);
    await Promise.resolve();
    const cancellation = await owned.actor.cancel({ reason: 'operator cancelled' });
    expect(cancellation).toEqual({ card_id: 'project', status: 'cancelled', cancelled_card_ids: ['project'] });
    await expect(activation).resolves.toEqual({ status: 'cancelled', summary: 'operator cancelled' });
    expect(owned.processor.disposed).toBe(true);
    expect(cards.read('project')?.lifecycle.status).toBe('cancelled');
    expect(liveLookup.size).toBe(0);
    expect(lookup.size).toBe(0);
    expect(releaseSettledActor).toHaveBeenCalledTimes(1);
    expect(releaseSettledActor).toHaveBeenCalledWith(owned.actor);
    const version = cards.read('project')!.version_seq;
    owned.processor.outcome.resolve({ status: 'done', summary: 'late', result: { kind: 'done', summary: 'late' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(cards.read('project')?.version_seq).toBe(version);
    expect(cards.read('project')?.lifecycle.status).toBe('cancelled');
  });

  it('keeps cancellation publication and exact release observable before caller callbacks', async () => {
    const owned = actor('project');
    const activation = prepareBacklogRoot(owned);
    await Promise.resolve();
    const observations: string[] = [];
    void activation.then(() => observations.push(`activation:${cards.read('project')!.lifecycle.status}:${lookup.has('project')}`));
    const cancellation = owned.actor.cancel({ reason: 'operator cancelled' });
    void cancellation.then(() => observations.push(`cancellation:${cards.read('project')!.lifecycle.status}:${lookup.has('project')}`));

    await cancellation;
    await activation;
    expect(observations).toEqual(['activation:cancelled:false', 'cancellation:cancelled:false']);
  });

  it('result-first completes the synchronous claim and cancellation cannot overwrite it', async () => {
    const owned = actor('project');
    const activation = prepareBacklogRoot(owned);
    await Promise.resolve();
    owned.processor.input!.claimResult();
    owned.processor.outcome.resolve({ status: 'done', summary: 'accepted', result: { kind: 'done', summary: 'accepted' } });
    await expect(activation).resolves.toMatchObject({ status: 'done' });
    await expect(owned.actor.cancel({ reason: 'too late' })).rejects.toThrow('no live activation owner');
    expect(liveLookup.size).toBe(0);
    expect(lookup.size).toBe(0);
    expect(releaseSettledActor).toHaveBeenCalledTimes(1);
    expect(releaseSettledActor).toHaveBeenCalledWith(owned.actor);
    expect(cards.read('project')).toMatchObject({ lifecycle: { status: 'done', result: { kind: 'done', summary: 'accepted' } } });
  });

  it.each([
    { label: 'unclaimed failure', claim: false, outcome: { status: 'failed' as const, summary: 'provider failed', result: { kind: 'failed' as const, summary: 'provider failed' } } },
    { label: 'claimed done', claim: true, outcome: { status: 'done' as const, summary: 'complete', result: { kind: 'done' as const, summary: 'complete' } } },
    { label: 'claimed blocked', claim: true, outcome: { status: 'blocked' as const, summary: 'waiting', result: { kind: 'blocked' as const, summary: 'waiting', resume_reason: 'waiting' } } },
    { label: 'claimed failed', claim: true, outcome: { status: 'failed' as const, summary: 'accepted failure', result: { kind: 'failed' as const, summary: 'accepted failure' } } },
  ])('publishes exactly one terminal version for $label before caller settlement and release', async ({ claim, outcome }) => {
    const owned = actor('project');
    const activation = prepareBacklogRoot(owned);
    await Promise.resolve();
    const runningVersion = cards.read('project')!.version_seq;
    if (claim) owned.processor.input!.claimResult();
    owned.processor.outcome.resolve(outcome);
    await expect(activation).resolves.toEqual(outcome);

    const card = cards.read('project')!;
    expect(card.version_seq).toBe(runningVersion + 1);
    expect(card.lifecycle.status).toBe(outcome.status);
    expect(card.lifecycle.result).toEqual(outcome.result);
    expect(card.lifecycle.error).toBe(outcome.status === 'done' ? null : outcome.summary);
    expect(card.lifecycle.completed_at === null).toBe(outcome.status === 'blocked');
    expect(releaseSettledActor).toHaveBeenCalledTimes(1);
    expect(lookup.has('project')).toBe(false);
    expect(liveLookup.has('project')).toBe(false);
  });

  it('orders publication, settled event queue, exact release, parent resumption, and caller continuation', async () => {
    const childCard = cards.create(child('project', 'ordered child'));
    const order: string[] = [];
    const owned = actor(childCard.id);
    const commit = jest.spyOn(cards, 'commitTerminalLifecycle').mockImplementation((...args) => {
      order.push('publication');
      return Reflect.apply(Object.getPrototypeOf(cards).commitTerminalLifecycle, cards, args) as never;
    });
    const originalRelease = releaseSettledActor.getMockImplementation()!;
    releaseSettledActor.mockImplementation((settled) => { order.push('release'); originalRelease(settled); });
    const sendEvent = jest.spyOn(owned.actor as unknown as { sendEvent(name: string): void }, 'sendEvent').mockImplementation((name) => {
      if (name === 'settled') order.push('event');
      return Reflect.apply(Object.getPrototypeOf(owned.actor).sendEvent, owned.actor, [name]);
    });
    const resumeParent = owned.actor.deps.currentness.resumeParent as jest.Mock;
    resumeParent.mockImplementation(() => { order.push('resume'); });

    const activation = owned.actor.activate({ kind: 'parent', cardId: 'project' }, () => cards.setStatus(childCard.id, 'running'));
    void activation.then(() => order.push('caller'));
    await Promise.resolve();
    owned.processor.input!.claimResult();
    owned.processor.outcome.resolve({ status: 'done', summary: 'done', result: { kind: 'done', summary: 'done' } });
    await activation;
    await Promise.resolve();

    expect(order).toEqual(['publication', 'event', 'release', 'resume', 'caller']);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(sendEvent).toHaveBeenCalledWith('settled');
  });

  it('admits a real stopped child before controlled processor activation with STOPPED entry', async () => {
    const childCard = cards.create(child('project', 'stopped child'));
    cards.setStatus(childCard.id, 'running');
    cards.stopRunningForRecovery(childCard.id);
    const owned = actor(childCard.id);
    const statusAtProcessorActivation: string[] = [];
    const activate = jest.spyOn(owned.processor, 'activate').mockImplementation((input) => {
      statusAtProcessorActivation.push(cards.read(childCard.id)!.lifecycle.status);
      owned.processor.input = input;
      return owned.processor.outcome.promise;
    });
    const admission = jest.fn(() => cards.activateStopped(childCard.id));

    const activation = owned.actor.activate({ kind: 'parent', cardId: 'project' }, admission);
    await Promise.resolve();

    expect(admission).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(statusAtProcessorActivation).toEqual(['running']);
    expect(owned.processor.input).toMatchObject({ entry: 'STOPPED', caller: { kind: 'parent', cardId: 'project' } });
    owned.processor.input!.claimResult();
    owned.processor.outcome.resolve({ status: 'done', summary: 'done', result: { kind: 'done', summary: 'done' } });
    await expect(activation).resolves.toMatchObject({ status: 'done' });
  });

  it('re-enters a blocked child through BLOCKED with a fresh actor after settlement', async () => {
    const childCard = cards.create(child('project', 'blocked child'));
    const first = actor(childCard.id);
    const firstActivation = first.actor.activate({ kind: 'parent', cardId: 'project' }, () => cards.setStatus(childCard.id, 'running'));
    await Promise.resolve();
    first.processor.input!.claimResult();
    first.processor.outcome.resolve({ status: 'blocked', summary: 'waiting', result: { kind: 'blocked', summary: 'waiting', resume_reason: 'test' } });
    await expect(firstActivation).resolves.toMatchObject({ status: 'blocked' });
    expect(cards.read(childCard.id)?.lifecycle.status).toBe('blocked');

    const second = actor(childCard.id);
    const secondActivation = second.actor.activate({ kind: 'parent', cardId: 'project' }, () => cards.setStatus(childCard.id, 'running'));
    await Promise.resolve();
    expect(second.processor.input).toMatchObject({ entry: 'BLOCKED', caller: { kind: 'parent', cardId: 'project' } });
    second.processor.input!.claimResult();
    second.processor.outcome.resolve({ status: 'done', summary: 'done', result: { kind: 'done', summary: 'done' } });
    await expect(secondActivation).resolves.toMatchObject({ status: 'done' });
  });

  it('fails in place when terminal publication throws before publication', async () => {
    const owned = actor('project');
    const activation = prepareBacklogRoot(owned);
    let settled = false;
    void activation.finally(() => { settled = true; });
    await Promise.resolve();
    const runningVersion = cards.read('project')!.version_seq;
    const failure = new Error('publication failed');
    const commit = jest.spyOn(cards, 'commitTerminalLifecycle').mockImplementation(() => { throw failure; });
    const read = jest.spyOn(cards, 'read');
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    owned.processor.outcome.resolve({ status: 'failed', summary: 'processor failed', result: { kind: 'failed', summary: 'processor failed' } });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(commit).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(0);
    expect(cards.read('project')).toMatchObject({ lifecycle: { status: 'running' }, version_seq: runningVersion });
    expect(settled).toBe(false);
    expect(releaseSettledActor).not.toHaveBeenCalled();
    expect(liveLookup.get('project')).toBe(owned.actor);
    consoleError.mockRestore();
  });

  it('fails in place when a propagating post-publication callback throws', async () => {
    const bus = new EventBus();
    cards = new CardService(root, bus, new ReadModelChangeBroadcaster());
    const callbackFailure = new Error('post-publication callback failed');
    const owned = actor('project');
    const activation = prepareBacklogRoot(owned);
    let settled = false;
    void activation.finally(() => { settled = true; });
    await Promise.resolve();
    const runningVersion = cards.read('project')!.version_seq;
    bus.subscribe('card_history_appended', () => { throw callbackFailure; }, { propagateErrors: true });
    const commit = jest.spyOn(cards, 'commitTerminalLifecycle');
    const read = jest.spyOn(cards, 'read');
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    owned.processor.outcome.resolve({ status: 'failed', summary: 'processor failed', result: { kind: 'failed', summary: 'processor failed' } });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(commit).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(cards.read('project')).toMatchObject({ lifecycle: { status: 'failed' }, version_seq: runningVersion + 1 });
    expect(settled).toBe(false);
    expect(releaseSettledActor).not.toHaveBeenCalled();
    expect(liveLookup.get('project')).toBe(owned.actor);
    consoleError.mockRestore();
  });

  it('recursively claims live descendants, cancels every cancellable status, and preserves done/cancelled descendants', async () => {
    const activeChild = cards.create(child('project', 'active'));
    const inactiveChild = cards.create(child('project', 'inactive'));
    const doneChild = cards.create(child('project', 'done'));
    const failedChild = cards.create(child('project', 'failed'));
    const blockedChild = cards.create(child('project', 'blocked'));
    const stoppedChild = cards.create(child('project', 'stopped'));
    const cancelledChild = cards.create(child('project', 'cancelled'));
    cards.setStatus(inactiveChild.id, 'running');
    cards.setStatus(inactiveChild.id, 'changed');
    cards.setStatus(doneChild.id, 'running');
    cards.commitTerminalLifecycle(doneChild.id, { lifecycle: { status: 'done', result: { kind: 'done', summary: 'kept' }, error: null, completed_at: '2026-07-15T00:00:00.000Z' } });
    cards.setStatus(failedChild.id, 'running');
    cards.commitTerminalLifecycle(failedChild.id, { lifecycle: { status: 'failed', result: { kind: 'failed', summary: 'retry' }, error: 'retry', completed_at: '2026-07-15T00:00:00.000Z' } });
    cards.setStatus(blockedChild.id, 'running');
    cards.commitTerminalLifecycle(blockedChild.id, { lifecycle: { status: 'blocked', result: { kind: 'blocked', summary: 'wait', resume_reason: 'test' }, error: 'wait', completed_at: null } });
    cards.setStatus(stoppedChild.id, 'running');
    cards.stopRunningForRecovery(stoppedChild.id);
    cards.setStatus(cancelledChild.id, 'cancelled');
    const parent = actor('project');
    const liveChild = actor(activeChild.id);
    const parentResult = prepareBacklogRoot(parent);
    const childResult = liveChild.actor.activate({ kind: 'parent', cardId: 'project' }, () => cards.setStatus(activeChild.id, 'running'));
    await Promise.resolve();
    cardRuntimeSnapshots.length = 0;
    const result = await parent.actor.cancel({ reason: 'cancel subtree' });
    expect(result.cancelled_card_ids).toEqual([activeChild.id, inactiveChild.id, failedChild.id, blockedChild.id, stoppedChild.id, 'project']);
    await expect(parentResult).resolves.toMatchObject({ status: 'cancelled' });
    await expect(childResult).resolves.toMatchObject({ status: 'cancelled' });
    expect(cards.read(activeChild.id)?.lifecycle.status).toBe('cancelled');
    expect(cards.read(inactiveChild.id)?.lifecycle.status).toBe('cancelled');
    expect(cards.read(doneChild.id)?.lifecycle.status).toBe('done');
    expect(cards.read(failedChild.id)?.lifecycle.status).toBe('cancelled');
    expect(cards.read(blockedChild.id)?.lifecycle.status).toBe('cancelled');
    expect(cards.read(stoppedChild.id)?.lifecycle.status).toBe('cancelled');
    expect(cards.read(cancelledChild.id)?.lifecycle.status).toBe('cancelled');
    expect(liveLookup.size).toBe(0);
    expect(lookup.size).toBe(0);
    expect(releaseSettledActor).toHaveBeenCalledTimes(2);
    expect(cardRuntimeSnapshots).toHaveLength(6);
    expect(cardRuntimeSnapshots[0]?.[activeChild.id]).toBe('cancelled');
    expect(cardRuntimeSnapshots[1]?.[inactiveChild.id]).toBe('cancelled');
    expect(cardRuntimeSnapshots[2]?.[failedChild.id]).toBe('cancelled');
    expect(cardRuntimeSnapshots[3]?.[blockedChild.id]).toBe('cancelled');
    expect(cardRuntimeSnapshots[4]?.[stoppedChild.id]).toBe('cancelled');
    expect(cardRuntimeSnapshots[5]?.project).toBe('cancelled');
  });

  it('fails fast for a running descendant without an exact live owner', async () => {
    const orphan = cards.create(child('project', 'orphan running'));
    cards.setStatus(orphan.id, 'running');
    const parent = actor('project');
    void prepareBacklogRoot(parent);
    await Promise.resolve();
    await expect(parent.actor.cancel({ reason: 'cancel subtree' })).rejects.toThrow(`Running card '${orphan.id}' has no live activation owner.`);
    expect(cards.read(orphan.id)?.lifecycle.status).toBe('running');
  });

  it('enforces singular child actor construction eligibility', () => {
    const running = cards.create(child('project', 'running child'));
    const terminal = cards.create(child('project', 'terminal child'));
    cards.setStatus(running.id, 'running');
    cards.setStatus(terminal.id, 'running');
    cards.commitTerminalLifecycle(terminal.id, { lifecycle: { status: 'failed', result: { kind: 'failed', summary: 'failed' }, error: 'failed', completed_at: '2026-07-20T00:00:00.000Z' } });
    const parent = actor('project');

    expect(() => parent.actor.childCardActor(running.id)).toThrow(`Running card '${running.id}' has no retained activation owner.`);
    expect(parent.actor.childCardActor(terminal.id)).toBeNull();
    expect([...lookup.keys()]).toEqual(['project']);

    const retainedRunning = actor(running.id);
    expect(parent.actor.childCardActor(running.id)).toBe(retainedRunning.actor);
    expect([...lookup.keys()]).toEqual(['project', running.id]);
  });

  it('rejects non-project prepared launch ownership', () => {
    const childCard = cards.create(child('project', 'not root'));
    cards.setStatus(childCard.id, 'running');
    const owned = actor(childCard.id);

    expect(() => owned.actor.prepareRootRunning('STOPPED')).toThrow(`Card '${childCard.id}' is not the project root.`);
    expect(liveLookup.size).toBe(0);
  });

  it('project Stop rejects by exact interruption identity without card mutation or owner removal', async () => {
    cards.setStatus('project', 'running');
    const owned = actor('project');
    const activation = prepareStoppedRoot(owned);
    await Promise.resolve();
    const interruption = new RuntimeStoppedInterruption();
    const failures: string[] = [];
    await owned.actor.stop({ interruption, reportContainmentFailure: (component) => failures.push(component) });

    await expect(activation).rejects.toBe(interruption);
    expect(failures).toEqual([]);
    expect(owned.actor.claim).toBe('claimed_stop');
    expect(cards.read('project')?.lifecycle.status).toBe('running');
    expect(liveLookup.get('project')).toBe(owned.actor);
    expect(lookup.get('project')).toBe(owned.actor);
    expect(releaseSettledActor).not.toHaveBeenCalled();
  });

  it.each(['success' as const, 'failure' as const])('preserves result-winner arbitration with controlled processor settlement %s', async (cleanup) => {
    cards.setStatus('project', 'running');
    const owned = actor('project');
    const activation = prepareStoppedRoot(owned);
    await Promise.resolve();
    const cleanupSettlement = deferred<readonly InvocationJoinOutcome[]>();
    owned.processor.joinResult = cleanupSettlement.promise;
    owned.processor.input!.claimResult();

    runtimeClosing = true;
    const interruption = new RuntimeStoppedInterruption();
    const failures: string[] = [];
    const stopped = owned.actor.stop({ interruption, reportContainmentFailure: (component) => failures.push(component) });
    if (cleanup === 'success') cleanupSettlement.resolve([]);
    else cleanupSettlement.reject(new Error('cleanup failed'));

    owned.processor.outcome.resolve({ status: 'done', summary: 'accepted', result: { kind: 'done', summary: 'accepted' } });
    await expect(activation).resolves.toMatchObject({ status: 'done' });
    await stopped;
    expect(owned.actor.claim).toBe('claimed_result');
    expect(owned.processor.continuationSuppressed).toBe(true);
    expect(owned.processor.suppressionReason).toBe(interruption);
    expect(failures).toEqual(cleanup === 'failure' ? ['card:project'] : []);
    expect(liveLookup.get('project')).toBe(owned.actor);
    expect(lookup.get('project')).toBe(owned.actor);
    expect(releaseSettledActor).not.toHaveBeenCalled();
  });

  it('keeps Stop pending until caller-first cancellation publishes and settles its activation caller', async () => {
    cards.setStatus('project', 'running');
    const owned = actor('project');
    const activation = prepareStoppedRoot(owned);
    await Promise.resolve();
    const cleanupSettlement = deferred<readonly InvocationJoinOutcome[]>();
    owned.processor.joinResult = cleanupSettlement.promise;
    const order: string[] = [];
    void activation.then(() => order.push('activation'));
    const cancellation = owned.actor.cancel({ reason: 'accepted cancellation' });

    runtimeClosing = true;
    const failures: string[] = [];
    const stopped = owned.actor.stop({ interruption: new RuntimeStoppedInterruption(), reportContainmentFailure: (component) => failures.push(component) });
    void stopped.then(() => order.push('stop'));
    await Promise.resolve();

    expect(order).toEqual([]);
    expect(cards.read('project')?.lifecycle.status).toBe('running');
    expect(liveLookup.get('project')).toBe(owned.actor);

    cleanupSettlement.resolve([]);
    await expect(cancellation).resolves.toEqual({ card_id: 'project', status: 'cancelled', cancelled_card_ids: ['project'] });
    await expect(activation).resolves.toEqual({ status: 'cancelled', summary: 'accepted cancellation' });
    await stopped;

    expect(order).toEqual(['activation', 'stop']);
    expect(cards.read('project')?.lifecycle.status).toBe('cancelled');
    expect(failures).toEqual([]);
    expect(liveLookup.get('project')).toBe(owned.actor);
    expect(lookup.get('project')).toBe(owned.actor);
    expect(releaseSettledActor).not.toHaveBeenCalled();
  });

  it('lets Stop start the exact claim-owned cancellation settlement before the normal caller reaches it', async () => {
    cards.setStatus('project', 'running');
    const owned = actor('project');
    const activation = prepareStoppedRoot(owned);
    await Promise.resolve();
    const cleanupSettlement = deferred<readonly InvocationJoinOutcome[]>();
    owned.processor.joinResult = cleanupSettlement.promise;
    owned.actor.claimCancellation({ reason: 'winning reason' });

    runtimeClosing = true;
    let stopSettled = false;
    const stopped = owned.actor.stop({ interruption: new RuntimeStoppedInterruption(), reportContainmentFailure: jest.fn() });
    void stopped.then(() => { stopSettled = true; });
    const normalSettlement = owned.actor.settleClaimedCancellation();
    expect(owned.actor.settleClaimedCancellation()).toBe(normalSettlement);
    await Promise.resolve();

    expect(stopSettled).toBe(false);
    expect(cards.read('project')?.lifecycle.status).toBe('running');
    expect(liveLookup.get('project')).toBe(owned.actor);

    cleanupSettlement.resolve([]);
    await expect(normalSettlement).resolves.toEqual({ card_id: 'project', status: 'cancelled', cancelled_card_ids: ['project'] });
    await expect(activation).resolves.toEqual({ status: 'cancelled', summary: 'winning reason' });
    await stopped;
    expect(cards.read('project')?.lifecycle.status).toBe('cancelled');
    expect(releaseSettledActor).not.toHaveBeenCalled();
  });

  it('reports caller-first cancellation settlement failure through Stop containment without replacing the cancellation error', async () => {
    cards.setStatus('project', 'running');
    const owned = actor('project');
    void prepareStoppedRoot(owned);
    await Promise.resolve();
    const cleanupSettlement = deferred<readonly InvocationJoinOutcome[]>();
    owned.processor.joinResult = cleanupSettlement.promise;
    const cancellation = owned.actor.cancel({ reason: 'accepted cancellation' });
    runtimeClosing = true;
    const failures: Array<{ component: string; error: unknown }> = [];
    const stopped = owned.actor.stop({ interruption: new RuntimeStoppedInterruption(), reportContainmentFailure: (component, error) => failures.push({ component, error }) });
    const cleanupError = new Error('cleanup failed');

    cleanupSettlement.reject(cleanupError);
    await expect(cancellation).rejects.toBe(cleanupError);
    await expect(stopped).resolves.toBeUndefined();
    expect(failures).toEqual([{ component: 'card:project', error: cleanupError }]);
    expect(cards.read('project')?.lifecycle.status).toBe('running');
    expect(liveLookup.get('project')).toBe(owned.actor);
    expect(lookup.get('project')).toBe(owned.actor);
    expect(releaseSettledActor).not.toHaveBeenCalled();
  });

  it('publishes dynamic admission before child entry, then release before parent resumption', async () => {
    const changes = new ReadModelChangeBroadcaster();
    const store = new CardService(root, undefined, changes);
    const retained = new Map<string, CardActor>();
    const live = new Map<string, CardActor>();
    const snapshots: Array<{ source: 'card' | 'actor'; current: string | null; childStatus: string | null; retained: string[] }> = [];
    let currentness!: ActiveCardLeaf;
    const snapshot = (source: 'card' | 'actor') => snapshots.push({ source, current: currentness.activeCardId(), childStatus: store.read(IDS[0]!)?.lifecycle.status ?? null, retained: [...retained.keys()] });
    currentness = new ActiveCardLeaf(() => snapshot('actor'));
    changes.subscribe({ runtimeChanged: () => snapshot('card'), cardProjectionChanged: () => undefined, agentsChanged: () => undefined, conversationChanged: () => undefined });
    const deps = {
      projectRoot: root, storeForCard: () => store, currentness,
      provider: {}, processRunner: {}, promptTemplates: {}, notifyCard: () => ({ ok: true, notificationId: 'n' }),
      lookup: retained, liveLookup: live, runtimeProjectionChanged: () => snapshot('actor'),
      releaseSettledActor: (settled: CardActor) => { live.delete(settled.cardId); retained.delete(settled.cardId); snapshot('actor'); },
      cancelCard: async () => { throw new Error('unused'); }, conversations: { projectRoot: root }, appLogs: { projectRoot: root }, isRuntimeClosing: () => false,
    } as unknown as CardActorDeps;
    const makeActor = (cardId: string) => {
      const value = new CardActor({ card: store.read(cardId)!, deps, deferProcessorStart: true });
      const processor = new ControlledProcessor();
      Object.defineProperty(value, 'processor', { value: processor });
      value.start();
      return { value, processor };
    };
    makeActor('project');
    currentness.setChain(['project']);
    const childCard = store.create(child('project', 'dynamic'));
    snapshots.length = 0;
    const ownedChild = makeActor(childCard.id);

    const activation = ownedChild.value.activate({ kind: 'parent', cardId: 'project' }, () => store.setStatus(childCard.id, 'running'));
    await Promise.resolve();
    expect(snapshots.slice(0, 3)).toEqual([
      { source: 'actor', current: 'project', childStatus: 'backlog', retained: ['project', childCard.id] },
      { source: 'card', current: 'project', childStatus: 'running', retained: ['project', childCard.id] },
      { source: 'actor', current: childCard.id, childStatus: 'running', retained: ['project', childCard.id] },
    ]);

    ownedChild.processor.input!.claimResult();
    ownedChild.processor.outcome.resolve({ status: 'done', summary: 'done', result: { kind: 'done', summary: 'done' } });
    await activation;
    const actorTail = snapshots.filter(({ source }) => source === 'actor').slice(-2);
    expect(actorTail).toEqual([
      { source: 'actor', current: childCard.id, childStatus: 'done', retained: ['project'] },
      { source: 'actor', current: 'project', childStatus: 'done', retained: ['project'] },
    ]);
  });

  it('publishes ordinary child activation and parent resumption', async () => {
    const first = cards.create(child('project', 'ordinary wait'));
    const retained = new Map<string, CardActor>();
    const live = new Map<string, CardActor>();
    const currents: Array<string | null> = [];
    let currentness!: ActiveCardLeaf;
    currentness = new ActiveCardLeaf(() => currents.push(currentness.activeCardId()));
    const deps = {
      projectRoot: root, storeForCard: () => cards, currentness,
      provider: {}, processRunner: {}, promptTemplates: {}, notifyCard: () => ({ ok: true, notificationId: 'n' }),
      lookup: retained, liveLookup: live, runtimeProjectionChanged: () => undefined,
      releaseSettledActor: (settled: CardActor) => { live.delete(settled.cardId); retained.delete(settled.cardId); },
      cancelCard: async () => { throw new Error('unused'); }, conversations: { projectRoot: root }, appLogs: { projectRoot: root }, isRuntimeClosing: () => false,
    } as unknown as CardActorDeps;
    const makeActor = (cardId: string) => {
      const value = new CardActor({ card: cards.read(cardId)!, deps, deferProcessorStart: true });
      const processor = new ControlledProcessor();
      Object.defineProperty(value, 'processor', { value: processor });
      value.start();
      return { value, processor };
    };
    makeActor('project');
    const directChild = makeActor(first.id);
    currentness.setChain(['project']);
    currents.length = 0;
    const activation = directChild.value.activate({ kind: 'parent', cardId: 'project' }, () => cards.setStatus(first.id, 'running'));
    expect(currents).toEqual([first.id]);
    directChild.processor.input!.claimResult();
    directChild.processor.outcome.resolve({ status: 'done', summary: 'done', result: { kind: 'done', summary: 'done' } });
    await expect(activation).resolves.toEqual({ status: 'done', summary: 'done', result: { kind: 'done', summary: 'done' } });
    expect(currents).toEqual([first.id, 'project']);
  });
});
