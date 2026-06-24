import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import {
  buildActorRecoveryPlan,
  cleanupConvertedRecoverySnapshots,
  cleanupHandledRecoverySnapshots,
  convertActorRecoveryOutcomes,
  appendLlmTurnFinished,
  PlanningCardProcessorActor,
  recoverActorStartupOutcomes,
  recoverProjectedTerminalToolOutcomes,
  TerminalCardProcessorActor,
  readRecoveryDiagnostics,
  readActorSnapshots,
  readToolCallStatuses,
  recoveryDiagnosticsPath,
  removeActorSnapshot,
  saveActorSnapshot,
  writeRecoveryDiagnostics,
  type LLMProviderPort,
} from '../../../src/runtime/actors/index.js';
import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { CardStore } from '../../../src/cards/card-store.js';

function withTempProject<T>(fn: (projectRoot: string) => Promise<T> | T): Promise<T> | T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-actor-recovery-'));
  const result = fn(projectRoot);
  if (result instanceof Promise) return result.finally(() => rmSync(projectRoot, { recursive: true, force: true }));
  rmSync(projectRoot, { recursive: true, force: true });
  return result;
}

function saveSnapshot(projectRoot: string, actorId: string, actorKind: 'supervisor' | 'card' | 'llm' | 'process' | 'processor', stateValue: unknown, context: Record<string, unknown> = {}): void {
  saveActorSnapshot(projectRoot, {
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
  return { schema_version: 1, kind: 'llm_turn', agent_id: `planner:${cardId}`, role: 'planner', card_id: cardId, input_id: inputId, input: { inputId, agentId: `planner:${cardId}`, role: 'planner', sessionId: `planner:${cardId}`, systemPrompt: 'system', contextMessages: [], tools: [], terminalToolNames: [], modelParams: {}, capabilityRequest: {}, episodeContext: { cardId } }, provider_call_id: null, waiting_tool_call: null, delivered_tool_call_ids: [], tool_delivery_counter: 0, started_at: '2026-06-12T00:00:00.000Z' };
}

function llmWaitingActive(cardId: string, role: 'planner' | 'reviewer' | 'executor', toolName: string, toolCallId = 'call-1', assessmentId = `assessment-${cardId}-1`): Record<string, unknown> {
  const agentId = `${role}:${cardId}`;
  const inputId = `${role}:${cardId}:1`;
  return { ...llmActive(cardId, inputId), agent_id: agentId, role, input_id: inputId, input: { inputId, agentId, role, sessionId: role === 'reviewer' ? `reviewer:${cardId}:${assessmentId}` : agentId, systemPrompt: 'system', contextMessages: [], tools: [], terminalToolNames: [], modelParams: {}, capabilityRequest: {}, episodeContext: role === 'reviewer' ? { cardId, assessmentId } : { cardId } }, waiting_tool_call: { sourceInputId: inputId, toolCallId, toolName } };
}

function appendLoggedToolCall(projectRoot: string, cardId: string, role: 'planner' | 'reviewer' | 'executor', toolName: string, args: unknown, toolCallId = 'call-1'): void {
  const agentId = `${role}:${cardId}`;
  const inputId = `${role}:${cardId}:1`;
  appendLlmTurnFinished(projectRoot, { inputId, agentId, role, sessionId: agentId, systemPrompt: 'system', contextMessages: [], tools: [], terminalToolNames: [], modelParams: {}, capabilityRequest: {}, episodeContext: { cardId } }, { kind: 'tool_calls', tool_calls: [{ id: toolCallId, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] });
}

function reviewerPass(evidenceId: string, summary = 'review ok'): Record<string, unknown> {
  return { assessment: { result: 'pass', summary, achieved: ['done'], issues: [], evidence_card_ids: [evidenceId] } };
}

function reviewerCorrections(evidenceId: string, summary = 'needs correction'): Record<string, unknown> {
  return { assessment: { result: 'needs_corrections', summary, achieved: [], issues: [{ severity: 'blocker', summary }], evidence_card_ids: [evidenceId] } };
}

function recoveryProcessorDeps(projectRoot: string, store: CardStore) {
  const provider: LLMProviderPort = { completeTurn: jest.fn(async () => ({ kind: 'message' as const, content: 'unused' })) };
  return {
    projectRoot,
    store,
    generatedAt: '2026-06-12T00:00:00.000Z',
    makePlanningProcessor: (cardId: string) => new PlanningCardProcessorActor({ projectRoot, cardId, store, children: { get: () => null }, provider }),
    makeTerminalProcessor: (cardId: string) => new TerminalCardProcessorActor({ projectRoot, cardId, provider }),
  };
}

function createRunningGoal(projectRoot: string): { store: CardStore; cardId: string } {
  initProjectTree(projectRoot);
  const store = new CardStore(projectRoot);
  store.create({ type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
  const card = store.create({ type: 'goal', parent: 'project', depth: 1, title: 'goal', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
  store.setStatus(card.id, 'running');
  return { store, cardId: card.id };
}

function createDoneEvidence(store: CardStore, parent: string): string {
  const card = store.create({ type: 'code', parent, depth: 2, title: 'evidence', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
  store.commitTerminalLifecyclePatch(card.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'executor_success', executor: { summary: 'done' }, generated_files: [], verified_at: '2026-06-12T00:00:00.000Z', latest_self_report: { result: 'done', outcome: 'done', summary: 'done', status_text: 'done', at: '2026-06-12T00:00:00.000Z' }, warnings: [] }, error: null, completed_at: '2026-06-12T00:00:00.000Z' } });
  return card.id;
}

function createRunningTerminalCard(projectRoot: string): { store: CardStore; cardId: string } {
  initProjectTree(projectRoot);
  const store = new CardStore(projectRoot);
  store.create({ type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
  const card = store.create({ type: 'code', parent: 'project', depth: 1, title: 'code', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
  store.setStatus(card.id, 'running');
  return { store, cardId: card.id };
}

describe('actor recovery plan', () => {
  it('builds an empty plan when no actor snapshots exist', () => withTempProject((projectRoot) => {
    expect(buildActorRecoveryPlan(projectRoot)).toEqual({ supervisor: null, cards: [], llms: [], processors: [], processes: [], diagnostics: [] });
  }));

  it('builds a deterministic plan for supervisor, active goal card, and planner LLM snapshots', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'planner:G-1', 'llm', 'calling_provider', { cardId: 'G-1', active_reconstruction: llmActive('G-1') });
    saveSnapshot(projectRoot, 'supervisor', 'supervisor', { mode: 'running', work: 'ready' }, { projectRoot });
    saveSnapshot(projectRoot, 'card:G-1', 'card', 'running', { cardId: 'G-1', active_reconstruction: cardActive('G-1') });

    const plan = buildActorRecoveryPlan(projectRoot);

    expect(plan.supervisor?.actor_id).toBe('supervisor');
    expect(plan.cards).toMatchObject([{ cardId: 'G-1', active: true, activeReconstruction: expect.objectContaining({ kind: 'card_activation' }) }]);
    expect(plan.llms).toMatchObject([{ actorId: 'planner:G-1', role: 'planner', cardId: 'G-1', active: true, activeReconstruction: expect.objectContaining({ kind: 'llm_turn' }), action: 'abandon_provider_call' }]);
    expect(plan.processors).toEqual([]);
    expect(plan.processes).toEqual([]);
  }));

  it('includes terminal executor and process snapshots with abandonment requirements', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'card:T-1', 'card', 'running', { cardId: 'T-1', active_reconstruction: cardActive('T-1') });
    saveSnapshot(projectRoot, 'executor:T-1', 'llm', 'idle', { cardId: 'T-1' });
    saveSnapshot(projectRoot, 'process:build-1', 'process', 'running', { processId: 'build-1' });
    saveSnapshot(projectRoot, 'process:done-1', 'process', 'settled', { processId: 'done-1' });

    const plan = buildActorRecoveryPlan(projectRoot);

    expect(plan.llms).toMatchObject([{ actorId: 'executor:T-1', role: 'executor', cardId: 'T-1', active: false }]);
    expect(plan.processes).toMatchObject([
      { processId: 'build-1', action: 'abandon_running_process' },
      { processId: 'done-1', action: 'none' },
    ]);
    expect(plan.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: 'card:T-1', severity: 'warning' }),
      expect.objectContaining({ actorId: 'process:build-1', severity: 'warning' }),
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
    saveSnapshot(projectRoot, 'reviewer:G-1', 'llm', 'waiting_tool', { cardId: 'G-1', active_reconstruction: { ...llmActive('G-1'), agent_id: 'reviewer:G-1', role: 'reviewer', waiting_tool_call: { sourceInputId: 'reviewer:G-1:1', toolCallId: 'call-1', toolName: 'tool' } } });

    const plan = buildActorRecoveryPlan(projectRoot);

    expect(plan.processors).toMatchObject([{ actorId: 'processor:G-1', cardId: 'G-1', active: true, activeReconstruction: expect.objectContaining({ kind: 'processor_activation' }) }]);
    expect(plan.llms).toMatchObject([
      { actorId: 'planner:G-1', action: 'abandon_provider_call', active: true },
      { actorId: 'reviewer:G-1', action: 'resume_tool_wait', active: true },
    ]);
    expect(plan.diagnostics).toEqual([
      expect.objectContaining({ actorId: 'planner:G-1', severity: 'warning' }),
      expect.objectContaining({ actorId: 'processor:G-1', severity: 'warning' }),
      expect.objectContaining({ actorId: 'reviewer:G-1', severity: 'info' }),
    ]);
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

    expect(plan.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: 'planner:G-1', severity: 'warning' }),
    ]));
  }));

  it('diagnoses active cards without active processor, LLM, or active child evidence', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'card:G-stranded', 'card', 'running', { cardId: 'G-stranded', active_reconstruction: cardActive('G-stranded') });

    const plan = buildActorRecoveryPlan(projectRoot, { read: jest.fn(() => null), listChildren: jest.fn(() => []) });

    expect(plan.diagnostics).toEqual([expect.objectContaining({ actorId: 'card:G-stranded', severity: 'warning' })]);
    expect(plan.diagnostics[0].message).toContain('no active processor');
  }));

  it('does not diagnose active cards as stranded when processor or active child evidence exists', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'card:G-processor', 'card', 'running', { cardId: 'G-processor', active_reconstruction: cardActive('G-processor') });
    saveSnapshot(projectRoot, 'processor:G-processor', 'processor', 'planning', { cardId: 'G-processor', active_reconstruction: processorActive('G-processor') });
    saveSnapshot(projectRoot, 'card:G-parent', 'card', 'running', { cardId: 'G-parent', active_reconstruction: cardActive('G-parent') });
    saveSnapshot(projectRoot, 'card:G-child', 'card', 'running', { cardId: 'G-child', active_reconstruction: cardActive('G-child') });
    const children = new Map<string, string[]>([['G-parent', ['G-child']]]);

    const plan = buildActorRecoveryPlan(projectRoot, { read: jest.fn(() => null), listChildren: jest.fn((cardId: string) => children.get(cardId) ?? []) });

    expect(plan.diagnostics.filter((diagnostic) => diagnostic.message.includes('no active processor')).map((diagnostic) => diagnostic.actorId)).toEqual(['card:G-child']);
  }));

  it('diagnoses ambiguous active card states', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'card:G-old', 'card', 'planning', { cardId: 'G-old', active_reconstruction: cardActive('G-old') });

    const plan = buildActorRecoveryPlan(projectRoot);

    expect(plan.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: 'card:G-old', severity: 'warning' }),
    ]));
    expect(plan.diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toContain("ambiguous state 'planning'");
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
        expect.objectContaining({ actorId: 'planner:G-1', kind: 'llm_recovery_action', action: 'abandon_provider_call', cardId: 'G-1' }),
      ]),
    });
    expect(readRecoveryDiagnostics(projectRoot)).toEqual(written);
    expect(JSON.stringify(readRecoveryDiagnostics(projectRoot))).not.toContain('not persisted');
  }));

  it('clears stale recovery diagnostics when recovery work is clean', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'process:build-1', 'process', 'running', { processId: 'build-1' });
    expect(writeRecoveryDiagnostics(projectRoot, buildActorRecoveryPlan(projectRoot), '2026-06-12T00:00:00.000Z')).not.toBeNull();
    expect(existsSync(recoveryDiagnosticsPath(projectRoot))).toBe(true);

    removeActorSnapshot(projectRoot, 'process:build-1');
    expect(writeRecoveryDiagnostics(projectRoot, buildActorRecoveryPlan(projectRoot), '2026-06-12T00:00:01.000Z')).toBeNull();
    expect(existsSync(recoveryDiagnosticsPath(projectRoot))).toBe(false);
  }));

  it('diagnoses non-idle supervisor snapshots as discarded on startup', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'supervisor', 'supervisor', { mode: 'running', work: 'model_invocation_active' }, { projectRoot, activeProviderCallId: 'call-1' });

    const written = writeRecoveryDiagnostics(projectRoot, buildActorRecoveryPlan(projectRoot), '2026-06-12T00:00:00.000Z');

    expect(written).toMatchObject({
      diagnostics: [expect.objectContaining({ actorId: 'supervisor', severity: 'warning' })],
      actions: [expect.objectContaining({ actorId: 'supervisor', kind: 'discarded_supervisor', action: 'discard_stale_supervisor' })],
    });
  }));

  it('persists running process abandonment diagnostics instead of reconciliation requests', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'process:build-1', 'process', 'running', { processId: 'build-1' });
    saveSnapshot(projectRoot, 'process:kill-1', 'process', 'killing', { processId: 'kill-1' });

    const written = writeRecoveryDiagnostics(projectRoot, buildActorRecoveryPlan(projectRoot), '2026-06-12T00:00:00.000Z');

    expect(written).toMatchObject({
      actions: expect.arrayContaining([
        expect.objectContaining({ actorId: 'process:build-1', kind: 'running_process', action: 'abandon_running_process', processId: 'build-1' }),
        expect.objectContaining({ actorId: 'process:kill-1', kind: 'running_process', action: 'abandon_running_process', processId: 'kill-1' }),
      ]),
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ actorId: 'process:build-1', severity: 'warning' }),
        expect.objectContaining({ actorId: 'process:kill-1', severity: 'warning' }),
      ]),
    });
    const messages = written?.diagnostics.map((diagnostic) => diagnostic.message).join('\n') ?? '';
    expect(messages).toContain('abandoned on startup');
    expect(messages).not.toContain('requires live process reconciliation');
  }));

  it('cleans up only abandoned process snapshots after diagnostics are written', () => withTempProject((projectRoot) => {
    saveSnapshot(projectRoot, 'process:build-1', 'process', 'running', { processId: 'build-1' });
    saveSnapshot(projectRoot, 'process:done-1', 'process', 'settled', { processId: 'done-1' });
    saveSnapshot(projectRoot, 'card:G-1', 'card', 'running', { cardId: 'G-1', active_reconstruction: cardActive('G-1') });
    const plan = buildActorRecoveryPlan(projectRoot);
    writeRecoveryDiagnostics(projectRoot, plan, '2026-06-12T00:00:00.000Z');

    cleanupHandledRecoverySnapshots(projectRoot, plan);

    expect(readRecoveryDiagnostics(projectRoot)?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: 'process:build-1', action: 'abandon_running_process' }),
    ]));
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_id)).toEqual(expect.arrayContaining(['card:G-1', 'process:done-1']));
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_id)).not.toContain('process:build-1');
  }));

  it('converts interrupted running card work into a blocked card outcome', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'calling_provider', { cardId, active_reconstruction: llmActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    const plan = buildActorRecoveryPlan(projectRoot, store);

    const conversions = convertActorRecoveryOutcomes(plan, store, '2026-06-12T00:00:00.000Z');

    expect(conversions).toEqual([{ cardId, status: 'blocked', reason: expect.stringContaining('cannot be safely resumed'), actorIds: [`card:${cardId}`, `planner:${cardId}`, `processor:${cardId}`].sort() }]);
    expect(store.read(cardId)).toMatchObject({
      status: 'blocked',
      lifecycle: { status: 'blocked', result: { kind: 'planner_blocked', blocker_cause: 'generic' } },
      status_text: expect.stringContaining('cannot be safely resumed'),
    });
  }));

  it('recovers a persisted planner blocked terminal tool call', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'planner', 'emit_planner_result') });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'emit_planner_result', { status: 'blocked', blocked_reason: 'needs operator', summary: 'needs operator' });
    const plan = buildActorRecoveryPlan(projectRoot, store);

    const recoveries = recoverProjectedTerminalToolOutcomes(plan, recoveryProcessorDeps(projectRoot, store));
    cleanupConvertedRecoverySnapshots(projectRoot, recoveries);

    expect(recoveries).toEqual([{ cardId, status: 'blocked', reason: expect.stringContaining('terminal tool call'), actorIds: [`card:${cardId}`, `planner:${cardId}`, `processor:${cardId}`].sort() }]);
    expect(store.read(cardId)).toMatchObject({ status: 'blocked', lifecycle: { status: 'blocked', result: { kind: 'planner_blocked', blocked_reason: 'needs operator' } } });
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_id)).toEqual([]);
    expect(convertActorRecoveryOutcomes(buildActorRecoveryPlan(projectRoot, store), store)).toEqual([]);
  }));

  it('does not recover planner done terminal tool calls before reviewer reconstruction exists', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'planner', 'emit_planner_result') });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'emit_planner_result', { status: 'done', summary: 'done' });
    const plan = buildActorRecoveryPlan(projectRoot, store);

    expect(recoverProjectedTerminalToolOutcomes(plan, recoveryProcessorDeps(projectRoot, store))).toEqual([]);
    expect(convertActorRecoveryOutcomes(plan, store)).toEqual([{ cardId, status: 'blocked', reason: expect.stringContaining('cannot be safely resumed'), actorIds: [`card:${cardId}`, `planner:${cardId}`, `processor:${cardId}`].sort() }]);
  }));

  it('recovers paired planner done and reviewer pass terminal tool calls', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    const evidenceId = createDoneEvidence(store, cardId);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'planner', 'emit_planner_result') });
    saveSnapshot(projectRoot, `reviewer:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'reviewer', 'emit_reviewer_result') });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'emit_planner_result', { status: 'done', summary: 'done' });
    appendLoggedToolCall(projectRoot, cardId, 'reviewer', 'emit_reviewer_result', reviewerPass(evidenceId));

    const recoveries = recoverProjectedTerminalToolOutcomes(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store));
    cleanupConvertedRecoverySnapshots(projectRoot, recoveries);

    expect(recoveries).toEqual([{ cardId, status: 'done', reason: expect.stringContaining('planner and reviewer'), actorIds: [`card:${cardId}`, `planner:${cardId}`, `processor:${cardId}`, `reviewer:${cardId}`].sort() }]);
    expect(store.read(cardId)).toMatchObject({ status: 'done', lifecycle: { status: 'done', result: { kind: 'reviewer_pass', planning: { kind: 'planner_done', summary: 'done' } } } });
    expect(readToolCallStatuses(projectRoot).filter((record) => record.status === 'terminal_projected').map((record) => record.agent_id).sort()).toEqual([`planner:${cardId}`, `reviewer:${cardId}`].sort());
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_id)).toEqual([]);
  }));

  it('recovers paired planner done and reviewer correction terminal tool calls as blocked', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    const evidenceId = createDoneEvidence(store, cardId);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'planner', 'emit_planner_result') });
    saveSnapshot(projectRoot, `reviewer:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'reviewer', 'emit_reviewer_result') });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'emit_planner_result', { status: 'done', summary: 'done' });
    appendLoggedToolCall(projectRoot, cardId, 'reviewer', 'emit_reviewer_result', reviewerCorrections(evidenceId, 'fix issue'));

    const recoveries = recoverProjectedTerminalToolOutcomes(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store));

    expect(recoveries).toEqual([{ cardId, status: 'blocked', reason: expect.stringContaining('planner and reviewer'), actorIds: [`card:${cardId}`, `planner:${cardId}`, `processor:${cardId}`, `reviewer:${cardId}`].sort() }]);
    expect(store.read(cardId)).toMatchObject({ status: 'blocked', lifecycle: { status: 'blocked', result: { kind: 'planner_blocked', reviewer_correction: { assessment_id: `assessment-${cardId}-1`, summary: 'fix issue' } } } });
  }));

  it('refuses planner done recovery when reviewer reconstruction identity is missing', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    const evidenceId = createDoneEvidence(store, cardId);
    const reviewer = llmWaitingActive(cardId, 'reviewer', 'emit_reviewer_result');
    (reviewer.input as Record<string, unknown>).episodeContext = { cardId };
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'planner', 'emit_planner_result') });
    saveSnapshot(projectRoot, `reviewer:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: reviewer });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'emit_planner_result', { status: 'done', summary: 'done' });
    appendLoggedToolCall(projectRoot, cardId, 'reviewer', 'emit_reviewer_result', reviewerPass(evidenceId));

    expect(recoverProjectedTerminalToolOutcomes(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store))).toEqual([]);
  }));

  it('refuses planner done recovery when descendants are incomplete', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    const incomplete = store.create({ type: 'code', parent: cardId, depth: 2, title: 'incomplete', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'planner', 'emit_planner_result') });
    saveSnapshot(projectRoot, `reviewer:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'reviewer', 'emit_reviewer_result') });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'emit_planner_result', { status: 'done', summary: 'done' });
    appendLoggedToolCall(projectRoot, cardId, 'reviewer', 'emit_reviewer_result', reviewerPass(incomplete.id));

    expect(recoverProjectedTerminalToolOutcomes(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store))).toEqual([]);
    expect(store.read(cardId)?.status).toBe('running');
  }));

  it('recovers a persisted executor terminal success tool call', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningTerminalCard(projectRoot);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'executing', { cardId, active_reconstruction: terminalProcessorActive(cardId) });
    saveSnapshot(projectRoot, `executor:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'executor', 'emit_executor_result') });
    appendLoggedToolCall(projectRoot, cardId, 'executor', 'emit_executor_result', { card_id: cardId, status: 'done', status_text: 'implemented', summary: 'implemented', artifacts: [], attachments: [] });

    const recoveries = recoverProjectedTerminalToolOutcomes(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store));

    expect(recoveries).toEqual([{ cardId, status: 'done', reason: expect.stringContaining('terminal tool call'), actorIds: [`card:${cardId}`, `executor:${cardId}`, `processor:${cardId}`].sort() }]);
    expect(store.read(cardId)).toMatchObject({ status: 'done', lifecycle: { status: 'done', result: { kind: 'executor_success' } }, status_text: 'implemented' });
  }));

  it('converts nonterminal waiting tool calls through the generic blocked path', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'planner', 'activate_card') });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'activate_card', { card_id: 'child' });
    const plan = buildActorRecoveryPlan(projectRoot, store);

    expect(recoverProjectedTerminalToolOutcomes(plan, recoveryProcessorDeps(projectRoot, store))).toEqual([]);
    expect(convertActorRecoveryOutcomes(plan, store)).toEqual([{ cardId, status: 'blocked', reason: expect.stringContaining('cannot be safely resumed'), actorIds: [`card:${cardId}`, `planner:${cardId}`, `processor:${cardId}`].sort() }]);
  }));

  it('recovers startup outcomes in a single pass without converting projected cards again', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'waiting_tool', { cardId, active_reconstruction: llmWaitingActive(cardId, 'planner', 'emit_planner_result') });
    appendLoggedToolCall(projectRoot, cardId, 'planner', 'emit_planner_result', { status: 'blocked', blocked_reason: 'needs operator', summary: 'needs operator' });

    const recoveries = recoverActorStartupOutcomes(buildActorRecoveryPlan(projectRoot, store), recoveryProcessorDeps(projectRoot, store));
    cleanupConvertedRecoverySnapshots(projectRoot, recoveries);

    expect(recoveries).toEqual([{ cardId, status: 'blocked', reason: expect.stringContaining('terminal tool call'), actorIds: [`card:${cardId}`, `planner:${cardId}`, `processor:${cardId}`].sort() }]);
    expect(store.read(cardId)).toMatchObject({ status: 'blocked', lifecycle: { status: 'blocked', result: { kind: 'planner_blocked', blocked_reason: 'needs operator' } } });
    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_id)).toEqual([]);
    expect(convertActorRecoveryOutcomes(buildActorRecoveryPlan(projectRoot, store), store)).toEqual([]);
  }));

  it('does not convert process-only work or non-running cards', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    saveSnapshot(projectRoot, 'process:build-1', 'process', 'running', { processId: 'build-1' });
    const done = store.create({ type: 'goal', parent: 'project', depth: 1, title: 'done', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
    store.commitTerminalLifecyclePatch(done.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'planner_done', summary: 'done' }, error: null, completed_at: '2026-06-12T00:00:00.000Z' } });
    saveSnapshot(projectRoot, `planner:${done.id}`, 'llm', 'calling_provider', { cardId: done.id, active_reconstruction: llmActive(done.id) });
    const plan = buildActorRecoveryPlan(projectRoot, store);

    expect(convertActorRecoveryOutcomes(plan, store, '2026-06-12T00:00:00.000Z')).toEqual([]);
    expect(store.read(cardId)?.status).toBe('running');
    expect(store.read(done.id)?.status).toBe('done');
  }));

  it('cleans up converted card, LLM, and processor snapshots', () => withTempProject((projectRoot) => {
    const { store, cardId } = createRunningGoal(projectRoot);
    saveSnapshot(projectRoot, `card:${cardId}`, 'card', 'running', { cardId, active_reconstruction: cardActive(cardId) });
    saveSnapshot(projectRoot, `planner:${cardId}`, 'llm', 'calling_provider', { cardId, active_reconstruction: llmActive(cardId) });
    saveSnapshot(projectRoot, `processor:${cardId}`, 'processor', 'planning', { cardId, active_reconstruction: processorActive(cardId) });
    const plan = buildActorRecoveryPlan(projectRoot, store);
    const conversions = convertActorRecoveryOutcomes(plan, store, '2026-06-12T00:00:00.000Z');

    cleanupConvertedRecoverySnapshots(projectRoot, conversions);

    expect(readActorSnapshots(projectRoot).map((snapshot) => snapshot.actor_id)).toEqual([]);
  }));
});
