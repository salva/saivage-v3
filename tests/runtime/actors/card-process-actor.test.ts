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
import { cardProcessesSchema } from '../../../src/agents/config-schema.js';
import { DEFAULT_CARD_PROCESSES } from '../../../src/agents/default-card-processes.js';
import { compileCardProcesses, type CompiledCardProcess } from '../../../src/runtime/card-process/card-process-config.js';

const tool = (id: string, outcome: string, summary = outcome): ProviderTurnCompletion => ({ result: { kind: 'tool_calls', tool_calls: [{ id, type: 'function', function: { name: 'emit_result', arguments: JSON.stringify({ outcome, summary }) } }] }, provider_exchanges: [] });

describe('CardProcessActor configured graph execution', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function harness(completeTurn: LLMProviderPort['completeTurn'], options: { cardType?: 'project' | 'code'; process?: CompiledCardProcess } = {}) {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-card-process-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const store = new CardService(projectRoot);
    const cardId = options.cardType === 'code'
      ? store.create({ type: 'code', parent: 'project', title: 'code', brief: 'code', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] }).id
      : 'project';
    const processRunner = createTestProcessRunner(projectRoot);
    const actor = new CardProcessActor({
      projectRoot, cardId, process: options.process ?? (options.cardType === 'code' ? testAutonomousCompaction.cardProcesses.terminal : testAutonomousCompaction.cardProcesses.planning),
      store, children: { get: () => null }, ownerStructuralWait: { begin: (relationship) => relationship, end: () => undefined },
      cancelCard: async () => { throw new Error('unused'); }, provider: { completeTurn }, conversations: { projectRoot }, appLogs: { projectRoot },
      processRunner, promptTemplates: { render: (_type, _role, values) => String(values.contractDescription) },
      runtimeProjectionChanged: () => undefined, ...testAutonomousCompaction,
    });
    actor.start();
    const claimResult = jest.fn();
    const input = () => ({ activationId: 'activation-test', card: store.read(cardId)!, caller: { kind: 'root' as const }, entry: 'BACKLOG' as const, claimResult, alreadyStabilizedRoles: new Set<'planner' | 'reviewer' | 'executor'>(), notificationDelivery: { selectNotifications: () => store.read(cardId)!.pending_notifications, removeNotifications: (ids: readonly string[]) => { store.removeNotifications(cardId, [...ids]); } } });
    return { projectRoot, cardId, store, processRunner, actor, claimResult, input };
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

  it.each([
    ['array', []], ['null', null], ['unknown field', { outcome: 'complete_direct', summary: 'ready', extra: true }],
    ['non-string outcome', { outcome: 1, summary: 'ready' }], ['unknown outcome', { outcome: 'unknown', summary: 'ready' }],
    ['empty summary', { outcome: 'complete_direct', summary: '  ' }], ['overlong summary', { outcome: 'complete_direct', summary: 'x'.repeat(2001) }],
    ['non-string summary', { outcome: 'complete_direct', summary: 1 }],
  ])('repairs parsed emit_result %s without re-entering the node', async (_label, invalid) => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      if (calls === 1) { const open = h.store.openRecord('project', 'status.md'); h.store.editRecord('project', 'status.md', open.version, 'ready'); return { result: { kind: 'tool_calls', tool_calls: [{ id: 'invalid', type: 'function', function: { name: 'emit_result', arguments: JSON.stringify(invalid) } }] }, provider_exchanges: [] }; }
      return tool('valid', 'complete_direct');
    });
    await expect(h.actor.activate(h.input(), new AbortController().signal)).resolves.toMatchObject({ status: 'done' });
    expect(calls).toBe(2);
    expect(readConversation(h.projectRoot, 'planner:project').sourceRows.filter((row) => row.kind === 'activity' && row.content.includes('activation_open'))).toHaveLength(1);
  });

  it.each(['reviewer', 'executor'] as const)('delivers candidate-gate notifications and continues the same %s node', async (role) => {
    let roleCalls = 0;
    const h = harness(async (input) => {
      if (input.role === 'planner') {
        const open = h.store.openRecord(h.cardId, 'status.md'); h.store.editRecord(h.cardId, 'status.md', open.version, 'ready');
        return tool('to-review', 'admit_review');
      }
      roleCalls += 1;
      if (roleCalls === 1) {
        const open = h.store.openRecord(h.cardId, role === 'reviewer' ? 'review.md' : 'status.md');
        h.store.editRecord(h.cardId, role === 'reviewer' ? 'review.md' : 'status.md', open.version, 'ready');
        h.store.enqueueNotification(h.cardId, { id: `${role}-late`, content: `${role} late context`, created_at: '2026-07-18T00:00:00.000Z' });
      }
      return tool(`${role}-${roleCalls}`, role === 'reviewer' ? 'approved' : 'done');
    }, role === 'executor' ? { cardType: 'code' } : {});
    await expect(h.actor.activate(h.input(), new AbortController().signal)).resolves.toMatchObject({ status: 'done' });
    expect(roleCalls).toBe(2);
    expect(h.store.read(h.cardId)!.pending_notifications).toEqual([]);
    const rows = readConversation(h.projectRoot, `${role}:${h.cardId}`).sourceRows;
    expect(rows.some((row) => row.kind === 'tool_result' && row.content.includes('pending_notifications'))).toBe(true);
    expect(rows.filter((row) => row.kind === 'activity' && row.content.includes('activation_open'))).toHaveLength(1);
  });

  it('routes two same-role executor nodes with one stable session and distinct node cleanup scopes', async () => {
    const source = cardProcessesSchema.parse({
      planning: DEFAULT_CARD_PROCESSES.planning,
      terminal: { entries: { BACKLOG: { node: 'implement' }, CHANGED: { node: 'implement' }, BLOCKED: { node: 'implement' }, STOPPED: { node: 'implement', prompt: 'stopped-recovery' } }, nodes: {
        implement: { role: 'executor', prompt: 'implement', correction_prompt: 'correct-execution-result', records: [{ name: 'status.md', updated: true }], edges: { implementation_ready: { target: { node: 'verify' }, prompt: 'implementation-to-verification' }, blocked: { target: { terminal: 'BLOCKED' } }, failed: { target: { terminal: 'FAILED' } } } },
        verify: { role: 'executor', prompt: 'verify', correction_prompt: 'correct-execution-result', records: [{ name: 'status.md', updated: true }], edges: { verified: { target: { terminal: 'DONE' } }, blocked: { target: { terminal: 'BLOCKED' } }, failed: { target: { terminal: 'FAILED' } } } },
      } },
    });
    const process = compileCardProcesses(source).terminal;
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      if (calls === 2) expect(h.claimResult).not.toHaveBeenCalled();
      const open = h.store.openRecord(h.cardId, 'status.md'); h.store.editRecord(h.cardId, 'status.md', open.version, `node ${calls}`);
      return tool(`node-${calls}`, calls === 1 ? 'implementation_ready' : 'verified');
    }, { cardType: 'code', process });
    const createScope = jest.spyOn(h.processRunner, 'createDirectScope');
    const cleanup = jest.spyOn(h.processRunner, 'terminateScopeTree');
    await expect(h.actor.activate(h.input(), new AbortController().signal)).resolves.toMatchObject({ status: 'done' });
    const rows = readConversation(h.projectRoot, `executor:${h.cardId}`).sourceRows;
    expect(rows.filter((row) => row.kind === 'activity' && row.content.includes('activation_open'))).toHaveLength(2);
    expect(rows.some((row) => row.role === 'user' && row.content.includes('Previous process node: implement'))).toBe(true);
    expect(createScope.mock.calls.map(([, ownerId]) => ownerId)).toEqual(['card-activation:activation-test:node:0', 'card-activation:activation-test:node:1']);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(h.claimResult).toHaveBeenCalledTimes(1);
  });

  it('claims a terminal result before record-close failure selects the existing failed outcome', async () => {
    const h = harness(async () => {
      const open = h.store.openRecord('project', 'status.md'); h.store.editRecord('project', 'status.md', open.version, 'ready');
      return tool('accepted-before-close', 'complete_direct');
    });
    jest.spyOn(h.store, 'closeRecord').mockImplementation(() => { throw new Error('close failed after claim'); });
    await expect(h.actor.activate(h.input(), new AbortController().signal)).resolves.toMatchObject({ status: 'failed', summary: 'close failed after claim' });
    expect(h.claimResult).toHaveBeenCalledTimes(1);
    expect(h.store.readRecord('project', 'status.md', 'open').artifact.content).toBe('ready');
  });
});
