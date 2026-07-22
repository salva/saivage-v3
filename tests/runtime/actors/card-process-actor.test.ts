import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { appendConversationBatch, readConversation } from '../../../src/persistence/conversation-file.js';
import { AppLogPublicationError } from '../../../src/persistence/app-log.js';
import { cardProcessesSchema } from '../../../src/schemas/saivage-config.js';
import { DEFAULT_CARD_PROCESSES } from '../../../src/agents/default-card-processes.js';
import { compileCardProcesses, type CompiledCardProcess } from '../../../src/runtime/card-process/card-process-config.js';
import { estimateCanonicalStaticTokens } from '../../../src/runtime/actors/compaction/compactor.js';
import { AgentNodeExecution } from '../../../src/runtime/actors/agent-node-execution.js';
import { ConversationLLMActor } from '../../../src/runtime/actors/llm-actor.js';
import { appendActivationMarker } from '../../../src/runtime/actors/conversation-session.js';
import { agentMessageSchema } from '../../../src/schemas/index.js';

const tool = (id: string, outcome: string, summary = outcome): ProviderTurnCompletion => ({ result: { kind: 'tool_calls', tool_calls: [{ id, type: 'function', function: { name: 'emit_result', arguments: JSON.stringify({ outcome, summary }) } }] }, provider_exchanges: [] });

describe('CardProcessActor configured graph execution', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function harness(completeTurn: LLMProviderPort['completeTurn'], options: { cardType?: 'project' | 'code'; process?: CompiledCardProcess; entry?: 'BACKLOG' | 'CHANGED' | 'BLOCKED' | 'STOPPED'; runtimeProjectionChanged?: () => void; publicationError?: AppLogPublicationError; publicationFailureMarker?: () => void; removeNotifications?: (store: CardService, cardId: string, ids: readonly string[]) => void; onClaim?: () => void; renderPrompt?: (toolList: string) => string } = {}) {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-card-process-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const store = new CardService(projectRoot);
    const cardId = options.cardType === 'code'
      ? store.create({ type: 'code', parent: 'project', title: 'code', brief: 'code', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] }).id
      : 'project';
    const processes = createTestProcessRunner(projectRoot);
    const processRunner = processes.processRunner;
    const actor = new CardProcessActor({
      projectRoot, cardId, process: options.process ?? (options.cardType === 'code' ? testAutonomousCompaction.cardProcesses.terminal : testAutonomousCompaction.cardProcesses.planning),
      store, parentControl: { activateChild: async () => { throw new Error('unused'); }, cancelChild: async () => { throw new Error('unused'); } },
      notifyCard: () => ({ ok: true, notificationId: 'unused' }), provider: { completeTurn, projectProviderExchanges: () => { if (options.publicationError) { options.publicationFailureMarker?.(); throw options.publicationError; } } }, conversations: { projectRoot },
      processRunner, runtimeProcessRootScope: processes.runtimeProcessRootScope, promptTemplates: { render: (_type, _role, values) => options.renderPrompt ? options.renderPrompt(values.toolList) : String(values.contractDescription) },
      runtimeProjectionChanged: options.runtimeProjectionChanged ?? (() => undefined), ...testAutonomousCompaction,
    });
    actor.start();
    const claimResult = jest.fn(() => options.onClaim?.());
    const input = () => ({ activationId: 'activation-test', card: store.read(cardId)!, caller: { kind: 'root' as const }, entry: options.entry ?? 'BACKLOG', claimResult, alreadyStabilizedRoles: new Set<'planner' | 'reviewer' | 'executor'>(), notificationDelivery: { selectNotifications: () => store.read(cardId)!.pending_notifications, removeNotifications: (ids: readonly string[]) => { options.removeNotifications ? options.removeNotifications(store, cardId, ids) : store.removeNotifications(cardId, [...ids]); } } });
    return { projectRoot, cardId, store, processRunner, actor, claimResult, input };
  }

  function nodeExecutionHarness(completeTurn: LLMProviderPort['completeTurn']) {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-agent-node-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const store = new CardService(projectRoot);
    const cardId = store.create({ type: 'code', parent: 'project', title: 'code', brief: 'code', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] }).id;
    const processes = createTestProcessRunner(projectRoot);
    const process = testAutonomousCompaction.cardProcesses.terminal;
    const stateId = 'node:execute';
    const node = process.states.get(stateId);
    if (!node || node.kind !== 'node') throw new Error('Missing test executor node.');
    const execution = new AgentNodeExecution({
      projectRoot, cardId, store,
      parentControl: { activateChild: async () => { throw new Error('unused'); }, cancelChild: async () => { throw new Error('unused'); } },
      notifyCard: () => ({ ok: true, notificationId: 'unused' }),
      processRunner: processes.processRunner, runtimeProcessRootScope: processes.runtimeProcessRootScope,
      promptTemplates: { render: () => 'executor prompt' }, conversations: { projectRoot },
      ...testAutonomousCompaction,
    }, {
      createLlm: (agentId) => new ConversationLLMActor({
        agentId, provider: { completeTurn }, conversations: { projectRoot },
        compactor: testAutonomousCompaction.compactor, summarizerProvider: testAutonomousCompaction.summarizerProvider,
      }),
      selectLlm: () => undefined,
      freshInputId: () => '00000000-0000-4000-8000-000000000001',
      assertCurrentActivation: () => undefined,
    });
    const input = {
      activationId: 'activation-test', card: store.read(cardId)!, caller: { kind: 'root' as const }, entry: 'BACKLOG' as const,
      claimResult: jest.fn(), alreadyStabilizedRoles: new Set<'planner' | 'reviewer' | 'executor'>(['executor']),
      notificationDelivery: { selectNotifications: () => store.read(cardId)!.pending_notifications, removeNotifications: (ids: readonly string[]) => store.removeNotifications(cardId, [...ids]) },
    };
    return {
      cardId, store, processRunner: processes.processRunner,
      execute: () => execution.execute({ process, stateId, node, transition: { context: { source: 'entry:BACKLOG', event: 'entry:route', target: stateId, reentered: false }, acceptedResult: null }, input, signal: new AbortController().signal, nodeOrdinal: 0 }),
    };
  }

  it('keeps autonomous prompt tools operational-only and provider/compaction tools terminal-last for every role', async () => {
    const captured: LlmInvocationInput[] = [];
    const execute = async (cardType: 'project' | 'code', routeReviewer: boolean) => {
      let h!: ReturnType<typeof harness>;
      h = harness(async (input) => {
        captured.push(input);
        const filename = input.role === 'reviewer' ? 'review.md' : 'status.md';
        const open = h.store.openRecord(h.cardId, filename);
        h.store.editRecord(h.cardId, filename, open.version, `${input.role} evidence`);
        return input.role === 'planner' && routeReviewer ? tool('route-reviewer', 'admit_review') : input.role === 'reviewer' ? tool('approve', 'approved') : tool('complete', input.role === 'planner' ? 'complete_direct' : 'done');
      }, { cardType, renderPrompt: (toolList) => toolList });
      await h.actor.activate(h.input(), new AbortController().signal);
    };
    await execute('project', false);
    await execute('project', true);
    await execute('code', false);

    const byRole = new Map(captured.map((input) => [input.role, input]));
    expect([...byRole.keys()].sort()).toEqual(['executor', 'planner', 'reviewer']);
    for (const role of ['planner', 'reviewer', 'executor'] as const) {
      const input = byRole.get(role)!;
      const finalNames = input.tools.map((definition) => definition.function.name);
      const operationalNames = finalNames.slice(0, -1);
      const promptNames = input.systemPrompt.split('\n').filter(Boolean).map((line) => line.slice(2, line.indexOf(':')));
      expect(promptNames).toEqual(operationalNames);
      expect(promptNames).not.toContain('emit_result');
      expect(finalNames).toEqual([...operationalNames, 'emit_result']);
      expect(finalNames.filter((name) => name === 'emit_result')).toHaveLength(1);
      expect(input.preparedCompaction?.estimatedStaticTokens).toBe(estimateCanonicalStaticTokens(input.systemPrompt, input.tools));
      expect(input.preparedCompaction?.estimatedStaticTokens).not.toBe(estimateCanonicalStaticTokens(input.systemPrompt, input.tools.slice(0, -1)));
    }
  });

  it('routes complete_direct to DONE without reviewer and claims only after fresh status evidence', async () => {
    const roles: string[] = [];
    const h = harness(async (input) => { roles.push(input.role); const open = h.store.openRecord('project', 'status.md'); h.store.editRecord('project', 'status.md', open.version, 'complete'); return tool('plan-done', 'complete_direct'); });
    const outcome = await h.actor.activate(h.input(), new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'done', summary: 'complete_direct' });
    expect(roles).toEqual(['planner']);
    expect(h.claimResult).toHaveBeenCalledTimes(1);
    expect(h.store.readRecord('project', 'status.md', 'latest').artifact.content).toBe('complete');
  });

  it('uses the conversation context root for real-actor recovery and projection while planner tools use the workspace root', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'saivage-card-workspace-root-'));
    const conversationRoot = mkdtempSync(join(tmpdir(), 'saivage-card-conversation-root-'));
    roots.push(workspaceRoot, conversationRoot);
    initProjectTree(workspaceRoot);
    initProjectTree(conversationRoot);
    writeFileSync(join(workspaceRoot, 'same-path.txt'), 'workspace-root-value');
    writeFileSync(join(conversationRoot, 'same-path.txt'), 'conversation-root-value');

    const sessionId = 'planner:project';
    const interruptedInputId = '11111111-1111-4111-8111-111111111111';
    const contextMarker = appendActivationMarker({ projectRoot: conversationRoot }, sessionId, { event: 'activation_open', role: 'planner', card_id: 'project', input_id: interruptedInputId });
    appendConversationBatch({ projectRoot: conversationRoot }, [agentMessageSchema.parse({
      id: `${interruptedInputId}:message`, session_id: sessionId, role: 'assistant', kind: 'text', content: 'context-root interrupted planner state',
      round_id: contextMarker.round_id, message_index: 1, block_index: 0, timestamp: '2026-07-22T00:00:00.000Z',
    })]);

    const decoyInputId = '22222222-2222-4222-8222-222222222222';
    const decoyMarker = appendActivationMarker({ projectRoot: workspaceRoot }, sessionId, { event: 'activation_open', role: 'planner', card_id: 'project', input_id: decoyInputId });
    appendConversationBatch({ projectRoot: workspaceRoot }, [
      agentMessageSchema.parse({ id: `${decoyInputId}:tool-call:decoy`, session_id: sessionId, role: 'assistant', kind: 'tool_call', tool: 'emit_result', tool_call_id: 'decoy', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'decoy', type: 'function', function: { name: 'emit_result', arguments: '{}' } }] }), round_id: decoyMarker.round_id, message_index: 1, block_index: 0, timestamp: '2026-07-22T00:00:00.000Z' }),
      agentMessageSchema.parse({ id: `${decoyInputId}:tool-result:decoy`, session_id: sessionId, role: 'tool', kind: 'tool_result', tool: 'emit_result', tool_call_id: 'decoy', content: JSON.stringify({ success: true }), round_id: decoyMarker.round_id, message_index: 2, block_index: 0, timestamp: '2026-07-22T00:00:00.001Z' }),
    ]);
    const workspaceDecoyBefore = readConversation(workspaceRoot, sessionId).physicalRows;

    const store = new CardService(workspaceRoot);
    const processes = createTestProcessRunner(workspaceRoot);
    const providerInputs: LlmInvocationInput[] = [];
    const provider: LLMProviderPort = { completeTurn: async (input) => {
      providerInputs.push(input);
      if (providerInputs.length === 1) {
        expect(input.providerConversation.messages).toContainEqual(expect.objectContaining({ content: 'context-root interrupted planner state' }));
        expect(input.providerConversation.messages).toContainEqual(expect.objectContaining({ kind: 'model_recovered' }));
        expect(input.providerConversation.messages).not.toContainEqual(expect.objectContaining({ tool_call_id: 'decoy' }));
        return { result: { kind: 'tool_calls', tool_calls: [{ id: 'read-workspace', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'project:///same-path.txt' }) } }] }, provider_exchanges: [] };
      }
      expect(input.providerConversation.messages.some((message) => message.kind === 'tool_result' && message.content.includes('workspace-root-value'))).toBe(true);
      expect(input.providerConversation.messages.every((message) => !message.content.includes('conversation-root-value'))).toBe(true);
      const open = store.openRecord('project', 'status.md');
      store.editRecord('project', 'status.md', open.version, 'distinct roots accepted');
      return tool('accepted', 'complete_direct', 'distinct roots accepted');
    } };
    const actor = new CardProcessActor({
      projectRoot: workspaceRoot, cardId: 'project', process: testAutonomousCompaction.cardProcesses.planning,
      store, parentControl: { activateChild: async () => { throw new Error('unused'); }, cancelChild: async () => { throw new Error('unused'); } },
      notifyCard: () => ({ ok: true, notificationId: 'unused' }), provider, conversations: { projectRoot: conversationRoot },
      processRunner: processes.processRunner, runtimeProcessRootScope: processes.runtimeProcessRootScope,
      promptTemplates: { render: () => 'planner prompt' }, runtimeProjectionChanged() {}, ...testAutonomousCompaction,
    });
    actor.start();
    const claimResult = jest.fn();
    const outcome = await actor.activate({ activationId: 'distinct-root-activation', card: store.read('project')!, caller: { kind: 'root' }, entry: 'BACKLOG', claimResult, alreadyStabilizedRoles: new Set(), notificationDelivery: { selectNotifications: () => [], removeNotifications: () => undefined } }, new AbortController().signal);

    expect(outcome).toMatchObject({ status: 'done', summary: 'distinct roots accepted' });
    expect(claimResult).toHaveBeenCalledTimes(1);
    expect(providerInputs).toHaveLength(2);
    expect(readConversation(workspaceRoot, sessionId).physicalRows).toEqual(workspaceDecoyBefore);
    expect(readConversation(conversationRoot, sessionId).sourceRows).toContainEqual(expect.objectContaining({ id: `${interruptedInputId}:model-recovered` }));
  });

  it.each(['BACKLOG', 'CHANGED', 'BLOCKED', 'STOPPED'] as const)('routes %s through observable entry and first-node states with exact optional prompt behavior', async (entry) => {
    const positions: string[] = [];
    let h!: ReturnType<typeof harness>;
    h = harness(async () => { const open = h.store.openRecord('project', 'status.md'); h.store.editRecord('project', 'status.md', open.version, 'complete'); return tool('done', 'complete_direct'); }, { entry, runtimeProjectionChanged: () => { if (h) positions.push(h.actor.processPosition().stateId); } });
    await expect(h.actor.activate(h.input(), new AbortController().signal)).resolves.toMatchObject({ status: 'done' });
    expect(positions).toEqual(expect.arrayContaining([`entry:${entry}`, `node:${entry === 'STOPPED' ? 'recover' : 'plan'}`, 'terminal:DONE']));
    const transitionRows = readConversation(h.projectRoot, 'planner:project').sourceRows.filter((row) => row.role === 'user' && row.content !== 'test process prompt: plan' && row.content !== 'test process prompt: recover');
    if (entry === 'STOPPED') expect(transitionRows.map((row) => row.content)).toEqual([expect.stringContaining('graph position was discarded')]);
    else expect(transitionRows).toEqual([]);
  });

  it('admits reviewer with zero children and preserves role-context then transition then node-prompt order', async () => {
    const roles: string[] = [];
    const h = harness(async (input) => {
      roles.push(input.role);
      expect(h.actor.executingLlmSnapshot()).toMatchObject({ role: input.role, cardId: 'project', activity: { mode: 'active' } });
      const filename = input.role === 'planner' ? 'status.md' : 'review.md';
      const open = h.store.openRecord('project', filename); h.store.editRecord('project', filename, open.version, input.role);
      return input.role === 'planner' ? tool('plan-review', 'admit_review', 'review it') : tool('review-approved', 'approved', 'approved');
    });
    const outcome = await h.actor.activate(h.input(), new AbortController().signal);
    expect(outcome.status).toBe('done');
    expect(roles).toEqual(['planner', 'reviewer']);
    expect(h.claimResult).toHaveBeenCalledTimes(1);
    expect(h.actor.executingLlmSnapshot()).toBeNull();
    const reviewerRows = readConversation(h.projectRoot, 'reviewer:project').sourceRows.filter((row) => row.role === 'user');
    expect(reviewerRows.map((row) => row.content)).toEqual([
      'Descendant work:\n(none)',
      expect.stringContaining('Previous process node: plan'),
      'test process prompt: review',
    ]);
  });

  it('reuses one pending activation promise and clears its executing snapshot after settlement', async () => {
    let release!: (completion: ProviderTurnCompletion) => void;
    const h = harness(() => new Promise<ProviderTurnCompletion>((resolve) => { release = resolve; }));
    const first = h.actor.activate(h.input(), new AbortController().signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.actor.executingLlmSnapshot()).toMatchObject({ role: 'planner', cardId: 'project', activity: { mode: 'active' } });
    const second = h.actor.activate(h.input(), new AbortController().signal);
    expect(second).toBe(first);
    const open = h.store.openRecord('project', 'status.md'); h.store.editRecord('project', 'status.md', open.version, 'complete');
    release(tool('complete', 'complete_direct'));
    await expect(first).resolves.toMatchObject({ status: 'done' });
    expect(h.actor.executingLlmSnapshot()).toBeNull();
  });

  it('retains tracker and LLM containment after terminal transition for noncooperative raw work', async () => {
    const h = harness(() => new Promise<ProviderTurnCompletion>(() => undefined));
    const activation = h.actor.activate(h.input(), new AbortController().signal);
    for (let count = 0; count < 100 && h.actor.executingLlmSnapshot() === null; count += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.actor.executingLlmSnapshot()).not.toBeNull();
    const reason = new Error('contain noncooperative node');
    h.actor.disposeActivation(reason);
    h.actor.suppressContinuationAndPrepareJoin(reason);
    await expect(activation).resolves.toMatchObject({ status: 'failed', summary: reason.message });
    expect(h.actor.processPosition()).toMatchObject({ kind: 'terminal', terminal: 'FAILED' });
    await expect(h.actor.joinActivation()).resolves.toEqual(expect.arrayContaining([{ status: 'external_dependency_abandoned', abandonedCount: 1 }]));
  });

  it('keeps a non-aborted delayed LLM and tracker join pending through terminal settlement', async () => {
    let release!: (completion: ProviderTurnCompletion) => void;
    const h = harness(() => new Promise<ProviderTurnCompletion>((resolve) => { release = resolve; }));
    const activation = h.actor.activate(h.input(), new AbortController().signal);
    for (let count = 0; count < 100 && h.actor.executingLlmSnapshot() === null; count += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    const reason = new Error('close continuation after admitted winner');
    h.actor.suppressContinuationAndPrepareJoin(reason);
    let joined = false;
    const joining = h.actor.joinActivation().then((outcomes) => { joined = true; return outcomes; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(joined).toBe(false);
    const open = h.store.openRecord('project', 'status.md'); h.store.editRecord('project', 'status.md', open.version, 'complete');
    release(tool('complete', 'complete_direct'));
    await expect(activation).resolves.toMatchObject({ status: 'done' });
    expect(h.actor.processPosition()).toMatchObject({ kind: 'terminal', terminal: 'DONE' });
    await expect(joining).resolves.toEqual([{ status: 'joined' }, { status: 'joined' }]);
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

  it.each(['plain text', 'malformed arguments', 'missing record', 'empty record'] as const)('keeps %s correction inside one logical node', async (failure) => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      if (calls === 1) {
        if (failure === 'plain text') return { result: { kind: 'message', content: 'premature answer' }, provider_exchanges: [] };
        if (failure === 'malformed arguments') return { result: { kind: 'tool_calls', tool_calls: [{ id: 'malformed', type: 'function', function: { name: 'emit_result', arguments: '{not-json' } }] }, provider_exchanges: [] };
        if (failure === 'empty record') { const open = h.store.openRecord('project', 'status.md'); h.store.editRecord('project', 'status.md', open.version, '   '); }
        return tool('invalid-record', 'complete_direct');
      }
      let open;
      try { open = h.store.readRecord('project', 'status.md', 'open'); }
      catch { open = h.store.openRecord('project', 'status.md'); }
      h.store.editRecord('project', 'status.md', open.version, 'corrected evidence');
      return tool('valid', 'complete_direct');
    });
    await expect(h.actor.activate(h.input(), new AbortController().signal)).resolves.toMatchObject({ status: 'done' });
    expect(calls).toBe(2);
    const rows = readConversation(h.projectRoot, 'planner:project').sourceRows;
    expect(rows.filter((row) => row.kind === 'activity' && row.content.includes('activation_open'))).toHaveLength(1);
    expect(rows.some((row) => row.kind === (failure === 'plain text' ? 'model_repair' : 'tool_result'))).toBe(true);
  });

  it('accepts non-empty closed existence-only evidence without opening or closing another version', async () => {
    const source = cardProcessesSchema.parse({
      planning: { ...DEFAULT_CARD_PROCESSES.planning, nodes: { ...DEFAULT_CARD_PROCESSES.planning.nodes, plan: { ...DEFAULT_CARD_PROCESSES.planning.nodes.plan, records: [{ name: 'status.md', updated: false }] } } },
      terminal: DEFAULT_CARD_PROCESSES.terminal,
    });
    const h = harness(async () => tool('closed-evidence', 'complete_direct'), { process: compileCardProcesses(source).planning });
    const open = h.store.openRecord('project', 'status.md'); h.store.editRecord('project', 'status.md', open.version, 'existing evidence'); h.store.closeRecord('project', 'status.md', open.version, 'planner', h.store.read('project')!.version_seq);
    const close = jest.spyOn(h.store, 'closeRecord');
    await expect(h.actor.activate(h.input(), new AbortController().signal)).resolves.toMatchObject({ status: 'done' });
    expect(close).not.toHaveBeenCalled();
    expect(h.store.readRecord('project', 'status.md', 'latest').version).toBe(open.version);
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
      if (reviewerCalls === 1) expect(h.store.reorderChildren('project', [second.id, first.id])).toEqual({ ok: true, changed: 2 });
      if (reviewerCalls === 2) expect(h.store.reorderChildren('project', [first.id, second.id])).toEqual({ ok: true, changed: 2 });
      return tool(`review-${reviewerCalls}`, 'approved');
    });
    const first = h.store.create({ type: 'code', parent: 'project', title: 'first', brief: 'first', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const second = h.store.create({ type: 'code', parent: 'project', title: 'second', brief: 'second', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    for (const child of [first, second]) { h.store.setStatus(child.id, 'running'); h.store.commitActivationOutcome(child.id, { status: 'done', summary: 'child done', result: { kind: 'done', summary: 'child done' } }, '2026-07-22T00:00:00.000Z'); }
    const outcome = await h.actor.activate(h.input(), new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'done' });
    expect(reviewerCalls).toBe(3);
    const rows = readConversation(h.projectRoot, 'reviewer:project').sourceRows;
    expect(rows.some((row) => row.kind === 'tool_result' && row.content.includes('Review context is stale'))).toBe(true);
    expect(rows.filter((row) => row.kind === 'tool_result' && row.content.includes('Review context is stale'))).toHaveLength(2);
    expect(rows.filter((row) => row.role === 'user' && row.content.startsWith('Descendant work:'))).toHaveLength(3);
    expect(h.store.read('project')!.children).toEqual([first.id, second.id]);
    expect([h.store.read(first.id)!.lifecycle.status, h.store.read(second.id)!.lifecycle.status]).toEqual(['done', 'done']);
  });

  it.each([
    ['array', []], ['null', null], ['string', 'invalid'], ['number', 1], ['boolean', true],
    ['missing outcome', { summary: 'ready' }], ['missing summary', { outcome: 'complete_direct' }],
    ['unknown field', { outcome: 'complete_direct', summary: 'ready', extra: true }],
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
    const cleanup = jest.spyOn(h.processRunner, 'closeAndTerminateDirectScope');
    await expect(h.actor.activate(h.input(), new AbortController().signal)).resolves.toMatchObject({ status: 'done' });
    const rows = readConversation(h.projectRoot, `executor:${h.cardId}`).sourceRows;
    expect(rows.filter((row) => row.kind === 'activity' && row.content.includes('activation_open'))).toHaveLength(2);
    expect(rows.some((row) => row.role === 'user' && row.content.includes('Previous process node: implement'))).toBe(true);
    expect(createScope.mock.calls.map(([, ownerId]) => ownerId)).toEqual(['card-activation:activation-test:node:0', 'card-activation:activation-test:node:1']);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(h.claimResult).toHaveBeenCalledTimes(1);
  });

  it('uses actor transitions for cross-node and explicit self reentry with exact zero-based ordinals', async () => {
    const source = cardProcessesSchema.parse({ planning: DEFAULT_CARD_PROCESSES.planning, terminal: { entries: { BACKLOG: { node: 'first' }, CHANGED: { node: 'first' }, BLOCKED: { node: 'first' }, STOPPED: { node: 'first', prompt: 'stopped-recovery' } }, nodes: {
      first: { role: 'executor', prompt: 'implement', correction_prompt: 'correct-execution-result', records: [{ name: 'status.md', updated: true }], edges: { next: { target: { node: 'second' } } } },
      second: { role: 'executor', prompt: 'verify', correction_prompt: 'correct-execution-result', records: [{ name: 'status.md', updated: true }], edges: { again: { target: { node: 'second' }, prompt: 'implementation-to-verification' }, done: { target: { terminal: 'DONE' } } } },
    } } });
    const ordinals: number[] = [];
    let calls = 0;
    let h!: ReturnType<typeof harness>;
    h = harness(async () => {
      calls += 1;
      const position = h.actor.processPosition();
      if (position.kind !== 'node') throw new Error('expected node position');
      ordinals.push(position.executionOrdinal);
      const open = h.store.openRecord(h.cardId, 'status.md'); h.store.editRecord(h.cardId, 'status.md', open.version, `node ${calls}`);
      return tool(`result-${calls}`, calls === 1 ? 'next' : calls === 2 ? 'again' : 'done');
    }, { cardType: 'code', process: compileCardProcesses(source).terminal });
    const createScope = jest.spyOn(h.processRunner, 'createDirectScope');
    await expect(h.actor.activate(h.input(), new AbortController().signal)).resolves.toMatchObject({ status: 'done' });
    expect(ordinals).toEqual([0, 1, 2]);
    expect(createScope.mock.calls.map(([, ownerId]) => ownerId)).toEqual(['card-activation:activation-test:node:0', 'card-activation:activation-test:node:1', 'card-activation:activation-test:node:2']);
    expect(readConversation(h.projectRoot, `executor:${h.cardId}`).sourceRows.filter((row) => row.kind === 'activity' && row.content.includes('activation_open'))).toHaveLength(3);
  });

  it('closes multiple records in configured order and supplies their exact URLs to a same-role next node', async () => {
    const source = cardProcessesSchema.parse({
      planning: { entries: { BACKLOG: { node: 'prepare' }, CHANGED: { node: 'prepare' }, BLOCKED: { node: 'prepare' }, STOPPED: { node: 'prepare', prompt: 'stopped-recovery' } }, nodes: {
        prepare: { role: 'planner', prompt: 'plan', correction_prompt: 'correct-plan-result', records: [{ name: 'brief.md', updated: false }, { name: 'status.md', updated: false }], edges: { prepared: { target: { node: 'finish' }, prompt: 'review-to-plan' } } },
        finish: { role: 'planner', prompt: 'recover', correction_prompt: 'correct-plan-result', records: [{ name: 'status.md', updated: true }], edges: { complete: { target: { terminal: 'DONE' } } } },
      } }, terminal: DEFAULT_CARD_PROCESSES.terminal,
    });
    let calls = 0;
    const h = harness(async (input) => {
      calls += 1;
      expect(h.actor.executingLlmSnapshot()?.role).toBe('planner');
      if (calls === 1) return tool('prepared', 'prepared', 'prepared records');
      const transition = input.providerConversation.messages.find((row) => row.role === 'user' && row.content.includes('Previous process node: prepare'))?.content;
      expect(transition).toContain('record:///brief.md?card=project&v=2\n- record:///status.md?card=project&v=1');
      const open = h.store.openRecord('project', 'status.md'); h.store.editRecord('project', 'status.md', open.version, 'final status');
      return tool('complete', 'complete');
    }, { process: compileCardProcesses(source).planning });
    const brief = h.store.openRecord('project', 'brief.md'); h.store.editRecord('project', 'brief.md', brief.version, 'updated brief');
    const status = h.store.openRecord('project', 'status.md'); h.store.editRecord('project', 'status.md', status.version, 'prepared status');
    const closeOrder: string[] = [];
    const close = h.store.closeRecord.bind(h.store);
    jest.spyOn(h.store, 'closeRecord').mockImplementation((cardId, filename, ...args) => { closeOrder.push(filename); return close(cardId, filename, ...args); });
    await expect(h.actor.activate(h.input(), new AbortController().signal)).resolves.toMatchObject({ status: 'done' });
    expect(calls).toBe(2);
    expect(closeOrder).toEqual(['brief.md', 'status.md', 'status.md']);
    expect(readConversation(h.projectRoot, 'planner:project').sourceRows.filter((row) => row.kind === 'activity' && row.content.includes('activation_open'))).toHaveLength(2);
    expect(h.claimResult).toHaveBeenCalledTimes(1);
  });

  it('propagates one provider-exchange publication error by identity and permits only an external join after rejection', async () => {
    const error = new AppLogPublicationError('provider_exchange', new Error('hostile publication failure'));
    const projection = jest.fn();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = harness(async () => ({ ...tool('terminal', 'complete_direct'), provider_exchanges: [{ attempt_index: 0, contract_id: 'test', contract_name: 'test', transport: 'generic', provider: 'test', model: 'model', source_input_id: 'input', request_params: {}, started_at: '2026-07-21T00:00:00.000Z', completed_at: '2026-07-21T00:00:01.000Z', status: 'ok', terminal_tool_fired: 'emit_result' }] }), { publicationError: error, runtimeProjectionChanged: projection, publicationFailureMarker: () => projection.mockClear() });
    const activation = h.actor.activate(h.input(), new AbortController().signal);
    await expect(activation).rejects.toBe(error);
    expect(h.claimResult).not.toHaveBeenCalled();
    expect(h.store.read(h.cardId)?.lifecycle.status).not.toBe('failed');
    const joined = h.actor.joinActivation();
    await expect(Promise.race([joined, new Promise((_, reject) => setTimeout(() => reject(new Error('join deadlock')), 500))])).resolves.toEqual(expect.any(Array));
    expect(consoleError).not.toHaveBeenCalled();
    expect(projection).not.toHaveBeenCalled();
  });

  it('preserves primary publication failure identity when executor cleanup also fails', async () => {
    const publicationError = new AppLogPublicationError('provider_exchange', new Error('publication failed'));
    const cleanupError = new Error('cleanup failed');
    const h = nodeExecutionHarness(async () => { throw publicationError; });
    jest.spyOn(h.processRunner, 'closeAndTerminateDirectScope').mockRejectedValue(cleanupError);

    await expect(h.execute()).rejects.toBe(publicationError);
  });

  it('prefers executor cleanup failure identity over ordinary execution rejection', async () => {
    const executionError = new Error('execution failed');
    const cleanupError = new Error('cleanup failed');
    const h = nodeExecutionHarness(async () => { throw executionError; });
    jest.spyOn(h.processRunner, 'closeAndTerminateDirectScope').mockRejectedValue(cleanupError);

    await expect(h.execute()).rejects.toBe(cleanupError);
  });

  it('prefers executor cleanup failure identity over successful execution', async () => {
    const cleanupError = new Error('cleanup failed');
    let h!: ReturnType<typeof nodeExecutionHarness>;
    h = nodeExecutionHarness(async () => {
      const open = h.store.openRecord(h.cardId, 'status.md');
      h.store.editRecord(h.cardId, 'status.md', open.version, 'complete');
      return tool('complete', 'done');
    });
    jest.spyOn(h.processRunner, 'closeAndTerminateDirectScope').mockRejectedValue(cleanupError);

    await expect(h.execute()).rejects.toBe(cleanupError);
  });

  it.each(['planner', 'reviewer', 'executor'] as const)('retains duplicate-visible context when %s crashes after candidate appends before removal', async (role) => {
    let roleCalls = 0;
    const crash = new Error('crash before notification removal');
    const h = harness(async (input) => {
      if (input.role === 'planner' && role !== 'planner') {
        const open = h.store.openRecord(h.cardId, 'status.md'); h.store.editRecord(h.cardId, 'status.md', open.version, 'ready');
        return tool('to-review', 'admit_review');
      }
      roleCalls += 1;
      const filename = role === 'reviewer' ? 'review.md' : 'status.md';
      const open = h.store.openRecord(h.cardId, filename); h.store.editRecord(h.cardId, filename, open.version, 'ready');
      h.store.enqueueNotification(h.cardId, { id: `${role}-retained`, content: `${role} duplicate-visible`, created_at: '2026-07-18T00:00:00.000Z' });
      return tool(`${role}-candidate`, role === 'reviewer' ? 'approved' : role === 'executor' ? 'done' : 'complete_direct');
    }, { cardType: role === 'executor' ? 'code' : undefined, removeNotifications: () => { throw crash; } });
    await expect(h.actor.activate(h.input(), new AbortController().signal)).resolves.toMatchObject({ status: 'failed', summary: crash.message });
    const rows = readConversation(h.projectRoot, `${role}:${h.cardId}`).sourceRows;
    expect(rows.some((row) => row.kind === 'tool_result' && row.content.includes('pending_notifications'))).toBe(true);
    expect(rows.some((row) => row.role === 'user' && row.content === `${role} duplicate-visible`)).toBe(true);
    expect(rows.some((row) => row.role === 'user' && row.content.includes('reconsider the appended context'))).toBe(true);
    expect(h.store.read(h.cardId)!.pending_notifications.map(({ id }) => id)).toEqual([`${role}-retained`]);
    expect(roleCalls).toBe(1);
  });

  it.each(['planner', 'reviewer', 'executor'] as const)('removes only the selected %s IDs and corrects again for a late arrival', async (role) => {
    let roleCalls = 0;
    let insertedLate = false;
    const h = harness(async (input) => {
      if (input.role === 'planner' && role !== 'planner') {
        const open = h.store.openRecord(h.cardId, 'status.md'); h.store.editRecord(h.cardId, 'status.md', open.version, 'ready');
        return tool('to-review', 'admit_review');
      }
      roleCalls += 1;
      if (roleCalls === 1) {
        const filename = role === 'reviewer' ? 'review.md' : 'status.md';
        const open = h.store.openRecord(h.cardId, filename); h.store.editRecord(h.cardId, filename, open.version, 'ready');
        h.store.enqueueNotification(h.cardId, { id: `${role}-selected`, content: 'selected first', created_at: '2026-07-18T00:00:00.000Z' });
      }
      return tool(`${role}-${roleCalls}`, role === 'reviewer' ? 'approved' : role === 'executor' ? 'done' : 'complete_direct');
    }, {
      cardType: role === 'executor' ? 'code' : undefined,
      removeNotifications: (store, cardId, ids) => {
        if (!insertedLate) {
          insertedLate = true;
          store.enqueueNotification(cardId, { id: `${role}-late`, content: 'arrived after selection', created_at: '2026-07-18T00:00:01.000Z' });
        }
        store.removeNotifications(cardId, [...ids]);
      },
    });
    await expect(h.actor.activate(h.input(), new AbortController().signal)).resolves.toMatchObject({ status: 'done' });
    expect(roleCalls).toBe(3);
    expect(h.store.read(h.cardId)!.pending_notifications).toEqual([]);
    const rows = readConversation(h.projectRoot, `${role}:${h.cardId}`).sourceRows;
    expect(rows.filter((row) => row.kind === 'tool_result' && row.content.includes('pending_notifications'))).toHaveLength(2);
    expect(rows.filter((row) => row.kind === 'activity' && row.content.includes('activation_open'))).toHaveLength(1);
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

  it.each([
    { emitted: 'done', status: 'done' }, { emitted: 'blocked', status: 'blocked' }, { emitted: 'failed', status: 'failed' },
  ] as const)('maps terminal executor outcome $emitted to the existing $status processor outcome', async ({ emitted, status }) => {
    const h = harness(async () => { const open = h.store.openRecord(h.cardId, 'status.md'); h.store.editRecord(h.cardId, 'status.md', open.version, emitted); return tool(`terminal-${emitted}`, emitted); }, { cardType: 'code' });
    await expect(h.actor.activate(h.input(), new AbortController().signal)).resolves.toMatchObject({ status, summary: emitted });
    expect(h.claimResult).toHaveBeenCalledTimes(1);
  });

  it('keeps the terminal claim authoritative when cleanup fails', async () => {
    const point = 'cleanup';
    const injected = new Error(`${point} failed after claim`);
    const h = harness(async () => {
      const open = h.store.openRecord(h.cardId, 'status.md'); h.store.editRecord(h.cardId, 'status.md', open.version, 'ready');
      return tool('accepted', 'done');
    }, { cardType: 'code' });
    jest.spyOn(h.processRunner, 'closeAndTerminateDirectScope').mockRejectedValue(injected);
    const outcome = await h.actor.activate(h.input(), new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'failed', summary: expect.stringContaining(injected.message) });
    expect(h.claimResult).toHaveBeenCalledTimes(1);
    expect(h.store.readRecord(h.cardId, 'status.md', 'latest').artifact.content).toBe('ready');
    const accepted = readConversation(h.projectRoot, `executor:${h.cardId}`).sourceRows.filter((row) => row.kind === 'tool_result' && row.content.includes('"accepted":true'));
    expect(accepted).toHaveLength(1);
  });

  it('reuses one executor node scope through correction and cleans it before routing onward', async () => {
    const source = cardProcessesSchema.parse({
      planning: DEFAULT_CARD_PROCESSES.planning,
      terminal: { entries: { BACKLOG: { node: 'implement' }, CHANGED: { node: 'implement' }, BLOCKED: { node: 'implement' }, STOPPED: { node: 'implement', prompt: 'stopped-recovery' } }, nodes: {
        implement: { role: 'executor', prompt: 'implement', correction_prompt: 'correct-execution-result', records: [{ name: 'status.md', updated: true }], edges: { implementation_ready: { target: { node: 'verify' }, prompt: 'implementation-to-verification' }, failed: { target: { terminal: 'FAILED' } } } },
        verify: { role: 'executor', prompt: 'verify', correction_prompt: 'correct-execution-result', records: [{ name: 'status.md', updated: true }], edges: { verified: { target: { terminal: 'DONE' } }, failed: { target: { terminal: 'FAILED' } } } },
      } },
    });
    let calls = 0;
    const events: string[] = [];
    const h = harness(async () => {
      calls += 1;
      if (calls === 1) return { result: { kind: 'message', content: 'not a typed result' }, provider_exchanges: [] };
      if (calls === 2) { const open = h.store.openRecord(h.cardId, 'status.md'); h.store.editRecord(h.cardId, 'status.md', open.version, 'implementation'); return tool('implemented', 'implementation_ready'); }
      expect(events).toContain('cleanup:0');
      const open = h.store.openRecord(h.cardId, 'status.md'); h.store.editRecord(h.cardId, 'status.md', open.version, 'verification'); return tool('verified', 'verified');
    }, { cardType: 'code', process: compileCardProcesses(source).terminal });
    const createScope = jest.spyOn(h.processRunner, 'createDirectScope');
    const terminate = h.processRunner.closeAndTerminateDirectScope.bind(h.processRunner);
    jest.spyOn(h.processRunner, 'closeAndTerminateDirectScope').mockImplementation(async (args) => { events.push(`cleanup:${events.length}`); return terminate(args); });
    const outcome = await h.actor.activate(h.input(), new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'done' });
    expect(calls).toBe(3);
    expect(createScope.mock.calls.map(([, ownerId]) => ownerId)).toEqual(['card-activation:activation-test:node:0', 'card-activation:activation-test:node:1']);
    expect(events).toEqual(['cleanup:0', 'cleanup:1']);
  });

});
