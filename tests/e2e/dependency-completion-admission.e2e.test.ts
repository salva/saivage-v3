import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LlmCompleteResult, ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import { CardService } from '../../src/cards/card-service.js';
import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { SupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { selectLinkedRunningChain } from '../../src/runtime/running-card-chain.js';
import { initProjectTree } from '../helpers/canonical-project.js';
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

type RuntimeOwnership = {
  activationOwners: Map<string, { readonly cardId: string }>;
};

function runtime(projectRoot: string, cards: CardService, processRunner: ProcessRunner, runtimeProcessRootScope: import('../../src/runtime/managed-process-group-registry.js').ManagedProcessScope, provider: { completeTurn(input: LlmInvocationInput, signal: AbortSignal): Promise<ProviderTurnCompletion> }): SupervisorRuntimeApi {
  return new SupervisorRuntimeApi({
    ...testAutonomousCompaction,
    projectRoot,
    actorStore: cards,
    interventionBinding: new RuntimeInterventionBinding(),
    provider,
    conversations: { projectRoot },
    readModelChanges: { runtimeChanged() {}, cardProjectionChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) },
    processRunner,
    runtimeProcessRootScope,
    promptTemplates: { render: () => 'test prompt' },
  });
}

describe('dependency-completion activation admission E2E', () => {
  it('rejects B before A is done, then admits and completes B through the ordinary planner and executor stack', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-dependency-admission-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const parent = cards.create({ type: 'goal', parent: 'project', title: 'Parent', brief: 'Run dependency order', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const dependency = cards.create({ type: 'code', parent: parent.id, title: 'A', brief: 'Complete first', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const dependent = cards.create({ type: 'code', parent: parent.id, title: 'B', brief: 'Complete second', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [dependency.id], related: [] });
    cards.setStatus('project', 'running');

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
    let projectCalls = 0;
    let firstDependentToolResult: unknown;

    const provider = {
      completeTurn: jest.fn(async (input: LlmInvocationInput, signal: AbortSignal): Promise<ProviderTurnCompletion> => {
        if (input.sessionId === 'planner:project') {
          projectCalls += 1;
          if (projectCalls === 1) return complete(tool('activate-parent', 'activate_card', { card_id: parent.id }));
          if (projectCalls === 2) return complete(tool('write-project-status', 'write', { path: 'record:///status.md?v=next', content: 'Dependency workflow complete.' }));
          return complete(tool('complete-project', 'emit_result', { outcome: 'complete_direct', summary: 'Project complete.' }));
        }
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
            if (cards.read(dependency.id)?.lifecycle.status !== 'done') throw new Error('Dependency A was not durably done before the next planner request.');
            dependencyDoneBeforeSecondRequest.resolve();
            await allowDependent.promise;
            return complete(tool('activate-b-second', 'activate_card', { card_id: dependent.id }));
          }
          if (parentCalls === 4) return complete(tool('write-parent-status', 'write', { path: 'record:///status.md?v=next', content: 'Dependencies complete.' }));
          return complete(tool('complete-parent', 'emit_result', { outcome: 'complete_direct', summary: 'Parent complete.' }));
        }
        if (input.sessionId === `executor:${dependency.id}`) {
          dependencyCalls += 1;
          if (dependencyCalls === 1) return complete(tool('write-a', 'write', { path: 'record:///status.md?v=next', content: 'A completed first.' }));
          return complete(tool('done-a', 'emit_result', { outcome: 'done', summary: 'A complete.' }));
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
            return complete(tool('done-b', 'emit_result', { outcome: 'done', summary: 'B complete.' }));
          }
          throw new Error('Dependent executor received an unexpected extra turn.');
        }
        throw new Error(`Unexpected provider session '${input.sessionId}'.`);
      }),
    };
    const registry = new ManagedProcessGroupRegistry();
    const runtimeProcessRootScope = registry.createContainerScope(registry.rootScope, 'runtime-cards');
    const processRunner = new ProcessRunner(projectRoot, registry);
    const supervisor = runtime(projectRoot, cards, processRunner, runtimeProcessRootScope, provider);
    const ownership = supervisor as unknown as RuntimeOwnership;
    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('Run was not accepted.');
    supervisor.launchStartedProject(prepared.launch);

    await settleWithin(bRejected.promise, 'initial B rejection');
    expect(firstDependentToolResult).toEqual({
      success: false,
      error: `Child card '${dependent.id}' has incomplete dependencies: ${dependency.id} (backlog).`,
    });
    expect(cards.read(dependent.id)).toMatchObject({ lifecycle: { status: 'backlog' }, version_seq: 1 });
    expect(ownership.activationOwners.has(dependent.id)).toBe(false);
    expect([...ownership.activationOwners.keys()]).toEqual(['project', parent.id]);
    expect(supervisor.getActorRuntimeReadModel().cards.some(({ cardId }) => cardId === dependent.id)).toBe(false);
    expect(supervisor.getActorRuntimeReadModel()).not.toHaveProperty('agents');
    expect(supervisor.getStatus().currentCardId).toBe(parent.id);
    expect(supervisor.getRuntimeState()?.current_card_id).toBe(parent.id);
    expect(selectLinkedRunningChain(cards).map(({ id }) => id)).toEqual(['project', parent.id]);
    expect(dependentCalls).toBe(0);
    expect(readConversation(projectRoot, `executor:${dependent.id}`).physicalRows).toEqual([]);
    expect(() => cards.readRecord(dependent.id, 'status.md')).toThrow();
    expect(processRunner.list({ cardId: dependent.id })).toEqual([]);

    allowDependency.resolve();
    await settleWithin(dependencyDoneBeforeSecondRequest.promise, 'A completion');
    expect(cards.read(dependency.id)).toMatchObject({ lifecycle: { status: 'done', result: { kind: 'done', summary: 'A complete.' } } });
    expect(cards.readRecord(dependency.id, 'status.md').artifact.content).toBe('A completed first.');
    expect(dependencyCalls).toBe(2);
    expect(cards.read(dependent.id)?.lifecycle.status).toBe('backlog');

    allowDependent.resolve();
    await settleWithin(dependentProviderStarted.promise, 'admitted B provider start');
    expect(cards.read(dependent.id)?.lifecycle.status).toBe('running');
    expect(selectLinkedRunningChain(cards).map(({ id }) => id)).toEqual(['project', parent.id, dependent.id]);
    expect(supervisor.getStatus().currentCardId).toBe(dependent.id);
    expect(supervisor.getRuntimeState()?.current_card_id).toBe(dependent.id);
    expect(ownership.activationOwners.get(dependent.id)?.cardId).toBe(dependent.id);
    expect(dependentCalls).toBe(1);

    allowDependentTool.resolve();
    await settleWithin(dependentToolCompleted.promise, 'B tool completion');
    expect(cards.readRecord(dependent.id, 'status.md', 'open').artifact.content).toBe('B admitted after A.');
    expect(readConversation(projectRoot, `executor:${dependent.id}`).physicalRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool_call', tool: 'write', tool_call_id: 'write-b' }),
      expect.objectContaining({ kind: 'tool_result', tool: 'write', tool_call_id: 'write-b' }),
    ]));

    allowDependentCompletion.resolve();
    await waitUntil(() => cards.read(dependent.id)?.lifecycle.status === 'done');
    expect(cards.read(dependent.id)).toMatchObject({ lifecycle: { status: 'done', result: { kind: 'done', summary: 'B complete.' } } });
    expect(cards.readRecord(dependent.id, 'status.md').artifact.content).toBe('B admitted after A.');
    expect(dependentCalls).toBe(2);
    expect(ownership.activationOwners.has(dependent.id)).toBe(false);
    await waitUntil(() => supervisor.getStatus().status === 'stopped');
    expect(ownership.activationOwners.size).toBe(0);
  }, 15_000);
});
