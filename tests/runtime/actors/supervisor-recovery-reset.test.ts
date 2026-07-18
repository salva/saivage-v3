import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService } from '../../../src/cards/card-service.js';
import { RuntimeInterventionBinding } from '../../../src/application/intervention-readiness.js';
import { ReadModelChangeBroadcaster } from '../../../src/application/read-model-changes.js';
import { ManagedProcessGroupRegistry } from '../../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../../src/runtime/process-runner.js';
import { SupervisorRuntimeApi } from '../../../src/runtime/actors/supervisor-runtime-api.js';
import { appendConversationBatch, readConversation } from '../../../src/persistence/conversation-file.js';
import { initProjectTree } from '../../helpers/canonical-project.js';
import { testAutonomousCompaction } from '../../helpers/llm-test-helpers.js';
import type { AgentMessage, ConversationSessionId } from '../../../src/schemas/index.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';

const roots: string[] = [];
const oldInputs = new Map<string, string>();

function pendingSession(root: string, sessionId: ConversationSessionId, role: 'planner' | 'reviewer' | 'executor', cardId: string, digit: string, tool = false): void {
  const inputId = `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
  oldInputs.set(sessionId, inputId);
  const marker: AgentMessage = { id: `${sessionId}:activation:${digit}`, session_id: sessionId, role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', role, card_id: cardId, input_id: inputId, timestamp: '2026-07-18T00:00:00.000Z' }), round_id: `r-pre-${digit.repeat(32)}`, message_index: 0, block_index: 0, timestamp: '2026-07-18T00:00:00.000Z' };
  const pending: AgentMessage = tool
    ? { id: `${inputId}:tool-call:pending`, session_id: sessionId, role: 'assistant', kind: 'tool_call', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'pending', type: 'function', function: { name: 'activate_card', arguments: '{}' } }] }), tool: 'activate_card', tool_call_id: 'pending', round_id: `r-assistant-${digit.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-07-18T00:00:00.001Z' }
    : { id: `${inputId}:repair`, session_id: sessionId, role: 'user', kind: 'model_repair', content: 'continue', round_id: `r-user-${digit.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-07-18T00:00:00.001Z' };
  appendConversationBatch(root, [marker, pending]);
}

function supervisor(root: string, cards: CardService, options: { changes?: ReadModelChangeBroadcaster; provider?: { completeTurn(input: LlmInvocationInput, signal: AbortSignal): Promise<never> } } = {}) {
  const changes = options.changes ?? new ReadModelChangeBroadcaster();
  return new SupervisorRuntimeApi({ ...testAutonomousCompaction, projectRoot: root, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(), provider: options.provider ?? { completeTurn: (_input, signal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }, conversations: { projectRoot: root, changes }, appLogs: { projectRoot: root }, readModelChanges: changes, processRunner: new ProcessRunner(root, new ManagedProcessGroupRegistry()), promptTemplates: { render: () => 'test prompt' } });
}

describe('Supervisor full-chain stopped recovery', () => {
  afterEach(() => { oldInputs.clear(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

  it('stabilizes every eligible role and publishes stopped leaf-to-root before top-only STOPPED activation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-full-reset-')); roots.push(root); initProjectTree(root);
    const changes = new ReadModelChangeBroadcaster();
    const cards = new CardService(root, undefined, changes);
    const goal = cards.create({ type: 'goal', parent: 'project', title: 'goal', brief: 'goal', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const leaf = cards.create({ type: 'code', parent: goal.id, title: 'leaf', brief: 'leaf', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running'); cards.setStatus(goal.id, 'running'); cards.setStatus(leaf.id, 'running');
    pendingSession(root, 'planner:project', 'planner', 'project', '1');
    pendingSession(root, 'reviewer:project', 'reviewer', 'project', '2');
    pendingSession(root, `planner:${goal.id}`, 'planner', goal.id, '3');
    pendingSession(root, `reviewer:${goal.id}`, 'reviewer', goal.id, '4');
    pendingSession(root, `executor:${leaf.id}`, 'executor', leaf.id, '5', true);
    const order: string[] = [];
    changes.subscribe({ conversationChanged: (sessionId) => order.push(`conversation:${sessionId}`), cardProjectionChanged: (cardId) => order.push(`card:${cardId}`), agentsChanged() {}, runtimeChanged() {} });
    const stop = jest.spyOn(cards, 'stopRunningForRecovery').mockImplementation((id) => { order.push(`stop:${id}`); return CardService.prototype.stopRunningForRecovery.call(cards, id); });
    const activate = jest.spyOn(cards, 'activateStopped').mockImplementation((id) => { order.push(`activate:${id}`); return CardService.prototype.activateStopped.call(cards, id); });
    const list = jest.spyOn(cards, 'list');
    let plannerInput: LlmInvocationInput | null = null;
    const runtime = supervisor(root, cards, { changes, provider: { completeTurn: (input, signal) => { plannerInput = input; return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } } });
    const prepared = await runtime.beginStartProject();
    expect(prepared.accepted).toBe(true);
    expect((runtime as unknown as { cardActors: Map<string, unknown> }).cardActors.size).toBe(0);
    expect(list).not.toHaveBeenCalled();
    expect(order.filter((value) => value.startsWith('conversation:'))).toEqual([`conversation:executor:${leaf.id}`, `conversation:executor:${leaf.id}`, `conversation:planner:${goal.id}`, `conversation:reviewer:${goal.id}`, 'conversation:planner:project', 'conversation:reviewer:project']);
    expect(stop.mock.calls.map(([id]) => id)).toEqual([leaf.id, goal.id, 'project']);
    expect(activate).toHaveBeenCalledTimes(1); expect(activate).toHaveBeenCalledWith('project');
    expect(cards.read('project')?.status).toBe('running'); expect(cards.read(goal.id)?.status).toBe('stopped'); expect(cards.read(leaf.id)?.status).toBe('stopped');
    const firstStop = order.findIndex((value) => value.startsWith('stop:'));
    expect(order.slice(0, firstStop).filter((value) => value.startsWith('conversation:'))).toHaveLength(6);
    if (!prepared.accepted) throw new Error('Run rejected');
    runtime.launchStartedProject(prepared.launch);
    for (let attempt = 0; plannerInput === null && attempt < 50; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(plannerInput).not.toBeNull();
    const plannerRows = readConversation(root, 'planner:project').sourceRows;
    const markers = plannerRows.filter((row) => row.kind === 'activity' && row.content.includes('activation_open')).map((row) => JSON.parse(row.content).input_id);
    expect(markers).toHaveLength(2); expect(markers[1]).not.toBe(markers[0]);
    expect(plannerRows.some((row) => row.role === 'user' && row.content.includes('graph position was discarded'))).toBe(true);
    await runtime.stopProject();
  });

  it('recovers a partial stopped suffix as a fresh Run without duplicate notice or descendant activation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-partial-reset-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'child', brief: 'child', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running'); cards.setStatus(child.id, 'running');
    pendingSession(root, 'planner:project', 'planner', 'project', '6');
    cards.stopRunningForRecovery(child.id);
    const runtime = supervisor(root, cards);
    const prepared = await runtime.beginStartProject();
    expect(prepared.accepted).toBe(true);
    expect(cards.read('project')?.status).toBe('running'); expect(cards.read(child.id)?.status).toBe('stopped');
    expect(readConversation(root, 'planner:project').sourceRows.filter((row) => row.kind === 'model_recovered')).toHaveLength(1);
  });

  it('settles an unmatched activate_card ordinarily while preserving a terminal child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-terminal-child-reset-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'child', brief: 'child', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus(child.id, 'cancelled'); cards.setStatus('project', 'running');
    pendingSession(root, 'planner:project', 'planner', 'project', '7', true);
    await supervisor(root, cards).beginStartProject();
    expect(cards.read(child.id)?.status).toBe('cancelled');
    const result = readConversation(root, 'planner:project').sourceRows.find((row) => row.kind === 'tool_result')!;
    expect(JSON.parse(result.content)).toMatchObject({ success: false, data: { outcome_unknown: true } });
    expect(JSON.parse(result.content)).not.toHaveProperty('data.card_id');
  });

  it('stops at the first status publication failure and a later fresh Run uses the canonical prefix', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-reset-failure-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'child', brief: 'child', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.setStatus('project', 'running'); cards.setStatus(child.id, 'running');
    const original = cards.stopRunningForRecovery.bind(cards); let calls = 0;
    jest.spyOn(cards, 'stopRunningForRecovery').mockImplementation((id) => { calls += 1; if (id === 'project') throw new Error('root stop failed'); return original(id); });
    await expect(supervisor(root, cards).beginStartProject()).rejects.toThrow('root stop failed');
    expect(calls).toBe(2); expect(cards.read('project')?.status).toBe('running'); expect(cards.read(child.id)?.status).toBe('stopped');
    jest.restoreAllMocks();
    await expect(supervisor(root, cards).beginStartProject()).resolves.toMatchObject({ accepted: true });
    expect(cards.read('project')?.status).toBe('running'); expect(cards.read(child.id)?.status).toBe('stopped');
  });
});
