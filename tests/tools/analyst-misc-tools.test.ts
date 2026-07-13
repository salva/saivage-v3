import { initProjectTree, CardStore } from '../helpers/canonical-project.js';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


import { appendConversationMessage, buildContextTextMessage } from '../../src/runtime/actors/index.js';
import { list_agent_sessions, read_agent_session } from '../../src/tools/analyst-misc-tools.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';

let root: string;
let ctx: ToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saivage-analyst-tools-'));
  initProjectTree(root);
  ctx = { projectRoot: root, processRunner: new ProcessRunner(root), store: new CardStore(root), actor: 'analyst', surface: 'web-chat', restartServerAvailable: false };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('analyst misc tools', () => {
  it('lists agent sessions from conversation segments', async () => {
    appendConversationMessage(root, { ...buildContextTextMessage('analyst:global', 'user', 'hello'), id: 'analyst-message', timestamp: '2026-01-01T00:00:00.000Z' });
    appendConversationMessage(root, { ...buildContextTextMessage('planner:card-1', 'user', 'plan'), id: 'planner-message', timestamp: '2026-01-01T00:00:01.000Z' });

    const result = await list_agent_sessions(ctx, {});

    expect(result.success).toBe(true);
    expect(result.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'analyst:global', role: 'analyst', status: 'inactive' }),
      expect.objectContaining({ id: 'planner:card-1', role: 'planner', card_id: 'card-1' }),
    ]));
  });

  it('reads a segment-backed agent session with tailing', async () => {
    appendConversationMessage(root, { ...buildContextTextMessage('executor:card-1', 'user', 'first'), id: 'executor-message-1', timestamp: '2026-01-01T00:00:00.000Z' });
    appendConversationMessage(root, { ...buildContextTextMessage('executor:card-1', 'user', 'second'), id: 'executor-message-2', timestamp: '2026-01-01T00:00:01.000Z' });

    const result = await read_agent_session(ctx, { sessionId: 'executor:card-1', lastN: 1 });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(expect.objectContaining({
      session: expect.objectContaining({ id: 'executor:card-1', role: 'executor', card_id: 'card-1' }),
      total_messages: 2,
      returned: 1,
      messages: [expect.objectContaining({ id: 'executor-message-2', content: 'second' })],
    }));
  });
});
