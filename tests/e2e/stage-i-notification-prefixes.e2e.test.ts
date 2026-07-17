import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../../src/cards/card-service.js';
import { PlanningCardProcessorActor } from '../../src/runtime/actors/planning-card-processor-actor.js';
import { TerminalCardProcessorActor } from '../../src/runtime/actors/terminal-card-processor-actor.js';
import { RuntimeGate } from '../../src/runtime/runtime-gate.js';
import type { LLMProviderPort } from '../../src/runtime/actors/llm-actor.js';
import type { LlmCompleteResult, ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { testAppLogs } from '../helpers/app-logs.js';
import { createTestPromptTemplateRegistry } from '../helpers/prompt-template-registry.js';
import { testAutonomousCompaction } from '../helpers/llm-test-helpers.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import { RuntimeStoppedInterruption } from '../../src/runtime/actors/runtime-stopped-interruption.js';

const roots: string[] = [];
const CARD = '11111111-1111-4111-8111-111111111111';

afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function complete(result: LlmCompleteResult): ProviderTurnCompletion { return { result, provider_exchanges: [] }; }
function tool(id: string, name: string, args: object): LlmCompleteResult {
  return { kind: 'tool_calls', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not reached');
}

describe('planner/executor notification crash prefixes', () => {
  const cases: Array<['planner' | 'executor', 'after_failed_result' | 'after_notification_append' | 'after_exact_removal']> = [
    ['planner', 'after_failed_result'],
    ['planner', 'after_notification_append'],
    ['planner', 'after_exact_removal'],
    ['executor', 'after_failed_result'],
    ['executor', 'after_notification_append'],
    ['executor', 'after_exact_removal'],
  ];
  it.each(cases)('%s preserves the %s restart prefix without a delivery marker', async (role, prefix) => {
    const projectRoot = mkdtempSync(join(tmpdir(), `saivage-${role}-notification-prefix-`));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const cards = new CardService(projectRoot, undefined, undefined, () => CARD);
    const card = role === 'planner'
      ? cards.read('project')!
      : cards.create({ type: 'code', parent: 'project', depth: 1, title: 'Code', brief: 'Implement.', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    if (role === 'executor') cards.setStatus(card.id, 'running');

    let releaseTerminal!: () => void;
    let calls = 0;
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => {
      calls += 1;
      if (calls === 1) return complete(tool('write-status', 'write', { path: 'record:///status.md?v=next', content: 'Initial evidence.' }));
      if (calls === 2) return new Promise<ProviderTurnCompletion>((resolve) => {
        releaseTerminal = () => resolve(complete(tool('emit-stale', 'emit_result', { status: 'done', summary: 'stale result' })));
      });
      return new Promise<ProviderTurnCompletion>(() => undefined);
    }) };
    const gate = new RuntimeGate();
    const actor = role === 'planner'
      ? new PlanningCardProcessorActor({ projectRoot, cardId: card.id, store: cards, children: { get: () => null }, cancelCard: async () => { throw new Error('unused'); }, provider, conversations: { projectRoot }, appLogs: testAppLogs(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), gate, runtimeProjectionChanged: () => undefined, ...testAutonomousCompaction })
      : new TerminalCardProcessorActor({ projectRoot, cardId: card.id, store: cards, provider, processRunner: createTestProcessRunner(projectRoot), conversations: { projectRoot }, appLogs: testAppLogs(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), gate, runtimeProjectionChanged: () => undefined, ...testAutonomousCompaction });
    actor.start();
    const controller = new AbortController();
    const notification = { id: `notification-${role}-${prefix}`, content: `new ${role} context`, created_at: '2026-07-16T00:00:00.000Z' };
    let continuationSelection = false;
    const activation = actor.activate({
      activationId: 'activation',
      card: cards.read(card.id)!,
      caller: role === 'planner' ? { kind: 'root' } : { kind: 'parent', cardId: 'project' },
      claimResult: jest.fn(),
      notificationDelivery: {
        selectNotifications: () => {
          const selected = [...cards.read(card.id)!.pending_notifications];
          if (selected.length > 0) {
            continuationSelection = true;
            if (prefix === 'after_failed_result') throw new Error('injected crash after failed result');
          }
          return selected;
        },
        removeNotifications: (ids) => {
          if (prefix === 'after_notification_append') throw new Error('injected crash after notification append');
          cards.removeNotifications(card.id, [...ids]);
        },
      },
    }, controller.signal);

    await waitUntil(() => typeof releaseTerminal === 'function');
    cards.enqueueNotification(card.id, notification);
    if (prefix === 'after_exact_removal') gate.requestPause(() => undefined);
    releaseTerminal();
    await waitUntil(() => continuationSelection);
    const sessionId = `${role}:${card.id}`;
    await waitUntil(() => readConversation(projectRoot, sessionId).physicalRows.some((row) => row.tool_call_id === 'emit-stale' && row.kind === 'tool_result'));
    if (prefix === 'after_exact_removal') await waitUntil(() => cards.read(card.id)!.pending_notifications.length === 0);
    else await activation.catch(() => undefined);

    const rows = readConversation(projectRoot, sessionId).physicalRows;
    const failedIndex = rows.findIndex((row) => row.tool_call_id === 'emit-stale' && row.kind === 'tool_result');
    const notificationIndex = rows.findIndex((row) => row.kind === 'text' && row.content === notification.content);
    expect(JSON.parse(rows[failedIndex]!.content)).toMatchObject({ success: false, data: { reason: 'pending_notifications' } });
    if (prefix === 'after_failed_result') {
      expect(notificationIndex).toBe(-1);
      expect(cards.read(card.id)!.pending_notifications).toEqual([notification]);
    } else if (prefix === 'after_notification_append') {
      expect(notificationIndex).toBeGreaterThan(failedIndex);
      expect(cards.read(card.id)!.pending_notifications).toEqual([notification]);
    } else {
      expect(notificationIndex).toBeGreaterThan(failedIndex);
      expect(cards.read(card.id)!.pending_notifications).toEqual([]);
      expect(provider.completeTurn).toHaveBeenCalledTimes(2);
      controller.abort(new RuntimeStoppedInterruption());
      await activation.catch(() => undefined);
    }
    expect(rows.some((row) => /delivery.marker|notification.delivered/i.test(row.content))).toBe(false);
  });
});
