import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initProjectTree } from '../../helpers/canonical-project.js';
import { testAppLogs } from '../../helpers/app-logs.js';
import { createTestPromptTemplateRegistry } from '../../helpers/prompt-template-registry.js';
import { testAutonomousCompaction } from '../../helpers/llm-test-helpers.js';
import { CardService } from '../../../src/cards/card-service.js';
import { PlanningCardProcessorActor } from '../../../src/runtime/actors/planning-card-processor-actor.js';
import type { LLMProviderPort } from '../../../src/runtime/actors/llm-actor.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import type { LlmCompleteResult, ProviderTurnCompletion } from '../../../src/agents/llm-contracts.js';
import { readConversation } from '../../../src/persistence/conversation-file.js';

const roots: string[] = [];
const CHILD = 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function complete(result: LlmCompleteResult): ProviderTurnCompletion { return { result, provider_exchanges: [] }; }
function tool(id: string, name: string, args: object): LlmCompleteResult { return { kind: 'tool_calls', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }; }
async function waitUntil(predicate: () => boolean): Promise<void> { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } throw new Error('condition not reached'); }

describe('reviewer pending-notification deferral and semantic currentness', () => {
  it.each(['done', 'blocked', 'failed', 'rework'] as const)('defers reviewer %s under both current and stale fingerprints, discards draft, and returns context only to planner', async (reviewStatus) => {
    for (const stale of [false, true]) {
      const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-review-deferral-'));
      roots.push(projectRoot);
      initProjectTree(projectRoot);
      const store = new CardService(projectRoot);
      const child = store.create({ type: 'code', parent: 'project', title: 'Child', brief: 'Work', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
      store.setStatus(child.id, 'running');
      store.commitTerminalLifecyclePatch(child.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'child done' }, error: null, completed_at: '2026-07-15T00:00:00.000Z' } });
      const preexisting = store.openRecord('project', 'review.md');
      store.editRecord('project', 'review.md', preexisting.version, 'obsolete draft');
      let plannerCalls = 0;
      let reviewerCalls = 0;
      let releaseReview!: () => void;
      let freshPlannerObserved = false;
      const provider: LLMProviderPort = { completeTurn: jest.fn(async (input: LlmInvocationInput, signal: AbortSignal) => {
        if (input.role === 'planner') {
          plannerCalls += 1;
          if (plannerCalls === 1) return complete(tool('write-status', 'write', { path: 'record:///status.md?v=next', content: 'Ready for review.' }));
          if (plannerCalls === 2) return complete(tool('planner-done', 'emit_result', { status: 'done', summary: 'Review.' }));
          freshPlannerObserved = true;
          return new Promise<ProviderTurnCompletion>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        }
        reviewerCalls += 1;
        if (reviewerCalls === 1) {
          expect(() => store.readRecord('project', 'review.md', 'open')).toThrow();
          return complete(tool('write-review', 'write', { path: 'record:///review.md?v=next', content: 'Fresh review.' }));
        }
        return new Promise<ProviderTurnCompletion>((resolve) => { releaseReview = () => resolve(complete(tool('review-result', 'emit_result', { status: reviewStatus, summary: `candidate ${reviewStatus}` }))); });
      }) };
      const actor = new PlanningCardProcessorActor({ projectRoot, cardId: 'project', store, children: { get: () => null }, cancelCard: async () => { throw new Error('unused'); }, provider, conversations: { projectRoot }, appLogs: testAppLogs(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), runtimeProjectionChanged: () => undefined, ...testAutonomousCompaction });
      const controller = new AbortController();
      const activation = (actor as unknown as { runActivation(input: unknown, signal: AbortSignal): Promise<unknown> }).runActivation({ activationId: 'activation', card: store.read('project')!, caller: { kind: 'root' }, notificationDelivery: { selectNotifications: () => [...store.read('project')!.pending_notifications], removeNotifications: (ids: readonly string[]) => store.removeNotifications('project', [...ids]) }, claimResult: jest.fn() }, controller.signal);
      await waitUntil(() => typeof releaseReview === 'function');
      if (stale) store.setStatus(child.id, 'changed');
      store.enqueueNotification('project', { id: `n-${reviewStatus}-${stale}`, content: `operator context ${reviewStatus} ${stale}`, created_at: '2026-07-15T00:00:01.000Z' });
      releaseReview();
      await waitUntil(() => freshPlannerObserved);

      const reviewerRows = readConversation(projectRoot, 'reviewer:project').physicalRows;
      const deferral = reviewerRows.find((row) => row.kind === 'tool_result' && row.tool_call_id === 'review-result')!;
      expect(JSON.parse(deferral.content)).toMatchObject({ success: false, data: { reason: 'pending_notifications' } });
      expect(reviewerRows.some((row) => row.content.includes(`operator context ${reviewStatus} ${stale}`))).toBe(false);
      expect(readConversation(projectRoot, 'planner:project').physicalRows.some((row) => row.content === `operator context ${reviewStatus} ${stale}`)).toBe(true);
      expect(() => store.readRecord('project', 'review.md', 'open')).toThrow();
      expect(store.read('project')).toMatchObject({ status: 'backlog', pending_notifications: [] });
      controller.abort(new Error('test complete'));
      await activation.catch(() => undefined);
    }
  });

  it('ignores notification-only churn but repeatedly detects semantic card changes without a retry counter', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-review-fingerprint-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const store = new CardService(projectRoot);
    const child = store.create({ type: 'code', parent: 'project', title: 'Child', brief: 'Work', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: 'project', store, children: { get: () => null }, cancelCard: async () => { throw new Error('unused'); }, provider: { completeTurn: jest.fn() as never }, conversations: { projectRoot }, appLogs: testAppLogs(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), runtimeProjectionChanged: () => undefined, ...testAutonomousCompaction });
    const internal = actor as unknown as { captureReviewerCurrentness(input: { card: ReturnType<CardService['read']> }): unknown; reviewerCurrentnessStaleReason(input: { card: ReturnType<CardService['read']> }, snapshot: unknown): string | null };
    const input = { card: store.read('project') };
    const snapshot = internal.captureReviewerCurrentness(input);
    store.enqueueNotification(child.id, { id: 'notification-only', content: 'context', created_at: '2026-07-15T00:00:00.000Z' });
    expect(internal.reviewerCurrentnessStaleReason(input, snapshot)).toBeNull();
    store.mutateCard(child.id, { title: 'first semantic edit' }, { actor: 'analyst', surface: 'web-chat', reason: 'edit 1' });
    expect(internal.reviewerCurrentnessStaleReason(input, snapshot)).toContain('changed during review');
    const refreshed = internal.captureReviewerCurrentness(input);
    store.mutateCard(child.id, { title: 'second semantic edit' }, { actor: 'analyst', surface: 'web-chat', reason: 'edit 2' });
    expect(internal.reviewerCurrentnessStaleReason(input, refreshed)).toContain('changed during review');
    expect(JSON.stringify(store.read('project'))).not.toMatch(/review.*retr|rework.*count/i);
  });

  it('detects a descendant parent-owned child reorder in an ancestor review snapshot', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-review-order-fingerprint-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const store = new CardService(projectRoot);
    const parent = store.create({ type: 'goal', parent: 'project', title: 'Parent', brief: 'Plan', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const first = store.create({ type: 'code', parent: parent.id, title: 'First', brief: 'Work', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const second = store.create({ type: 'code', parent: parent.id, title: 'Second', brief: 'Work', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const actor = new PlanningCardProcessorActor({ projectRoot, cardId: 'project', store, children: { get: () => null }, cancelCard: async () => { throw new Error('unused'); }, provider: { completeTurn: jest.fn() as never }, conversations: { projectRoot }, appLogs: testAppLogs(projectRoot), promptTemplates: createTestPromptTemplateRegistry(), runtimeProjectionChanged: () => undefined, ...testAutonomousCompaction });
    const internal = actor as unknown as { captureReviewerCurrentness(input: { card: ReturnType<CardService['read']> }): unknown; reviewerCurrentnessStaleReason(input: { card: ReturnType<CardService['read']> }, snapshot: unknown): string | null };
    const input = { card: store.read('project') };
    const snapshot = internal.captureReviewerCurrentness(input);

    expect(store.reorderChildren(parent.id, [second.id, first.id], { actor: 'planner', surface: 'runtime', reason: 'review currentness test' })).toEqual({ ok: true, changed: 2 });
    expect(internal.reviewerCurrentnessStaleReason(input, snapshot)).toContain('changed during review');
  });
});
