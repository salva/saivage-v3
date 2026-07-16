import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initProjectTree, CardService as TestCardService } from '../../helpers/canonical-project.js';
import { CardService } from '../../../src/cards/card-service.js';
import { testAppLogs } from '../../helpers/app-logs.js';
import { createTestPromptTemplateRegistry } from '../../helpers/prompt-template-registry.js';
import { createTestProcessRunner } from '../../helpers/test-process-runner.js';
import { PlanningCardProcessorActor } from '../../../src/runtime/actors/planning-card-processor-actor.js';
import { TerminalCardProcessorActor } from '../../../src/runtime/actors/terminal-card-processor-actor.js';
import type { LLMProviderPort } from '../../../src/runtime/actors/llm-actor.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import type { LlmCompleteResult, ProviderTurnCompletion } from '../../../src/agents/llm-contracts.js';
import { readConversation } from '../../../src/persistence/conversation-file.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';

const roots: string[] = [];
const CARD = '11111111-1111-4111-8111-111111111111';

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'saivage-terminal-retained-'));
  roots.push(value);
  initProjectTree(value);
  return value;
}

function complete(result: LlmCompleteResult): ProviderTurnCompletion { return { result, provider_exchanges: [] }; }
function tool(id: string, name: string, args: object): LlmCompleteResult {
  return { kind: 'tool_calls', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}
function delivery(store: CardService, cardId: string) {
  return {
    selectNotifications: () => [...store.read(cardId)!.pending_notifications],
    removeNotifications: (ids: readonly string[]) => store.removeNotifications(cardId, [...ids]),
  };
}

describe('retained terminal ordering and notification arbitration', () => {
  it('claims and terminalizes a childless planning card after record close and canonical success', async () => {
    const projectRoot = root();
    const store = new TestCardService(projectRoot);
    const project = store.read('project')!;
    const order: string[] = [];
    const close = jest.spyOn(store, 'closeRecord').mockImplementation((...args) => { order.push('record'); return Reflect.apply(Object.getPrototypeOf(store).closeRecord, store, args) as never; });
    const commit = jest.spyOn(store, 'commitTerminalLifecyclePatch').mockImplementation((...args) => { order.push('card'); return Reflect.apply(Object.getPrototypeOf(store).commitTerminalLifecyclePatch, store, args) as never; });
    let call = 0;
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => complete(++call === 1
      ? tool('write-status', 'write', { path: 'record:///status.md?v=next', content: 'Ready.' })
      : tool('emit-done', 'emit_result', { status: 'done', summary: 'Complete.' }))) };
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: 'project', store, children: { get: () => null }, cancelCard: async () => { throw new Error('unused'); }, provider, conversations: { projectRoot }, appLogs: testAppLogs(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), runtimeProjectionChanged: () => undefined });
    actor.start();
    const claimResult = jest.fn(() => order.push('claim'));

    await expect(actor.activate({ activationId: 'activation', card: project, caller: { kind: 'root' }, notificationDelivery: delivery(store, 'project'), claimResult }, new AbortController().signal)).resolves.toMatchObject({ status: 'done', result: { kind: 'done' } });

    expect(order).toEqual(['claim', 'record', 'card']);
    expect(close).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(store.read('project')).toMatchObject({ status: 'done', lifecycle: { result: { kind: 'done', summary: 'Complete.' } } });
    const rows = readConversation(projectRoot, 'planner:project').physicalRows;
    expect(rows.at(-1)).toMatchObject({ kind: 'tool_result', tool_call_id: 'emit-done', content: JSON.stringify({ success: true, data: { accepted: true } }) });
  });

  it('settles failed emit_result before notification context, removes exactly delivered entries, and parks continuation during Pause', async () => {
    const projectRoot = root();
    const store = new CardService(projectRoot, undefined, undefined, () => CARD);
    const card = store.create({ type: 'code', parent: 'project', depth: 1, title: 'Code', brief: 'Implement.', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    store.setStatus(card.id, 'running');
    const gate = new RuntimeGate();
    let releaseTerminal!: () => void;
    let calls = 0;
    const provider: LLMProviderPort = { completeTurn: jest.fn(async (_input: LlmInvocationInput) => {
      calls += 1;
      if (calls === 1) return complete(tool('write-status', 'write', { path: 'record:///status.md?v=next', content: 'Initial.' }));
      if (calls === 2) return new Promise<ProviderTurnCompletion>((resolve) => { releaseTerminal = () => resolve(complete(tool('emit-first', 'emit_result', { status: 'done', summary: 'Stale.' }))); });
      return complete(tool('emit-second', 'emit_result', { status: 'done', summary: 'Fresh.' }));
    }) };
    const actor = new TerminalCardProcessorActor({ projectRoot, cardId: card.id, store, provider, processRunner: createTestProcessRunner(projectRoot), conversations: { projectRoot }, appLogs: testAppLogs(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), gate, runtimeProjectionChanged: () => undefined });
    actor.start();
    const pending = actor.activate({ activationId: 'activation', card: store.read(card.id)!, caller: { kind: 'parent', cardId: 'project' }, notificationDelivery: delivery(store, card.id), claimResult: jest.fn() }, new AbortController().signal);
    while (!releaseTerminal) await new Promise((resolve) => setTimeout(resolve, 1));
    store.enqueueNotification(card.id, { id: 'n-before-terminal', content: 'Use the new requirement.', created_at: '2026-07-15T00:00:00.000Z' });
    gate.requestPause(() => {});
    releaseTerminal();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(provider.completeTurn).toHaveBeenCalledTimes(2);
    expect(store.read(card.id)!.pending_notifications).toEqual([]);
    const prefix = readConversation(projectRoot, `executor:${card.id}`).physicalRows;
    const failedIndex = prefix.findIndex((row) => row.tool_call_id === 'emit-first' && row.kind === 'tool_result');
    const notificationIndex = prefix.findIndex((row) => row.kind === 'text' && row.content === 'Use the new requirement.');
    expect(failedIndex).toBeGreaterThanOrEqual(0);
    expect(notificationIndex).toBeGreaterThan(failedIndex);
    expect(JSON.parse(prefix[failedIndex]!.content)).toMatchObject({ success: false, data: { reason: 'pending_notifications' } });

    gate.open();
    await expect(pending).resolves.toMatchObject({ status: 'done', summary: 'Fresh.' });
    expect(provider.completeTurn).toHaveBeenCalledTimes(3);
    expect(store.read(card.id)).toMatchObject({ status: 'done', lifecycle: { result: { kind: 'done', summary: 'Fresh.' } } });
  });
});
