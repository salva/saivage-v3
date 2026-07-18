import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService } from '../../../src/cards/card-service.js';
import { CardProcessActor } from '../../../src/runtime/actors/card-process-actor.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import type { LLMProviderPort } from '../../../src/runtime/actors/llm-actor.js';
import type { ProviderTurnCompletion } from '../../../src/agents/llm-contracts.js';
import { initProjectTree } from '../../helpers/canonical-project.js';
import { testAutonomousCompaction } from '../../helpers/llm-test-helpers.js';
import { createTestProcessRunner } from '../../helpers/test-process-runner.js';
import { readConversation } from '../../../src/persistence/conversation-file.js';

const tool = (id: string, outcome: string, summary = outcome): ProviderTurnCompletion => ({ result: { kind: 'tool_calls', tool_calls: [{ id, type: 'function', function: { name: 'emit_result', arguments: JSON.stringify({ outcome, summary }) } }] }, provider_exchanges: [] });

describe('CardProcessActor configured graph execution', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function harness(completeTurn: LLMProviderPort['completeTurn']) {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-card-process-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const store = new CardService(projectRoot);
    const actor = new CardProcessActor({
      projectRoot, cardId: 'project', process: testAutonomousCompaction.cardProcesses.planning,
      store, children: { get: () => null }, ownerStructuralWait: { begin: (relationship) => relationship, end: () => undefined },
      cancelCard: async () => { throw new Error('unused'); }, provider: { completeTurn }, conversations: { projectRoot }, appLogs: { projectRoot },
      processRunner: createTestProcessRunner(projectRoot), promptTemplates: { render: (_type, _role, values) => String(values.contractDescription) },
      runtimeProjectionChanged: () => undefined, ...testAutonomousCompaction,
    });
    actor.start();
    const claimResult = jest.fn();
    const input = () => ({ activationId: 'activation-test', card: store.read('project')!, caller: { kind: 'root' as const }, entry: 'BACKLOG' as const, claimResult, notificationDelivery: { selectNotifications: () => store.read('project')!.pending_notifications, removeNotifications: (ids: readonly string[]) => { store.removeNotifications('project', [...ids]); } } });
    return { projectRoot, store, actor, claimResult, input };
  }

  it('routes complete_direct to DONE without reviewer and claims only after fresh status evidence', async () => {
    const roles: string[] = [];
    const h = harness(async (input) => { roles.push(input.role); const open = h.store.openRecord('project', 'status.md'); h.store.editRecord('project', 'status.md', open.version, 'complete'); return tool('plan-done', 'complete_direct'); });
    const outcome = await h.actor.activate(h.input(), new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'done', summary: 'complete_direct' });
    expect(roles).toEqual(['planner']);
    expect(h.claimResult).toHaveBeenCalledTimes(1);
    expect(h.store.readRecord('project', 'status.md', 'latest').artifact.content).toBe('complete');
  });

  it('admits reviewer with zero children and preserves role-context then transition then node-prompt order', async () => {
    const roles: string[] = [];
    const h = harness(async (input) => {
      roles.push(input.role);
      const filename = input.role === 'planner' ? 'status.md' : 'review.md';
      const open = h.store.openRecord('project', filename); h.store.editRecord('project', filename, open.version, input.role);
      return input.role === 'planner' ? tool('plan-review', 'admit_review', 'review it') : tool('review-approved', 'approved', 'approved');
    });
    const outcome = await h.actor.activate(h.input(), new AbortController().signal);
    expect(outcome.status).toBe('done');
    expect(roles).toEqual(['planner', 'reviewer']);
    expect(h.claimResult).toHaveBeenCalledTimes(1);
    const reviewerRows = readConversation(h.projectRoot, 'reviewer:project').sourceRows.filter((row) => row.role === 'user');
    expect(reviewerRows.map((row) => row.content)).toEqual([
      'Descendant work:\n(none)',
      expect.stringContaining('Previous process node: plan'),
      'test process prompt: review',
    ]);
  });

  it('captures one baseline across correction and accepts a later revision of the same open record', async () => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      const open = h.store.readRecord('project', 'status.md', 'open');
      if (calls === 2) h.store.editRecord('project', 'status.md', open.version, 'fresh revision');
      return tool(`result-${calls}`, 'complete_direct');
    });
    const preexisting = h.store.openRecord('project', 'status.md'); h.store.editRecord('project', 'status.md', preexisting.version, 'stale baseline');
    const outcome = await h.actor.activate(h.input(), new AbortController().signal);
    expect(outcome.status).toBe('done');
    expect(calls).toBe(2);
    const rows = readConversation(h.projectRoot, 'planner:project').sourceRows;
    expect(rows.some((row) => row.kind === 'tool_result' && row.content.includes('updated after this node began'))).toBe(true);
  });

  it('delivers late pending notifications with correction before exact removal and retries the same node', async () => {
    let calls = 0;
    const h = harness(async (_input: LlmInvocationInput) => {
      calls += 1;
      if (calls === 1) {
        const open = h.store.openRecord('project', 'status.md'); h.store.editRecord('project', 'status.md', open.version, 'ready');
        h.store.enqueueNotification('project', { id: 'notification-1', content: 'late operator context', created_at: '2026-07-18T00:00:00.000Z' });
      }
      return tool(`pending-${calls}`, 'complete_direct');
    });
    const outcome = await h.actor.activate(h.input(), new AbortController().signal);
    expect(outcome.status).toBe('done');
    expect(calls).toBe(2);
    expect(h.store.read('project')!.pending_notifications).toEqual([]);
    const visible = readConversation(h.projectRoot, 'planner:project').sourceRows.filter((row) => row.kind === 'tool_result' || row.role === 'user').map((row) => row.content);
    const failed = visible.findIndex((content) => content.includes('pending_notifications'));
    const notification = visible.indexOf('late operator context');
    const correction = visible.findIndex((content) => content.includes('reconsider the appended context'));
    expect(failed).toBeGreaterThanOrEqual(0); expect(notification).toBeGreaterThan(failed); expect(correction).toBeGreaterThan(notification);
    expect(h.claimResult).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale review, replaces its exact semantic snapshot, and accepts the unchanged refresh', async () => {
    let reviewerCalls = 0;
    const h = harness(async (input) => {
      if (input.role === 'planner') { const open = h.store.openRecord('project', 'status.md'); h.store.editRecord('project', 'status.md', open.version, 'ready'); return tool('to-review', 'admit_review'); }
      reviewerCalls += 1;
      const open = h.store.openRecord('project', 'review.md'); h.store.editRecord('project', 'review.md', open.version, `review ${reviewerCalls}`);
      if (reviewerCalls === 1) h.store.mutateCard('project', { title: 'Changed during review' }, { actor: 'planner', surface: 'runtime', reason: 'test semantic change' });
      return tool(`review-${reviewerCalls}`, 'approved');
    });
    await expect(h.actor.activate(h.input(), new AbortController().signal)).resolves.toMatchObject({ status: 'done' });
    expect(reviewerCalls).toBe(2);
    const rows = readConversation(h.projectRoot, 'reviewer:project').sourceRows;
    expect(rows.some((row) => row.kind === 'tool_result' && row.content.includes('Review context is stale'))).toBe(true);
    expect(rows.filter((row) => row.role === 'user' && row.content.startsWith('Descendant work:'))).toHaveLength(2);
  });

  it('repairs a strict parsed emit_result shape without re-entering the node', async () => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      if (calls === 1) { const open = h.store.openRecord('project', 'status.md'); h.store.editRecord('project', 'status.md', open.version, 'ready'); return { result: { kind: 'tool_calls', tool_calls: [{ id: 'invalid', type: 'function', function: { name: 'emit_result', arguments: JSON.stringify({ outcome: 'complete_direct', summary: 'ready', extra: true }) } }] }, provider_exchanges: [] }; }
      return tool('valid', 'complete_direct');
    });
    await expect(h.actor.activate(h.input(), new AbortController().signal)).resolves.toMatchObject({ status: 'done' });
    expect(calls).toBe(2);
    expect(readConversation(h.projectRoot, 'planner:project').sourceRows.filter((row) => row.kind === 'activity' && row.content.includes('activation_open'))).toHaveLength(1);
  });
});
