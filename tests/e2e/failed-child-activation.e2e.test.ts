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
import type { CardActor } from '../../src/runtime/actors/card-actor.js';
import { SupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import type { LlmCompleteResult } from '../../src/agents/llm-contracts.js';
import { selectRunningCardChain } from '../../src/runtime/running-card-chain.js';
import { createPlannerControlProvider } from '../../src/tools/planner-control-provider.js';
import { invokeTool } from '../../src/tools/invocation.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { testAppLogs } from '../helpers/app-logs.js';
import { testAutonomousCompaction } from '../helpers/llm-test-helpers.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function complete(result: LlmCompleteResult): ProviderTurnCompletion { return { result, provider_exchanges: [] }; }
function tool(id: string, name: string, args: object): LlmCompleteResult { return { kind: 'tool_calls', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function waitUntil(predicate: () => boolean): Promise<void> { for (let attempt = 0; attempt < 500; attempt += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } throw new Error('condition not reached'); }
function history(cards: CardService, cardId: string) { const result = cards.listCardHistory(cardId); if (result.kind !== 'found') throw new Error(`missing ${cardId}`); return result.value; }

type RuntimeInternals = { cardActors: Map<string, CardActor>; liveCardActors: Map<string, CardActor>; cardActor(cardId: string): CardActor };

function runtime(projectRoot: string, cards: CardService, provider: { completeTurn(input: LlmInvocationInput, signal: AbortSignal): Promise<ProviderTurnCompletion>; projectProviderExchanges?: (sessionId: string, inputId: string, attempts: ProviderExchangeAttempt[], outputIds: string[]) => void }, processRunner = new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry())): SupervisorRuntimeApi {
  return new SupervisorRuntimeApi({
    ...testAutonomousCompaction,
    projectRoot, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(), provider,
    conversations: { projectRoot }, appLogs: testAppLogs(projectRoot),
    readModelChanges: { runtimeChanged() {}, cardStateChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) },
    processRunner, promptTemplates: { render: () => 'test prompt' },
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
  it('publishes a canonical provider failure before sibling admission and supports changed-card retry', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-failed-child-siblings-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const parent = cards.create({ type: 'goal', parent: 'project', title: 'Parent', brief: 'Plan children', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const failedChild = cards.create({ type: 'code', parent: parent.id, title: 'A', brief: 'Fail once', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const sibling = cards.create({ type: 'code', parent: parent.id, title: 'B', brief: 'Run second', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running');
    cards.setStatus(parent.id, 'running');

    const parentAfterFailure = deferred<void>();
    const continueParent = deferred<void>();
    const siblingAdmitted = deferred<void>();
    const releaseSibling = deferred<void>();
    let parentCalls = 0;
    let failedChildCalls = 0;
    let siblingCalls = 0;
    let failedRunningVersion = 0;
    let failureToolResult: unknown;
    let supervisor!: SupervisorRuntimeApi;
    const provider = {
      projectProviderExchanges: jest.fn(),
      completeTurn: jest.fn(async (input: LlmInvocationInput, signal: AbortSignal): Promise<ProviderTurnCompletion> => {
        if (input.sessionId === `planner:${parent.id}`) {
          parentCalls += 1;
          if (parentCalls === 1) return complete(tool('activate-a', 'activate_card', { card_id: failedChild.id }));
          if (parentCalls === 2) {
            const row = [...input.providerConversation.messages].reverse().find((message) => message.kind === 'tool_result' && message.tool_call_id === 'activate-a');
            failureToolResult = row ? JSON.parse(row.content) : null;
            parentAfterFailure.resolve();
            await continueParent.promise;
            return complete(tool('activate-b', 'activate_card', { card_id: sibling.id }));
          }
          if (parentCalls === 3) return complete(tool('edit-a', 'edit_card', { card_id: failedChild.id, title: 'A changed' }));
          if (parentCalls === 4) return complete(tool('retry-a', 'activate_card', { card_id: failedChild.id }));
          return new Promise<ProviderTurnCompletion>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        }
        if (input.sessionId === `executor:${failedChild.id}`) {
          failedChildCalls += 1;
          if (failedChildCalls === 1) {
            failedRunningVersion = cards.read(failedChild.id)!.version_seq;
            throw permanentFailure(input);
          }
          if (failedChildCalls === 2) return complete(tool('write-a', 'write', { path: 'record:///status.md?v=next', content: 'Retry succeeded.' }));
          return complete(tool('done-a', 'emit_result', { status: 'done', summary: 'A succeeded on retry.' }));
        }
        if (input.sessionId === `executor:${sibling.id}`) {
          siblingCalls += 1;
          if (siblingCalls === 1) {
            siblingAdmitted.resolve();
            await releaseSibling.promise;
            return complete(tool('write-b', 'write', { path: 'record:///status.md?v=next', content: 'B complete.' }));
          }
          return complete(tool('done-b', 'emit_result', { status: 'done', summary: 'B complete.' }));
        }
        throw new Error(`Unexpected provider session '${input.sessionId}'.`);
      }),
    };
    supervisor = runtime(projectRoot, cards, provider);
    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('Run was not accepted.');
    supervisor.launchStartedProject(prepared.state);
    await parentAfterFailure.promise;

    const internals = supervisor as unknown as RuntimeInternals;
    const failed = cards.read(failedChild.id)!;
    expect(failed).toMatchObject({ status: 'failed', version_seq: failedRunningVersion + 1, lifecycle: { result: { kind: 'failed', summary: expect.stringContaining('authentication failed permanently') }, error: expect.stringContaining('authentication failed permanently') } });
    expect(failureToolResult).toEqual({ success: true, data: { card_id: failedChild.id, outcome: 'failed', summary: expect.stringContaining('authentication failed permanently'), result: { kind: 'failed', summary: expect.stringContaining('authentication failed permanently') } } });
    expect(internals.cardActors.has(failedChild.id)).toBe(false);
    expect(internals.liveCardActors.has(failedChild.id)).toBe(false);
    expect(history(cards, failedChild.id).filter((entry) => entry.change_reason === 'terminal lifecycle commit')).toHaveLength(1);

    const retryActor = internals.cardActor(failedChild.id);
    const activate = jest.spyOn(retryActor, 'activate');
    const awaitSettlement = jest.spyOn(retryActor, 'awaitSettlement');
    const plannerTools = createPlannerControlProvider({ projectRoot, parentCardId: parent.id, sessionId: `planner:${parent.id}`, store: cards, children: { get: (cardId) => cardId === failedChild.id ? retryActor : internals.cardActor(cardId) }, cancelCard: (cardId, reason) => supervisor.cancelCard(cardId, reason), appLogs: testAppLogs(projectRoot) });
    await expect(invokeTool({ role: 'planner', tools: new Map(plannerTools.tools.map((definition) => [definition.name, definition])), providers: [plannerTools] }, 'activate_card', { card_id: failedChild.id })).resolves.toEqual({ success: false, error: `Card '${failedChild.id}' in status 'failed' is not activatable.` });
    expect(activate).toHaveBeenCalledTimes(1);
    expect(awaitSettlement).not.toHaveBeenCalled();

    continueParent.resolve();
    await siblingAdmitted.promise;
    const runningChain = selectRunningCardChain(cards.list()).map((card) => card.id);
    expect(runningChain).toEqual(['project', parent.id, sibling.id]);
    expect(cards.read(failedChild.id)?.status).toBe('failed');
    expect(internals.liveCardActors.has(failedChild.id)).toBe(false);
    expect(internals.liveCardActors.get(sibling.id)?.cardId).toBe(sibling.id);
    const cardProjection = new CardsReadModelService(projectRoot, cards, supervisor).getCard(failedChild.id).body as { card: { status: string } };
    expect(cardProjection.card.status).toBe('failed');
    expect(supervisor.getActorRuntimeReadModel().cards.some((card) => card.cardId === failedChild.id && card.actorState === 'running')).toBe(false);

    releaseSibling.resolve();
    await waitUntil(() => cards.read(failedChild.id)?.status === 'done');
    expect(cards.read(failedChild.id)).toMatchObject({ title: 'A changed', status: 'done', lifecycle: { result: { kind: 'done', summary: 'A succeeded on retry.' } } });
    expect(activate).toHaveBeenCalledTimes(2);
    expect(awaitSettlement).not.toHaveBeenCalled();
    expect(failedChildCalls).toBe(3);
    expect(history(cards, failedChild.id).filter((entry) => entry.change_reason === 'terminal lifecycle commit')).toHaveLength(2);
    await expect(supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
  });

  it('selects cleanup failure after accepted executor terminal handling as the only terminal publication', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-cleanup-failure-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Cleanup', brief: 'Fail cleanup', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running');
    cards.setStatus(child.id, 'running');
    const runningVersion = cards.read(child.id)!.version_seq;
    const processRunner = new ProcessRunner(projectRoot, new ManagedProcessGroupRegistry());
    jest.spyOn(processRunner, 'terminateScopeTree').mockImplementation(async ({ rootScope }) => rootScope === processRunner.runtimeRootScope
      ? { selected: [], stopped: [], failed: [] }
      : { selected: ['cleanup'], stopped: [], failed: [{ groupId: 'cleanup', state: 'unconfirmed', diagnostic: 'cleanup exploded' }] });
    let executorCalls = 0;
    const provider = { completeTurn: jest.fn(async (input: LlmInvocationInput, signal: AbortSignal) => {
      if (input.role === 'executor') return complete(++executorCalls === 1
        ? tool('write', 'write', { path: 'record:///status.md?v=next', content: 'Accepted output.' })
        : tool('accepted', 'emit_result', { status: 'done', summary: 'Accepted before cleanup.' }));
      return new Promise<ProviderTurnCompletion>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }) };
    const supervisor = runtime(projectRoot, cards, provider, processRunner);
    const prepared = await supervisor.beginStartProject();
    if (!prepared.accepted) throw new Error('Run was not accepted.');
    supervisor.launchStartedProject(prepared.state);
    await waitUntil(() => cards.read(child.id)?.status === 'failed');

    expect(cards.read(child.id)).toMatchObject({ status: 'failed', version_seq: runningVersion + 1, lifecycle: { result: { kind: 'failed', summary: 'cleanup: unconfirmed: cleanup exploded' }, error: 'cleanup: unconfirmed: cleanup exploded' } });
    expect(history(cards, child.id).filter((entry) => entry.change_reason === 'terminal lifecycle commit')).toHaveLength(1);
    expect(cards.readRecord(child.id, 'status.md', 'latest').artifact.content).toBe('Accepted output.');
    expect(() => cards.readRecord(child.id, 'status.md', 'open')).toThrow();
    const terminalRows = readConversation(projectRoot, `executor:${child.id}`).physicalRows.filter((row) => row.tool_call_id === 'accepted');
    expect(terminalRows).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'tool_result', content: JSON.stringify({ success: true, data: { accepted: true } }) })]));
    expect((supervisor as unknown as RuntimeInternals).cardActors.has(child.id)).toBe(false);
    expect((supervisor as unknown as RuntimeInternals).liveCardActors.has(child.id)).toBe(false);
    await expect(supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: false });
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
    supervisor.launchStartedProject(prepared.state);
    await waitUntil(() => supervisor.getStatus().status === 'stopped');

    expect(cards.read('project')).toMatchObject({ status: 'failed', version_seq: runningVersion + 1, lifecycle: { result: { kind: 'failed', summary: expect.stringContaining('failed without ProviderTurnFailure metadata') }, error: expect.stringContaining('failed without ProviderTurnFailure metadata') } });
    expect(history(cards, 'project').filter((entry) => entry.change_reason === 'terminal lifecycle commit')).toHaveLength(1);
    expect((supervisor as unknown as RuntimeInternals).cardActors.size).toBe(0);
    expect((supervisor as unknown as RuntimeInternals).liveCardActors.size).toBe(0);
    consoleError.mockRestore();
  });
});
