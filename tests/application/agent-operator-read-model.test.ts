import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  AgentOperatorReadModelService,
  AgentSessionNotFoundError,
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
import { cardConversationsRoot, cardStreamFile } from '../../src/persistence/layout.js';
import { executingLlmSnapshots } from '../helpers/executing-llm-snapshot.js';

const roots: string[] = [];
const timestamp = '2026-07-24T00:00:00.000Z';

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('AgentOperatorReadModelService granular resources', () => {
  it('derives compiled-workflow candidates and reads index metadata for summaries', () => {
    const projectRoot = createRoot();
    const cards = new CardService(projectRoot);
    const child = cards.create({
      type: 'code',
      parent: 'project',
      title: 'Code child',
      bootstrap_content: 'brief',
      tags: [],
      priority: 0,
      urgency: 'normal',
      created_by: 'analyst',
      depends_on: [],
      related: [],
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
      type: 'code', parent: 'project', title: 'First', bootstrap_content: 'brief', tags: [],
      priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [],
    });
    const second = cards.create({
      type: 'code', parent: 'project', title: 'Second', bootstrap_content: 'brief', tags: [],
      priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [],
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
      type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'brief', tags: [],
      priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [],
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
      type: 'goal', parent: 'project', title: 'Goal', bootstrap_content: 'brief', tags: [],
      priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [],
    });
    const code = cards.create({
      type: 'code', parent: goal.id, title: 'Code', bootstrap_content: 'brief', tags: [],
      priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [],
    });
    publishMarker(projectRoot, cardAgentSessionId('planner', 'project'));
    publishMarker(projectRoot, cardAgentSessionId('executor', code.id));
    const snapshot = runReadCountChild(projectRoot);
    expect(Object.keys(snapshot.cardStreamOpens).sort()).toEqual(
      ['project', goal.id, code.id].map((cardId) => cardStreamFile(projectRoot, cardId)).sort(),
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
      type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'brief', tags: [],
      priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [],
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
      type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'brief', tags: [],
      priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [],
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
