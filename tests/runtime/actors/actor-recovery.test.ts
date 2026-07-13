import { initProjectTree, CardStore, testCompositionAuthority } from '../../helpers/canonical-project.js';
import { testActorSnapshots } from '../../helpers/actor-snapshots.js';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { appendTestConversationMessage as appendConversationMessage, testConversationMutations } from '../../helpers/conversation-mutations.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import {
  buildActorRecoveryPlan,
  appendLlmTurnFinished as productionAppendLlmTurnFinished,
  projectActorRecovery,
  readConversationMessages,
  recoverActorStartupOutcomes,
  recoverProjectedTerminalToolOutcomes,
  readRecoveryDiagnostics,
  readActorSnapshots,
  recoveryDiagnosticsPath,
} from '../../../src/runtime/actors/index.js';
import { runActorStartupRecovery, writeRecoveryDiagnostics } from '../../helpers/recovery-diagnostics.js';

const appendLlmTurnFinished = (conversations: ReturnType<typeof testConversationMutations>, input: Parameters<typeof productionAppendLlmTurnFinished>[2], result: Parameters<typeof productionAppendLlmTurnFinished>[3]) => productionAppendLlmTurnFinished(conversations, testCompositionAuthority(conversations.projectRoot), input, result);




function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-actor-recovery-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

function saveSnapshot(projectRoot: string, actorId: string, actorKind: 'card' | 'llm' | 'processor', stateValue: unknown, context: Record<string, unknown> = {}): void {
  testActorSnapshots(projectRoot).save({
    actor_id: actorId,
    actor_kind: actorKind,
    state_value: stateValue,
    context,
    updated_at: '2026-06-12T00:00:00.000Z',
  });
}

function cardActive(cardId: string): Record<string, unknown> {
  return { schema_version: 1, kind: 'card_activation', card_id: cardId, processor_actor_id: `processor:${cardId}`, caller: { kind: 'root' }, started_at: '2026-06-12T00:00:00.000Z' };
}

function processorActive(cardId: string): Record<string, unknown> {
  return { schema_version: 1, kind: 'processor_activation', processor_kind: 'planning', card_id: cardId, caller: { kind: 'root' }, activation_counter: 1, started_at: '2026-06-12T00:00:00.000Z' };
}

function terminalProcessorActive(cardId: string): Record<string, unknown> {
  return { schema_version: 1, kind: 'processor_activation', processor_kind: 'terminal', card_id: cardId, caller: { kind: 'parent', cardId: 'project' }, activation_counter: 1, started_at: '2026-06-12T00:00:00.000Z' };
}

function llmActive(cardId: string, inputId = 'planner:input:1'): Record<string, unknown> {
  return { schema_version: 1, kind: 'llm_turn', agent_id: `planner:${cardId}`, role: 'planner', card_id: cardId, input_id: inputId, input: { inputId, agentId: `planner:${cardId}`, role: 'planner', sessionId: `planner:${cardId}`, systemPrompt: 'system', contextMessages: [], tools: [], terminalToolNames: [], modelParams: {}, capabilityRequest: {}, episodeContext: { cardId } }, provider_call_id: `planner:${cardId}:${inputId}`, waiting_tool_call: null, delivered_tool_call_ids: [], tool_delivery_counter: 0, started_at: '2026-06-12T00:00:00.000Z' };
}

function llmWaitingActive(cardId: string, role: 'planner' | 'reviewer' | 'executor', toolName: string, toolCallId = 'call-1', assessmentId = `assessment-${cardId}-1`): Record<string, unknown> {
  const agentId = `${role}:${cardId}`;
  const inputId = `${role}:${cardId}:1`;
  return { ...llmActive(cardId, inputId), agent_id: agentId, role, input_id: inputId, input: { inputId, agentId, role, sessionId: role === 'reviewer' ? `reviewer:${cardId}:${assessmentId}` : agentId, systemPrompt: 'system', contextMessages: [], tools: [], terminalToolNames: [], modelParams: {}, capabilityRequest: {}, episodeContext: role === 'reviewer' ? { cardId, assessmentId } : { cardId } }, provider_call_id: null, waiting_tool_call: { sourceInputId: inputId, toolCallId, toolName } };
}

function appendLoggedToolCall(projectRoot: string, cardId: string, role: 'planner' | 'reviewer' | 'executor', toolName: string, args: unknown, toolCallId = 'call-1', writeRequiredRecord = true): void {
  const agentId = `${role}:${cardId}`;
  const inputId = `${role}:${cardId}:1`;
  const assessmentId = `assessment-${cardId}-1`;
  const sessionId = role === 'reviewer' ? `reviewer:${cardId}:${assessmentId}` : agentId;
  appendLlmTurnFinished(testConversationMutations(projectRoot), { inputId, agentId, role, sessionId, systemPrompt: 'system', contextMessages: [], tools: [], terminalToolNames: [], modelParams: {}, capabilityRequest: {}, episodeContext: role === 'reviewer' ? { cardId, assessmentId } : { cardId } }, { kind: 'tool_calls', tool_calls: [{ id: toolCallId, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] });
  if (!writeRequiredRecord) return;
  const store = new CardStore(projectRoot);
  const filename = role === 'reviewer' ? 'review.md' : 'status.md';
  const record = store.openRecord(cardId, filename);
  store.editRecord(cardId, filename, record.version, `${role} recovery record`);
}

function toolMessageKinds(projectRoot: string, sessionId: string): string[] {
  return readConversationMessages(projectRoot, sessionId).filter((message) => message.kind === 'tool_call' || message.kind === 'tool_result').map((message) => message.kind);
}

function projectedToolResultSessions(projectRoot: string, sessions: string[]): string[] {
  return sessions.filter((sessionId) => readConversationMessages(projectRoot, sessionId).some((message) => message.kind === 'tool_result' && message.content === JSON.stringify({ projected: true })));
}

function reviewerPass(_evidenceId: string, summary = 'review ok'): Record<string, unknown> {
  return { status: 'done', summary };
}

function reviewerCorrections(_evidenceId: string, summary = 'needs correction'): Record<string, unknown> {
  return { status: 'rework', summary };
}

function recoveryProcessorDeps(projectRoot: string, store: CardStore) {
  return {
    projectRoot, snapshots: testActorSnapshots(projectRoot), conversations: testConversationMutations(projectRoot), mutationAuthority: testCompositionAuthority(projectRoot),
    store,
    generatedAt: '2026-06-12T00:00:00.000Z',
  };
}

function createRunningGoal(projectRoot: string): { store: CardStore; cardId: string } {
  initProjectTree(projectRoot);
  const store = new CardStore(projectRoot);
  const card = store.create({ type: 'goal', parent: 'project', depth: 1, title: 'goal', brief: 'Goal brief.', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
  store.setStatus(card.id, 'running');
  return { store, cardId: card.id };
}

function createDoneEvidence(store: CardStore, parent: string): string {
  const card = store.create({ type: 'code', parent, depth: 2, title: 'evidence', brief: 'Evidence brief.', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
  store.commitTerminalLifecyclePatch(card.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-06-12T00:00:00.000Z' } });
  return card.id;
}

function createRunningTerminalCard(projectRoot: string): { store: CardStore; cardId: string } {
  initProjectTree(projectRoot);
  const store = new CardStore(projectRoot);
  const card = store.create({ type: 'code', parent: 'project', depth: 1, title: 'code', brief: 'Code brief.', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
  store.setStatus(card.id, 'running');
  return { store, cardId: card.id };
}

describe('actor recovery plan', () => {
  it('builds an empty plan when no actor snapshots exist', () => withTempProject((projectRoot) => {
    expect(buildActorRecoveryPlan(projectRoot)).toEqual({ cards: [], llms: [], processors: [] });
  }));

  it('builds a deterministic plan for active goal card and planner LLM snapshots', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'planner:G-1', 'llm', 'calling_provider', { cardId: 'G-1', active_reconstruction: llmActive('G-1') });
    saveSnapshot(projectRoot, 'card:G-1', 'card', 'running', { cardId: 'G-1', active_reconstruction: cardActive('G-1') });

    const plan = buildActorRecoveryPlan(projectRoot);

    expect(plan.cards).toMatchObject([{ cardId: 'G-1', active: true, activeReconstruction: expect.objectContaining({ kind: 'card_activation' }) }]);
    expect(plan.llms).toMatchObject([{ actorId: 'planner:G-1', role: 'planner', cardId: 'G-1', active: true, activeReconstruction: expect.objectContaining({ kind: 'llm_turn' }) }]);
    expect(plan.processors).toEqual([]);
  }));

  it('includes inactive terminal executor snapshots without recovery diagnostics', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'card:T-1', 'card', 'running', { cardId: 'T-1', active_reconstruction: cardActive('T-1') });
    saveSnapshot(projectRoot, 'executor:T-1', 'llm', 'idle', { cardId: 'T-1' });

    const plan = buildActorRecoveryPlan(projectRoot);

    expect(plan.llms).toMatchObject([{ actorId: 'executor:T-1', role: 'executor', cardId: 'T-1', active: false }]);
    expect(projectActorRecovery(plan).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: 'card:T-1', severity: 'warning' }),
    ]));
  }));

  it('treats card snapshots as active only when active reconstruction is present', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'card:G-backlog', 'card', 'backlog', { cardId: 'G-backlog' });
    saveSnapshot(projectRoot, 'card:G-blocked', 'card', 'blocked', { cardId: 'G-blocked' });
    saveSnapshot(projectRoot, 'card:G-running', 'card', 'running', { cardId: 'G-running' });
    saveSnapshot(projectRoot, 'card:G-active', 'card', 'running', { cardId: 'G-active', active_reconstruction: cardActive('G-active') });

    const plan = buildActorRecoveryPlan(projectRoot);

    expect(plan.cards).toMatchObject([
      { cardId: 'G-active', active: true },
      { cardId: 'G-backlog', active: false },
      { cardId: 'G-blocked', active: false },
      { cardId: 'G-running', active: false },
    ]);
  }));

  it('classifies processor snapshots and active LLM recovery actions', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'card:G-1', 'card', 'running', { cardId: 'G-1', active_reconstruction: cardActive('G-1') });
    saveSnapshot(projectRoot, 'processor:G-1', 'processor', 'planning', { cardId: 'G-1', active_reconstruction: processorActive('G-1') });
    saveSnapshot(projectRoot, 'planner:G-1', 'llm', 'calling_provider', { cardId: 'G-1', active_reconstruction: llmActive('G-1') });
    saveSnapshot(projectRoot, 'reviewer:G-1', 'llm', 'waiting_tool', { cardId: 'G-1', active_reconstruction: llmWaitingActive('G-1', 'reviewer', 'tool') });

    const plan = buildActorRecoveryPlan(projectRoot);

    expect(plan.processors).toMatchObject([{ actorId: 'processor:G-1', cardId: 'G-1', active: true, activeReconstruction: expect.objectContaining({ kind: 'processor_activation' }) }]);
    expect(plan.llms).toMatchObject([
      { actorId: 'planner:G-1', active: true },
      { actorId: 'reviewer:G-1', active: true },
    ]);
    expect(projectActorRecovery(plan).diagnostics).toEqual([
      expect.objectContaining({ actorId: 'planner:G-1', severity: 'warning' }),
      expect.objectContaining({ actorId: 'processor:G-1', severity: 'warning' }),
      expect.objectContaining({ actorId: 'reviewer:G-1', severity: 'warning' }),
    ]);
    expect(projectActorRecovery(plan).actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: 'planner:G-1', kind: 'llm_recovery_action', action: 'reissue_provider_call' }),
      expect.objectContaining({ actorId: 'reviewer:G-1', kind: 'llm_recovery_action', action: 'replay_tool_wait' }),
    ]));
  }));

  it('keeps recovery plan facts free of eager diagnostics and projected actions', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'planner:G-1', 'llm', 'calling_provider', { cardId: 'G-1', active_reconstruction: llmActive('G-1') });

    const plan = buildActorRecoveryPlan(projectRoot, { read: jest.fn(() => ({ id: 'G-1', type: 'goal' })) });

    expect(plan).not.toHaveProperty('diagnostics');
    expect(plan.llms[0]).not.toHaveProperty('action');
    expect(projectActorRecovery(plan).actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: 'planner:G-1', action: 'reissue_provider_call' }),
    ]));
  }));

  it('allows an active LLM snapshot when the owner card exists in the domain reader', () => withTempProject((projectRoot) => {
    const cards = new Map<string, { id: string; type: string }>([['G-domain', { id: 'G-domain', type: 'goal' }]]);
    saveSnapshot(projectRoot, 'planner:G-domain', 'llm', 'calling_provider', { cardId: 'G-domain', active_reconstruction: llmActive('G-domain') });

    const plan = buildActorRecoveryPlan(projectRoot, { read: jest.fn((cardId: string) => cards.get(cardId) ?? null) });

    expect(plan.llms).toMatchObject([{ actorId: 'planner:G-domain', cardId: 'G-domain', active: true }]);
  }));

  it('diagnoses active LLM snapshots without a concrete recovery action', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'card:G-1', 'card', 'running', { cardId: 'G-1', active_reconstruction: cardActive('G-1') });
    saveSnapshot(projectRoot, 'planner:G-1', 'llm', 'unknown_active_phase', { cardId: 'G-1', active_reconstruction: llmActive('G-1') });

    const plan = buildActorRecoveryPlan(projectRoot);

    expect(projectActorRecovery(plan).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: 'planner:G-1', severity: 'warning' }),
    ]));
  }));

  it('diagnoses active cards without active processor, LLM, or active child evidence', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'card:G-stranded', 'card', 'running', { cardId: 'G-stranded', active_reconstruction: cardActive('G-stranded') });

    const plan = buildActorRecoveryPlan(projectRoot, { read: jest.fn(() => null), listChildren: jest.fn(() => []) });

    const projection = projectActorRecovery(plan, { read: jest.fn(() => null), listChildren: jest.fn(() => []) });
    expect(projection.diagnostics).toEqual([expect.objectContaining({ actorId: 'card:G-stranded', severity: 'warning' })]);
    expect(projection.diagnostics[0].message).toContain('no active processor');
  }));

  it('does not diagnose active cards as stranded when processor or active child evidence exists', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'card:G-processor', 'card', 'running', { cardId: 'G-processor', active_reconstruction: cardActive('G-processor') });
    saveSnapshot(projectRoot, 'processor:G-processor', 'processor', 'planning', { cardId: 'G-processor', active_reconstruction: processorActive('G-processor') });
    saveSnapshot(projectRoot, 'card:G-parent', 'card', 'running', { cardId: 'G-parent', active_reconstruction: cardActive('G-parent') });
    saveSnapshot(projectRoot, 'card:G-child', 'card', 'running', { cardId: 'G-child', active_reconstruction: cardActive('G-child') });
    const children = new Map<string, string[]>([['G-parent', ['G-child']]]);

    const plan = buildActorRecoveryPlan(projectRoot, { read: jest.fn(() => null), listChildren: jest.fn((cardId: string) => children.get(cardId) ?? []) });

    expect(projectActorRecovery(plan, { read: jest.fn(() => null), listChildren: jest.fn((cardId: string) => children.get(cardId) ?? []) }).diagnostics.filter((diagnostic) => diagnostic.message.includes('no active processor')).map((diagnostic) => diagnostic.actorId)).toEqual(['card:G-child']);
  }));

  it('diagnoses ambiguous active card states', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'card:G-old', 'card', 'planning', { cardId: 'G-old', active_reconstruction: cardActive('G-old') });

    const plan = buildActorRecoveryPlan(projectRoot);

    expect(projectActorRecovery(plan).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: 'card:G-old', severity: 'warning' }),
    ]));
    expect(projectActorRecovery(plan).diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toContain("unknown lifecycle state 'planning'");
  }));

  it('diagnoses active card snapshots that are not in the running lifecycle state', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'card:G-parked-active', 'card', 'parked', { cardId: 'G-parked-active', active_reconstruction: cardActive('G-parked-active') });

    const diagnostics = projectActorRecovery(buildActorRecoveryPlan(projectRoot)).diagnostics.map((diagnostic) => diagnostic.message);

    expect(diagnostics).toEqual(expect.arrayContaining([expect.stringContaining("lifecycle state 'parked'")]));
    expect(diagnostics).toEqual(expect.arrayContaining([expect.stringContaining('no active processor')]));
  }));

  it('fails fast on corrupt or mismatched active reconstruction records', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'card:G-corrupt', 'card', 'running', { cardId: 'G-corrupt', active_reconstruction: { schema_version: 1, kind: 'llm_turn' } });
    expect(() => buildActorRecoveryPlan(projectRoot)).toThrow("active_reconstruction kind mismatch: expected 'card_activation', received 'llm_turn'");

    testActorSnapshots(projectRoot).remove('card:G-corrupt');
    saveSnapshot(projectRoot, 'planner:G-role', 'llm', 'calling_provider', { cardId: 'G-role', active_reconstruction: { ...llmActive('G-role'), role: 'reviewer' } });
    expect(() => buildActorRecoveryPlan(projectRoot, { read: jest.fn(() => ({ id: 'G-role', type: 'goal' })) })).toThrow("role 'reviewer' does not match actor role 'planner'");
  }));

  it('throws on orphan active LLM snapshots without a snapshot or domain card owner', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'planner:G-orphan', 'llm', 'running', { cardId: 'G-orphan', active_reconstruction: llmActive('G-orphan') });

    expect(() => buildActorRecoveryPlan(projectRoot, { read: jest.fn(() => null) })).toThrow(
      "Cannot recover active LLM actor 'planner:G-orphan': owner card 'G-orphan' was not found.",
    );
  }));

  it('persists sanitized recovery diagnostics only when recovery work exists', () => withTempProject((projectRoot) => {
    expect(readRecoveryDiagnostics(projectRoot)).toBeNull();
    expect(writeRecoveryDiagnostics(projectRoot, buildActorRecoveryPlan(projectRoot), '2026-06-12T00:00:00.000Z')).toBeNull();
    expect(existsSync(recoveryDiagnosticsPath(projectRoot))).toBe(false);

    saveSnapshot(projectRoot, 'card:G-1', 'card', 'running', { cardId: 'G-1', secretLike: 'not persisted', active_reconstruction: cardActive('G-1') });
    saveSnapshot(projectRoot, 'planner:G-1', 'llm', 'calling_provider', { cardId: 'G-1', providerPayload: 'not persisted', active_reconstruction: llmActive('G-1') });
    const written = writeRecoveryDiagnostics(projectRoot, buildActorRecoveryPlan(projectRoot), '2026-06-12T00:00:00.000Z');

    expect(written).toMatchObject({
      schema_version: 1,
      generated_at: '2026-06-12T00:00:00.000Z',
      diagnostics: [expect.objectContaining({ actorId: 'planner:G-1', severity: 'warning' })],
      actions: expect.arrayContaining([
        expect.objectContaining({ actorId: 'card:G-1', kind: 'active_card', cardId: 'G-1' }),
        expect.objectContaining({ actorId: 'planner:G-1', kind: 'active_llm', cardId: 'G-1' }),
        expect.objectContaining({ actorId: 'planner:G-1', kind: 'llm_recovery_action', action: 'reissue_provider_call', cardId: 'G-1' }),
      ]),
    });
    expect(readRecoveryDiagnostics(projectRoot)).toEqual(written);
    expect(JSON.stringify(readRecoveryDiagnostics(projectRoot))).not.toContain('not persisted');
  }));

  it('clears stale recovery diagnostics when recovery work is clean', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'card:G-1', 'card', 'running', { cardId: 'G-1', active_reconstruction: cardActive('G-1') });
    expect(writeRecoveryDiagnostics(projectRoot, buildActorRecoveryPlan(projectRoot), '2026-06-12T00:00:00.000Z')).not.toBeNull();
    expect(existsSync(recoveryDiagnosticsPath(projectRoot))).toBe(true);

    testActorSnapshots(projectRoot).remove('card:G-1');
    expect(writeRecoveryDiagnostics(projectRoot, buildActorRecoveryPlan(projectRoot), '2026-06-12T00:00:01.000Z')).toBeNull();
    expect(existsSync(recoveryDiagnosticsPath(projectRoot))).toBe(false);
  }));

  it('uses role-agnostic and fact-based recovery diagnostic messages', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'planner:G-provider', 'llm', 'calling_provider', { cardId: 'G-provider', active_reconstruction: llmActive('G-provider') });
    saveSnapshot(projectRoot, 'reviewer:G-tool', 'llm', 'waiting_tool', { cardId: 'G-tool', active_reconstruction: llmWaitingActive('G-tool', 'reviewer', 'emit_result') });

    const diagnostics = projectActorRecovery(buildActorRecoveryPlan(projectRoot, { read: jest.fn(() => ({ id: 'G', type: 'goal' })) })).diagnostics.map((diagnostic) => diagnostic.message).join('\n');

    expect(diagnostics).toContain('re-issued from the reconstructed LLM input');
    expect(diagnostics).toContain('waiting for a persisted tool call');
    expect(diagnostics).not.toContain('planner-visible');
    expect(diagnostics).not.toContain('will be blocked unless');
  }));

  it('reports handled startup incidents while outstanding diagnostics stay unresolved-only', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    store.commitTerminalLifecyclePatch(cardId, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-06-12T00:00:00.000Z' } });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'calling_provider', { cardId, active_reconstruction: llmActive(cardId) });
    const report = runActorStartupRecovery(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store));

    expect(report.incidents).toEqual([expect.objectContaining({ actorId: `planner:${cardId}`, action: 'cleanup_non_running_card_llm_snapshot', cardId })]);
    expect(readRecoveryDiagnostics(projectRoot)).toBeNull();
  }));

  it('does not convert interrupted running card work into a blocked card outcome', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'calling_provider', { cardId, active_reconstruction: llmActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });

    expect(recoverActorStartupOutcomes(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store))).toEqual([]);
    expect(store.read(cardId)?.status).toBe('running');
  }));

  it('recovers a persisted planner blocked terminal tool call', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'planner', 'emit_result') });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'emit_result', { status: 'blocked', summary: 'needs operator' });
    const plan = buildActorRecoveryPlan(projectRoot, store);

    const recoveries = recoverProjectedTerminalToolOutcomes(plan, recoveryProcessorDeps(projectRoot, store));
    expect(recoveries).toEqual([{ cardId, status: 'blocked', reason: expect.stringContaining('terminal tool call'), actorIds: [`card:${cardId}`, `planner:${cardId}`, `processor:${cardId}`].sort() }]);
    expect(store.read(cardId)).toMatchObject({ status: 'blocked', lifecycle: { status: 'blocked', result: { kind: 'blocked', summary: 'needs operator' } } });
  }));

  it('does not recover a terminal planner tool call without the required status record', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'planner', 'emit_result') });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'emit_result', { status: 'blocked', summary: 'needs operator' }, 'call-1', false);

    expect(recoverProjectedTerminalToolOutcomes(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store))).toEqual([]);
    expect(store.read(cardId)?.status).toBe('running');
    expect(toolMessageKinds(projectRoot, `planner:${cardId}`)).toEqual(['tool_call']);
  }));

  it('does not recover a terminal planner tool call when the required status record is empty', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'planner', 'emit_result') });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'emit_result', { status: 'blocked', summary: 'needs operator' }, 'call-1', false);
    store.openRecord(cardId, 'status.md');

    expect(recoverProjectedTerminalToolOutcomes(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store))).toEqual([]);
    expect(store.read(cardId)?.status).toBe('running');
    expect(toolMessageKinds(projectRoot, `planner:${cardId}`)).toEqual(['tool_call']);
  }));

  it('does not recover planner done terminal tool calls before reviewer reconstruction exists', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'planner', 'emit_result') });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'emit_result', { status: 'done', summary: 'done' });
    const plan = buildActorRecoveryPlan(projectRoot, store);

    expect(recoverProjectedTerminalToolOutcomes(plan, recoveryProcessorDeps(projectRoot, store))).toEqual([]);
    expect(store.read(cardId)?.status).toBe('running');
  }));

  it('recovers paired planner done and reviewer pass terminal tool calls', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    const evidenceId = createDoneEvidence(store, cardId);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'planner', 'emit_result') });
    saveSnapshot(projectRoot, `reviewer:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'reviewer', 'emit_result') });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'emit_result', { status: 'done', summary: 'done' });
    appendLoggedToolCall(projectRoot, cardId, 'reviewer', 'emit_result', reviewerPass(evidenceId));

    const recoveries = recoverProjectedTerminalToolOutcomes(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store));
    expect(recoveries).toEqual([{ cardId, status: 'done', reason: expect.stringContaining('planner and reviewer'), actorIds: [`card:${cardId}`, `planner:${cardId}`, `processor:${cardId}`, `reviewer:${cardId}`].sort() }]);
    expect(store.read(cardId)).toMatchObject({ status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'review ok' } } });
    expect(projectedToolResultSessions(projectRoot, [`planner:${cardId}`, `reviewer:${cardId}:assessment-${cardId}-1`]).sort()).toEqual([`planner:${cardId}`, `reviewer:${cardId}:assessment-${cardId}-1`].sort());
    expect(readConversationMessages(projectRoot, `reviewer:${cardId}`).filter((message) => message.kind === 'tool_result')).toEqual([]);
  }));

  it('fails fast when reviewer projection needs descendant traversal but store cannot list children', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    const evidenceId = createDoneEvidence(store, cardId);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'planner', 'emit_result') });
    saveSnapshot(projectRoot, `reviewer:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'reviewer', 'emit_result') });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'emit_result', { status: 'done', summary: 'done' });
    appendLoggedToolCall(projectRoot, cardId, 'reviewer', 'emit_result', reviewerPass(evidenceId));
    const deps = recoveryProcessorDeps(projectRoot, store);
    const traversalLessStore = { read: store.read.bind(store), setStatus: store.setStatus.bind(store), commitTerminalLifecyclePatch: store.commitTerminalLifecyclePatch.bind(store), readRecord: store.readRecord.bind(store), closeRecord: store.closeRecord.bind(store) };

    expect(() => recoverProjectedTerminalToolOutcomes(buildActorRecoveryPlan(projectRoot, store), { ...deps, store: traversalLessStore })).toThrow('must provide listChildren');
  }));

  it('recovers paired planner done and reviewer correction terminal tool calls as blocked', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    const evidenceId = createDoneEvidence(store, cardId);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'planner', 'emit_result') });
    saveSnapshot(projectRoot, `reviewer:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'reviewer', 'emit_result') });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'emit_result', { status: 'done', summary: 'done' });
    appendLoggedToolCall(projectRoot, cardId, 'reviewer', 'emit_result', reviewerCorrections(evidenceId, 'fix issue'));

    const recoveries = recoverProjectedTerminalToolOutcomes(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store));

    expect(recoveries).toEqual([{ cardId, status: 'blocked', reason: expect.stringContaining('planner and reviewer'), actorIds: [`card:${cardId}`, `planner:${cardId}`, `processor:${cardId}`, `reviewer:${cardId}`].sort() }]);
    expect(store.read(cardId)).toMatchObject({ status: 'blocked', lifecycle: { status: 'blocked', result: { kind: 'rework', summary: 'fix issue' } } });
  }));

  it('recomputes reviewer reconstruction identity for planner done recovery', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    const evidenceId = createDoneEvidence(store, cardId);
    const reviewer = llmWaitingActive(cardId, 'reviewer', 'emit_result');
    (reviewer.input as Record<string, unknown>).episodeContext = { cardId };
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'planner', 'emit_result') });
    saveSnapshot(projectRoot, `reviewer:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: reviewer });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'emit_result', { status: 'done', summary: 'done' });
    appendLoggedToolCall(projectRoot, cardId, 'reviewer', 'emit_result', reviewerPass(evidenceId));

    const recoveries = recoverProjectedTerminalToolOutcomes(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store));

    expect(recoveries).toEqual([{ cardId, status: 'done', reason: expect.stringContaining('planner and reviewer'), actorIds: [`card:${cardId}`, `planner:${cardId}`, `processor:${cardId}`, `reviewer:${cardId}`].sort() }]);
    expect(store.read(cardId)).toMatchObject({ status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'review ok' } } });
  }));

  it('refuses planner done recovery when descendants are incomplete', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    const incomplete = store.create({ type: 'code', parent: cardId, depth: 2, title: 'incomplete', brief: 'Incomplete brief.', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'planner', 'emit_result') });
    saveSnapshot(projectRoot, `reviewer:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'reviewer', 'emit_result') });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'emit_result', { status: 'done', summary: 'done' });
    appendLoggedToolCall(projectRoot, cardId, 'reviewer', 'emit_result', reviewerPass(incomplete.id));

    expect(recoverProjectedTerminalToolOutcomes(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store))).toEqual([]);
    expect(store.read(cardId)?.status).toBe('running');
  }));

  it('recovers a persisted executor terminal success tool call', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningTerminalCard(projectRoot);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'executing', { cardId, active_reconstruction: terminalProcessorActive(cardId) });
    saveSnapshot(projectRoot, `executor:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'executor', 'emit_result') });
    appendLoggedToolCall(projectRoot, cardId, 'executor', 'emit_result', { status: 'done', summary: 'implemented' });

    const recoveries = recoverProjectedTerminalToolOutcomes(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store));

    expect(recoveries).toEqual([{ cardId, status: 'done', reason: expect.stringContaining('terminal tool call'), actorIds: [`card:${cardId}`, `executor:${cardId}`, `processor:${cardId}`].sort() }]);
    expect(store.read(cardId)).toMatchObject({ status: 'done', lifecycle: { status: 'done', result: { kind: 'done' } }, status_text: 'implemented' });
  }));

  it('leaves nonterminal waiting tool calls for actor replay/resume', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'planner', 'activate_card') });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'activate_card', { card_id: 'child' });
    const plan = buildActorRecoveryPlan(projectRoot, store);

    expect(recoverProjectedTerminalToolOutcomes(plan, recoveryProcessorDeps(projectRoot, store))).toEqual([]);
    expect(store.read(cardId)?.status).toBe('running');
  }));

  it('appends an actionable failed result for unrelinked activate_card startup waits', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'planner', 'activate_card') });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'activate_card', { card_id: 'missing-child' });

    const report = runActorStartupRecovery(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store));
    const toolResults = readConversationMessages(projectRoot, `planner:${cardId}`).filter((message) => message.kind === 'tool_result');

    expect(report.incidents).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'fail_unrelinked_activation_wait', cardId })]));
    expect(toolResults).toEqual([expect.objectContaining({ content: expect.stringContaining('inspect child card state before retrying') })]);
  }));

  it('preserves an existing activation wait for a compatible running child', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    const child = store.create({ type: 'code', parent: cardId, depth: 2, title: 'child', brief: 'Child brief.', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
    store.setStatus(child.id, 'running');
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'planner', 'activate_card') });
    saveSnapshot(projectRoot, `card:${child.id}`, 'card', 'running', { cardId: child.id, active_reconstruction: { ...cardActive(child.id), caller: { kind: 'parent', cardId, sessionId: `planner:${cardId}` } } });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'activate_card', { card_id: child.id });

    const report = runActorStartupRecovery(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store));
    const toolResults = readConversationMessages(projectRoot, `planner:${cardId}`).filter((message) => message.kind === 'tool_result');

    expect(report.incidents).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'relink_existing_activation_wait', message: expect.stringContaining(child.id) })]));
    expect(toolResults).toEqual([]);
  }));

  it('fails a running child activation wait when the parent LLM continuation is absent', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    const child = store.create({ type: 'code', parent: cardId, depth: 2, title: 'child', brief: 'Child brief.', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
    store.setStatus(child.id, 'running');
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `card:${child.id}`, 'card', 'running', { cardId: child.id, active_reconstruction: { ...cardActive(child.id), caller: { kind: 'parent', cardId, sessionId: `planner:${cardId}` } } });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'activate_card', { card_id: child.id });

    const report = runActorStartupRecovery(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store));
    const toolResults = readConversationMessages(projectRoot, `planner:${cardId}`).filter((message) => message.kind === 'tool_result');

    expect(report.incidents).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'fail_unrelinked_activation_wait', message: expect.stringContaining('no deterministic child-completion registration surface') })]));
    expect(report.incidents).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'promote_orphan_running_card', cardId: child.id })]));
    expect(toolResults).toEqual([expect.objectContaining({ content: expect.stringContaining(child.id) })]);
  }));

  it('settles tool_error rows and removes stale provider snapshots before reissue', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'calling_provider', { cardId, active_reconstruction: llmActive(cardId, `planner:${cardId}:1`) });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'read', { path: 'README.md' }, 'call-1', false);
    appendConversationMessage(projectRoot, {
      id: `planner:${cardId}:1:tool-error:call-1`,
      session_id: `planner:${cardId}`,
      role: 'tool',
      kind: 'tool_error',
      content: 'read failed',
      tool: 'read',
      tool_call_id: 'call-1',
      round_id: 'r-user-11111111111111111111111111111111',
      message_index: 2,
      block_index: 0,
      timestamp: '2026-06-12T00:00:00.000Z',
    });

    const report = runActorStartupRecovery(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store));
    const toolResults = readConversationMessages(projectRoot, `planner:${cardId}`).filter((message) => message.kind === 'tool_result');

    expect(report.incidents).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'cleanup_provider_snapshot_for_tool_error_settlement', cardId }),
      expect.objectContaining({ action: 'settle_recovery_tool_error', cardId }),
    ]));
    expect(toolResults).toEqual([expect.objectContaining({ content: expect.stringContaining('read failed') })]);
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_id)).not.toContain(`planner:${cardId}`);
  }));

  it('repairs autonomous plain text without changing an Analyst conversation', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'calling_provider', { cardId, active_reconstruction: llmActive(cardId) });
    saveSnapshot(projectRoot, 'analyst:global', 'llm', 'idle');
    appendLlmTurnFinished(testConversationMutations(projectRoot), { inputId: 'planner:input:1', agentId: `planner:${cardId}`, role: 'planner', sessionId: `planner:${cardId}`, systemPrompt: 'system', contextMessages: [], tools: [], terminalToolNames: [], modelParams: {}, capabilityRequest: {}, episodeContext: { cardId } }, { kind: 'message', content: 'plain text' });
    appendLlmTurnFinished(testConversationMutations(projectRoot), { inputId: 'analyst:global:1', agentId: 'analyst:global', role: 'analyst', sessionId: 'analyst:global', systemPrompt: 'system', contextMessages: [], tools: [], terminalToolNames: [], modelParams: {}, capabilityRequest: {}, episodeContext: { cardId: null } }, { kind: 'message', content: 'ordinary Analyst reply' });
    const analystMessages = readConversationMessages(projectRoot, 'analyst:global');

    const report = runActorStartupRecovery(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store));

    expect(report.incidents).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'repair_assistant_text_pending_provider_snapshot', cardId })]));
    expect(readConversationMessages(projectRoot, `planner:${cardId}`).map((message) => message.kind)).toContain('model_repair');
    expect(readConversationMessages(projectRoot, 'analyst:global')).toEqual(analystMessages);
    expect(report.incidents.some((incident) => incident.actorId === 'analyst:global')).toBe(false);
  }));

  it('recovers an interrupted activate_card wait from a settled child card', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    const child = store.create({ type: 'code', parent: cardId, depth: 2, title: 'child', brief: 'Child brief.', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
    store.commitTerminalLifecyclePatch(child.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'child done' }, error: null, completed_at: '2026-06-12T00:00:00.000Z' }, status_text: 'child done' });
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'planner', 'activate_card') });
    saveSnapshot(projectRoot, `card:${child.id}`, 'card', 'done', { cardId: child.id, active_reconstruction: cardActive(child.id) });
    saveSnapshot(projectRoot, `processor:${child.id}`, 'processor', 'executing', { cardId: child.id, active_reconstruction: terminalProcessorActive(child.id) });
    saveSnapshot(projectRoot, `executor:${child.id}`, 'llm', 'waiting_tool', { cardId: child.id, active_reconstruction: llmWaitingActive(child.id, 'executor', 'emit_result') });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'activate_card', { card_id: child.id });

    expect(recoverActorStartupOutcomes(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store))).toEqual([]);
    expect(store.read(cardId)?.status).toBe('running');
    expect(toolMessageKinds(projectRoot, `planner:${cardId}`)).toEqual(['tool_call']);
  }));

  it('recovers startup outcomes in a single pass without converting projected cards again', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'planner', 'emit_result') });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'emit_result', { status: 'blocked', summary: 'needs operator' });

    const recoveries = recoverActorStartupOutcomes(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store));

    expect(recoveries).toEqual([{ cardId, status: 'blocked', reason: expect.stringContaining('terminal tool call'), actorIds: [`card:${cardId}`, `planner:${cardId}`, `processor:${cardId}`].sort() }]);
    expect(store.read(cardId)).toMatchObject({ status: 'blocked', lifecycle: { status: 'blocked', result: { kind: 'blocked', summary: 'needs operator' } } });
  }));

  it('projects terminal calls before stale pending abandonment in startup recovery', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'planner', 'emit_result') });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'emit_result', { status: 'blocked', summary: 'needs operator' });

    runActorStartupRecovery(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store));

    expect(readConversationMessages(projectRoot, `planner:${cardId}`).filter((message) => message.kind === 'tool_result')).toEqual([
      expect.objectContaining({ id: `planner:${cardId}:1:tool:0:tool-result:call-1`, content: JSON.stringify({ projected: true }) }),
    ]);
  }));

  it('does not alter non-running cards during startup outcome recovery', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    const done = store.create({ type: 'goal', parent: 'project', depth: 1, title: 'done', brief: 'Done brief.', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], retries: 0 });
    store.commitTerminalLifecyclePatch(done.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-06-12T00:00:00.000Z' } });
    saveSnapshot(projectRoot, `planner:${done.id}`, 'llm', 'calling_provider', { cardId: done.id, active_reconstruction: llmActive(done.id) });
    expect(recoverActorStartupOutcomes(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store))).toEqual([]);
    expect(store.read(cardId)?.status).toBe('running');
    expect(store.read(done.id)?.status).toBe('done');
  }));

  it('cleans up stale active snapshots for durable cancelled cards at startup', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    store.setStatus(cardId, 'cancelled');
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'calling_provider', { cardId, active_reconstruction: llmActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });

    const report = runActorStartupRecovery(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store));

    expect(report.incidents).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'cleanup_cancelled_card_snapshots', cardId }),
    ]));
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_id)).toEqual([]);
    expect(readRecoveryDiagnostics(projectRoot)).toBeNull();
  }));
});
