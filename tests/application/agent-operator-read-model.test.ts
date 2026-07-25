import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';

import {
  AgentOperatorReadModelService,
  AgentSessionNotFoundError,
  CardAgentScopeNotFoundError,
} from '../../src/application/read-models/agent-operator-read-model.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import { conversationFile } from '../../src/runtime/actors/conversation-inventory.js';
import {
  agentMessageSchema,
  cardAgentSessionId,
  conversationSessionIdentity,
  globalAgentSessionId,
  type ConversationSessionId,
} from '../../src/schemas/index.js';
import { CardService, initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';

const roots: string[] = [];
const timestamp = '2026-07-24T00:00:00.000Z';

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('AgentOperatorReadModelService granular resources', () => {
  it('derives compiled-workflow candidates and reads only their first envelopes for summaries', () => {
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
    const planner = cardAgentSessionId('planner', 'project');
    const reviewer = cardAgentSessionId('reviewer', 'project');
    const executor = cardAgentSessionId('executor', child.id);
    for (const sessionId of [analyst, planner, reviewer, executor]) publishMarker(projectRoot, sessionId);

    appendFileSync(conversationFile(projectRoot, planner), '{malformed later envelope}\n');
    const service = new AgentOperatorReadModelService(projectRoot, TEST_WORKFLOWS);

    expect(service.listSessions().sessions.map(({ id }) => id)).toEqual(
      [analyst, executor, planner, reviewer].sort(),
    );
    expect(service.getSession(planner).session.started_at).toBe(timestamp);
    expect(() => service.getConversation(planner)).toThrow(/malformed/i);
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
    ).listCardSessions(first.id);
    expect(response).toEqual({ card_id: first.id, sessions: [expect.objectContaining({ id: firstSession })] });
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
    const service = new AgentOperatorReadModelService(projectRoot, TEST_WORKFLOWS);
    expect(service.listSessions().sessions).toContainEqual(expect.objectContaining({ id: sessionId }));

    cards.deleteSubtrees([child.id], () => true);

    expect(service.listSessions().sessions).not.toContainEqual(expect.objectContaining({ id: sessionId }));
    expect(service.getSession(sessionId).session.id).toBe(sessionId);
    expect(() => service.listCardSessions(child.id)).toThrow(CardAgentScopeNotFoundError);
  });

  it('omits only exact ENOENT candidates and keeps exact missing detail distinct', () => {
    const projectRoot = createRoot();
    const service = new AgentOperatorReadModelService(projectRoot, TEST_WORKFLOWS);
    expect(service.listSessions()).toEqual({ sessions: [] });
    expect(() => service.getSession('agent:analyst:global')).toThrow(AgentSessionNotFoundError);
  });
});

function createRoot(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agent-operator-read-model-'));
  roots.push(projectRoot);
  initProjectTree(projectRoot);
  return projectRoot;
}

function publishMarker(projectRoot: string, sessionId: ConversationSessionId): void {
  const identity = conversationSessionIdentity(sessionId);
  appendConversationBatch(
    { projectRoot },
    [
      agentMessageSchema.parse({
        id: `${sessionId}:marker`,
        session_id: sessionId,
        role: 'system',
        kind: 'activity',
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
