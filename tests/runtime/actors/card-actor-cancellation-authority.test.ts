import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../../../src/cards/card-service.js';
import type { NewCardInput } from '../../../src/cards/lifecycle.js';
import { CardActor, type CardActivationInput, type CardActivationOutcome, type CardActorDeps, type CardProcessorActor } from '../../../src/runtime/actors/card-actor.js';
import type { InvocationJoinOutcome } from '../../../src/runtime/actors/invocation-lifecycle.js';
import { initProjectTree } from '../../helpers/canonical-project.js';
import { RuntimeStoppedInterruption } from '../../../src/runtime/actors/runtime-stopped-interruption.js';
import { ActiveCardLeaf } from '../../../src/runtime/active-card-leaf.js';
import { ReadModelChangeBroadcaster } from '../../../src/application/read-model-changes.js';

const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];

function child(parent: string, title: string, depth = 1, type: NewCardInput['type'] = 'code'): NewCardInput {
  return { type, parent, depth, title, brief: title, status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] };
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
  joinResult: Promise<readonly InvocationJoinOutcome[]> = Promise.resolve([]);
  activate(input: CardActivationInput): Promise<Exclude<CardActivationOutcome, { status: 'cancelled' }>> { this.input = input; return this.outcome.promise; }
  disposeActivation(reason?: unknown): void {
    this.disposed = true;
    this.disposalReason = reason;
    if (!(reason instanceof RuntimeStoppedInterruption)) this.outcome.reject(reason ?? new Error('disposed'));
  }
  suppressContinuationAndPrepareJoin(): void { this.continuationSuppressed = true; }
  async joinActivation(): Promise<readonly InvocationJoinOutcome[]> {
    const result = await this.joinResult;
    if (this.disposed && !(this.disposalReason instanceof RuntimeStoppedInterruption)) await this.outcome.promise.catch(() => undefined);
    return result;
  }
  pendingJoinTaskCount(): number { return 0; }
}

describe('CardActor authoritative cancellation', () => {
  let root: string;
  let cards: CardService;
  let identityIndex: number;
  let lookup: Map<string, CardActor>;
  let liveLookup: Map<string, CardActor>;
  let releaseSettledActor: jest.Mock<(actor: CardActor) => void>;
  let runtimeClosing: boolean;
  let cardRuntimeSnapshots: Array<Record<string, string>>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'saivage-card-cancel-'));
    initProjectTree(root);
    identityIndex = 0;
    const changes = new ReadModelChangeBroadcaster();
    cards = new CardService(root, undefined, changes, () => IDS[identityIndex++]!);
    cardRuntimeSnapshots = [];
    changes.subscribe({ runtimeChanged: () => cardRuntimeSnapshots.push(Object.fromEntries(cards.list().map((card) => [card.id, card.status]))), cardStateChanged: () => undefined, agentsChanged: () => undefined, conversationChanged: () => undefined });
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

  it('cancel-first revokes the activation, publishes once, settles the caller, and suppresses a late result', async () => {
    const owned = actor('project');
    const activation = owned.actor.activate({ kind: 'root' });
    await Promise.resolve();
    const cancellation = await owned.actor.cancel({ reason: 'operator cancelled' });
    expect(cancellation).toEqual({ card_id: 'project', status: 'cancelled', cancelled_card_ids: ['project'] });
    await expect(activation).resolves.toEqual({ status: 'cancelled', summary: 'operator cancelled' });
    expect(owned.processor.disposed).toBe(true);
    expect(cards.read('project')?.status).toBe('cancelled');
    expect(liveLookup.size).toBe(0);
    expect(lookup.size).toBe(0);
    expect(releaseSettledActor).toHaveBeenCalledTimes(1);
    expect(releaseSettledActor).toHaveBeenCalledWith(owned.actor);
    const version = cards.read('project')!.version_seq;
    owned.processor.outcome.resolve({ status: 'done', summary: 'late', result: { kind: 'done', summary: 'late' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(cards.read('project')?.version_seq).toBe(version);
    expect(cards.read('project')?.status).toBe('cancelled');
  });

  it('result-first completes the synchronous claim and cancellation cannot overwrite it', async () => {
    const owned = actor('project');
    const activation = owned.actor.activate({ kind: 'root' });
    await Promise.resolve();
    owned.processor.input!.claimResult();
    owned.processor.outcome.resolve({ status: 'done', summary: 'accepted', result: { kind: 'done', summary: 'accepted' } });
    await expect(activation).resolves.toMatchObject({ status: 'done' });
    await expect(owned.actor.cancel({ reason: 'too late' })).rejects.toThrow('no live activation owner');
    expect(liveLookup.size).toBe(0);
    expect(lookup.size).toBe(0);
    expect(releaseSettledActor).toHaveBeenCalledTimes(1);
    expect(releaseSettledActor).toHaveBeenCalledWith(owned.actor);
  });

  it('recursively claims live descendants, cancels inactive descendants, and preserves done descendants', async () => {
    const activeChild = cards.create(child('project', 'active'));
    const inactiveChild = cards.create(child('project', 'inactive'));
    const doneChild = cards.create(child('project', 'done'));
    cards.setStatus(inactiveChild.id, 'running');
    cards.setStatus(inactiveChild.id, 'changed');
    cards.setStatus(doneChild.id, 'running');
    cards.commitTerminalLifecyclePatch(doneChild.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'kept' }, error: null, completed_at: '2026-07-15T00:00:00.000Z' } });
    const parent = actor('project');
    const liveChild = actor(activeChild.id);
    const parentResult = parent.actor.activate({ kind: 'root' });
    const childResult = liveChild.actor.activate({ kind: 'parent', cardId: 'project' }, () => cards.setStatus(activeChild.id, 'running'));
    await Promise.resolve();
    cardRuntimeSnapshots.length = 0;
    const result = await parent.actor.cancel({ reason: 'cancel subtree' });
    expect(result.cancelled_card_ids).toEqual([activeChild.id, inactiveChild.id, 'project']);
    await expect(parentResult).resolves.toMatchObject({ status: 'cancelled' });
    await expect(childResult).resolves.toMatchObject({ status: 'cancelled' });
    expect(cards.read(activeChild.id)?.status).toBe('cancelled');
    expect(cards.read(inactiveChild.id)?.status).toBe('cancelled');
    expect(cards.read(doneChild.id)?.status).toBe('done');
    expect(liveLookup.size).toBe(0);
    expect(lookup.size).toBe(0);
    expect(releaseSettledActor).toHaveBeenCalledTimes(2);
    expect(cardRuntimeSnapshots).toHaveLength(3);
    expect(cardRuntimeSnapshots[0]?.[activeChild.id]).toBe('cancelled');
    expect(cardRuntimeSnapshots[1]?.[inactiveChild.id]).toBe('cancelled');
    expect(cardRuntimeSnapshots[2]?.project).toBe('cancelled');
  });

  it('fails fast for a running descendant without an exact live owner', async () => {
    const orphan = cards.create(child('project', 'orphan running'));
    cards.setStatus(orphan.id, 'running');
    const parent = actor('project');
    void parent.actor.activate({ kind: 'root' });
    await Promise.resolve();
    await expect(parent.actor.cancel({ reason: 'cancel subtree' })).rejects.toThrow(`Running card '${orphan.id}' has no live activation owner.`);
    expect(cards.read(orphan.id)?.status).toBe('running');
  });

  it('project Stop rejects by exact interruption identity without card mutation or owner removal', async () => {
    cards.setStatus('project', 'running');
    const owned = actor('project');
    const activation = owned.actor.restartRunning({ kind: 'root' });
    await Promise.resolve();
    const interruption = new RuntimeStoppedInterruption();
    const failures: string[] = [];
    await owned.actor.stop({ interruption, reportContainmentFailure: (component) => failures.push(component) });

    await expect(activation).rejects.toBe(interruption);
    expect(failures).toEqual([]);
    expect(owned.actor.claim).toBe('claimed_stop');
    expect(cards.read('project')?.status).toBe('running');
    expect(liveLookup.get('project')).toBe(owned.actor);
    expect(lookup.get('project')).toBe(owned.actor);
    expect(releaseSettledActor).not.toHaveBeenCalled();
  });

  it.each(['success' as const, 'failure' as const])('preserves a result winner across Stop cleanup %s', async (cleanup) => {
    cards.setStatus('project', 'running');
    const owned = actor('project');
    const activation = owned.actor.restartRunning({ kind: 'root' });
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
    expect(failures).toEqual(cleanup === 'failure' ? ['card:project'] : []);
    expect(liveLookup.get('project')).toBe(owned.actor);
    expect(lookup.get('project')).toBe(owned.actor);
    expect(releaseSettledActor).not.toHaveBeenCalled();
  });

  it('keeps Stop pending until caller-first cancellation publishes and settles its activation caller', async () => {
    cards.setStatus('project', 'running');
    const owned = actor('project');
    const activation = owned.actor.restartRunning({ kind: 'root' });
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
    expect(cards.read('project')?.status).toBe('running');
    expect(liveLookup.get('project')).toBe(owned.actor);

    cleanupSettlement.resolve([]);
    await expect(cancellation).resolves.toEqual({ card_id: 'project', status: 'cancelled', cancelled_card_ids: ['project'] });
    await expect(activation).resolves.toEqual({ status: 'cancelled', summary: 'accepted cancellation' });
    await stopped;

    expect(order).toEqual(['activation', 'stop']);
    expect(cards.read('project')?.status).toBe('cancelled');
    expect(failures).toEqual([]);
    expect(liveLookup.get('project')).toBe(owned.actor);
    expect(lookup.get('project')).toBe(owned.actor);
    expect(releaseSettledActor).not.toHaveBeenCalled();
  });

  it('lets Stop start the exact claim-owned cancellation settlement before the normal caller reaches it', async () => {
    cards.setStatus('project', 'running');
    const owned = actor('project');
    const activation = owned.actor.restartRunning({ kind: 'root' });
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
    expect(cards.read('project')?.status).toBe('running');
    expect(liveLookup.get('project')).toBe(owned.actor);

    cleanupSettlement.resolve([]);
    await expect(normalSettlement).resolves.toEqual({ card_id: 'project', status: 'cancelled', cancelled_card_ids: ['project'] });
    await expect(activation).resolves.toEqual({ status: 'cancelled', summary: 'winning reason' });
    await stopped;
    expect(cards.read('project')?.status).toBe('cancelled');
    expect(releaseSettledActor).not.toHaveBeenCalled();
  });

  it('reports caller-first cancellation settlement failure through Stop containment without replacing the cancellation error', async () => {
    cards.setStatus('project', 'running');
    const owned = actor('project');
    void owned.actor.restartRunning({ kind: 'root' });
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
    expect(cards.read('project')?.status).toBe('running');
    expect(liveLookup.get('project')).toBe(owned.actor);
    expect(lookup.get('project')).toBe(owned.actor);
    expect(releaseSettledActor).not.toHaveBeenCalled();
  });

  it('wakes only the immediate structural parent through a three-level chain', async () => {
    const goal = cards.create(child('project', 'goal', 1, 'goal'));
    const leaf = cards.create(child(goal.id, 'leaf', 2));
    for (const id of ['project', goal.id, leaf.id]) cards.setStatus(id, 'running');
    const rootOwner = actor('project');
    const goalOwner = actor(goal.id);
    const leafOwner = actor(leaf.id);
    const leafSettlement = leafOwner.actor.prepareRunning({ kind: 'parent', cardId: goal.id });
    const goalSettlement = goalOwner.actor.installStructuralWait(leafOwner.actor, { kind: 'parent', cardId: 'project' });
    rootOwner.actor.installStructuralWait(goalOwner.actor, { kind: 'root' });
    leafOwner.actor.startPreparedProcessor();
    await Promise.resolve();

    cards.commitTerminalLifecyclePatch(leaf.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'leaf done' }, error: null, completed_at: '2026-07-16T00:00:00.000Z' } });
    leafOwner.processor.input!.claimResult();
    leafOwner.processor.outcome.resolve({ status: 'done', summary: 'leaf done', result: { kind: 'done', summary: 'leaf done' } });
    await leafSettlement;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(goalOwner.processor.input).not.toBeNull();
    expect(rootOwner.processor.input).toBeNull();

    cards.commitTerminalLifecyclePatch(goal.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'goal done' }, error: null, completed_at: '2026-07-16T00:00:01.000Z' } });
    goalOwner.processor.input!.claimResult();
    goalOwner.processor.outcome.resolve({ status: 'done', summary: 'goal done', result: { kind: 'done', summary: 'goal done' } });
    await goalSettlement;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(rootOwner.processor.input).not.toBeNull();
  });

  it('publishes dynamic admission before child entry, then release before parent resumption', async () => {
    const changes = new ReadModelChangeBroadcaster();
    const store = new CardService(root, undefined, changes, () => IDS[0]!);
    const retained = new Map<string, CardActor>();
    const live = new Map<string, CardActor>();
    const snapshots: Array<{ source: 'card' | 'actor'; current: string | null; childStatus: string | null; retained: string[] }> = [];
    let currentness!: ActiveCardLeaf;
    const snapshot = (source: 'card' | 'actor') => snapshots.push({ source, current: currentness.activeCardId(), childStatus: store.read(IDS[0]!)?.status ?? null, retained: [...retained.keys()] });
    currentness = new ActiveCardLeaf(() => snapshot('actor'));
    changes.subscribe({ runtimeChanged: () => snapshot('card'), cardStateChanged: () => undefined, agentsChanged: () => undefined, conversationChanged: () => undefined });
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

    store.commitTerminalLifecyclePatch(childCard.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-07-16T00:00:00.000Z' } });
    ownedChild.processor.input!.claimResult();
    ownedChild.processor.outcome.resolve({ status: 'done', summary: 'done', result: { kind: 'done', summary: 'done' } });
    await activation;
    const actorTail = snapshots.filter(({ source }) => source === 'actor').slice(-2);
    expect(actorTail).toEqual([
      { source: 'actor', current: childCard.id, childStatus: 'done', retained: ['project'] },
      { source: 'actor', current: 'project', childStatus: 'done', retained: ['project'] },
    ]);
  });

  it('publishes existing-child wait entry and both direct and structural parent resumptions', async () => {
    const first = cards.create(child('project', 'existing wait'));
    const second = cards.create(child('project', 'structural wait'));
    for (const id of ['project', first.id, second.id]) cards.setStatus(id, 'running');
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
    const parent = makeActor('project');
    const directChild = makeActor(first.id);
    currentness.setChain(['project']);
    currents.length = 0;
    directChild.value.prepareRunning({ kind: 'parent', cardId: 'project' });
    const directWait = directChild.value.awaitSettlement({ kind: 'parent', cardId: 'project' });
    directChild.value.startPreparedProcessor();
    expect(currents).toEqual([first.id]);
    cards.commitTerminalLifecyclePatch(first.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-07-16T00:00:00.000Z' } });
    directChild.processor.input!.claimResult();
    directChild.processor.outcome.resolve({ status: 'done', summary: 'done', result: { kind: 'done', summary: 'done' } });
    await directWait;
    expect(currents).toEqual([first.id, 'project']);

    const structuralChild = makeActor(second.id);
    const structuralSettlement = structuralChild.value.prepareRunning({ kind: 'parent', cardId: 'project' });
    parent.value.installStructuralWait(structuralChild.value, { kind: 'root' });
    currentness.setChain(['project', second.id]);
    currents.length = 0;
    structuralChild.value.startPreparedProcessor();
    cards.commitTerminalLifecyclePatch(second.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-07-16T00:00:01.000Z' } });
    structuralChild.processor.input!.claimResult();
    structuralChild.processor.outcome.resolve({ status: 'done', summary: 'done', result: { kind: 'done', summary: 'done' } });
    await structuralSettlement;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(currents).toEqual(['project']);
  });
});
