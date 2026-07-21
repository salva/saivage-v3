import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardsReadModelService } from '../../src/application/read-models/cards-read-model.js';
import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js';
import { CardService } from '../../src/cards/card-service.js';
import { ProviderTurnFailure, type ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import { LlmRequestError } from '../../src/contracts/llm-failure.js';
import type { ProviderExchangeAttempt } from '../../src/contracts/provider-exchange.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { SupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import type { LlmCompleteResult } from '../../src/agents/llm-contracts.js';
import { selectLinkedRunningChain } from '../../src/runtime/running-card-chain.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { testAutonomousCompaction } from '../helpers/llm-test-helpers.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function complete(result: LlmCompleteResult): ProviderTurnCompletion { return { result, provider_exchanges: [] }; }
function tool(id: string, name: string, args: object): LlmCompleteResult { return { kind: 'tool_calls', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function waitUntil(predicate: () => boolean): Promise<void> { for (let attempt = 0; attempt < 500; attempt += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } throw new Error('condition not reached'); }
function history(cards: CardService, cardId: string) { const result = cards.listCardHistory(cardId); if (result.kind !== 'found') throw new Error(`missing ${cardId}`); return result.value; }

type RuntimeOwnership = {
  activationOwners: Map<string, { readonly cardId: string }>;
};

function runtime(projectRoot: string, cards: CardService, provider: { completeTurn(input: LlmInvocationInput, signal: AbortSignal): Promise<ProviderTurnCompletion>; projectProviderExchanges?: (sessionId: string, inputId: string, attempts: ProviderExchangeAttempt[], outputIds: string[]) => void }, processes?: { processRunner: ProcessRunner; runtimeProcessRootScope: import('../../src/runtime/managed-process-group-registry.js').ManagedProcessScope }): SupervisorRuntimeApi {
  const registry = processes ? null : new ManagedProcessGroupRegistry();
  const processRunner = processes?.processRunner ?? new ProcessRunner(projectRoot, registry!);
  const runtimeProcessRootScope = processes?.runtimeProcessRootScope ?? registry!.createContainerScope(registry!.rootScope, 'runtime-cards');
  return new SupervisorRuntimeApi({
    ...testAutonomousCompaction,
    projectRoot, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(), provider,
    conversations: { projectRoot },
    readModelChanges: { runtimeChanged() {}, cardProjectionChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) },
    processRunner, runtimeProcessRootScope, promptTemplates: { render: () => 'test prompt' },
  });
}

function permanentFailure(input: LlmInvocationInput): ProviderTurnFailure {
  const message = 'LLM authentication failed permanently';
  const originalFailure = new LlmRequestError({ kind: 'auth_permanent', provider: 'test-provider', status: 401, message });
  const exchange: ProviderExchangeAttempt = {
    contract_id: 'test-contract', contract_name: 'test contract', transport: 'generic', provider: 'test-provider', model: 'test-model',
    source_input_id: input.inputId, attempt_index: 0, request_params: {}, started_at: '2026-07-17T00:00:00.000Z', completed_at: '2026-07-17T00:00:00.001Z',
    status: 'error', response_status: 401, terminal_tool_fired: null, error: { name: 'LlmRequestError', message, status: 401 },
  };
  return new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: [exchange], originalFailure });
}

describe('failed child activation lifecycle E2E', () => {
  it('rejects autonomous reactivation of a failed child without ownership, then continues through a sibling to natural completion', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-failed-child-siblings-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const parent = cards.create({ type: 'goal', parent: 'project', title: 'Parent', brief: 'Plan children', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const failedChild = cards.create({ type: 'code', parent: parent.id, title: 'A', brief: 'Fail once', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const sibling = cards.create({ type: 'code', parent: parent.id, title: 'B', brief: 'Run second', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running');

    const parentAfterRejectedRetry = deferred<void>();
    const continueParent = deferred<void>();
    const siblingAdmitted = deferred<void>();
    const releaseSibling = deferred<void>();
    let parentCalls = 0;
    let failedChildCalls = 0;
    let siblingCalls = 0;
    let projectCalls = 0;
    let failedRunningVersion = 0;
    let failureToolResult: unknown;
    let rejectedRetryToolResult: unknown;
    const provider = {
      projectProviderExchanges: jest.fn(),
      completeTurn: jest.fn(async (input: LlmInvocationInput, signal: AbortSignal): Promise<ProviderTurnCompletion> => {
        if (input.sessionId === 'planner:project') {
          projectCalls += 1;
          if (projectCalls === 1) return complete(tool('activate-parent', 'activate_card', { card_id: parent.id }));
          if (projectCalls === 2) return complete(tool('write-project-status', 'write', { path: 'record:///status.md?v=next', content: 'Parent workflow complete.' }));
          return complete(tool('fail-project', 'emit_result', { outcome: 'failed', summary: 'Project failed after child failure.' }));
        }
        if (input.sessionId === `planner:${parent.id}`) {
          parentCalls += 1;
          if (parentCalls === 1) return complete(tool('activate-a', 'activate_card', { card_id: failedChild.id }));
          if (parentCalls === 2) {
            const row = [...input.providerConversation.messages].reverse().find((message) => message.kind === 'tool_result' && message.tool_call_id === 'activate-a');
            failureToolResult = row ? JSON.parse(row.content) : null;
            return complete(tool('retry-failed-a', 'activate_card', { card_id: failedChild.id }));
          }
          if (parentCalls === 3) {
            const row = [...input.providerConversation.messages].reverse().find((message) => message.kind === 'tool_result' && message.tool_call_id === 'retry-failed-a');
            rejectedRetryToolResult = row ? JSON.parse(row.content) : null;
            parentAfterRejectedRetry.resolve();
            await continueParent.promise;
            return complete(tool('activate-b', 'activate_card', { card_id: sibling.id }));
          }
          if (parentCalls === 4) return complete(tool('write-parent-status', 'write', { path: 'record:///status.md?v=next', content: 'Sibling complete; failed child retained.' }));
          return complete(tool('fail-parent', 'emit_result', { outcome: 'failed', summary: 'Parent failed after child failure.' }));
        }
        if (input.sessionId === `executor:${failedChild.id}`) {
          failedChildCalls += 1;
          if (failedChildCalls === 1) {
            failedRunningVersion = cards.read(failedChild.id)!.version_seq;
            throw permanentFailure(input);
          }
          throw new Error('Failed child received an unexpected extra turn.');
        }
        if (input.sessionId === `executor:${sibling.id}`) {
          siblingCalls += 1;
          if (siblingCalls === 1) {
            siblingAdmitted.resolve();
            await releaseSibling.promise;
            return complete(tool('write-b', 'write', { path: 'record:///status.md?v=next', content: 'B complete.' }));
          }
          return complete(tool('done-b', 'emit_result', { outcome: 'done', summary: 'B complete.' }));
        }
        throw new Error(`Unexpected provider session '${input.sessionId}'.`);
      }),
    };
    const supervisor = runtime(projectRoot, cards, provider);
    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('Run was not accepted.');
    supervisor.launchStartedProject(prepared.launch);
    await parentAfterRejectedRetry.promise;
    expect(supervisor.getStatus().currentCardId).toBe(parent.id);
    expect(supervisor.getRuntimeState()?.current_card_id).toBe(parent.id);

    const ownership = supervisor as unknown as RuntimeOwnership;
    const failed = cards.read(failedChild.id)!;
    expect(failed).toMatchObject({ version_seq: failedRunningVersion + 1, lifecycle: { status: 'failed', result: { kind: 'failed', summary: expect.stringContaining('authentication failed permanently') }, error: expect.stringContaining('authentication failed permanently') } });
    expect(failureToolResult).toEqual({ success: true, data: { card_id: failedChild.id, outcome: 'failed', summary: expect.stringContaining('authentication failed permanently'), result: { kind: 'failed', summary: expect.stringContaining('authentication failed permanently') } } });
    expect(rejectedRetryToolResult).toEqual({ success: false, error: `Card '${failedChild.id}' in status 'failed' is not activatable.` });
    expect(ownership.activationOwners.has(failedChild.id)).toBe(false);
    expect([...ownership.activationOwners.keys()]).toEqual(['project', parent.id]);
    expect(supervisor.getActorRuntimeReadModel().cards.map(({ cardId }) => cardId)).toEqual(['project', parent.id]);
    expect(history(cards, failedChild.id).filter((entry) => entry.change_reason === 'terminal lifecycle commit')).toHaveLength(1);

    continueParent.resolve();
    await siblingAdmitted.promise;
    expect(supervisor.getStatus().currentCardId).toBe(sibling.id);
    expect(supervisor.getRuntimeState()?.current_card_id).toBe(sibling.id);
    const runningChain = selectLinkedRunningChain(cards).map((card) => card.id);
    expect(runningChain).toEqual(['project', parent.id, sibling.id]);
    expect(cards.read(failedChild.id)?.lifecycle.status).toBe('failed');
    expect(ownership.activationOwners.has(failedChild.id)).toBe(false);
    expect(ownership.activationOwners.get(sibling.id)?.cardId).toBe(sibling.id);
    const cardProjection = new CardsReadModelService(projectRoot, cards, supervisor).getCard(failedChild.id);
    if ('statusCode' in cardProjection) throw new Error('expected card projection');
    expect(cardProjection.body.card.lifecycle.status).toBe('failed');
    expect(supervisor.getActorRuntimeReadModel().cards.some((card) => card.cardId === failedChild.id && card.actorState === 'running')).toBe(false);

    releaseSibling.resolve();
    await waitUntil(() => supervisor.getStatus().status === 'stopped');
    expect(cards.read(failedChild.id)).toMatchObject({ lifecycle: { status: 'failed', result: { kind: 'failed' } } });
    expect(failedChildCalls).toBe(1);
    expect(history(cards, failedChild.id).filter((entry) => entry.change_reason === 'terminal lifecycle commit')).toHaveLength(1);
    expect(cards.read(parent.id)).toMatchObject({ lifecycle: { status: 'failed', result: { kind: 'failed', summary: 'Parent failed after child failure.' } } });
    expect(cards.read('project')).toMatchObject({ lifecycle: { status: 'failed', result: { kind: 'failed', summary: 'Project failed after child failure.' } } });
    expect(selectLinkedRunningChain(cards)).toEqual([]);
    expect(ownership.activationOwners.size).toBe(0);
    expect(supervisor.getRuntimeState()).toBeNull();
  });

  it('constructs a fresh actor when a failed child is changed and autonomously retried', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-failed-child-changed-retry-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Retry child', brief: 'Fail, change, and retry', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running');
    const retryAdmitted = deferred<void>();
    const releaseRetry = deferred<void>();
    let projectCalls = 0;
    let childCalls = 0;
    let firstActivationResult: unknown;
    const provider = {
      projectProviderExchanges: jest.fn(),
      completeTurn: jest.fn(async (input: LlmInvocationInput): Promise<ProviderTurnCompletion> => {
        if (input.sessionId === 'planner:project') {
          projectCalls += 1;
          if (projectCalls === 1) return complete(tool('activate-child-first', 'activate_card', { card_id: child.id }));
          if (projectCalls === 2) {
            const row = [...input.providerConversation.messages].reverse().find((message) => message.kind === 'tool_result' && message.tool_call_id === 'activate-child-first');
            firstActivationResult = row ? JSON.parse(row.content) : null;
            return complete(tool('edit-failed-child', 'edit_card', { card_id: child.id, title: 'Retry child changed' }));
          }
          if (projectCalls === 3) return complete(tool('activate-child-second', 'activate_card', { card_id: child.id }));
          if (projectCalls === 4) return complete(tool('write-project-status', 'write', { path: 'record:///status.md?v=next', content: 'Changed child retry complete.' }));
          return complete(tool('complete-project', 'emit_result', { outcome: 'complete_direct', summary: 'Project complete after changed retry.' }));
        }
        if (input.sessionId === `executor:${child.id}`) {
          childCalls += 1;
          if (childCalls === 1) throw permanentFailure(input);
          if (childCalls === 2) {
            retryAdmitted.resolve();
            await releaseRetry.promise;
            return complete(tool('write-child-status', 'write', { path: 'record:///status.md?v=next', content: 'Retry succeeded.' }));
          }
          if (childCalls === 3) return complete(tool('complete-child', 'emit_result', { outcome: 'done', summary: 'Changed child completed.' }));
        }
        throw new Error(`Unexpected provider session '${input.sessionId}'.`);
      }),
    };
    const supervisor = runtime(projectRoot, cards, provider);
    const ownership = supervisor as unknown as RuntimeOwnership;
    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('Run was not accepted.');
    supervisor.launchStartedProject(prepared.launch);

    await retryAdmitted.promise;
    expect(firstActivationResult).toEqual({ success: true, data: { card_id: child.id, outcome: 'failed', summary: expect.stringContaining('authentication failed permanently'), result: { kind: 'failed', summary: expect.stringContaining('authentication failed permanently') } } });
    expect(cards.read(child.id)).toMatchObject({ title: 'Retry child changed', lifecycle: { status: 'running' } });
    expect(ownership.activationOwners.get(child.id)?.cardId).toBe(child.id);
    expect(supervisor.getStatus().currentCardId).toBe(child.id);
    releaseRetry.resolve();

    await waitUntil(() => supervisor.getStatus().status === 'stopped');
    expect(cards.read(child.id)).toMatchObject({ title: 'Retry child changed', lifecycle: { status: 'done', result: { kind: 'done', summary: 'Changed child completed.' } } });
    expect(history(cards, child.id).filter((entry) => entry.change_reason === 'terminal lifecycle commit')).toHaveLength(2);
    expect(childCalls).toBe(3);
    expect(ownership.activationOwners.size).toBe(0);
  });

  it('selects cleanup failure after accepted executor terminal handling as the only terminal publication', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-cleanup-failure-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Cleanup', brief: 'Fail cleanup', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running');
    const initialVersion = cards.read(child.id)!.version_seq;
    const registry = new ManagedProcessGroupRegistry();
    const runtimeProcessRootScope = registry.createContainerScope(registry.rootScope, 'runtime-cards');
    const processRunner = new ProcessRunner(projectRoot, registry);
    jest.spyOn(processRunner, 'closeAndTerminateDirectScope').mockResolvedValue({ selected: ['cleanup'], stopped: [], failed: [{ groupId: 'cleanup', state: 'unconfirmed', diagnostic: 'cleanup exploded' }] });
    let executorCalls = 0;
    let plannerCalls = 0;
    const provider = { completeTurn: jest.fn(async (input: LlmInvocationInput, signal: AbortSignal) => {
      if (input.role === 'planner') {
        plannerCalls += 1;
        if (plannerCalls === 1) return complete(tool('activate-cleanup-child', 'activate_card', { card_id: child.id }));
        if (plannerCalls === 2) return complete(tool('write-project-failure', 'write', { path: 'record:///status.md?v=next', content: 'Child cleanup failed.' }));
        return complete(tool('fail-project', 'emit_result', { outcome: 'failed', summary: 'Child cleanup failed.' }));
      }
      if (input.role === 'executor') return complete(++executorCalls === 1
        ? tool('write', 'write', { path: 'record:///status.md?v=next', content: 'Accepted output.' })
        : tool('accepted', 'emit_result', { outcome: 'done', summary: 'Accepted before cleanup.' }));
      return new Promise<ProviderTurnCompletion>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }) };
    const supervisor = runtime(projectRoot, cards, provider, { processRunner, runtimeProcessRootScope });
    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('Run was not accepted.');
    supervisor.launchStartedProject(prepared.launch);
    await waitUntil(() => cards.read(child.id)?.lifecycle.status === 'failed');
    await waitUntil(() => !(supervisor as unknown as RuntimeOwnership).activationOwners.has(child.id));

    expect(cards.read(child.id)).toMatchObject({ version_seq: initialVersion + 2, lifecycle: { status: 'failed', result: { kind: 'failed', summary: 'cleanup: unconfirmed: cleanup exploded' }, error: 'cleanup: unconfirmed: cleanup exploded' } });
    expect(history(cards, child.id).filter((entry) => entry.change_reason === 'terminal lifecycle commit')).toHaveLength(1);
    expect(cards.readRecord(child.id, 'status.md', 'latest').artifact.content).toBe('Accepted output.');
    expect(() => cards.readRecord(child.id, 'status.md', 'open')).toThrow();
    const terminalRows = readConversation(projectRoot, `executor:${child.id}`).physicalRows.filter((row) => row.tool_call_id === 'accepted');
    expect(terminalRows).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'tool_result', content: JSON.stringify({ success: true, data: { accepted: true } }) })]));
    expect((supervisor as unknown as RuntimeOwnership).activationOwners.has(child.id)).toBe(false);
    await waitUntil(() => supervisor.getStatus().status === 'stopped');
  });

  it('publishes one failed lifecycle for malformed provider failure metadata through the real processor stack', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-malformed-provider-failure-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    cards.setStatus('project', 'running');
    const runningVersion = cards.read('project')!.version_seq;
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const supervisor = runtime(projectRoot, cards, { completeTurn: async () => { throw new Error('malformed provider envelope'); } });
    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('Run was not accepted.');
    supervisor.launchStartedProject(prepared.launch);
    await waitUntil(() => supervisor.getStatus().status === 'stopped');

    expect(cards.read('project')).toMatchObject({ lifecycle: { status: 'failed', result: { kind: 'failed', summary: 'malformed provider envelope' }, error: 'malformed provider envelope' } });
    expect(cards.read('project')!.version_seq).toBeGreaterThan(runningVersion);
    expect(history(cards, 'project').filter((entry) => entry.change_reason === 'terminal lifecycle commit')).toHaveLength(1);
    expect((supervisor as unknown as RuntimeOwnership).activationOwners.size).toBe(0);
    consoleError.mockRestore();
  });
});
