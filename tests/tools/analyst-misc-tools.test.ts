import { initProjectTree, CardStore, testConfigAuthority } from '../helpers/canonical-project.js';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


import { appendConversationMessage, buildContextTextMessage } from '../../src/runtime/actors/index.js';
import { list_agent_sessions, mcp_reconcile, read_agent_session, reconfigure } from '../../src/tools/analyst-misc-tools.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';

let root: string;
let ctx: ToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saivage-analyst-tools-'));
  initProjectTree(root);
  const processRunner = createTestProcessRunner(root);
  const store = new CardStore(root);
  ctx = { projectRoot: root, configAuthority: testConfigAuthority(root), mutationAuthority: () => store.currentMutationAuthority(), processRunner, processScope: processRunner.createDirectScope(processRunner.analystRootScope, 'test-analyst', 'operator_session'), store, actor: 'analyst', surface: 'web-chat', restartServerAvailable: false };
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

  it('rejects Analyst MCP desired-config mutation and reconciliation before quiescent Pause', async () => {
    const mutate = jest.fn();
    const reconcilePersistedConfig = jest.fn();
    ctx.configAuthority = { ...ctx.configAuthority, mutate } as never;
    ctx.mcpManager = { reconcilePersistedConfig } as never;

    const mutation = await reconfigure(ctx, { action: 'mcp_add', name: 'server', command: '/bin/server' });
    const retry = await mcp_reconcile(ctx);

    expect(mutation).toMatchObject({ success: false, data: { persisted: false, reconciled: false } });
    expect(retry).toMatchObject({ success: false, data: { persisted: false, reconciled: false } });
    expect(mutate).not.toHaveBeenCalled();
    expect(reconcilePersistedConfig).not.toHaveBeenCalled();
  });
});
