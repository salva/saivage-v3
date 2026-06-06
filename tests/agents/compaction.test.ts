/**
 * Tests for context-compactor.ts — context compaction mechanism
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestAnalystRuntime } from '../helpers/test-runtime-application.js';

const TEST_ROOT = join(tmpdir(), `saivage-compaction-test-${Date.now()}`);
const SAIVAGE_DIR = join(TEST_ROOT, '.saivage');
const TEST_STAMP = { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 };

let compactionMod: typeof import('../../src/agents/context-compactor.js');
let sessionMod: typeof import('../../src/agents/session-persistence.js');

beforeAll(async () => {
  compactionMod = await import('../../src/agents/context-compactor.js');
  sessionMod = await import('../../src/agents/session-persistence.js');
});

function compactor() {
  return new compactionMod.ContextCompactor({
    saivageDir: SAIVAGE_DIR,
    sessionStamper: createTestAnalystRuntime().stamper,
  });
}

function setup() {
  mkdirSync(SAIVAGE_DIR, { recursive: true });
}

function cleanup() {
  if (existsSync(TEST_ROOT)) {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  }
}

beforeEach(() => {
  cleanup();
  setup();
});
afterEach(() => cleanup());

function appendLargeTextMessage(sessionId: string, index: number) {
  sessionMod.appendMessage(SAIVAGE_DIR, sessionId, {
    role: index % 2 === 0 ? 'user' : 'assistant',
    kind: 'text',
    content: `Message ${index}: ` + 'x'.repeat(200),
  }, TEST_STAMP);
}

describe('needsCompaction', () => {
  it('should return true when tokens exceed threshold', () => {
    expect(compactor().needsCompaction(850, { contextLimit: 1000, threshold: 0.8 })).toBe(true);
  });

  it('should return false when tokens are below threshold', () => {
    expect(compactor().needsCompaction(500, { contextLimit: 1000, threshold: 0.8 })).toBe(false);
  });

  it('should return false when context limit is 0', () => {
    expect(compactor().needsCompaction(100, { contextLimit: 0 })).toBe(false);
  });

  it('should use default threshold of 0.8', () => {
    expect(compactor().needsCompaction(800, { contextLimit: 1000 })).toBe(true);
    expect(compactor().needsCompaction(799, { contextLimit: 1000 })).toBe(false);
  });
});

describe('compactSession', () => {
  it('should not compact when below threshold', async () => {
    const session = sessionMod.createSession(SAIVAGE_DIR, 'planner', 'goal-1');
    // Add a small message - well below any threshold
    sessionMod.appendMessage(SAIVAGE_DIR, session.id, {
      role: 'user',
      kind: 'text',
      content: 'Hello',
    }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });

    const result = await compactor().compactSession(session.id, {
      contextLimit: 100000,
      threshold: 0.8,
      maxCompactions: 3,
    });

    expect(result.compacted).toBe(false);
    expect(result.maxReached).toBe(false);
  });

  it('should fallback to truncation when no summarizer', async () => {
    const session = sessionMod.createSession(SAIVAGE_DIR, 'planner', 'goal-1');

    // Add many messages to simulate large conversation
    for (let i = 0; i < 50; i++) {
      sessionMod.appendMessage(SAIVAGE_DIR, session.id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        kind: 'text',
        content: `Message ${i}: ` + 'x'.repeat(200), // ~57 tokens per message
      }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });
    }

    const result = await compactor().compactSession(session.id, {
      contextLimit: 1000, // very small to trigger compaction
      threshold: 0.01, // almost always triggers
      maxCompactions: 3,
    });

    expect(result.compacted).toBe(true);
    expect(result.usedFallback).toBe(true);
    expect(result.messagesAfter).toBeLessThan(result.messagesBefore);
    expect(result.compactionCount).toBe(1);
  });

  it('should reach max compactions after limit', async () => {
    const session = sessionMod.createSession(SAIVAGE_DIR, 'planner', 'goal-1');
    const testCompactor = compactor();

    // Set compaction count to 3 (max)
    for (let i = 0; i < 3; i++) {
      // Trigger compaction
      for (let j = 0; j < 50; j++) {
        sessionMod.appendMessage(SAIVAGE_DIR, session.id, {
          role: 'user',
          kind: 'text',
          content: 'x'.repeat(200),
        }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });
      }
      await testCompactor.compactSession(session.id, {
        contextLimit: 1000,
        threshold: 0.01,
        maxCompactions: 3,
      });
    }

    // This should be the 4th attempt — max reached
    for (let j = 0; j < 50; j++) {
      sessionMod.appendMessage(SAIVAGE_DIR, session.id, {
        role: 'user',
        kind: 'text',
        content: 'x'.repeat(200),
      }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });
    }
    const result = await testCompactor.compactSession(session.id, {
      contextLimit: 1000,
      threshold: 0.01,
      maxCompactions: 3,
    });

    expect(result.maxReached).toBe(true);
    expect(result.compactionCount).toBe(3);
  });

  it('should use summarization function when provided', async () => {
    const session = sessionMod.createSession(SAIVAGE_DIR, 'planner', 'goal-1');

    for (let i = 0; i < 50; i++) {
      sessionMod.appendMessage(SAIVAGE_DIR, session.id, {
        role: 'user',
        kind: 'text',
        content: 'x'.repeat(200),
      }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });
    }

    let summarizerCalled = false;
    const result = await compactor().compactSession(session.id, {
      contextLimit: 1000,
      threshold: 0.01,
      maxCompactions: 3,
      summarizeFn: async (messages) => {
        summarizerCalled = true;
        return `Summarized ${messages.length} messages.`;
      },
    });

    expect(summarizerCalled).toBe(true);
    expect(result.usedFallback).toBe(false);
    expect(result.compacted).toBe(true);

    // Verify summary message exists
    const messages = sessionMod.getSessionMessages(SAIVAGE_DIR, session.id);
    expect(messages.length).toBe(1);
    expect(messages[0].content).toContain('Summarized');
  });

  it('should fallback when summarization throws', async () => {
    const session = sessionMod.createSession(SAIVAGE_DIR, 'planner', 'goal-1');

    for (let i = 0; i < 50; i++) {
      sessionMod.appendMessage(SAIVAGE_DIR, session.id, {
        role: 'user',
        kind: 'text',
        content: 'x'.repeat(200),
      }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });
    }

    const result = await compactor().compactSession(session.id, {
      contextLimit: 1000,
      threshold: 0.01,
      maxCompactions: 3,
      summarizeFn: async () => {
        throw new Error('Summarization failed');
      },
    });

    expect(result.usedFallback).toBe(true);
    expect(result.compacted).toBe(true);
  });

  it('fallback truncation drops leading orphan tool_result', async () => {
    const session = sessionMod.createSession(SAIVAGE_DIR, 'planner', 'goal-1');

    for (let i = 0; i < 8; i++) appendLargeTextMessage(session.id, i);
    sessionMod.appendMessage(SAIVAGE_DIR, session.id, {
      role: 'tool',
      kind: 'tool_result',
      tool: 'read_project_file',
      tool_call_id: 'call-dropped',
      content: 'orphan result ' + 'x'.repeat(200),
    }, TEST_STAMP);
    sessionMod.appendMessage(SAIVAGE_DIR, session.id, {
      role: 'assistant',
      kind: 'text',
      content: 'final retained text ' + 'x'.repeat(200),
    }, TEST_STAMP);

    const result = await compactor().compactSession(session.id, {
      contextLimit: 1000,
      threshold: 0.01,
      maxCompactions: 3,
    });

    const messages = sessionMod.getSessionMessages(SAIVAGE_DIR, session.id);
    expect(result.usedFallback).toBe(true);
    expect(messages.map((message) => message.kind)).toEqual(['context_compaction', 'text']);
    expect(messages[0].content).toContain('Only the most recent 1 messages are preserved below.');
  });

  it('fallback truncation preserves tool_call/tool_result pair when both are retained', async () => {
    const session = sessionMod.createSession(SAIVAGE_DIR, 'planner', 'goal-1');

    for (let i = 0; i < 8; i++) appendLargeTextMessage(session.id, i);
    sessionMod.appendMessage(SAIVAGE_DIR, session.id, {
      role: 'assistant',
      kind: 'tool_call',
      tool: 'read_project_file',
      tool_call_id: 'call-retained',
      content: 'call retained ' + 'x'.repeat(200),
    }, TEST_STAMP);
    sessionMod.appendMessage(SAIVAGE_DIR, session.id, {
      role: 'tool',
      kind: 'tool_result',
      tool: 'read_project_file',
      tool_call_id: 'call-retained',
      content: 'result retained ' + 'x'.repeat(200),
    }, TEST_STAMP);

    const result = await compactor().compactSession(session.id, {
      contextLimit: 1000,
      threshold: 0.01,
      maxCompactions: 3,
    });

    const messages = sessionMod.getSessionMessages(SAIVAGE_DIR, session.id);
    expect(result.usedFallback).toBe(true);
    expect(messages.map((message) => message.kind)).toEqual(['context_compaction', 'tool_call', 'tool_result']);
    expect(messages[1].tool_call_id).toBe('call-retained');
    expect(messages[2].tool_call_id).toBe('call-retained');
    expect(messages[0].content).toContain('Only the most recent 2 messages are preserved below.');
  });

  it('fallback truncation drops multiple leading orphan tool rows', async () => {
    const session = sessionMod.createSession(SAIVAGE_DIR, 'planner', 'goal-1');

    for (let i = 0; i < 8; i++) appendLargeTextMessage(session.id, i);
    sessionMod.appendMessage(SAIVAGE_DIR, session.id, {
      role: 'tool',
      kind: 'tool_result',
      tool: 'read_project_file',
      tool_call_id: 'call-dropped-1',
      content: 'orphan result ' + 'x'.repeat(200),
    }, TEST_STAMP);
    sessionMod.appendMessage(SAIVAGE_DIR, session.id, {
      role: 'tool',
      kind: 'tool_error',
      tool: 'read_project_file',
      tool_call_id: 'call-dropped-2',
      content: 'orphan error ' + 'x'.repeat(200),
    }, TEST_STAMP);

    const result = await compactor().compactSession(session.id, {
      contextLimit: 1000,
      threshold: 0.01,
      maxCompactions: 3,
    });

    const messages = sessionMod.getSessionMessages(SAIVAGE_DIR, session.id);
    expect(result.usedFallback).toBe(true);
    expect(messages.map((message) => message.kind)).toEqual(['context_compaction']);
    expect(messages[0].content).toContain('Only the most recent 0 messages are preserved below.');
  });
});

describe('getCompactionCount / resetState', () => {
  it('should track compaction count', async () => {
    const session = sessionMod.createSession(SAIVAGE_DIR, 'planner', 'goal-1');

    const testCompactor = compactor();
    expect(testCompactor.getCompactionCount(session.id)).toBe(0);

    for (let i = 0; i < 50; i++) {
      sessionMod.appendMessage(SAIVAGE_DIR, session.id, {
        role: 'user',
        kind: 'text',
        content: 'x'.repeat(200),
      }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });
    }
    await testCompactor.compactSession(session.id, {
      contextLimit: 1000,
      threshold: 0.01,
      maxCompactions: 5,
    });

    expect(testCompactor.getCompactionCount(session.id)).toBe(1);

    testCompactor.resetState(session.id);
    expect(testCompactor.getCompactionCount(session.id)).toBe(0);
  });
});
