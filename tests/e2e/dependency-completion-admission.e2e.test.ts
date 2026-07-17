import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LlmCompleteResult, ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import { CardService } from '../../src/cards/card-service.js';
import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import type { CardActor } from '../../src/runtime/actors/card-actor.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { SupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { selectRunningCardChain } from '../../src/runtime/running-card-chain.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { testAppLogs } from '../helpers/app-logs.js';
import { testAutonomousCompaction } from '../helpers/llm-test-helpers.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function complete(result: LlmCompleteResult): ProviderTurnCompletion { return { result, provider_exchanges: [] }; }
function tool(id: string, name: string, args: object): LlmCompleteResult { return { kind: 'tool_calls', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function waitUntil(predicate: () => boolean): Promise<void> { for (let attempt = 0; attempt < 500; attempt += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } throw new Error('condition not reached'); }
async function settleWithin(promise: Promise<void>, label: string): Promise<void> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 2_000); });
  try { await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}

type RuntimeInternals = {
  cardActors: Map<string, CardActor>;
  liveCardActors: Map<string, CardActor>;
  cardActor(cardId: string): CardActor;
};

function runtime(projectRoot: string, cards: CardService, processRunner: ProcessRunner, provider: { completeTurn(input: LlmInvocationInput, signal: AbortSignal): Promise<ProviderTurnCompletion> }): SupervisorRuntimeApi {
  return new SupervisorRuntimeApi({
    ...testAutonomousCompaction,
    projectRoot,
    actorStore: cards,
    interventionBinding: new RuntimeInterventionBinding(),
    provider,
    conversations: { projectRoot },
    appLogs: testAppLogs(projectRoot),
    readModelChanges: { runtimeChanged() {}, cardStateChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) },
    processRunner,
    promptTemplates: { render: () => 'test prompt' },
  });
}

describe('dependency-completion activation admission E2E', () => {
  it('rejects B before A is done, then admits and completes B through the ordinary planner and executor stack', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-dependency-admission-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const ids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ];
    let identityIndex = 0;
    const cards = new CardService(projectRoot, undefined, undefined, () => ids[identityIndex++]!);
    const parent = cards.create({ type: 'goal', parent: 'project', depth: 1, title: 'Parent', brief: 'Run dependency order', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const dependency = cards.create({ type: 'code', parent: parent.id, depth: 2, title: 'A', brief: 'Complete first', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const dependent = cards.create({ type: 'code', parent: parent.id, depth: 2, title: 'B', brief: 'Complete second', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [dependency.id], related: [] });
    cards.setStatus('project', 'running');
    cards.setStatus(parent.id, 'running');

    const bRejected = deferred<void>();
    const allowDependency = deferred<void>();
    const dependencyDoneBeforeSecondRequest = deferred<void>();
    const allowDependent = deferred<void>();
    const dependentProviderStarted = deferred<void>();
    const allowDependentTool = deferred<void>();
    const dependentToolCompleted = deferred<void>();
    const allowDependentCompletion = deferred<void>();
    let parentCalls = 0;
    let dependencyCalls = 0;
    let dependentCalls = 0;
    let firstDependentToolResult: unknown;

    const provider = {
      completeTurn: jest.fn(async (input: LlmInvocationInput, signal: AbortSignal): Promise<ProviderTurnCompletion> => {
        if (input.sessionId === `planner:${parent.id}`) {
          parentCalls += 1;
          if (parentCalls === 1) return complete(tool('activate-b-first', 'activate_card', { card_id: dependent.id }));
          if (parentCalls === 2) {
            const row = [...input.providerConversation.messages].reverse().find((message) => message.kind === 'tool_result' && message.tool_call_id === 'activate-b-first');
            firstDependentToolResult = row ? JSON.parse(row.content) : null;
            bRejected.resolve();
            await allowDependency.promise;
            return complete(tool('activate-a', 'activate_card', { card_id: dependency.id }));
          }
          if (parentCalls === 3) {
            if (cards.read(dependency.id)?.status !== 'done') throw new Error('Dependency A was not durably done before the next planner request.');
            dependencyDoneBeforeSecondRequest.resolve();
            await allowDependent.promise;
            return complete(tool('activate-b-second', 'activate_card', { card_id: dependent.id }));
          }
          return new Promise<ProviderTurnCompletion>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        }
        if (input.sessionId === `executor:${dependency.id}`) {
          dependencyCalls += 1;
          if (dependencyCalls === 1) return complete(tool('write-a', 'write', { path: 'record:///status.md?v=next', content: 'A completed first.' }));
          return complete(tool('done-a', 'emit_result', { status: 'done', summary: 'A complete.' }));
        }
        if (input.sessionId === `executor:${dependent.id}`) {
          dependentCalls += 1;
          if (dependentCalls === 1) {
            dependentProviderStarted.resolve();
            await allowDependentTool.promise;
            return complete(tool('write-b', 'write', { path: 'record:///status.md?v=next', content: 'B admitted after A.' }));
          }
          if (dependentCalls === 2) {
            dependentToolCompleted.resolve();
            await allowDependentCompletion.promise;
            return complete(tool('done-b', 'emit_result', { status: 'done', summary: 'B complete.' }));
          }
          throw new Error('Dependent executor received an unexpected extra turn.');
        }
        throw new Error(`Unexpected provider session '${input.sessionId}'.`);
      }),
    };
    const processRunner = new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry());
    const supervisor = runtime(projectRoot, cards, processRunner, provider);
    const internals = supervisor as unknown as RuntimeInternals;
    const cardActorLookup = jest.spyOn(internals, 'cardActor');
    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('Run was not accepted.');
    supervisor.launchStartedProject(prepared.state);

    await settleWithin(bRejected.promise, 'initial B rejection');
    expect(firstDependentToolResult).toEqual({
      success: false,
      error: `Child card '${dependent.id}' has incomplete dependencies: ${dependency.id} (backlog).`,
    });
    expect(cards.read(dependent.id)).toMatchObject({ status: 'backlog', version_seq: 1 });
    expect(cardActorLookup.mock.calls.filter(([cardId]) => cardId === dependent.id)).toHaveLength(0);
    expect(internals.cardActors.has(dependent.id)).toBe(false);
    expect(internals.liveCardActors.has(dependent.id)).toBe(false);
    expect(supervisor.getActorRuntimeReadModel().cards.some(({ cardId }) => cardId === dependent.id)).toBe(false);
    expect(supervisor.getActorRuntimeReadModel().agents.some(({ cardId }) => cardId === dependent.id)).toBe(false);
    expect(supervisor.getStatus().currentCardId).toBe(parent.id);
    expect(selectRunningCardChain(cards.list()).map(({ id }) => id)).toEqual(['project', parent.id]);
    expect(dependentCalls).toBe(0);
    expect(readConversation(projectRoot, `executor:${dependent.id}`).physicalRows).toEqual([]);
    expect(() => cards.readRecord(dependent.id, 'status.md')).toThrow();
    expect(processRunner.list({ cardId: dependent.id })).toEqual([]);

    allowDependency.resolve();
    await settleWithin(dependencyDoneBeforeSecondRequest.promise, 'A completion');
    expect(cards.read(dependency.id)).toMatchObject({ status: 'done', lifecycle: { result: { kind: 'done', summary: 'A complete.' } } });
    expect(cards.readRecord(dependency.id, 'status.md').artifact.content).toBe('A completed first.');
    expect(dependencyCalls).toBe(2);
    expect(cards.read(dependent.id)?.status).toBe('backlog');

    allowDependent.resolve();
    await settleWithin(dependentProviderStarted.promise, 'admitted B provider start');
    expect(cards.read(dependent.id)?.status).toBe('running');
    expect(selectRunningCardChain(cards.list()).map(({ id }) => id)).toEqual(['project', parent.id, dependent.id]);
    expect(supervisor.getStatus().currentCardId).toBe(dependent.id);
    expect(internals.liveCardActors.get(dependent.id)?.cardId).toBe(dependent.id);
    expect(dependentCalls).toBe(1);

    allowDependentTool.resolve();
    await settleWithin(dependentToolCompleted.promise, 'B tool completion');
    expect(cards.readRecord(dependent.id, 'status.md', 'open').artifact.content).toBe('B admitted after A.');
    expect(readConversation(projectRoot, `executor:${dependent.id}`).physicalRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool_call', tool: 'write', tool_call_id: 'write-b' }),
      expect.objectContaining({ kind: 'tool_result', tool: 'write', tool_call_id: 'write-b' }),
    ]));

    allowDependentCompletion.resolve();
    await waitUntil(() => cards.read(dependent.id)?.status === 'done');
    expect(cards.read(dependent.id)).toMatchObject({ status: 'done', lifecycle: { result: { kind: 'done', summary: 'B complete.' } } });
    expect(cards.readRecord(dependent.id, 'status.md').artifact.content).toBe('B admitted after A.');
    expect(dependentCalls).toBe(2);
    expect(internals.cardActors.has(dependent.id)).toBe(false);
    expect(internals.liveCardActors.has(dependent.id)).toBe(false);
    await expect(supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
  }, 15_000);
});
