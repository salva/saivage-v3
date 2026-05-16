import { describe, it, expect, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { AgentAdapter, type LlmCallFn } from '../../src/agents/agent-adapter.js';
import type { SaivageConfig } from '../../src/agents/config-schema.js';
import { CardStore } from '../../src/utils/card-store.js';
import { getSessionMessages } from '../../src/agents/session-persistence.js';

function createAdapter(tmpDir: string): AgentAdapter {
  const minimalConfig = { providers: {}, models: { routes: [] }, server: { port: 8080, host: '0.0.0.0' }, runtime: { compactionThreshold: 0.8, maxCompactions: 3, recoveryDelayMs: 60000, maxRecoveryRetries: 0, selfCheck: { planner: 0, executor: 0, reviewer: 0, analyst: 0 } }, security: {}, supervisor: {} } as unknown as SaivageConfig;
  return new AgentAdapter({ projectRoot: tmpDir, saivageDir: join(tmpDir, '.saivage'), config: minimalConfig });
}

describe('operator edits running card integration', () => {
  it('executor receives card_changed, diffs history, acknowledges, and completes cleanly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-f-integration-'));
    try {
      initProjectTree(root);
      const store = new CardStore(root);
      store.create({ id: 'goal-1', type: 'goal', parent: 'project', depth: 0, title: 'goal', description: '', status: 'active', tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', acceptance: '', depends_on: [], blocks: [], related: [], artifacts: [], attachments: [], retries: 0 });
      store.create({ id: 'code-1', type: 'code', parent: 'goal-1', depth: 0, title: 'task', description: 'before', status: 'backlog', tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', acceptance: 'a', depends_on: [], blocks: [], related: [], artifacts: [], attachments: [], retries: 0 });

      const adapter = createAdapter(root);
      jest.spyOn(adapter.router, 'resolve').mockResolvedValue([{ provider: 'test', account: 'default', model: 'fake-model' }]);
      const responses = [
        JSON.stringify({ toolCalls: [
          { id: 'tc-1', type: 'function', function: { name: 'diff_card', arguments: JSON.stringify({ cardId: 'code-1' }) } },
          { id: 'tc-2', type: 'function', function: { name: 'get_card_history_entry', arguments: JSON.stringify({ cardId: 'code-1', version_seq: 1 }) } },
          { id: 'tc-3', type: 'function', function: { name: 'acknowledge_notification', arguments: JSON.stringify({ notificationId: 'card_changed-test' }) } },
        ] }),
        JSON.stringify({ card_id: 'code-1', status: 'done', artifacts: [], attachments: [], summary: 'adjusted after operator edit' }),
      ];
      const llmCall = jest.fn<LlmCallFn>(async () => responses.shift() ?? '{}');
      adapter.setLlmCallFn(llmCall);
      adapter.setAfterSessionCreatedHook((sessionId) => {
        const notification = store.mutateCard('code-1', { description: 'after', acceptance: 'b' }, { actor: 'analyst', surface: 'web-chat', reason: 'operator edit' });
        void notification;
        const delivered = adapter.notificationCenter.drainPendingForSession(sessionId);
        if (delivered[0]) {
          adapter.notificationCenter.acknowledge(sessionId, delivered[0].id);
        }
        adapter.notificationCenter.enqueueForSession(sessionId, { id: 'card_changed-test', kind: 'card_changed', severity: 'block', payload_summary: 'Card code-1 updated by analyst', related_card_id: 'code-1', related_version_seq: 2, source_actor: 'analyst', source_surface: 'web-chat' });
      });

      const result = await adapter.invokeExecutor('code-1', 'goal-1', 'system prompt');
      expect(result.status).toBe('done');
      const sessionId = llmCall.mock.calls[0]?.[3] as string;
      const messages = getSessionMessages(join(root, '.saivage'), sessionId);
      expect(messages.some((message) => message.kind === 'tool_call' && message.content.includes('diff_card'))).toBe(true);
      expect(messages.some((message) => message.kind === 'tool_result' && message.tool === 'acknowledge_notification')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
