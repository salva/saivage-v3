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
  let runtimeClosing: boolean;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'saivage-card-cancel-'));
    initProjectTree(root);
    identityIndex = 0;
    cards = new CardService(root, undefined, undefined, () => IDS[identityIndex++]!);
    lookup = new Map();
    liveLookup = new Map();
    runtimeClosing = false;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function actor(cardId: string): { actor: CardActor; processor: ControlledProcessor } {
    const deps = {
      projectRoot: root,
      storeForCard: () => cards,
      currentness: { enterChild: jest.fn(), resumeParent: jest.fn() },
      provider: {}, processRunner: {}, promptTemplates: {}, notifyCard: () => ({ ok: true, notificationId: 'n' }),
      lookup, liveLookup, cancelCard: async (id: string, reason: string) => {
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
    const result = await parent.actor.cancel({ reason: 'cancel subtree' });
    expect(result.cancelled_card_ids).toEqual([activeChild.id, inactiveChild.id, 'project']);
    await expect(parentResult).resolves.toMatchObject({ status: 'cancelled' });
    await expect(childResult).resolves.toMatchObject({ status: 'cancelled' });
    expect(cards.read(activeChild.id)?.status).toBe('cancelled');
    expect(cards.read(inactiveChild.id)?.status).toBe('cancelled');
    expect(cards.read(doneChild.id)?.status).toBe('done');
    expect(liveLookup.size).toBe(0);
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
  });

  it.each([
    { winner: 'result' as const, cleanup: 'success' as const },
    { winner: 'result' as const, cleanup: 'failure' as const },
    { winner: 'cancel' as const, cleanup: 'success' as const },
    { winner: 'cancel' as const, cleanup: 'failure' as const },
  ])('preserves a $winner winner across Stop cleanup $cleanup', async ({ winner, cleanup }) => {
    cards.setStatus('project', 'running');
    const owned = actor('project');
    const activation = owned.actor.restartRunning({ kind: 'root' });
    await Promise.resolve();
    const cleanupSettlement = deferred<readonly InvocationJoinOutcome[]>();
    owned.processor.joinResult = cleanupSettlement.promise;
    let cancellation: Promise<unknown> | null = null;
    if (winner === 'result') owned.processor.input!.claimResult();
    else cancellation = owned.actor.cancel({ reason: 'accepted cancellation' });

    runtimeClosing = true;
    const interruption = new RuntimeStoppedInterruption();
    const failures: string[] = [];
    const stopped = owned.actor.stop({ interruption, reportContainmentFailure: (component) => failures.push(component) });
    if (cleanup === 'success') cleanupSettlement.resolve([]);
    else cleanupSettlement.reject(new Error('cleanup failed'));

    if (winner === 'result') {
      owned.processor.outcome.resolve({ status: 'done', summary: 'accepted', result: { kind: 'done', summary: 'accepted' } });
      await expect(activation).resolves.toMatchObject({ status: 'done' });
    } else if (cleanup === 'success') {
      await expect(cancellation!).resolves.toMatchObject({ status: 'cancelled' });
      await expect(activation).resolves.toMatchObject({ status: 'cancelled' });
      expect(cards.read('project')?.status).toBe('cancelled');
    } else {
      await expect(cancellation!).rejects.toThrow('cleanup failed');
    }
    await stopped;
    expect(owned.actor.claim).toBe(winner === 'result' ? 'claimed_result' : 'claimed_cancel');
    expect(owned.processor.continuationSuppressed).toBe(winner === 'result');
    expect(failures).toEqual(cleanup === 'failure' ? ['card:project'] : []);
    expect(liveLookup.get('project')).toBe(owned.actor);
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
});
