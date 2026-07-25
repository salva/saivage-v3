import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../helpers/canonical-project.js';
import { workflowResult } from '../helpers/workflow-result.js';
import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { SupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import type { LlmCompleteResult, ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { testAutonomousCompaction } from '../helpers/llm-test-helpers.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function complete(result: LlmCompleteResult): ProviderTurnCompletion { return { result, provider_exchanges: [] }; }
function tool(id: string, name: string, args: object): LlmCompleteResult { return { kind: 'tool_calls', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }; }
async function waitUntil(predicate: () => boolean): Promise<void> { for (let attempt = 0; attempt < 500; attempt += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } throw new Error('condition not reached'); }

function supervisor(projectRoot: string, cards: CardService, provider: { completeTurn(input: LlmInvocationInput, signal: AbortSignal): Promise<ProviderTurnCompletion> }): SupervisorRuntimeApi {
  const registry = new ManagedProcessGroupRegistry();
  const runtimeProcessRootScope = registry.createContainerScope(registry.rootScope, 'runtime-cards');
  return new SupervisorRuntimeApi({
    fatalPort: testApplicationFatalPort,
    ...testAutonomousCompaction,
    projectRoot,
    actorStore: cards,
    interventionBinding: new RuntimeInterventionBinding(),
    provider,
    conversations: { projectRoot },
    freshness: { runtimeChanged() {} },
    processRunner: new ProcessRunner(projectRoot, registry, testApplicationFatalPort),
    runtimeProcessRootScope,
    promptTemplates: { render: () => 'test prompt' },
  });
}

describe('Stage-I runtime lifecycle E2E', () => {
  it('parks an admitted child at Pause, resumes once, Stops without mutation, and starts a fresh activation in the same stable session on Run', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-stage-i-lifecycle-e2e-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'Execute', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running');
    cards.setStatus(child.id, 'running');
    const inputs: LlmInvocationInput[] = [];
    let releaseFirst!: () => void;
    const provider = { completeTurn: jest.fn(async (input: LlmInvocationInput, signal: AbortSignal) => {
      inputs.push(input);
      if (inputs.length === 1) return new Promise<ProviderTurnCompletion>((resolve) => { releaseFirst = () => resolve(complete(tool('write-status', 'write', { path: 'record:///status.md?v=next', content: 'work started' }))); });
      return new Promise<ProviderTurnCompletion>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }) };
    const runtime = supervisor(projectRoot, cards, provider);

    const started = await runtime.startProject();
    if (!started.started) throw new Error('Run was not accepted.');
    await waitUntil(() => inputs.length === 1);
    expect(runtime.getActorRuntimeReadModel().cards.map((entry) => entry.cardId)).toEqual(['project']);
    expect(runtime.getActorRuntimeReadModel()).not.toHaveProperty('agents');

    runtime.pause();
    releaseFirst();
    await waitUntil(() => runtime.getStatus().status === 'paused');
    expect(inputs).toHaveLength(1);
    const paused = runtime.getRuntimeState();
    if (!paused) throw new Error('Paused runtime state missing.');
    runtime.resume();
    await waitUntil(() => inputs.length === 2);
    expect(inputs[1]!.inputId).not.toBe(inputs[0]!.inputId);

    const durableBeforeStop = cards.list().map((card) => ({ id: card.id, status: card.lifecycle.status, version: card.version_seq }));
    await expect(runtime.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
    expect(cards.list().map((card) => ({ id: card.id, status: card.lifecycle.status, version: card.version_seq }))).toEqual(durableBeforeStop);

    const restarted = await runtime.startProject();
    if (!restarted.started) throw new Error('Restart Run was not accepted.');
    await waitUntil(() => inputs.length === 3);
    expect(inputs[2]!.sessionId).toBe('agent:planner:project');
    expect(inputs[2]!.inputId).not.toBe(inputs[1]!.inputId);
    expect(inputs[2]!.providerConversation.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'system', kind: 'model_recovered' })]));
    expect(readConversation(projectRoot, 'agent:planner:project').physicalRows.filter((row) => row.kind === 'model_recovered')).toHaveLength(1);
    expect(cards.read(child.id)?.lifecycle.status).toBe('stopped');
    await expect(runtime.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
  });

  it('claims a running ancestor subtree before a late terminal callback and preserves done descendants', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-stage-i-cancel-e2e-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot);
    const active = cards.create({ type: 'code', parent: 'project', title: 'Active', bootstrap_content: 'Execute', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const done = cards.create({ type: 'test', parent: 'project', title: 'Done', bootstrap_content: 'Done', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus(done.id, 'running');
    cards.commitActivationOutcome(done.id, { status: 'done', summary: 'kept', result: workflowResult('DONE','kept') }, '2026-07-16T00:00:00.000Z');
    cards.setStatus('project', 'running');
    cards.setStatus(active.id, 'running');
    let releaseTerminal!: () => void;
    let calls = 0;
    const provider = { completeTurn: jest.fn(async (_input: LlmInvocationInput, signal: AbortSignal) => {
      calls += 1;
      if (calls === 1) return complete(tool('write-status', 'write', { path: 'record:///status.md?v=next', content: 'candidate' }));
      return new Promise<ProviderTurnCompletion>((resolve, reject) => {
        releaseTerminal = () => resolve(complete(tool('emit-late', 'emit_result', { outcome: 'done', summary: 'late' })));
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }) };
    const runtime = supervisor(projectRoot, cards, provider);
    const started = await runtime.startProject();
    if (!started.started) throw new Error('Run was not accepted.');
    await waitUntil(() => typeof releaseTerminal === 'function');

    const cancellation = runtime.cancelCard('project', 'operator cancelled subtree');
    await expect(cancellation).resolves.toMatchObject({ card_id: 'project', status: 'cancelled', cancelled_card_ids: expect.arrayContaining([active.id, 'project']) });
    expect(cards.read(active.id)?.lifecycle.status).toBe('cancelled');
    expect(cards.read('project')?.lifecycle.status).toBe('cancelled');
    expect(cards.read(done.id)?.lifecycle.status).toBe('done');
    const versions = new Map(cards.list().map((card) => [card.id, card.version_seq]));
    releaseTerminal();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(new Map(cards.list().map((card) => [card.id, card.version_seq]))).toEqual(versions);
  });
});
