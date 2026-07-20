import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import * as YAML from 'yaml';
import type { LlmCompleteResult, ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import { DEFAULT_CARD_PROCESSES } from '../../src/agents/default-card-processes.js';
import { cardProcessesSchema } from '../../src/agents/config-schema.js';
import { compileCardProcesses } from '../../src/runtime/card-process/card-process-config.js';
import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js';
import { startApp, type App } from '../../src/boot/app.js';
import { CardService } from '../../src/cards/card-service.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import { stabilizeRoleSession } from '../../src/runtime/actors/conversation-recovery.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import { SupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import type { LLMProviderPort } from '../../src/runtime/actors/llm-actor.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { initProjectTree, testAnalystMutationServices } from '../helpers/canonical-project.js';
import { testAutonomousCompaction } from '../helpers/llm-test-helpers.js';

const roots: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) expect(await apps.pop()!.stop()).toEqual({ warnings: [] });
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const complete = (result: LlmCompleteResult): ProviderTurnCompletion => ({ result, provider_exchanges: [] });
const tool = (id: string, name: string, args: object): LlmCompleteResult => ({ kind: 'tool_calls', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
async function waitUntil(predicate: () => boolean): Promise<void> { for (let count = 0; count < 500; count += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } throw new Error('condition not reached'); }
async function availablePort(): Promise<number> { const probe = createNetServer(); await new Promise<void>((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).once('error', reject)); const address = probe.address(); if (!address || typeof address === 'string') throw new Error('No ephemeral port'); await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve())); return address.port; }
async function writeConfig(root: string): Promise<void> { writeFileSync(join(root, '.saivage', 'saivage.yaml'), YAML.stringify({ models: { default: ['test-model'], max_tokens: { analyst: 200 } }, providers: { test: { models: ['test-model'] } }, compaction: { enabled: true, input_budget_tokens: 1000, summarizer_candidate: { provider: 'test', account: null, model: 'test-model' } }, card_processes: DEFAULT_CARD_PROCESSES, runtime: { continuous_improvement: false }, server: { host: '127.0.0.1', port: await availablePort() } })); }

describe('configured card-process substantive E2E coverage', () => {
  it('executes cross-node and same-node reentry as live process states with ordinals 0, 1, 2', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-configured-reentry-e2e-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const configured = cardProcessesSchema.parse({
      planning: { entries: { BACKLOG: { node: 'first' }, CHANGED: { node: 'first' }, BLOCKED: { node: 'first' }, STOPPED: { node: 'first', prompt: 'stopped-recovery' } }, nodes: {
        first: { role: 'planner', prompt: 'plan', correction_prompt: 'correct-plan-result', records: [{ name: 'status.md', updated: true }], edges: { next: { target: { node: 'second' }, prompt: 'plan-to-review' } } },
        second: { role: 'planner', prompt: 'recover', correction_prompt: 'correct-plan-result', records: [{ name: 'status.md', updated: true }], edges: { again: { target: { node: 'second' }, prompt: 'review-to-plan' }, complete: { target: { terminal: 'DONE' } } } },
      } },
      terminal: DEFAULT_CARD_PROCESSES.terminal,
    });
    const positions: Array<{ stateId: string; executionOrdinal: number }> = [];
    let runtime!: SupervisorRuntimeApi;
    let calls = 0;
    const provider: LLMProviderPort = { completeTurn: jest.fn(async () => {
      calls += 1;
      const processState = runtime.getActorRuntimeReadModel().cards.find(({ cardId }) => cardId === 'project')?.processState;
      if (!processState || processState.kind !== 'node') throw new Error('Expected live node process projection.');
      positions.push({ stateId: processState.stateId, executionOrdinal: processState.executionOrdinal });
      const open = cards.openRecord('project', 'status.md'); cards.editRecord('project', 'status.md', open.version, `step ${calls}`);
      return complete(tool(`result-${calls}`, 'emit_result', { outcome: calls === 1 ? 'next' : calls === 2 ? 'again' : 'complete', summary: `step ${calls}` }));
    }) };
    runtime = new SupervisorRuntimeApi({ ...testAutonomousCompaction, cardProcesses: compileCardProcesses(configured), projectRoot: root, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(), provider, conversations: { projectRoot: root }, appLogs: { projectRoot: root }, readModelChanges: { runtimeChanged() {}, cardProjectionChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) }, processRunner: new ProcessRunner(root, new ManagedProcessGroupRegistry()), promptTemplates: { render: () => 'test prompt' } });
    const prepared = await runtime.beginStartProject(); if (!prepared.accepted) throw new Error('Run was rejected'); runtime.launchStartedProject(prepared.launch);
    await waitUntil(() => runtime.getStatus().status === 'stopped');
    expect(positions).toEqual([{ stateId: 'node:first', executionOrdinal: 0 }, { stateId: 'node:second', executionOrdinal: 1 }, { stateId: 'node:second', executionOrdinal: 2 }]);
    expect(cards.read('project')?.status).toBe('done');
  });

  it('settles and re-enters blocked configured work, then creates under the blocked planning parent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-blocked-reentry-e2e-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const goal = cards.create({ type: 'goal', parent: 'project', title: 'blocked goal', brief: 'recover blocked work', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const child = cards.create({ type: 'code', parent: goal.id, title: 'blocked implementation', brief: 'block once, then finish', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const calls = { project: 0, goal: 0, child: 0 };
    const childStatusesAtEntry: string[] = [];
    let childStatusBeforeReentry: string | null = null;
    const provider: LLMProviderPort = { completeTurn: jest.fn(async (input: LlmInvocationInput) => {
      if (input.sessionId === 'planner:project') {
        calls.project += 1;
        if (calls.project === 1) return complete(tool('activate-goal', 'activate_card', { card_id: goal.id }));
        if (calls.project === 2) return complete(tool('write-project-status', 'write', { path: 'record:///status.md?v=next', content: 'Goal remains blocked.' }));
        return complete(tool('block-project', 'emit_result', { outcome: 'blocked', summary: 'Goal remains blocked.' }));
      }
      if (input.sessionId === `planner:${goal.id}`) {
        calls.goal += 1;
        if (calls.goal === 1) return complete(tool('activate-child-first', 'activate_card', { card_id: child.id }));
        if (calls.goal === 2) { childStatusBeforeReentry = cards.read(child.id)!.status; return complete(tool('activate-child-again', 'activate_card', { card_id: child.id })); }
        if (calls.goal === 3) return complete(tool('write-goal-status', 'write', { path: 'record:///status.md?v=next', content: 'Goal is externally blocked.' }));
        return complete(tool('block-goal', 'emit_result', { outcome: 'blocked', summary: 'Goal is externally blocked.' }));
      }
      if (input.sessionId === `executor:${child.id}`) {
        calls.child += 1;
        childStatusesAtEntry.push(cards.read(child.id)!.status);
        if (calls.child === 1) return complete(tool('write-child-status-first', 'write', { path: 'record:///status.md?v=next', content: 'Waiting once.' }));
        if (calls.child === 2) return complete(tool('block-child', 'emit_result', { outcome: 'blocked', summary: 'Waiting once.' }));
        if (calls.child === 3) return complete(tool('write-child-status-second', 'write', { path: 'record:///status.md?v=next', content: 'Recovered and complete.' }));
        return complete(tool('complete-child', 'emit_result', { outcome: 'done', summary: 'Recovered and complete.' }));
      }
      throw new Error(`Unexpected provider session '${input.sessionId}'.`);
    }) };
    const runtime = new SupervisorRuntimeApi({ ...testAutonomousCompaction, projectRoot: root, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(), provider, conversations: { projectRoot: root }, appLogs: { projectRoot: root }, readModelChanges: { runtimeChanged() {}, cardProjectionChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) }, processRunner: new ProcessRunner(root, new ManagedProcessGroupRegistry()), promptTemplates: { render: () => 'test prompt' } });

    const prepared = await runtime.beginStartProject(); if (!prepared.accepted) throw new Error('Run was rejected'); runtime.launchStartedProject(prepared.launch);
    await waitUntil(() => runtime.getStatus().status === 'stopped');

    expect(calls).toEqual({ project: 3, goal: 4, child: 4 });
    expect(childStatusBeforeReentry).toBe('blocked');
    expect(childStatusesAtEntry).toEqual(['running', 'running', 'running', 'running']);
    expect(cards.read(child.id)).toMatchObject({ status: 'done', lifecycle: { result: { kind: 'done', summary: 'Recovered and complete.' } } });
    expect(cards.read(goal.id)).toMatchObject({ status: 'blocked', lifecycle: { result: { kind: 'blocked', summary: 'Goal is externally blocked.' } } });

    const later = cards.create({ type: 'test', parent: goal.id, title: 'new blocked-parent child', brief: 'new work', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    expect(later).toMatchObject({ parent: goal.id, status: 'backlog' });
    expect(cards.listChildren(goal.id)).toEqual([child.id, later.id]);
  });

  it('delivers late notifications in active executor, planner, and reviewer nodes before accepting the full chain', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-process-notifications-e2e-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'implementation', brief: 'implement', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus(child.id, 'running'); cards.stopRunningForRecovery(child.id);
    const staleStatus = cards.openRecord(child.id, 'status.md'); cards.editRecord(child.id, 'status.md', staleStatus.version, 'stale pre-activation evidence');
    const analystBrief = '# Goal\nEdited while stopped\n# Instructions\nPreserve identity\n# Acceptance Criteria\nComplete';
    expect(testAnalystMutationServices(root, cards, () => ({ ok: true, notificationId: 'analyst-edit' })).briefRecords.write(`record:///brief.md?card=${child.id}&v=next`, analystBrief)).toMatchObject({ success: true });
    const calls = { planner: 0, reviewer: 0, executor: 0 };
    const provider: LLMProviderPort = { completeTurn: jest.fn(async (input: LlmInvocationInput) => {
      const role = input.role as keyof typeof calls; calls[role] += 1; const call = calls[role];
      if (role === 'executor') {
        if (call === 1) return complete(tool('executor-stale-result', 'emit_result', { outcome: 'done', summary: 'premature' }));
        if (call === 2) return complete(tool('executor-write', 'write', { path: 'record:///status.md?v=next', content: 'implemented' }));
        if (call === 3) { cards.enqueueNotification(child.id, { id: 'executor-late', content: 'executor late context', created_at: '2026-07-18T00:00:00.000Z' }); return complete(tool('executor-first-result', 'emit_result', { outcome: 'done', summary: 'implemented' })); }
        expect(input.providerConversation.messages.some((row) => row.content === 'executor late context')).toBe(true);
        return complete(tool('executor-final-result', 'emit_result', { outcome: 'done', summary: 'implemented' }));
      }
      if (role === 'planner') {
        if (call === 1) return complete(tool('edit-stopped-child', 'edit_card', { card_id: child.id, title: 'edited stopped implementation' }));
        if (call === 2) return complete(tool('activate-child', 'activate_card', { card_id: child.id }));
        if (call === 3) return complete(tool('planner-write', 'write', { path: 'record:///status.md?v=next', content: 'planned and implemented' }));
        if (call === 4) { cards.enqueueNotification('project', { id: 'planner-late', content: 'planner late context', created_at: '2026-07-18T00:00:01.000Z' }); return complete(tool('planner-first-result', 'emit_result', { outcome: 'admit_review', summary: 'review' })); }
        expect(input.providerConversation.messages.some((row) => row.content === 'planner late context')).toBe(true);
        return complete(tool('planner-final-result', 'emit_result', { outcome: 'admit_review', summary: 'review' }));
      }
      if (call === 1) return complete(tool('reviewer-write', 'write', { path: 'record:///review.md?v=next', content: 'approved evidence' }));
      if (call === 2) { cards.enqueueNotification('project', { id: 'reviewer-late', content: 'reviewer late context', created_at: '2026-07-18T00:00:02.000Z' }); return complete(tool('reviewer-first-result', 'emit_result', { outcome: 'approved', summary: 'approved' })); }
      expect(input.providerConversation.messages.some((row) => row.content === 'reviewer late context')).toBe(true);
      return complete(tool('reviewer-final-result', 'emit_result', { outcome: 'approved', summary: 'approved' }));
    }) };
    const runtime = new SupervisorRuntimeApi({ ...testAutonomousCompaction, projectRoot: root, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(), provider, conversations: { projectRoot: root }, appLogs: { projectRoot: root }, readModelChanges: { runtimeChanged() {}, cardProjectionChanged() {}, agentsChanged() {}, conversationChanged() {}, subscribe: () => ({ unsubscribe() {} }) }, processRunner: new ProcessRunner(root, new ManagedProcessGroupRegistry()), promptTemplates: { render: () => 'test prompt' } });
    const prepared = await runtime.beginStartProject(); if (!prepared.accepted) throw new Error('Run was rejected'); runtime.launchStartedProject(prepared.launch);
    await waitUntil(() => runtime.getStatus().status === 'stopped');
    expect(cards.read('project')?.status).toBe('done'); expect(cards.read(child.id)?.status).toBe('done');
    expect(calls).toEqual({ planner: 5, reviewer: 3, executor: 4 });
    expect(cards.read(child.id)).toMatchObject({ id: child.id, title: 'edited stopped implementation', status: 'done' });
    expect(cards.readRecord(child.id, 'brief.md', 'latest').artifact.content).toBe(analystBrief);
    expect(cards.readRecord(child.id, 'status.md', 'latest')).toMatchObject({ version: staleStatus.version, artifact: { content: 'implemented' } });
    expect(readConversation(root, `executor:${child.id}`).sourceRows.some((row) => row.role === 'user' && row.content.includes('graph position was discarded'))).toBe(true);
    for (const [role, cardId] of [['planner', 'project'], ['reviewer', 'project'], ['executor', child.id]] as const) {
      expect(cards.read(cardId)?.pending_notifications).toEqual([]);
      const rows = readConversation(root, `${role}:${cardId}`).sourceRows;
      expect(rows.filter((row) => row.kind === 'tool_result' && row.content.includes('pending_notifications'))).toHaveLength(1);
      expect(rows.filter((row) => row.kind === 'activity' && row.content.includes('activation_open'))).toHaveLength(1);
    }
  });

  it('projects a stopped card through the real API with strict lifecycle, history, children, and actions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-stopped-api-e2e-')); roots.push(root); initProjectTree(root); await writeConfig(root);
    const cards = new CardService(root);
    const child = cards.create({ type: 'goal', parent: 'project', title: 'stopped child', brief: 'stopped', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus(child.id, 'running'); cards.stopRunningForRecovery(child.id);
    const app = await startApp({ argv: ['node', 'test', 'start', '--project-root', root], env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', SAIVAGE_API_TOKEN: undefined } }); apps.push(app);
    const detail = await app.server.fastify.inject({ method: 'GET', url: `/api/cards/${child.id}` });
    expect(detail.statusCode).toBe(200); expect(detail.json()).toMatchObject({ card: { id: child.id, status: 'stopped', lifecycle: { status: 'stopped', result: null, error: null, completed_at: null } } });
    expect(detail.json().card.allowedActions).toEqual(['card.start', 'card.cancel', 'card.delete']);
    expect(detail.json().card.allowedActions).not.toContain('card.restart');
    const children = await app.server.fastify.inject({ method: 'GET', url: '/api/cards/project/children' });
    expect(children.statusCode).toBe(200); expect(children.json().children).toEqual(expect.arrayContaining([expect.objectContaining({ id: child.id, status: 'stopped' })]));
    const history = await app.server.fastify.inject({ method: 'GET', url: `/api/cards/${child.id}/history` });
    expect(history.statusCode).toBe(200); expect(JSON.stringify(history.json())).toContain('stopped');
  });

  it('fails startup for an incompatible role override and accepts only the corrected singular generated contract', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-role-override-e2e-')); roots.push(root); initProjectTree(root); await writeConfig(root);
    const promptDir = join(root, '.saivage', 'config', 'prompts', 'project'); mkdirSync(promptDir, { recursive: true });
    const path = join(promptDir, 'planner.md'); writeFileSync(path, 'Use emit_result with status done, blocked, or failed.');
    await expect(startApp({ argv: ['node', 'test', 'start', '--project-root', root], env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', SAIVAGE_API_TOKEN: undefined } })).rejects.toThrow(/project.*planner.*planner\.md/i);
    writeFileSync(path, 'Follow this generated contract exactly:\n\n{{contractDescription}}');
    const app = await startApp({ argv: ['node', 'test', 'start', '--project-root', root], env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', SAIVAGE_API_TOKEN: undefined } }); apps.push(app);
    expect((await app.server.fastify.inject({ method: 'GET', url: '/api/runtime/status' })).json()).toMatchObject({ runtime: 'stopped' });
  });

  it('continues a partial reset in a genuinely fresh process without duplicate notice or cursor and publishes a fresh STOPPED marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-partial-reset-process-e2e-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'child', brief: 'child', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running'); cards.setStatus(child.id, 'running');
    const inputId = '99999999-9999-4999-8999-999999999999';
    const rows: AgentMessage[] = [
      { id: 'planner:project:activation:old', session_id: 'planner:project', role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', role: 'planner', card_id: 'project', input_id: inputId, timestamp: '2026-07-18T00:00:00.000Z' }), round_id: 'r-pre-99999999999999999999999999999999', message_index: 0, block_index: 0, timestamp: '2026-07-18T00:00:00.000Z' },
      { id: `${inputId}:pending`, session_id: 'planner:project', role: 'assistant', kind: 'text', content: 'pending', round_id: 'r-assistant-99999999999999999999999999999999', message_index: 1, block_index: 0, timestamp: '2026-07-18T00:00:00.001Z' },
    ];
    appendConversationBatch({ projectRoot: root }, rows);
    stabilizeRoleSession({ projectRoot: root, sessionId: 'planner:project', conversations: { projectRoot: root }, terminalToolNames: new Set(['emit_result']) });
    cards.stopRunningForRecovery(child.id);
    const worker = join(process.cwd(), 'tests', 'fixtures', 'recovery-fresh-process.ts');
    const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', worker, root], { encoding: 'utf8' })) as { cards: Array<{ id: string; status: string }>; markerCount: number; noticeCount: number };
    expect(result.cards).toEqual(expect.arrayContaining([{ id: 'project', status: 'running' }, { id: child.id, status: 'stopped' }]));
    expect(result.noticeCount).toBe(1);
    expect(result.markerCount).toBe(2);
  });
});
