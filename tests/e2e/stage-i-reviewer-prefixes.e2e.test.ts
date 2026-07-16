import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../../src/cards/card-service.js';
import { PlanningCardProcessorActor } from '../../src/runtime/actors/planning-card-processor-actor.js';
import { RuntimeGate } from '../../src/runtime/runtime-gate.js';
import { RuntimeStoppedInterruption } from '../../src/runtime/actors/runtime-stopped-interruption.js';
import { stabilizeRoleSession } from '../../src/runtime/actors/conversation-recovery.js';
import type { LLMProviderPort } from '../../src/runtime/actors/llm-actor.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import type { LlmCompleteResult, ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { testAppLogs } from '../helpers/app-logs.js';
import { createTestPromptTemplateRegistry } from '../helpers/prompt-template-registry.js';

const roots: string[] = [];
const CHILD = '11111111-1111-4111-8111-111111111111';
afterEach(() => { jest.restoreAllMocks(); while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function complete(result: LlmCompleteResult): ProviderTurnCompletion { return { result, provider_exchanges: [] }; }
function tool(id: string, name: string, args: object): LlmCompleteResult { return { kind: 'tool_calls', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }; }
async function waitUntil(predicate: () => boolean): Promise<void> { for (let attempt = 0; attempt < 300; attempt += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } throw new Error('condition not reached'); }

function setup(reviewStatus: 'done' | 'blocked' | 'failed' | 'rework') {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-review-prefix-race-'));
  roots.push(projectRoot);
  initProjectTree(projectRoot);
  const cards = new CardService(projectRoot, undefined, undefined, () => CHILD);
  const child = cards.create({ type: 'code', parent: 'project', depth: 1, title: 'Child', brief: 'Work', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
  cards.setStatus(child.id, 'running');
  cards.commitTerminalLifecyclePatch(child.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'child done' }, error: null, completed_at: '2026-07-16T00:00:00.000Z' } });
  const gate = new RuntimeGate();
  let plannerCalls = 0;
  let reviewerCalls = 0;
  let releaseReviewer!: () => void;
  const provider: LLMProviderPort = { completeTurn: jest.fn(async (input: LlmInvocationInput, signal: AbortSignal) => {
    if (input.role === 'planner') {
      plannerCalls += 1;
      if (plannerCalls === 1) return complete(tool('write-status', 'write', { path: 'record:///status.md?v=next', content: 'Ready.' }));
      if (plannerCalls === 2) return complete(tool('planner-done', 'emit_result', { status: 'done', summary: 'Review.' }));
      return new Promise<ProviderTurnCompletion>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    reviewerCalls += 1;
    if (reviewerCalls === 1) return complete(tool('write-review', 'write', { path: 'record:///review.md?v=next', content: 'Review draft.' }));
    return new Promise<ProviderTurnCompletion>((resolve) => { releaseReviewer = () => resolve(complete(tool('review-result', 'emit_result', { status: reviewStatus, summary: reviewStatus }))); });
  }) };
  const actor = new PlanningCardProcessorActor({ projectRoot, cardId: 'project', store: cards, children: { get: () => null }, cancelCard: async () => { throw new Error('unused'); }, provider, conversations: { projectRoot }, appLogs: testAppLogs(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), gate, runtimeProjectionChanged: () => undefined });
  actor.start();
  const controller = new AbortController();
  const activation = actor.activate({ activationId: 'activation', card: cards.read('project')!, caller: { kind: 'root' }, claimResult: jest.fn(), notificationDelivery: { selectNotifications: () => [...cards.read('project')!.pending_notifications], removeNotifications: (ids) => cards.removeNotifications('project', [...ids]) } }, controller.signal);
  return { projectRoot, cards, gate, provider, controller, activation, releaseReviewer: () => releaseReviewer(), ready: () => typeof releaseReviewer === 'function', plannerCalls: () => plannerCalls };
}

describe('reviewer deferral crash prefixes and Pause races', () => {
  it('faults after draft discard but before reviewer result and recovers only the unmatched session call', async () => {
    const scenario = setup('done');
    await waitUntil(scenario.ready);
    scenario.cards.enqueueNotification('project', { id: 'prefix-discard', content: 'new context', created_at: '2026-07-16T00:00:01.000Z' });
    const original = scenario.cards.discardRecord.bind(scenario.cards);
    jest.spyOn(scenario.cards, 'discardRecord').mockImplementation((...args) => {
      const result = original(...args);
      if (args[3] === 'notification_deferred') throw new Error('injected crash after discard');
      return result;
    });
    scenario.releaseReviewer();
    await scenario.activation.catch(() => undefined);

    expect(() => scenario.cards.readRecord('project', 'review.md', 'open')).toThrow();
    const beforeRecovery = readConversation(scenario.projectRoot, 'reviewer:project');
    expect(beforeRecovery.some((row) => row.tool_call_id === 'review-result' && row.kind === 'tool_result')).toBe(false);
    expect(scenario.cards.read('project')!.pending_notifications).toHaveLength(1);
    const recovered = stabilizeRoleSession({ projectRoot: scenario.projectRoot, sessionId: 'reviewer:project', conversations: { projectRoot: scenario.projectRoot }, terminalToolNames: new Set(['emit_result']) });
    expect(recovered.interrupted).toBe(true);
    expect(JSON.parse(readConversation(scenario.projectRoot, 'reviewer:project').at(-1)!.content)).toMatchObject({ success: false, data: { outcome_unknown: true } });
  });

  it.each(['done', 'blocked', 'failed', 'rework'] as const)('completes reviewer %s discard/result while Pause defers fresh planner provider admission', async (status) => {
    const scenario = setup(status);
    await waitUntil(scenario.ready);
    scenario.cards.enqueueNotification('project', { id: `pause-${status}`, content: `context ${status}`, created_at: '2026-07-16T00:00:01.000Z' });
    scenario.gate.requestPause(() => undefined);
    scenario.releaseReviewer();
    await waitUntil(() => readConversation(scenario.projectRoot, 'reviewer:project').some((row) => row.tool_call_id === 'review-result' && row.kind === 'tool_result'));
    await waitUntil(() => scenario.cards.read('project')!.pending_notifications.length === 0);

    const reviewerRows = readConversation(scenario.projectRoot, 'reviewer:project');
    expect(JSON.parse(reviewerRows.find((row) => row.tool_call_id === 'review-result' && row.kind === 'tool_result')!.content)).toMatchObject({ success: false, data: { reason: 'pending_notifications' } });
    expect(() => scenario.cards.readRecord('project', 'review.md', 'open')).toThrow();
    expect(scenario.plannerCalls()).toBe(2);
    expect(stabilizeRoleSession({ projectRoot: scenario.projectRoot, sessionId: 'reviewer:project', conversations: { projectRoot: scenario.projectRoot }, terminalToolNames: new Set(['emit_result']) }).interrupted).toBe(false);

    scenario.gate.open();
    await waitUntil(() => scenario.plannerCalls() === 3);
    scenario.controller.abort(new RuntimeStoppedInterruption());
    await scenario.activation.catch(() => undefined);
  });
});
