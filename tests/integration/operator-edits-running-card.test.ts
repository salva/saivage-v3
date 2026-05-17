import { describe, it, expect, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { AgentAdapter, type LlmCallFn } from '../../src/agents/agent-adapter.js';
import type { SaivageConfig } from '../../src/agents/config-schema.js';
import { CardStore } from '../../src/utils/card-store.js';
import { getSessionMessages, getSession } from '../../src/agents/session-persistence.js';
import { appendNote } from '../../src/utils/notes.js';

function createAdapter(tmpDir: string): AgentAdapter {
  const minimalConfig = { providers: {}, models: { routes: [] }, server: { port: 8080, host: '0.0.0.0' }, runtime: { compactionThreshold: 0.8, maxCompactions: 3, recoveryDelayMs: 60000, maxRecoveryRetries: 0, selfCheck: { planner: 0, executor: 0, reviewer: 0, analyst: 0 } }, security: {}, supervisor: {} } as unknown as SaivageConfig;
  return new AgentAdapter({ projectRoot: tmpDir, saivageDir: join(tmpDir, '.saivage'), config: minimalConfig });
}

describe('operator edits running card integration', () => {
  it('holds terminal completion until blocking notifications are canonically inspected and acknowledged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'post-wave-i-safe-point-'));
    try {
      initProjectTree(root);
      const store = new CardStore(root);
      store.create({ id: 'goal-1', type: 'goal', parent: 'project', depth: 0, title: 'goal', description: '', status: 'active', tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', acceptance: '', depends_on: [], blocks: [], related: [], artifacts: [], attachments: [], retries: 0 });
      store.create({ id: 'code-1', type: 'code', parent: 'goal-1', depth: 0, title: 'task', description: 'before secret=abc123', status: 'backlog', tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', acceptance: 'a', depends_on: [], blocks: [], related: [], artifacts: [], attachments: [], retries: 0 });

      const adapter = createAdapter(root);
      jest.spyOn(adapter.router, 'resolve').mockResolvedValue([{ provider: 'test', account: 'default', model: 'fake-model' }]);

      let sessionId = '';
      let cardNotificationId = '';
      let noteNotificationId = '';
      let noteId = '';
      const llmMessages: string[] = [];

      adapter.setAfterSessionCreatedHook((createdSessionId) => {
        sessionId = createdSessionId;
        store.setStatus('code-1', 'active');
        store.setStatus('code-1', 'running');
        store.mutateCard('code-1', { description: 'after secret=abc123', acceptance: 'b' }, { actor: 'analyst', surface: 'web-chat', reason: 'operator edit' });
        const note = appendNote(join(root, '.saivage'), 'code-1', { author: 'analyst', content: 'directive with token=xyz987', kind: 'escalation' });
        noteId = note.id;
        const pending = adapter.notificationCenter.drainPendingForSession(createdSessionId);
        expect(pending).toHaveLength(2);
        const cardNotification = pending.find((record) => record.kind === 'card_changed');
        const noteNotification = pending.find((record) => record.kind === 'note_added');
        expect(cardNotification).toBeTruthy();
        expect(noteNotification).toBeTruthy();
        cardNotificationId = cardNotification?.id ?? '';
        noteNotificationId = noteNotification?.id ?? '';
      });

      let llmTurn = 0;
      const llmCall = jest.fn<LlmCallFn>(async (_candidate, _systemPrompt, messages, _sessionId) => {
        const latestUserText = [...messages].reverse().find((message) => message.role === 'user' && message.kind === 'text')?.content ?? '';
        llmMessages.push(latestUserText);

        if (llmTurn === 0) {
          expect(latestUserText).toContain('## Operator updates since your last turn');
          expect(latestUserText).toContain(cardNotificationId);
          expect(latestUserText).toContain(noteNotificationId);
          expect(latestUserText).toContain('severity=block');
          expect(latestUserText).toContain('card=code-1');
          expect(latestUserText).toContain('note=' + noteId);
          expect(latestUserText).toContain('version=2');
          expect(latestUserText).toContain('list_card_history/get_card_history_entry/diff_card/list_notes/get_note');
          expect(latestUserText).toContain('acknowledge_notification');
          expect(latestUserText).not.toContain('abc123');
          expect(latestUserText).not.toContain('xyz987');
          llmTurn += 1;
          return JSON.stringify({ card_id: 'code-1', status: 'done', status_text: 'Completed successfully', artifacts: [], attachments: [], summary: 'premature completion before ack' });
        }

        if (llmTurn === 1) {
          expect(latestUserText).toContain('Blocking operator updates still require acknowledgement');
          expect(latestUserText).toContain(cardNotificationId);
          expect(latestUserText).toContain(noteNotificationId);
          expect(adapter.notificationCenter.hasBlockingPendingForSession(sessionId)).toBe(true);
          llmTurn += 1;
          return JSON.stringify({ toolCalls: [
            { id: 'tc-1', type: 'function', function: { name: 'list_card_history', arguments: JSON.stringify({ cardId: 'code-1' }) } },
            { id: 'tc-2', type: 'function', function: { name: 'get_card_history_entry', arguments: JSON.stringify({ cardId: 'code-1', version_seq: 1 }) } },
            { id: 'tc-3', type: 'function', function: { name: 'diff_card', arguments: JSON.stringify({ cardId: 'code-1', fromSeq: 1, toSeq: 2 }) } },
            { id: 'tc-4', type: 'function', function: { name: 'list_notes', arguments: JSON.stringify({ cardId: 'code-1' }) } },
            { id: 'tc-5', type: 'function', function: { name: 'get_note', arguments: JSON.stringify({ cardId: 'code-1', noteId }) } },
            { id: 'tc-6', type: 'function', function: { name: 'acknowledge_notification', arguments: JSON.stringify({ notificationId: cardNotificationId }) } },
            { id: 'tc-7', type: 'function', function: { name: 'acknowledge_notification', arguments: JSON.stringify({ notificationId: noteNotificationId }) } },
          ] });
        }

        expect(adapter.notificationCenter.hasBlockingPendingForSession(sessionId)).toBe(false);
        expect(latestUserText).not.toContain('abc123');
        expect(latestUserText).not.toContain('xyz987');
        return JSON.stringify({ card_id: 'code-1', status: 'done', status_text: 'Completed successfully', artifacts: [], attachments: [], summary: 'adjusted after operator change acknowledgement' });
      });
      adapter.setLlmCallFn(llmCall);

      const result = await adapter.invokeExecutor('code-1', 'goal-1', 'system prompt');
      expect(result.status).toBe('done');
      expect(llmCall).toHaveBeenCalledTimes(3);
      expect(adapter.notificationCenter.hasBlockingPendingForSession(sessionId)).toBe(false);

      const session = getSession(join(root, '.saivage'), sessionId);
      expect(session?.status).toBe('done');

      const messages = getSessionMessages(join(root, '.saivage'), sessionId);
      expect(messages.some((message) => message.role === 'system' && message.kind === 'model_issue' && message.content.includes('Terminal result held because blocking operator notifications remain unacknowledged.'))).toBe(true);
      expect(messages.some((message) => message.role === 'user' && message.kind === 'text' && message.content.includes('Blocking operator updates still require acknowledgement'))).toBe(true);
      expect(messages.some((message) => message.kind === 'tool_call' && message.content.includes('list_card_history'))).toBe(true);
      expect(messages.some((message) => message.kind === 'tool_call' && message.content.includes('get_card_history_entry'))).toBe(true);
      expect(messages.some((message) => message.kind === 'tool_call' && message.content.includes('diff_card'))).toBe(true);
      expect(messages.some((message) => message.kind === 'tool_call' && message.content.includes('list_notes'))).toBe(true);
      expect(messages.some((message) => message.kind === 'tool_call' && message.content.includes('get_note'))).toBe(true);
      expect(messages.filter((message) => message.kind === 'tool_result' && message.tool === 'acknowledge_notification')).toHaveLength(2);
      expect(messages.some((message) => message.kind === 'tool_result' && message.tool === 'acknowledge_notification' && message.content.includes(cardNotificationId))).toBe(true);
      expect(messages.some((message) => message.kind === 'tool_result' && message.tool === 'acknowledge_notification' && message.content.includes(noteNotificationId))).toBe(true);
      expect(messages.some((message) => message.kind === 'tool_result' && message.tool === 'get_note' && message.content.includes('[REDACTED]'))).toBe(false);

      const auditPath = join(root, '.saivage', 'runtime', 'control-actions.jsonl');
      const auditEntries = readFileSync(auditPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
      expect(auditEntries).toHaveLength(2);
      expect(auditEntries.every((entry) => entry.action === 'notification.acknowledge')).toBe(true);
      expect(auditEntries.every((entry) => entry.outcome === 'ok')).toBe(true);
      expect(llmMessages[0]).not.toContain('abc123');
      expect(llmMessages[0]).not.toContain('xyz987');
      expect(llmMessages[1]).not.toContain('abc123');
      expect(llmMessages[1]).not.toContain('xyz987');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
