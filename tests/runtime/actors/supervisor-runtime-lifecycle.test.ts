import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService } from '../../../src/cards/card-service.js';
import { RuntimeInterventionBinding } from '../../../src/application/intervention-readiness.js';
import { ReadModelChangeBroadcaster } from '../../../src/application/read-model-changes.js';
import { RuntimeControlService } from '../../../src/application/runtime-control-service.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import { dataPropertyGraphContains } from '../../helpers/data-property-graph.js';
import { SupervisorRuntimeApi, RuntimeControlConflictError } from '../../../src/runtime/actors/supervisor-runtime-api.js';
import { initProjectTree } from '../../helpers/canonical-project.js';
import { createTestProcessRunner } from '../../helpers/test-process-runner.js';
import { createTestPromptTemplateRegistry } from '../../helpers/prompt-template-registry.js';
import { testAutonomousCompaction } from '../../helpers/llm-test-helpers.js';
import type { LLMProviderPort } from '../../../src/runtime/actors/llm-actor.js';

const roots: string[] = [];
afterEach(() => { jest.restoreAllMocks(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function harness(provider: LLMProviderPort = blockingProvider()) {
  const root = mkdtempSync(join(tmpdir(), 'saivage-supervisor-owner-')); roots.push(root); initProjectTree(root);
  const cards = new CardService(root); const binding = new RuntimeInterventionBinding(); const gate = new RuntimeGate(); const changes = new ReadModelChangeBroadcaster(); const processes = createTestProcessRunner(root); const runner = processes.processRunner;
  const supervisorOptions = { ...testAutonomousCompaction, projectRoot: root, processIdentity: { pid: 1, startedAt: '2026-01-01T00:00:00.000Z' }, actorStore: cards, interventionBinding: binding, provider, conversations: { projectRoot: root }, readModelChanges: changes, processRunner: runner, runtimeProcessRootScope: processes.runtimeProcessRootScope, runtimeGate: gate, promptTemplates: createTestPromptTemplateRegistry() };
  const supervisor = new SupervisorRuntimeApi(supervisorOptions);
  const service = new RuntimeControlService(supervisor);
  return { root, cards, binding, gate, changes, runner, runtimeProcessRootScope: processes.runtimeProcessRootScope, supervisorOptions, supervisor, service };
}

function blockingProvider() { return { completeTurn: async (_input: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), projectProviderExchanges: jest.fn() }; }
function completingProvider() { let calls = 0; return { completeTurn: async () => { calls += 1; return calls === 1 ? { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'write', type: 'function' as const, function: { name: 'write', arguments: JSON.stringify({ path: 'record:///status.md?v=next', content: 'complete' }) } }] }, provider_exchanges: [] } : { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'emit', type: 'function' as const, function: { name: 'emit_result', arguments: JSON.stringify({ outcome: 'complete_direct', summary: 'done' }) } }] }, provider_exchanges: [] }; }, projectProviderExchanges: jest.fn() }; }
function childActivationProvider(childCardId: string) { return { completeTurn: async () => ({ result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childCardId }) } }] }, provider_exchanges: [] }), projectProviderExchanges: jest.fn() }; }
function terminalProviderResult() { return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'emit', type: 'function' as const, function: { name: 'emit_result', arguments: JSON.stringify({ outcome: 'complete_direct', summary: 'done' }) } }] }, provider_exchanges: [] }; }
async function waitUntil(predicate: () => boolean) { for (let i = 0; i < 200; i += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error('timeout'); }
const reentrantCases: Array<[string, 'stop' | 'close', boolean]> = [['stop-return', 'stop', false], ['stop-then-throw', 'stop', true], ['close-return', 'close', false], ['close-then-throw', 'close', true]];

describe('SupervisorRuntimeApi singular ownership lifecycle', () => {
  it('retains runner and exact runtime root only in native-private fields', () => {
    const h = harness();
    expect(dataPropertyGraphContains(h.supervisor, new Set([h.supervisorOptions, h.runner, h.runtimeProcessRootScope]))).toBe(false);
  });

  it('installs a prepared root owner before launch and clears it only after successful Stop containment', async () => {
    const h = harness(); await h.supervisor.start(); expect(h.binding.interventionReadiness()).toBe('stopped');
    const prepared = await h.supervisor.beginStartProject(); if (!prepared.accepted) throw new Error('not accepted');
    const owners = (h.supervisor as unknown as { activationOwners: Map<string, unknown> }).activationOwners;
    expect(h.supervisor.getStatus()).toMatchObject({ status: 'starting', currentCardId: 'project' }); expect(h.binding.interventionReadiness()).toBe('not_ready'); expect(owners.size).toBe(1);
    h.supervisor.launchStartedProject(prepared.launch); await waitUntil(() => h.supervisor.captureAutonomousExecutingLlmSnapshots().length === 1);
    const first = h.supervisor.stopProject(); const second = h.supervisor.stopProject(); expect(second).toBe(first); await expect(first).resolves.toEqual({ status: 'stopped', contained: true });
    expect(owners.size).toBe(0); expect(h.supervisor.getRuntimeState()).toBeNull(); expect(h.binding.interventionReadiness()).toBe('stopped');
  });

  it('lets application close own containment and makes later Stop join then conflict', async () => {
    const h = harness(); const prepared = await h.supervisor.beginStartProject(); if (!prepared.accepted) throw new Error('not accepted'); h.supervisor.launchStartedProject(prepared.launch); await waitUntil(() => h.supervisor.captureAutonomousExecutingLlmSnapshots().length === 1);
    h.supervisor.closeApplicationAdmission(); const stop = h.supervisor.stopProject(); await expect(h.supervisor.cleanupForApplicationStop()).resolves.toBeUndefined(); await expect(stop).rejects.toBeInstanceOf(RuntimeControlConflictError);
    expect(h.supervisor.getStatus().status).toBe('closing'); expect(h.binding.interventionReadiness()).toBe('not_ready');
  });

  it('retains outcome-unknown root publication until Stop clears local ownership without a reread or write', async () => {
    const h = harness(); const original = h.cards.setStatus.bind(h.cards); let calls = 0; const set = jest.spyOn(h.cards, 'setStatus').mockImplementation((...args) => { calls += 1; if (calls === 1) throw new Error('append outcome unknown'); return original(...args); });
    const start = h.supervisor.beginStartProject(); await waitUntil(() => h.supervisor.getStatus().status === 'error'); set.mockClear();
    await expect(h.supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true }); await expect(start).rejects.toBeInstanceOf(Error);
    expect(set).not.toHaveBeenCalled(); expect(h.cards.read).toBeDefined(); expect(h.binding.interventionReadiness()).toBe('stopped');
  });

  it.each(reentrantCases)('arbitrates reentrant running append callback %s before publication continuation', async (_name, claim, throws) => {
    const h = harness(); const snapshots: string[] = []; let containment: Promise<unknown> | undefined;
    h.changes.subscribe({ runtimeChanged: () => snapshots.push(`${h.supervisor.getStatus().status}/${h.binding.interventionReadiness()}`), agentsChanged() {}, conversationChanged() {}, cardProjectionChanged() {} });
    const original = h.cards.setStatus.bind(h.cards);
    const set = jest.spyOn(h.cards, 'setStatus').mockImplementation((...args) => {
      if (claim === 'stop') containment = h.supervisor.stopProject();
      else { h.supervisor.closeApplicationAdmission(); containment = h.supervisor.cleanupForApplicationStop(); }
      expect(h.supervisor.getStatus().status).toBe('closing'); expect(h.binding.interventionReadiness()).toBe('not_ready');
      if (throws) throw new Error('append returned outcome unknown after containment claim');
      return original(...args);
    });
    const start = h.supervisor.beginStartProject(); await expect(start).rejects.toBeInstanceOf(Error); set.mockClear();
    const read = jest.spyOn(h.cards, 'read'); const terminal = jest.spyOn(h.cards, 'commitTerminalLifecycle');
    if (claim === 'stop') await expect(containment).resolves.toEqual({ status: 'stopped', contained: true }); else await expect(containment).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(terminal).not.toHaveBeenCalled();
    expect(snapshots[0]).toBe('starting/not_ready'); expect(snapshots).toContain('closing/not_ready');
    if (claim === 'stop') expect(snapshots.at(-1)).toBe('stopped/stopped');
    else expect(h.supervisor.getStatus().status).toBe('closing');
  });

  it('keeps failed local containment retained as error/not-ready and repeated Stop joins the same failure', async () => {
    const h = harness(); const prepared = await h.supervisor.beginStartProject(); if (!prepared.accepted) throw new Error('not accepted'); h.supervisor.launchStartedProject(prepared.launch); await waitUntil(() => h.supervisor.captureAutonomousExecutingLlmSnapshots().length === 1);
    jest.spyOn(h.runner, 'terminateScopeTree').mockRejectedValueOnce(new Error('termination failed'));
    const first = h.supervisor.stopProject(); const second = h.supervisor.stopProject(); expect(second).toBe(first); await expect(first).rejects.toMatchObject({ code: 'runtime_containment_error' }); await expect(second).rejects.toMatchObject({ code: 'runtime_containment_error' });
    expect(h.supervisor.getStatus().status).toBe('error'); expect(h.binding.interventionReadiness()).toBe('not_ready'); expect((h.supervisor as unknown as { activationOwners: Map<string, unknown> }).activationOwners.size).toBe(1);
  });

  it.each(['interrupt', 'join', 'process'] as const)('keeps publication uncertainty distinct from a new %s containment failure with no stream access', async (failure) => {
    const h = harness(); jest.spyOn(h.cards, 'setStatus').mockImplementationOnce(() => { throw new Error('historical append unknown'); });
    const start = h.supervisor.beginStartProject(); void start.catch(() => undefined); await waitUntil(() => h.supervisor.getStatus().status === 'error');
    const owner = (h.supervisor as unknown as { activationOwners: Map<string, { processor: { disposeActivation(reason: unknown): void; joinActivation(): Promise<readonly never[]> } }> }).activationOwners.get('project'); if (!owner) throw new Error('owner missing');
    if (failure === 'interrupt') jest.spyOn(owner.processor, 'disposeActivation').mockImplementationOnce(() => { throw new Error('new interrupt failure'); });
    if (failure === 'join') jest.spyOn(owner.processor, 'joinActivation').mockRejectedValueOnce(new Error('new join failure'));
    if (failure === 'process') jest.spyOn(h.runner, 'terminateScopeTree').mockRejectedValueOnce(new Error('new process failure'));
    const read = jest.spyOn(h.cards, 'read'); const set = jest.spyOn(h.cards, 'setStatus'); set.mockClear(); const commit = jest.spyOn(h.cards, 'commitTerminalLifecycle');
    const first = h.supervisor.stopProject(); const repeated = h.supervisor.stopProject(); expect(repeated).toBe(first); await expect(first).rejects.toMatchObject({ code: 'runtime_containment_error' });
    expect(read).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled(); expect(h.supervisor.getStatus().status).toBe('error'); expect(h.binding.interventionReadiness()).toBe('not_ready');
  });

  it('keeps a child invocation suspended after outcome-unknown running publication until Stop clears it without stream access', async () => {
    const seed = harness(); const child = seed.cards.create({ type: 'code', parent: 'project', title: 'child', brief: 'child', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const provider = childActivationProvider(child.id); const h = { ...seed, supervisor: new SupervisorRuntimeApi({ ...testAutonomousCompaction, projectRoot: seed.root, processIdentity: { pid: 1, startedAt: 'now' }, actorStore: seed.cards, interventionBinding: seed.binding, provider, conversations: { projectRoot: seed.root }, readModelChanges: seed.changes, processRunner: seed.runner, runtimeProcessRootScope: seed.runtimeProcessRootScope, runtimeGate: seed.gate, promptTemplates: createTestPromptTemplateRegistry() }) };
    const original = h.cards.setStatus.bind(h.cards); const set = jest.spyOn(h.cards, 'setStatus').mockImplementation((id, status) => { if (id === child.id && status === 'running') throw new Error('child running unknown'); return original(id, status); });
    const prepared = await h.supervisor.beginStartProject(); if (!prepared.accepted) throw new Error('rejected'); h.supervisor.launchStartedProject(prepared.launch); await waitUntil(() => h.supervisor.getStatus().status === 'error');
    const owner = (h.supervisor as unknown as { activationOwners: Map<string, { phase: string }> }).activationOwners.get(child.id); expect(owner?.phase).toBe('publication_unknown'); set.mockClear(); await h.supervisor.stopProject(); expect(set).not.toHaveBeenCalled();
  });

  it('lets Stop claim child admission from the running append callback before currentness or provider continuation', async () => {
    const seed = harness(); const child = seed.cards.create({ type: 'code', parent: 'project', title: 'child', brief: 'child', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const h = { ...seed, supervisor: new SupervisorRuntimeApi({ ...testAutonomousCompaction, projectRoot: seed.root, processIdentity: { pid: 1, startedAt: 'now' }, actorStore: seed.cards, interventionBinding: seed.binding, provider: childActivationProvider(child.id), conversations: { projectRoot: seed.root }, readModelChanges: seed.changes, processRunner: seed.runner, runtimeProcessRootScope: seed.runtimeProcessRootScope, runtimeGate: seed.gate, promptTemplates: createTestPromptTemplateRegistry() }) };
    const original = h.cards.setStatus.bind(h.cards); let stop: Promise<unknown> | undefined;
    jest.spyOn(h.cards, 'setStatus').mockImplementation((id, status) => { if (id === child.id && status === 'running') { stop = h.supervisor.stopProject(); expect(h.supervisor.getStatus()).toMatchObject({ status: 'closing', currentCardId: 'project' }); } return original(id, status); });
    const prepared = await h.supervisor.beginStartProject(); if (!prepared.accepted) throw new Error('rejected'); h.supervisor.launchStartedProject(prepared.launch); await waitUntil(() => stop !== undefined); await expect(stop).resolves.toEqual({ status: 'stopped', contained: true });
    expect(h.supervisor.getRuntimeState()).toBeNull(); expect(h.binding.interventionReadiness()).toBe('stopped');
  });

  it('classifies terminal-result publication uncertainty separately from successful Stop containment', async () => {
    const h = harness(completingProvider()); const commit = jest.spyOn(h.cards, 'commitTerminalLifecycle').mockImplementation(() => { throw new Error('terminal append unknown'); });
    await h.service.startProject(); await waitUntil(() => h.supervisor.getStatus().status === 'error'); commit.mockClear(); await expect(h.supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true }); expect(commit).not.toHaveBeenCalled();
  });

  it('classifies cancellation publication uncertainty separately from successful Stop containment', async () => {
    const h = harness(); const prepared = await h.supervisor.beginStartProject(); if (!prepared.accepted) throw new Error('rejected'); h.supervisor.launchStartedProject(prepared.launch); await waitUntil(() => h.supervisor.captureAutonomousExecutingLlmSnapshots().length === 1);
    const set = jest.spyOn(h.cards, 'setStatus').mockImplementation(() => { throw new Error('cancel append unknown'); }); const cancellation = h.supervisor.cancelCard('project', 'cancel'); void cancellation.catch(() => undefined); await waitUntil(() => h.supervisor.getStatus().status === 'error'); set.mockClear(); await h.supervisor.stopProject(); expect(set).not.toHaveBeenCalled();
  });

  it('joins a result winner before rejecting the losing cancellation without a cancellation write', async () => {
    const h = harness(completingProvider()); const original = h.cards.commitTerminalLifecycle.bind(h.cards); let loser: Promise<unknown> | undefined;
    jest.spyOn(h.cards, 'commitTerminalLifecycle').mockImplementation((...args) => { loser = h.supervisor.cancelCard('project', 'late cancel'); void loser.catch(() => undefined); return original(...args); });
    await h.service.startProject(); await waitUntil(() => h.supervisor.getStatus().status === 'stopped');
    await expect(loser).rejects.toThrow('result already claimed'); expect(h.cards.read('project')?.lifecycle.status).toBe('done');
  });

  it('preserves a result winner when Stop re-enters terminal record publication and waits for its direct LLM settlement', async () => {
    const h = harness(completingProvider());
    const original = h.cards.commitTerminalLifecycle.bind(h.cards);
    let stop: Promise<unknown> | undefined;
    jest.spyOn(h.cards, 'commitTerminalLifecycle').mockImplementation((...args) => {
      stop ??= h.supervisor.stopProject();
      return original(...args);
    });

    await h.service.startProject();
    await waitUntil(() => stop !== undefined);
    await expect(stop).resolves.toEqual({ status: 'stopped', contained: true });
    expect(h.cards.read('project')?.lifecycle.status).toBe('done');
    expect(h.supervisor.getStatus().status).toBe('stopped');
  });

  it('keeps cancellation as sole abort/publication winner and discards a late provider result', async () => {
    let resolve!: (value: ReturnType<typeof terminalProviderResult>) => void; let signal!: AbortSignal;
    const provider = { completeTurn: async (_input: unknown, current: AbortSignal) => { signal = current; return new Promise<ReturnType<typeof terminalProviderResult>>((done) => { resolve = done; }); }, projectProviderExchanges: jest.fn() };
    const h = harness(provider); await h.service.startProject(); await waitUntil(() => signal !== undefined);
    const first = h.supervisor.cancelCard('project', 'cancel wins'); const second = h.supervisor.cancelCard('project', 'cancel wins'); expect(signal.aborted).toBe(true);
    resolve(terminalProviderResult()); await expect(first).resolves.toMatchObject({ status: 'cancelled' }); await expect(second).resolves.toEqual(await first);
    expect(h.cards.read('project')?.lifecycle.status).toBe('cancelled');
  });

  it('makes Stop-first own termination while later application cleanup only joins it and permanently closes Run', async () => {
    const h = harness(); await h.service.startProject(); await waitUntil(() => h.supervisor.captureAutonomousExecutingLlmSnapshots().length === 1);
    const terminate = jest.spyOn(h.runner, 'terminateScopeTree');
    const stop = h.supervisor.stopProject(); h.supervisor.closeApplicationAdmission(); const cleanup = h.supervisor.cleanupForApplicationStop();
    await expect(stop).resolves.toEqual({ status: 'stopped', contained: true }); await expect(cleanup).resolves.toBeUndefined();
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledWith({ rootScope: h.runtimeProcessRootScope, categories: ['runtime_card'], reason: 'runtime stop', graceMs: 5000 });
    await expect(h.supervisor.beginStartProject()).resolves.toMatchObject({ accepted: false, result: { error: 'Application is closing.' } });
  });

  it('prevents provider activation when Stop claims during launch invalidation', async () => {
    const provider = blockingProvider(); const complete = jest.spyOn(provider, 'completeTurn'); const h = harness(provider); const prepared = await h.supervisor.beginStartProject(); if (!prepared.accepted) throw new Error('rejected');
    let stop: Promise<unknown> | undefined; const subscription = h.changes.subscribe({ runtimeChanged: () => { if (h.supervisor.getStatus().status === 'running' && !stop) stop = h.supervisor.stopProject(); }, agentsChanged() {}, conversationChanged() {}, cardProjectionChanged() {} });
    expect(() => h.supervisor.launchStartedProject(prepared.launch)).toThrow('Runtime project execution stopped.'); await expect(stop).resolves.toEqual({ status: 'stopped', contained: true }); expect(complete).not.toHaveBeenCalled(); subscription.unsubscribe();
  });

  it('publishes complete stopped ownership before natural-release listeners can Stop', async () => {
    const h = harness(completingProvider()); const observations: unknown[] = [];
    h.changes.subscribe({ runtimeChanged: () => { if (h.supervisor.getStatus().status === 'stopped') observations.push({ status: h.supervisor.getStatus(), runtime: h.supervisor.getRuntimeState(), owners: (h.supervisor as unknown as { activationOwners: Map<string, unknown> }).activationOwners.size, readiness: h.binding.interventionReadiness(), stop: h.supervisor.stopProject() }); }, agentsChanged() {}, conversationChanged() {}, cardProjectionChanged() {} });
    await h.service.startProject(); await waitUntil(() => observations.length === 1); const observation = observations[0] as { status: { status: string; currentCardId: string | null }; runtime: unknown; owners: number; readiness: string; stop: Promise<unknown> };
    expect(observation).toMatchObject({ status: { status: 'stopped', currentCardId: null }, runtime: null, owners: 0, readiness: 'stopped' }); await expect(observation.stop).resolves.toEqual({ status: 'stopped', contained: false });
  });

  it('delegates Pause and Resume readiness entirely through the supervisor', async () => {
    const h = harness(); const prepared = await h.supervisor.beginStartProject(); if (!prepared.accepted) throw new Error('not accepted'); h.supervisor.launchStartedProject(prepared.launch); await waitUntil(() => h.supervisor.captureAutonomousExecutingLlmSnapshots().length === 1);
    h.service.pause(); expect(h.supervisor.getStatus().status).toBe('pausing'); expect(h.binding.interventionReadiness()).toBe('not_ready');
    const waiter = h.gate.waitUntilOpen(new AbortController().signal); await waitUntil(() => h.supervisor.getStatus().status === 'paused'); expect(h.binding.interventionReadiness()).toBe('paused');
    h.service.resume(); await waiter; expect(h.supervisor.getStatus().status).toBe('running'); expect(h.binding.interventionReadiness()).toBe('not_ready'); await h.service.stopProject();
  });

  it('leaves readiness unchanged for every rejected Pause/Resume/Run and already-stopped Stop', async () => {
    const h = harness(); await h.supervisor.start(); expect(() => h.service.pause()).toThrow("Cannot pause runtime from 'stopped'"); expect(() => h.service.resume()).toThrow("Cannot resume runtime from 'stopped'"); expect(h.binding.interventionReadiness()).toBe('stopped');
    await expect(h.service.stopProject()).resolves.toEqual({ status: 'stopped', contained: false }); expect(h.binding.interventionReadiness()).toBe('stopped');
    await h.service.startProject(); expect(() => h.service.resume()).toThrow("Cannot resume runtime from 'running'"); expect(h.binding.interventionReadiness()).toBe('not_ready');
    await expect(h.service.startProject()).resolves.toMatchObject({ started: false, status: 'running' }); expect(h.binding.interventionReadiness()).toBe('not_ready');
    h.service.pause(); const waiter = h.gate.waitUntilOpen(new AbortController().signal); await waitUntil(() => h.supervisor.getStatus().status === 'paused'); expect(() => h.service.pause()).toThrow("Cannot pause runtime from 'paused'"); expect(h.binding.interventionReadiness()).toBe('paused'); h.service.resume(); await waiter; await h.service.stopProject();
  });

  it.each(['pausing', 'paused'] as const)('naturally completes from %s and retires the exact run Pause callback before stopped invalidation', async (mode) => {
    const h = harness(completingProvider()); const snapshots: Array<{ status: string; readiness: string; gatePause: boolean }> = [];
    h.changes.subscribe({ runtimeChanged: () => snapshots.push({ status: h.supervisor.getStatus().status, readiness: h.binding.interventionReadiness(), gatePause: h.gate.pauseRequested }), agentsChanged() {}, conversationChanged() {}, cardProjectionChanged() {} });
    const original = h.cards.commitTerminalLifecycle.bind(h.cards); let injected = false;
    jest.spyOn(h.cards, 'commitTerminalLifecycle').mockImplementation((...args) => {
      if (!injected) { injected = true; h.service.pause(); if (mode === 'paused') { const controller = new AbortController(); void h.gate.waitUntilOpen(controller.signal).catch(() => undefined); controller.abort(new Error('retire frontier')); } }
      return original(...args);
    });
    await expect(h.service.startProject()).resolves.toMatchObject({ started: true }); await waitUntil(() => h.supervisor.getStatus().status === 'stopped');
    expect(h.supervisor.getRuntimeState()).toBeNull(); expect(h.binding.interventionReadiness()).toBe('stopped'); expect(h.gate.pauseRequested).toBe(false); expect(h.gate.isParked).toBe(false); expect(snapshots.at(-1)).toEqual({ status: 'stopped', readiness: 'stopped', gatePause: false });
    const controller = new AbortController(); const fresh = h.gate.waitUntilOpen(controller.signal); controller.abort(new Error('fresh')); await expect(fresh).rejects.toThrow('fresh'); expect(snapshots.at(-1)?.status).toBe('stopped');
  });
});
