/**
 * Tests for session-persistence.ts — agent session and message persistence
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { SessionMessageLog } from '../../src/agents/session-message-log.js';

const TEST_ROOT = join(tmpdir(), `saivage-session-test-${Date.now()}`);
const SAIVAGE_DIR = join(TEST_ROOT, '.saivage');

function setup() {
  initProjectTree(TEST_ROOT);
  mkdirSync(SAIVAGE_DIR, { recursive: true });
}

function cleanup() {
  if (existsSync(TEST_ROOT)) {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  }
}

let mod: typeof import('../../src/agents/session-persistence.js');
let persistenceMod: typeof import('../../src/persistence/index.js');

beforeAll(async () => {
  mod = await import('../../src/agents/session-persistence.js');
  persistenceMod = await import('../../src/persistence/index.js');
});

beforeEach(() => {
  cleanup();
  setup();
});
afterEach(() => cleanup());

describe('session-persistence', () => {
  describe('createSession', () => {
    it('should create an active session', () => {
      const session = mod.createSession(SAIVAGE_DIR, 'planner', 'goal-1', 'plan-1', 'gpt-5.5');
      expect(session.role).toBe('planner');
      expect(session.status).toBe('active');
      expect(session.goal_card_id).toBe('goal-1');
      expect(session.card_id).toBe('plan-1');
      expect(session.model).toBe('gpt-5.5');
      expect(session.started_at).toBeDefined();
      expect(session.id).toBeDefined();
    });

    it('should persist session to disk', () => {
      const session = mod.createSession(SAIVAGE_DIR, 'executor', 'goal-1');
      const loaded = mod.getSession(SAIVAGE_DIR, session.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(session.id);
      expect(loaded!.role).toBe('executor');
      expect(loaded!.status).toBe('active');
    });

    it('persists reviewer assessment identity', () => {
      const session = mod.createSession(SAIVAGE_DIR, 'reviewer', 'goal-1', 'goal-1', undefined, 'reviewer:goal-1:assessment-1', 'assessment-1');

      expect(session.assessment_id).toBe('assessment-1');
      expect(mod.getSession(SAIVAGE_DIR, session.id)?.assessment_id).toBe('assessment-1');
    });
  });

  describe('getSession', () => {
    it('should return null for nonexistent session', () => {
      const session = mod.getSession(SAIVAGE_DIR, 'nonexistent');
      expect(session).toBeNull();
    });

    it('should return the session for a valid ID', () => {
      const created = mod.createSession(SAIVAGE_DIR, 'reviewer', 'goal-1', 'plan-1');
      const loaded = mod.getSession(SAIVAGE_DIR, created.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.role).toBe('reviewer');
    });

    it('rejects legacy session state with discard guidance', () => {
      writeFileSync(
        join(SAIVAGE_DIR, 'agents', 'sessions', 'legacy.json'),
        JSON.stringify({ id: 'legacy', role: 'planner' }, null, 2),
      );
      expect(() => mod.getSession(SAIVAGE_DIR, 'legacy')).toThrow(/Legacy \.saivage state is not supported|discarded-<timestamp>/i);
    });
  });

  describe('completeSession', () => {
    it('should mark session as done', () => {
      const session = mod.createSession(SAIVAGE_DIR, 'planner');
      const completed = mod.completeSession(SAIVAGE_DIR, session.id, 'done');
      expect(completed.status).toBe('done');
      expect(completed.completed_at).toBeDefined();
    });

    it('should mark session as failed', () => {
      const session = mod.createSession(SAIVAGE_DIR, 'planner');
      const completed = mod.completeSession(SAIVAGE_DIR, session.id, 'failed');
      expect(completed.status).toBe('failed');
    });

    it('should mark session as waiting without a completion timestamp', () => {
      const session = mod.createSession(SAIVAGE_DIR, 'planner');
      mod.completeSession(SAIVAGE_DIR, session.id, 'done');
      const waiting = mod.markSessionWaiting(SAIVAGE_DIR, session.id);

      expect(waiting.status).toBe('waiting');
      expect(waiting.completed_at).toBeNull();
      expect(mod.getSession(SAIVAGE_DIR, session.id)?.status).toBe('waiting');
    });

    it('should throw for nonexistent session', () => {
      expect(() => mod.completeSession(SAIVAGE_DIR, 'nonexistent', 'done')).toThrow(/not found/);
    });
  });

  describe('reconcileOrphanedAgentSessions', () => {
    it('sweeps active planner', () => {
      const planner = mod.createSession(SAIVAGE_DIR, 'planner', 'goal-1', 'goal-1');

      const swept = mod.reconcileOrphanedAgentSessions(SAIVAGE_DIR, 'startup recovery');

      expect(swept.map((session) => session.id)).toEqual([planner.id]);
      expect(mod.getSession(SAIVAGE_DIR, planner.id)?.status).toBe('failed');
      expect(mod.getSessionMessages(SAIVAGE_DIR, planner.id)).toEqual([
        expect.objectContaining({ role: 'system', kind: 'model_issue', content: 'startup recovery' }),
      ]);
    });

    it('sweeps active executor and reviewer; analyst untouched', () => {
      const activeExecutor = mod.createSession(SAIVAGE_DIR, 'executor', 'goal-1', 'card-1');
      const activeReviewer = mod.createSession(SAIVAGE_DIR, 'reviewer', 'goal-1', 'goal-1');
      const analyst = mod.createSession(SAIVAGE_DIR, 'analyst');
      const analystBefore = readFileSync(join(SAIVAGE_DIR, 'agents', 'sessions', `${analyst.id}.json`), 'utf8');

      const swept = mod.reconcileOrphanedAgentSessions(SAIVAGE_DIR, 'startup recovery');

      expect(swept.map((session) => session.id).sort()).toEqual([activeExecutor.id, activeReviewer.id].sort());
      for (const sessionId of [activeExecutor.id, activeReviewer.id]) {
        expect(mod.getSession(SAIVAGE_DIR, sessionId)?.status).toBe('failed');
        expect(mod.getSessionMessages(SAIVAGE_DIR, sessionId)).toEqual([
          expect.objectContaining({ role: 'system', kind: 'model_issue', content: 'startup recovery' }),
        ]);
      }
      expect(readFileSync(join(SAIVAGE_DIR, 'agents', 'sessions', `${analyst.id}.json`), 'utf8')).toBe(analystBefore);
    });

    it('does NOT sweep waiting planner', () => {
      const planner = mod.createSession(SAIVAGE_DIR, 'planner', 'goal-1', 'goal-1');
      mod.markSessionWaiting(SAIVAGE_DIR, planner.id);
      const before = readFileSync(join(SAIVAGE_DIR, 'agents', 'sessions', `${planner.id}.json`), 'utf8');

      expect(mod.reconcileOrphanedAgentSessions(SAIVAGE_DIR)).toEqual([]);
      expect(readFileSync(join(SAIVAGE_DIR, 'agents', 'sessions', `${planner.id}.json`), 'utf8')).toBe(before);
      expect(mod.getSessionMessages(SAIVAGE_DIR, planner.id)).toEqual([]);
    });

    it('does NOT sweep terminal manifests', () => {
      const doneExecutor = mod.createSession(SAIVAGE_DIR, 'executor', 'goal-1', 'card-1');
      const failedReviewer = mod.createSession(SAIVAGE_DIR, 'reviewer', 'goal-2', 'goal-2');
      const blockedPlanner = mod.createSession(SAIVAGE_DIR, 'planner', 'goal-3', 'goal-3');
      mod.completeSession(SAIVAGE_DIR, doneExecutor.id, 'done');
      mod.completeSession(SAIVAGE_DIR, failedReviewer.id, 'failed');
      mod.completeSession(SAIVAGE_DIR, blockedPlanner.id, 'blocked');
      const before = new Map([doneExecutor.id, failedReviewer.id, blockedPlanner.id].map((id) => [
        id,
        readFileSync(join(SAIVAGE_DIR, 'agents', 'sessions', `${id}.json`), 'utf8'),
      ]));

      expect(mod.reconcileOrphanedAgentSessions(SAIVAGE_DIR)).toEqual([]);
      for (const [id, content] of before) {
        expect(readFileSync(join(SAIVAGE_DIR, 'agents', 'sessions', `${id}.json`), 'utf8')).toBe(content);
      }
    });

    it('is idempotent', () => {
      const executor = mod.createSession(SAIVAGE_DIR, 'executor', 'goal-1', 'card-1');

      expect(mod.reconcileOrphanedAgentSessions(SAIVAGE_DIR)).toHaveLength(1);
      expect(mod.reconcileOrphanedAgentSessions(SAIVAGE_DIR)).toEqual([]);
      expect(mod.getSessionMessages(SAIVAGE_DIR, executor.id)).toHaveLength(1);
    });
  });

  describe('assertNoActiveAgentSession', () => {
    it('throws when an active planner blocks a new executor', () => {
      const planner = mod.createSession(SAIVAGE_DIR, 'planner', 'goal-1', 'goal-1');

      expect(() => mod.assertNoActiveAgentSession(SAIVAGE_DIR, 'executor')).toThrow(mod.ConcurrentAgentSessionError);
      try {
        mod.assertNoActiveAgentSession(SAIVAGE_DIR, 'executor');
        throw new Error('expected assertion to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(mod.ConcurrentAgentSessionError);
        expect((error as InstanceType<typeof mod.ConcurrentAgentSessionError>).newRole).toBe('executor');
        expect((error as InstanceType<typeof mod.ConcurrentAgentSessionError>).conflictingSessionId).toBe(planner.id);
        expect((error as InstanceType<typeof mod.ConcurrentAgentSessionError>).conflictingRole).toBe('planner');
        expect((error as InstanceType<typeof mod.ConcurrentAgentSessionError>).conflictingCardId).toBe('goal-1');
      }
    });

    it('throws when an active executor blocks a new executor on a different card', () => {
      const executor = mod.createSession(SAIVAGE_DIR, 'executor', 'goal-1', 'card-1');

      expect(() => mod.assertNoActiveAgentSession(SAIVAGE_DIR, 'executor')).toThrow(executor.id);
    });

    it('throws when an active executor blocks a new reviewer (cross-role)', () => {
      const executor = mod.createSession(SAIVAGE_DIR, 'executor', 'goal-1', 'card-1');

      expect(() => mod.assertNoActiveAgentSession(SAIVAGE_DIR, 'reviewer')).toThrow(mod.ConcurrentAgentSessionError);
      expect(() => mod.assertNoActiveAgentSession(SAIVAGE_DIR, 'reviewer')).toThrow(executor.id);
    });

    it('does NOT throw on planner deterministic-ID re-entry from waiting', () => {
      const planner = mod.createSession(SAIVAGE_DIR, 'planner', 'goal-1', 'goal-1');
      mod.markSessionWaiting(SAIVAGE_DIR, planner.id);

      expect(() => mod.assertNoActiveAgentSession(SAIVAGE_DIR, 'planner')).not.toThrow();
    });

    it('does NOT throw when the new role is analyst, even with an active executor present', () => {
      mod.createSession(SAIVAGE_DIR, 'executor', 'goal-1', 'card-1');

      expect(() => mod.assertNoActiveAgentSession(SAIVAGE_DIR, 'analyst')).not.toThrow();
    });

    it('does NOT throw when only terminal manifests exist, or when only an active analyst exists', () => {
      const doneExecutor = mod.createSession(SAIVAGE_DIR, 'executor', 'goal-1', 'card-1');
      const analyst = mod.createSession(SAIVAGE_DIR, 'analyst');
      mod.completeSession(SAIVAGE_DIR, doneExecutor.id, 'done');

      expect(() => mod.assertNoActiveAgentSession(SAIVAGE_DIR, 'executor')).not.toThrow();
      expect(mod.getSession(SAIVAGE_DIR, analyst.id)?.status).toBe('active');
    });
  });

  describe('updateSessionModel', () => {
    it('should update the model field', () => {
      const session = mod.createSession(SAIVAGE_DIR, 'planner');
      const updated = mod.updateSessionModel(SAIVAGE_DIR, session.id, 'new-model');
      expect(updated.model).toBe('new-model');
    });
  });

  describe('appendMessage', () => {
    function sessionMessagesPath(sessionId: string): string {
      return join(SAIVAGE_DIR, 'agents', 'messages', `${sessionId}.jsonl`);
    }

    function nonEmptyLineCount(path: string): number {
      return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
    }

    it('should append a message to a session', () => {
      const session = mod.createSession(SAIVAGE_DIR, 'planner');
      const msg = mod.appendMessage(SAIVAGE_DIR, session.id, {
        role: 'assistant',
        kind: 'text',
        content: 'Hello world',
      }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });
      expect(msg.session_id).toBe(session.id);
      expect(msg.role).toBe('assistant');
      expect(msg.content).toBe('Hello world');
    });

    it('should append messages in order', () => {
      const session = mod.createSession(SAIVAGE_DIR, 'planner');
      mod.appendMessage(SAIVAGE_DIR, session.id, { role: 'user', kind: 'text', content: 'First' }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });
      mod.appendMessage(SAIVAGE_DIR, session.id, { role: 'assistant', kind: 'text', content: 'Second' }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });

      const messages = mod.getSessionMessages(SAIVAGE_DIR, session.id);
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('First');
      expect(messages[1].content).toBe('Second');
    });

    it('appends one JSONL line per new message without adding entry_id', () => {
      const session = mod.createSession(SAIVAGE_DIR, 'planner');
      const first = mod.appendMessage(SAIVAGE_DIR, session.id, { role: 'user', kind: 'text', content: 'First' }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });
      const mp = sessionMessagesPath(session.id);
      const before = readFileSync(mp, 'utf8');

      const second = mod.appendMessage(SAIVAGE_DIR, session.id, { role: 'assistant', kind: 'text', content: 'Second' }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 1, block_index: 0 });
      const after = readFileSync(mp, 'utf8');
      const secondLine = JSON.parse(after.split('\n').filter((line) => line.trim() !== '')[1]) as Record<string, unknown>;

      expect(nonEmptyLineCount(mp)).toBe(2);
      expect(after.startsWith(before)).toBe(true);
      expect(first.id).toBe(`msg-${session.id}-1`);
      expect(second.id).toBe(`msg-${session.id}-2`);
      expect(secondLine.id).toBe(second.id);
      expect(secondLine.entry_id).toBeUndefined();
    });

    it('idempotently skips a duplicate append with the same message id', () => {
      const session = mod.createSession(SAIVAGE_DIR, 'planner');
      mod.appendMessage(SAIVAGE_DIR, session.id, { role: 'user', kind: 'text', content: 'First' }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });
      const mp = sessionMessagesPath(session.id);
      const existingMessage = JSON.parse(readFileSync(mp, 'utf8').trim()) as Record<string, unknown>;

      persistenceMod.appendSyncIdempotentByKey(mp, existingMessage, 'id');

      expect(nonEmptyLineCount(mp)).toBe(1);
      expect(mod.getSessionMessages(SAIVAGE_DIR, session.id)).toHaveLength(1);
    });

    it('fails clearly instead of appending over a corrupt JSONL tail', () => {
      const session = mod.createSession(SAIVAGE_DIR, 'planner');
      mod.appendMessage(SAIVAGE_DIR, session.id, { role: 'user', kind: 'text', content: 'First' }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });
      const mp = sessionMessagesPath(session.id);
      const corruptContent = readFileSync(mp, 'utf8') + '{"id":"partial"';
      writeFileSync(mp, corruptContent);

      expect(() => mod.getSessionMessages(SAIVAGE_DIR, session.id)).toThrow(/malformed session message JSONL at line 2/);
      expect(() => mod.appendMessage(SAIVAGE_DIR, session.id, { role: 'assistant', kind: 'text', content: 'Second' }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 1, block_index: 0 })).toThrow(/malformed session message JSONL at line 2/);
      expect(readFileSync(mp, 'utf8')).toBe(corruptContent);
    });
  });

  describe('SessionMessageLog', () => {
    it('requires and uses the injected stamper for append ordering', () => {
      const session = mod.createSession(SAIVAGE_DIR, 'planner');
      const stamps: Array<{ round_id: string; message_index: number; block_index: number }> = [];
      const stamper = {
        stampUserMessage: () => ({ round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 }),
        stampDiagnosticInCurrentRound: () => ({ round_id: 'r-diagnostic-00000000000000000000000000000001', message_index: 1, block_index: 1 }),
        openAssistantRound: () => ({ round_id: 'r-assistant-00000000000000000000000000000001', message_index: 0, block_index: 0 }),
        stampInRound: () => ({ round_id: 'r-assistant-00000000000000000000000000000001', message_index: 1, block_index: 1 }),
        stampPre: () => ({ round_id: 'r-pre-00000000000000000000000000000001', message_index: 0, block_index: 0 }),
        stampCompacted: () => ({ round_id: 'r-compacted-00000000000000000000000000000001', message_index: 0, block_index: 0 }),
        closeRound: () => undefined,
        recordAppend: (message: { round_id: string; message_index: number; block_index: number }) => { stamps.push({ round_id: message.round_id, message_index: message.message_index, block_index: message.block_index }); },
      };

      const log = new SessionMessageLog(SAIVAGE_DIR, stamper);
      log.append(session.id, { role: 'assistant', kind: 'text', content: 'hello' });
      log.append(session.id, { role: 'tool', kind: 'tool_result', content: '{}', tool: 'read_file', tool_call_id: 'call-1' });

      expect(stamps).toEqual([
        { round_id: 'r-assistant-00000000000000000000000000000001', message_index: 0, block_index: 0 },
        { round_id: 'r-assistant-00000000000000000000000000000001', message_index: 1, block_index: 1 },
      ]);
    });
  });

  describe('getSessionMessages', () => {
    it('should return empty array for no messages', () => {
      const session = mod.createSession(SAIVAGE_DIR, 'planner');
      const messages = mod.getSessionMessages(SAIVAGE_DIR, session.id);
      expect(messages).toEqual([]);
    });

    it('should return all messages', () => {
      const session = mod.createSession(SAIVAGE_DIR, 'planner');
      mod.appendMessage(SAIVAGE_DIR, session.id, { role: 'user', kind: 'text', content: 'msg1' }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });
      mod.appendMessage(SAIVAGE_DIR, session.id, { role: 'assistant', kind: 'text', content: 'msg2' }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });

      const messages = mod.getSessionMessages(SAIVAGE_DIR, session.id);
      expect(messages).toHaveLength(2);
    });
  });

  describe('replaceSessionMessages', () => {
    it('should replace all messages', () => {
      const session = mod.createSession(SAIVAGE_DIR, 'planner');
      mod.appendMessage(SAIVAGE_DIR, session.id, { role: 'user', kind: 'text', content: 'old' }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });

      mod.replaceSessionMessages(SAIVAGE_DIR, session.id, [
        {
          id: 'msg-compact-1',
          session_id: session.id,
          role: 'system',
          kind: 'model_repair',
          content: 'Summary',
          round_id: 'r-compacted-00000000000000000000000000000001',
          message_index: 0,
          block_index: 0,
          timestamp: new Date().toISOString(),
        },
      ]);

      const messages = mod.getSessionMessages(SAIVAGE_DIR, session.id);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Summary');
    });
  });

  describe('getSessionTokenCount', () => {
    it('should estimate token count', () => {
      const session = mod.createSession(SAIVAGE_DIR, 'planner');
      mod.appendMessage(SAIVAGE_DIR, session.id, {
        role: 'user',
        kind: 'text',
        content: 'This is a test message with some words',
      }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });

      const count = mod.getSessionTokenCount(SAIVAGE_DIR, session.id);
      expect(count).toBeGreaterThan(0);
    });
  });

  describe('findUniqueUnresolvedActivateCardToolCall', () => {
    it('throws when duplicate unresolved activate_card calls exist for one child', () => {
      const session = mod.createSession(SAIVAGE_DIR, 'planner', 'goal-1', 'goal-1');
      mod.appendMessage(SAIVAGE_DIR, session.id, {
        role: 'assistant',
        kind: 'tool_call',
        content: JSON.stringify({
          role: 'assistant',
          tool_calls: [
            { id: 'call-older', type: 'function', function: { name: 'activate_card', arguments: JSON.stringify({ cardId: 'child-1' }) } },
          ],
        }),
      }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });
      mod.appendMessage(SAIVAGE_DIR, session.id, {
        role: 'assistant',
        kind: 'tool_call',
        content: JSON.stringify({
          role: 'assistant',
          tool_calls: [
            { id: 'call-newer', type: 'function', function: { name: 'activate_card', arguments: JSON.stringify({ cardId: 'child-1' }) } },
          ],
        }),
      }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });

      expect(() => mod.findUniqueUnresolvedActivateCardToolCall(SAIVAGE_DIR, session.id, 'child-1')).toThrow(/duplicate unresolved activate_card/);
    });
  });

  describe('findPlannerSessionForCard', () => {
    it('uses only the deterministic planner session id', () => {
      mod.createSession(SAIVAGE_DIR, 'planner', 'goal-1', 'goal-1', undefined, 'legacy-planner-goal-1');

      expect(mod.findPlannerSessionForCard(SAIVAGE_DIR, 'goal-1')).toBeNull();

      const deterministic = mod.createSession(SAIVAGE_DIR, 'planner', 'goal-1', 'goal-1');
      expect(mod.findPlannerSessionForCard(SAIVAGE_DIR, 'goal-1')?.id).toBe(deterministic.id);
    });
  });

  describe('deleteSession', () => {
    it('should delete session and messages', () => {
      const session = mod.createSession(SAIVAGE_DIR, 'planner');
      mod.appendMessage(SAIVAGE_DIR, session.id, { role: 'user', kind: 'text', content: 'test' }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });

      mod.deleteSession(SAIVAGE_DIR, session.id);
      expect(mod.getSession(SAIVAGE_DIR, session.id)).toBeNull();
      expect(mod.getSessionMessages(SAIVAGE_DIR, session.id)).toEqual([]);
    });
  });

  describe('listSessions', () => {
    it('should list all session IDs', () => {
      const s1 = mod.createSession(SAIVAGE_DIR, 'planner');
      const s2 = mod.createSession(SAIVAGE_DIR, 'executor');

      const ids = mod.listSessions(SAIVAGE_DIR);
      expect(ids).toContain(s1.id);
      expect(ids).toContain(s2.id);
    });

    it('should return empty array when no sessions', () => {
      const ids = mod.listSessions(SAIVAGE_DIR);
      expect(ids).toEqual([]);
    });
  });

  describe('estimateTokens', () => {
    it('should estimate tokens for text', () => {
      const tokens = mod.estimateTokens('This is a test sentence.');
      expect(tokens).toBeGreaterThan(0);
    });

    it('should return 0 for empty string', () => {
      expect(mod.estimateTokens('')).toBe(0);
    });
  });

  describe('buildConversationContext', () => {
    it('should build a context string from messages', () => {
      const session = mod.createSession(SAIVAGE_DIR, 'planner');
      mod.appendMessage(SAIVAGE_DIR, session.id, { role: 'user', kind: 'text', content: 'Hello' }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });
      mod.appendMessage(SAIVAGE_DIR, session.id, { role: 'assistant', kind: 'text', content: 'Hi there' }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });

      const messages = mod.getSessionMessages(SAIVAGE_DIR, session.id);
      const ctx = mod.buildConversationContext(messages);
      expect(ctx).toContain('[USER]');
      expect(ctx).toContain('Hello');
      expect(ctx).toContain('[ASSISTANT]');
    });
  });
});
