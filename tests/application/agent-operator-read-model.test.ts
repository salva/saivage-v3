import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  AgentOperatorReadModelService,
  AgentSessionNotFoundError,
  AgentCurrentStateUnavailableError,
  CardAgentScopeNotFoundError,
} from '../../src/application/read-models/agent-operator-read-model.js';
import { appendConversationBatch, initializeMissingConversation, readConversationCatalog } from '../../src/persistence/conversation-file.js';
import {
  agentMessageSchema,
  cardAgentSessionId,
  conversationSessionIdentity,
  globalAgentSessionId,
  type ConversationSessionId,
} from '../../src/schemas/index.js';
import { CardService, initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { currentConversationSegmentPath } from '../helpers/current-conversation-segment-path.js';
import { cardConversationsRoot, cardHeadFile, cardHistoryFile } from '../../src/persistence/layout.js';
import { executingLlmSnapshots } from '../helpers/executing-llm-snapshot.js';
import { publishThreeGenerationCompactedConversation } from '../helpers/compacted-conversation-fixture.js';
import { RESPONSES_A } from '../helpers/responses-producer-fixture.js';
import { responsesProducerAccountId } from '../../src/agents/llm-openai-responses-account.js';
import { compilePromptTemplate, createPromptTemplateRegistry } from '../../src/utils/prompt-api.js';
import { describeNodeResultContract } from '../../src/runtime/runtime-api.js';
import { formatVocabularySnippet } from '../../src/tools/prompt-api.js';
import { redactTextForOutbound } from '../../src/redaction/index.js';
import { globalAgentConversationsRoot, globalAgentConversationVersionIndexFile } from '../../src/persistence/layout.js';

const roots: string[] = [];
const timestamp = '2026-07-24T00:00:00.000Z';

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('AgentOperatorReadModelService granular resources', () => {
  it('keeps actual loaded bundled browser guidance visible for Analyst and matching card nodes', () => {
    const root = createRoot(); const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Browser guidance', bootstrap_content: 'Non-secret fixture', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    const service = new AgentOperatorReadModelService(root, TEST_WORKFLOWS, () => new Map());
    const analyst = service.getCurrentInstructions(globalAgentSessionId('analyst'));
    expect(analyst.bindings[0]!.instructions).toContain('mcp_server_control');
    expect(analyst.bindings[0]!.instructions).toContain("scale:'css'");
    for (const agent of ['executor', 'reviewer']) {
      const result = service.getCurrentInstructions(cardAgentSessionId(agent, agent === 'reviewer' ? 'project' : child.id));
      expect(result.bindings.length).toBeGreaterThan(0);
      for (const binding of result.bindings) {
        expect(binding.instructions).toContain('mcp_tools');
        expect(binding.instructions).toContain('omitted filename');
        expect(binding.instructions).toContain('Pixels cannot');
      }
    }
    expect(JSON.stringify(service.getCurrentInstructions(globalAgentSessionId('oversight')))).not.toContain('mcp_server_control');
  });
  it('renders both configured globals from loaded composition without consuming or creating conversations', () => {
    const root = createRoot();
    const before = readFileSync(cardHeadFile(root, 'project'));
    const capture = jest.fn(() => new Map());
    const service = new AgentOperatorReadModelService(root, TEST_WORKFLOWS, capture);
    const templates = createPromptTemplateRegistry(TEST_WORKFLOWS);
    const oversightRoot = join(globalAgentConversationsRoot(root), TEST_WORKFLOWS.oversight.name);
    expect(existsSync(oversightRoot)).toBe(false);
    for (const { agent } of TEST_WORKFLOWS.selectedGlobalParticipants.values()) {
      const result = service.getCurrentInstructions(globalAgentSessionId(agent.name));
      expect(result).toEqual({ session_id: globalAgentSessionId(agent.name), basis: 'server_loaded_configuration',
        scope: { kind: 'global' }, bindings: [{ kind: 'global', instructions: redactTextForOutbound(templates.render(
          { kind: 'global-agent' }, agent.name, { vocabularySnippet: formatVocabularySnippet(TEST_WORKFLOWS.cardTypeVocabulary) },
        )) }] });
    }
    expect(capture).not.toHaveBeenCalled();
    expect(existsSync(oversightRoot)).toBe(false);
    expect(readFileSync(cardHeadFile(root, 'project'))).toEqual(before);
    expect(() => service.getCurrentInstructions(globalAgentSessionId('unconfigured'))).toThrow(AgentSessionNotFoundError);
  });

  it('renders every matching node in declaration order using actual outcome/gate builders and full-composition redaction', () => {
    const root = createRoot();
    const workflow = TEST_WORKFLOWS.cardTypes.get('project')!;
    const selected = [...workflow.states].find(([, state]) => state.kind === 'node' && state.agent.name === 'planner')!;
    const [stateId, state] = selected;
    if (state.kind !== 'node') throw new Error('Expected planner node');
    // Workflow templates require exactly one contract placeholder. Put the secret seam
    // across adjacent fragment/literal tokens instead of duplicating that placeholder.
    const seamCompiled = compilePromptTemplate({ host: { kind: 'workflow-agent', cardType: 'project' },
      name: 'planner', path: '/fixture-only/prompt.md', text: '{{> safety}}seam-canary\n{{contractDescription}}\nFINAL',
      resolveFragment: () => ({ path: '/fixture-only/fragment.md', text: 'api_key=fragment-canary\nsk-' }) });
    const node = { ...state, selectedAgentPrompt: { ...state.selectedAgentPrompt, compiled: seamCompiled },
      requirements: [{ definition: { ...workflow.bootstrapRecord, name: 'sk-substituted-canary.md' }, mode: 'clean' as const, gate: 'updated' as const }] };
    const outcomeRoute = [...node.on.values()].find(route => route.semantic.kind === 'configured-outcome')!;
    if (outcomeRoute.semantic.kind !== 'configured-outcome') throw new Error('Expected configured outcome');
    const second = { ...node, nodeId: 'second', on: new Map(node.on).set('result:second-outcome', {
      ...outcomeRoute, semantic: { ...outcomeRoute.semantic, outcome: 'second-outcome' },
    }) };
    const expanded = { ...workflow, states: new Map(workflow.states).set(stateId, node).set('node:second', second) };
    const workflows = { ...TEST_WORKFLOWS, cardTypes: new Map(TEST_WORKFLOWS.cardTypes).set('project', expanded) };
    const service = new AgentOperatorReadModelService(root, workflows, () => { throw new Error('No runtime snapshot work'); });
    const before = readFileSync(cardHeadFile(root, 'project'));
    const result = service.getCurrentInstructions(cardAgentSessionId('planner', 'project'));
    const templates = createPromptTemplateRegistry(workflows);
    const expected = [...expanded.states].flatMap(([key, value]) => value.kind === 'node' && value.agent.name === 'planner'
      ? [{ kind: 'workflow_node', node_id: value.nodeId, instructions: redactTextForOutbound(templates.render(
        { kind: 'workflow-agent', cardType: 'project' }, 'planner', { contractDescription: describeNodeResultContract(expanded, key) },
      )) }] : []);
    expect(result.bindings).toEqual(expected);
    expect(result.bindings.at(-1)!.instructions).toContain('second-outcome');
    expect(result.bindings[0]!.instructions).not.toContain('second-outcome');
    expect(result.bindings[0]!.instructions).toContain('Required record gates:');
    expect(result.scope).toEqual({ kind: 'card', card_id: 'project', card_type: 'project', ownership: 'active' });
    expect(JSON.stringify(result)).not.toContain('canary');
    expect(JSON.stringify(result)).not.toContain('/fixture-only');
    expect(result.bindings.every(binding => binding.instructions.endsWith('FINAL'))).toBe(true);
    expect(readFileSync(cardHeadFile(root, 'project'))).toEqual(before);
    expect(Object.keys(result).sort()).toEqual(['basis', 'bindings', 'scope', 'session_id']);
  });

  it('projects fragment seams and substituted vocabulary for both configured global compositions', () => {
    const root = createRoot();
    const participants = new Map(TEST_WORKFLOWS.selectedGlobalParticipants);
    for (const [name, participant] of participants) {
      const compiled = compilePromptTemplate({ host: { kind: 'global-agent' }, name,
        path: '/fixture-only/global.md', text: '{{> safety}}seam-canary\n{{vocabularySnippet}}\nGLOBAL-FINAL',
        resolveFragment: () => ({ path: '/fixture-only/fragment.md', text: 'api_key=fragment-canary\nsk-' }) });
      participants.set(name, { ...participant, prompt: { ...participant.prompt, compiled } });
    }
    const workflows = { ...TEST_WORKFLOWS, selectedGlobalParticipants: participants,
      cardTypeVocabulary: [...TEST_WORKFLOWS.cardTypeVocabulary, 'sk-vocabulary-canary'] };
    const service = new AgentOperatorReadModelService(root, workflows, () => { throw new Error('No invocation observation'); });
    const registry = createPromptTemplateRegistry(workflows);
    const before = readFileSync(cardHeadFile(root, 'project'));
    const analystPath = globalAgentConversationVersionIndexFile(root, workflows.analyst.name);
    const analystBefore = readFileSync(analystPath);
    for (const { agent } of workflows.selectedGlobalParticipants.values()) {
      const raw = registry.render({ kind: 'global-agent' }, agent.name,
        { vocabularySnippet: formatVocabularySnippet(workflows.cardTypeVocabulary) });
      expect(raw).toContain('sk-seam-canary');
      expect(raw).toContain('sk-vocabulary-canary');
      const result = service.getCurrentInstructions(globalAgentSessionId(agent.name));
      expect(result.bindings).toEqual([{ kind: 'global', instructions: redactTextForOutbound(raw) }]);
      expect(JSON.stringify(result)).not.toContain('canary');
      expect(result.bindings[0]!.instructions.endsWith('GLOBAL-FINAL')).toBe(true);
      expect(Object.keys(result.bindings[0]!).sort()).toEqual(['instructions', 'kind']);
    }
    expect(readFileSync(cardHeadFile(root, 'project'))).toEqual(before);
    expect(readFileSync(analystPath)).toEqual(analystBefore);
    expect(existsSync(join(globalAgentConversationsRoot(root), workflows.oversight.name))).toBe(false);
  });

  it('uses current card type and retained final-card orientation, and rejects damaged exact selections', () => {
    const root = createRoot(); const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Private dynamic title', bootstrap_content: 'Private dynamic brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    const service = new AgentOperatorReadModelService(root, TEST_WORKFLOWS, () => new Map());
    const session = cardAgentSessionId('executor', child.id);
    const active = service.getCurrentInstructions(session);
    expect(active.bindings).toHaveLength(1);
    expect(JSON.stringify(active)).not.toContain('Private dynamic');
    cards.deleteSubtrees([child.id], () => true);
    expect(service.getCurrentInstructions(session)).toEqual({ ...active,
      scope: { kind: 'card', card_id: child.id, card_type: 'code', ownership: 'retained_tombstone' } });
    expect(() => service.getCurrentInstructions(cardAgentSessionId('planner', child.id))).toThrow(AgentSessionNotFoundError);
    expect(() => service.getCurrentInstructions(cardAgentSessionId('executor', 'card-z'))).toThrow(AgentSessionNotFoundError);
    writeFileSync(cardHeadFile(root, child.id), '{broken');
    expect(() => service.getCurrentInstructions(session)).toThrow(AgentCurrentStateUnavailableError);
  });
  it('hides private producer provenance in actual current, historical, compacted and tool-tail projections', async () => {
    const root = createRoot();
    const session = await publishThreeGenerationCompactedConversation(root, 'visible summary', undefined, RESPONSES_A);
    const service = new AgentOperatorReadModelService(root, TEST_WORKFLOWS, () => new Map());
    const current = service.getConversation(session);
    const historical = [1, 2, 3].map(version => service.getConversationVersion(session, version));
    for (const value of [current, ...historical, service.readCurrentSegmentTail(session, 100)]) {
      expect(JSON.stringify(value)).not.toContain('producer_account_id');
      expect(JSON.stringify(value)).not.toContain(responsesProducerAccountId(RESPONSES_A));
      expect(JSON.stringify(value)).not.toContain('ciphertext-');
      expect(JSON.stringify(value)).not.toContain('provider_projection');
    }
    expect(JSON.stringify(current)).toContain('retained-tool');
    expect(JSON.stringify(historical[0])).toContain('covered-tool');
  });
  it.each(['missing', 'malformed'] as const)('admits the exact session without consuming a %s old predecessor', fault => {
    const root = createRoot(); const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    const initial = JSON.parse(readFileSync(cardHeadFile(root, child.id), 'utf8')).ordinary;
    const session = cardAgentSessionId('executor', child.id); publishMarker(root, session);
    cards.editCard(child.id, { title: 'Current' });
    const oldPath = cardHistoryFile(root, child.id, initial.entry_id);
    if (fault === 'missing') unlinkSync(oldPath); else writeFileSync(oldPath, '{broken');
    const service = new AgentOperatorReadModelService(root, TEST_WORKFLOWS, () => new Map());
    expect(service.getSession(session).session.id).toBe(session);
    expect(() => cards.readCardVersion(child.id, 1)).toThrow();
    expect(() => service.getSession(cardAgentSessionId('planner', child.id))).toThrow(AgentSessionNotFoundError);
    expect(() => service.getSession(cardAgentSessionId('executor', 'card-z'))).toThrow(AgentSessionNotFoundError);
    const selected = JSON.parse(readFileSync(cardHeadFile(root, child.id), 'utf8')).ordinary;
    writeFileSync(cardHistoryFile(root, child.id, selected.entry_id), '{broken');
    expect(() => service.getSession(session)).toThrow(AgentCurrentStateUnavailableError);
  });

  it('admits a retained final tombstone but blocks a descendant below a tombstoned ancestor', () => {
    const root = createRoot(); const cards = new CardService(root);
    const parent = cards.create({ type: 'goal', parent: 'project', title: 'Goal', bootstrap_content: 'brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    const child = cards.create({ type: 'code', parent: parent.id, title: 'Child', bootstrap_content: 'brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    const parentSession = cardAgentSessionId('planner', parent.id); const childSession = cardAgentSessionId('executor', child.id);
    publishMarker(root, parentSession); publishMarker(root, childSession);
    cards.deleteSubtrees([parent.id], () => true);
    const service = new AgentOperatorReadModelService(root, TEST_WORKFLOWS, () => new Map());
    expect(service.getSession(parentSession).session.id).toBe(parentSession);
    expect(() => service.getSession(childSession)).toThrow(AgentSessionNotFoundError);
  });
  it('derives compiled-workflow candidates and reads index metadata for summaries', () => {
    const projectRoot = createRoot();
    const cards = new CardService(projectRoot);
    const child = cards.create({
      type: 'code',
      parent: 'project',
      title: 'Code child',
      bootstrap_content: 'brief',
      priority: 0,
      urgency: 'normal',
      created_by: 'analyst',
      depends_on: [],
    });
    const analyst = globalAgentSessionId(TEST_WORKFLOWS.analyst.name);
    const oversight = globalAgentSessionId(TEST_WORKFLOWS.oversight.name);
    const planner = cardAgentSessionId('planner', 'project');
    const reviewer = cardAgentSessionId('reviewer', 'project');
    const executor = cardAgentSessionId('executor', child.id);
    for (const sessionId of [analyst, oversight, planner, reviewer, executor]) publishMarker(projectRoot, sessionId);

    appendFileSync(currentConversationSegmentPath(projectRoot, planner), '{malformed later envelope}\n');
    const capture = jest.fn(() => executingLlmSnapshots([analyst, planner, reviewer]));
    const service = new AgentOperatorReadModelService(projectRoot, TEST_WORKFLOWS, capture);

    const firstList = service.listSessions();
    expect(firstList.sessions.map(({ id }) => id)).toEqual(
      [analyst, oversight, executor, planner, reviewer].sort(),
    );
    expect(firstList.sessions.find(({ id }) => id === executor)).toEqual({
      id: executor,
      agent_name: 'executor',
      session_scope: 'card',
      card_id: child.id,
      started_at: readConversationCatalog(projectRoot, executor).createdAt,
      status: 'inactive',
      activity: 'idle',
      compaction: null,
    });
    expect(service.listSessions().sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: analyst, status: 'active', activity: 'busy' }),
      expect.objectContaining({ id: oversight, status: 'inactive', activity: 'idle' }),
      expect.objectContaining({ id: planner, status: 'active', activity: 'busy' }),
      expect.objectContaining({ id: reviewer, status: 'active', activity: 'busy' }),
      expect.objectContaining({ id: executor, status: 'inactive', activity: 'idle' }),
    ]));
    expect(capture).toHaveBeenCalledTimes(2);
    expect(new Date(service.getSession(planner).session.started_at).toString()).not.toBe('Invalid Date');
    expect(capture).toHaveBeenCalledTimes(3);
    expect(() => service.getConversation(planner)).toThrow(/unavailable/i);
  });

  it('admits only selected globals and does not invent an Oversight row before publication', () => {
    const projectRoot = createRoot();
    const analyst = globalAgentSessionId(TEST_WORKFLOWS.analyst.name);
    const oversight = globalAgentSessionId(TEST_WORKFLOWS.oversight.name);
    publishMarker(projectRoot, analyst);
    const service = new AgentOperatorReadModelService(projectRoot, TEST_WORKFLOWS, () => new Map());
    expect(service.listSessions().sessions.map(({ id }) => id)).toEqual([analyst]);
    expect(() => service.getSession(oversight)).toThrow(AgentSessionNotFoundError);
    expect(() => service.getSession('agent:unused-global:global' as ConversationSessionId)).toThrow(AgentSessionNotFoundError);
    publishMarker(projectRoot, oversight);
    expect(service.listSessions().sessions.map(({ id }) => id)).toEqual([analyst, oversight].sort());
  });

  it('keeps card scope exact and never filters global inventory', () => {
    const projectRoot = createRoot();
    const cards = new CardService(projectRoot);
    const first = cards.create({
      type: 'code', parent: 'project', title: 'First', bootstrap_content: 'brief',
      priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [],
    });
    const second = cards.create({
      type: 'code', parent: 'project', title: 'Second', bootstrap_content: 'brief',
      priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [],
    });
    const firstSession = cardAgentSessionId('executor', first.id);
    const secondSession = cardAgentSessionId('executor', second.id);
    publishMarker(projectRoot, firstSession);
    publishMarker(projectRoot, secondSession);

    const response = new AgentOperatorReadModelService(
      projectRoot,
      TEST_WORKFLOWS,
      () => executingLlmSnapshots([secondSession]),
    ).listCardSessions(first.id);
    expect(response).toEqual({ card_id: first.id, sessions: [expect.objectContaining({ id: firstSession, status: 'inactive', activity: 'idle' })] });
    expect(response.sessions).not.toContainEqual(expect.objectContaining({ id: secondSession }));
  });

  it('retains historical exact summary after tombstone while active scopes exclude it', () => {
    const projectRoot = createRoot();
    const cards = new CardService(projectRoot);
    const child = cards.create({
      type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'brief',
      priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [],
    });
    const sessionId = cardAgentSessionId('executor', child.id);
    publishMarker(projectRoot, sessionId);
    const service = new AgentOperatorReadModelService(projectRoot, TEST_WORKFLOWS, () => new Map());
    expect(service.listSessions().sessions).toContainEqual(expect.objectContaining({ id: sessionId }));

    cards.deleteSubtrees([child.id], () => true);

    expect(service.listSessions().sessions).not.toContainEqual(expect.objectContaining({ id: sessionId }));
    expect(service.getSession(sessionId).session).toEqual(expect.objectContaining({ id: sessionId, status: 'inactive', activity: 'idle' }));
    expect(() => service.listCardSessions(child.id)).toThrow(CardAgentScopeNotFoundError);
  });

  it('omits only exact ENOENT candidates and keeps exact missing detail distinct', () => {
    const projectRoot = createRoot();
    const capture = jest.fn(() => executingLlmSnapshots(['agent:analyst:global']));
    const service = new AgentOperatorReadModelService(projectRoot, TEST_WORKFLOWS, capture);
    expect(service.listSessions()).toEqual({ sessions: [] });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(() => service.getSession('agent:analyst:global')).toThrow(AgentSessionNotFoundError);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('captures live IDs exactly once for every summary-producing operation', () => {
    const projectRoot = createRoot();
    const sessionId = cardAgentSessionId('planner', 'project');
    const inactiveSessionId = cardAgentSessionId('reviewer', 'project');
    publishMarker(projectRoot, sessionId);
    publishMarker(projectRoot, inactiveSessionId);
    const capture = jest.fn(() => executingLlmSnapshots([sessionId]));
    const service = new AgentOperatorReadModelService(projectRoot, TEST_WORKFLOWS, capture);
    service.listSessions();
    service.listCardSessions('project');
    service.getSession(sessionId);
    service.readCurrentSegmentTail(sessionId, 1);
    expect(capture).toHaveBeenCalledTimes(4);
  });

  it('decorates the exact executing session with ephemeral compaction progress', () => {
    const projectRoot = createRoot();
    const sessionId = cardAgentSessionId('planner', 'project');
    const inactiveSessionId = cardAgentSessionId('reviewer', 'project');
    publishMarker(projectRoot, sessionId);
    publishMarker(projectRoot, inactiveSessionId);
    const progress = { strategy: 'local_exact_admission' as const, startedAt: '2026-09-08T10:00:00.000Z', foldsDone: 3, foldInFlight: true };
    const service = new AgentOperatorReadModelService(projectRoot, TEST_WORKFLOWS, () => executingLlmSnapshots([sessionId], progress));
    expect(service.getSession(sessionId).session.compaction).toEqual({ strategy: 'local_exact_admission', started_at: progress.startedAt, folds_done: 3, fold_in_flight: true });
    expect(service.listSessions().sessions.find((session) => session.id === inactiveSessionId)?.compaction).toBeNull();
  });

  it('reads each card stream exactly once and no conversation segments during the global list', () => {
    const projectRoot = createRoot();
    const cards = new CardService(projectRoot);
    const goal = cards.create({
      type: 'goal', parent: 'project', title: 'Goal', bootstrap_content: 'brief',
      priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [],
    });
    const code = cards.create({
      type: 'code', parent: goal.id, title: 'Code', bootstrap_content: 'brief',
      priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [],
    });
    publishMarker(projectRoot, cardAgentSessionId('planner', 'project'));
    publishMarker(projectRoot, cardAgentSessionId('executor', code.id));
    const snapshot = runReadCountChild(projectRoot);
    expect(Object.keys(snapshot.cardStreamOpens).sort()).toEqual(
      ['project', goal.id, code.id].map((cardId) => cardHeadFile(projectRoot, cardId)).sort(),
    );
    for (const opens of Object.values(snapshot.cardStreamOpens)) expect(opens).toBe(1);
    expect(snapshot.conversationSegmentOpens).toBe(0);
    expect(Object.keys(snapshot.conversationIndexReads).length).toBeGreaterThan(0);
    for (const ledger of Object.values(snapshot.conversationIndexReads)) {
      expect(ledger.readFileCalls).toBe(1);
      expect(ledger.opens).toBe(1);
    }
  }, 60_000);

  it('throws the same session-not-found failure for a non-global analyst during the global list', () => {
    const projectRoot = createRoot();
    const nonGlobalAnalyst = { ...TEST_WORKFLOWS, analyst: { ...TEST_WORKFLOWS.analyst, session: 'card' as const } };
    const service = new AgentOperatorReadModelService(projectRoot, nonGlobalAnalyst, () => new Map());
    expect(() => service.listSessions()).toThrow(AgentSessionNotFoundError);
    expect(() => service.listSessions()).toThrow(/Agent session 'agent:analyst:global' not found/);
  });

  it('throws the same missing-workflow failure during candidate enumeration', () => {
    const projectRoot = createRoot();
    const cards = new CardService(projectRoot);
    const child = cards.create({
      type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'brief',
      priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [],
    });
    const cardTypes = new Map(TEST_WORKFLOWS.cardTypes);
    cardTypes.delete(child.type);
    const missingWorkflow = { ...TEST_WORKFLOWS, cardTypes };
    const service = new AgentOperatorReadModelService(projectRoot, missingWorkflow as typeof TEST_WORKFLOWS, () => new Map());
    expect(() => service.listSessions()).toThrow(`No compiled workflow for '${child.type}'.`);
  });

  it('omits an exact missing candidate conversation during the global list', () => {
    const projectRoot = createRoot();
    const cards = new CardService(projectRoot);
    const child = cards.create({
      type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'brief',
      priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [],
    });
    const sessionId = cardAgentSessionId('executor', child.id);
    publishMarker(projectRoot, sessionId);
    rmSync(cardConversationsRoot(projectRoot, child.id), { recursive: true, force: true });
    const service = new AgentOperatorReadModelService(projectRoot, TEST_WORKFLOWS, () => new Map());
    expect(service.listSessions().sessions).not.toEqual(expect.arrayContaining([expect.objectContaining({id:sessionId})]));
  });
});

function createRoot(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agent-operator-read-model-'));
  roots.push(projectRoot);
  initProjectTree(projectRoot);
  return projectRoot;
}

function runReadCountChild(projectRoot: string): {
  cardStreamOpens: Record<string, number>;
  conversationIndexReads: Record<string, { opens: number; readCalls: number; readFileCalls: number }>;
  conversationSegmentOpens: number;
} {
  const inputPath = join(tmpdir(), `agent-list-read-count-${process.pid}-${Date.now()}.json`);
  writeFileSync(inputPath, JSON.stringify({ root: projectRoot }));
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', join('tests', 'fixtures', 'agent-list-read-count-child.ts'), inputPath], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const line = result.stdout.trim().split('\n').at(-1)!;
    return JSON.parse(line);
  } finally {
    rmSync(inputPath, { force: true });
  }
}

function publishMarker(projectRoot: string, sessionId: ConversationSessionId): void {
  initializeMissingConversation(projectRoot, sessionId);
  const identity = conversationSessionIdentity(sessionId);
  appendConversationBatch(
    { projectRoot },
    [
      agentMessageSchema.parse({
        id: `${sessionId}:marker`,
        session_id: sessionId,
        role: 'system',
        kind: 'activity',
        context_policy: { kind: 'structural', behavior: 'activation_boundary' },
        content: JSON.stringify({
          agent_name: identity.agentName,
          ...(identity.cardId === null ? {} : { card_id: identity.cardId }),
          event: 'activation_open',
          input_id: '00000000-0000-4000-8000-000000000001',
          timestamp,
        }),
        round_id: `r-user-${'0'.repeat(32)}`,
        message_index: 0,
        block_index: 0,
        timestamp,
      }),
    ],
  );
}
