/**
 * Tests for compaction.ts — context compaction mechanism
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestActiveRuntime } from '../helpers/test-active-runtime.js';

const TEST_ROOT = join(tmpdir(), `saivage-compaction-test-${Date.now()}`);
const SAIVAGE_DIR = join(TEST_ROOT, '.saivage');

let compaction: typeof import('../../src/agents/compaction.js');
let sessionMod: typeof import('../../src/agents/session-persistence.js');

beforeAll(async () => {
  compaction = await import('../../src/agents/compaction.js');
  sessionMod = await import('../../src/agents/session-persistence.js');
});

function setup() {
  mkdirSync(SAIVAGE_DIR, { recursive: true });
}

function cleanup() {
  if (existsSync(TEST_ROOT)) {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  }
  // Reset compaction state between tests
  compaction.resetCompactionState('planner-user-1');
}

beforeEach(() => {
  cleanup();
  setup();
});
afterEach(() => cleanup());

describe('needsCompaction', () => {
  it('should return true when tokens exceed threshold', () => {
    expect(compaction.needsCompaction(850, 1000, 0.8)).toBe(true);
  });

  it('should return false when tokens are below threshold', () => {
    expect(compaction.needsCompaction(500, 1000, 0.8)).toBe(false);
  });

  it('should return false when context limit is 0', () => {
    expect(compaction.needsCompaction(100, 0)).toBe(false);
  });

  it('should use default threshold of 0.8', () => {
    expect(compaction.needsCompaction(800, 1000)).toBe(true);
    expect(compaction.needsCompaction(799, 1000)).toBe(false);
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

    const result = await compaction.compactSession(SAIVAGE_DIR, session.id, {
      contextLimit: 100000,
      threshold: 0.8,
      maxCompactions: 3,
    }, createTestActiveRuntime());

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

    const result = await compaction.compactSession(SAIVAGE_DIR, session.id, {
      contextLimit: 1000, // very small to trigger compaction
      threshold: 0.01, // almost always triggers
      maxCompactions: 3,
    }, createTestActiveRuntime());

    expect(result.compacted).toBe(true);
    expect(result.usedFallback).toBe(true);
    expect(result.messagesAfter).toBeLessThan(result.messagesBefore);
    expect(result.compactionCount).toBe(1);
  });

  it('should reach max compactions after limit', async () => {
    const session = sessionMod.createSession(SAIVAGE_DIR, 'planner', 'goal-1');

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
      await compaction.compactSession(SAIVAGE_DIR, session.id, {
        contextLimit: 1000,
        threshold: 0.01,
        maxCompactions: 3,
      }, createTestActiveRuntime());
    }

    // This should be the 4th attempt — max reached
    for (let j = 0; j < 50; j++) {
      sessionMod.appendMessage(SAIVAGE_DIR, session.id, {
        role: 'user',
        kind: 'text',
        content: 'x'.repeat(200),
      }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });
    }
    const result = await compaction.compactSession(SAIVAGE_DIR, session.id, {
      contextLimit: 1000,
      threshold: 0.01,
      maxCompactions: 3,
    }, createTestActiveRuntime());

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
    const result = await compaction.compactSession(SAIVAGE_DIR, session.id, {
      contextLimit: 1000,
      threshold: 0.01,
      maxCompactions: 3,
      summarizeFn: async (messages) => {
        summarizerCalled = true;
        return `Summarized ${messages.length} messages.`;
      },
    }, createTestActiveRuntime());

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

    const result = await compaction.compactSession(SAIVAGE_DIR, session.id, {
      contextLimit: 1000,
      threshold: 0.01,
      maxCompactions: 3,
      summarizeFn: async () => {
        throw new Error('Summarization failed');
      },
    }, createTestActiveRuntime());

    expect(result.usedFallback).toBe(true);
    expect(result.compacted).toBe(true);
  });
});

describe('getCompactionCount / resetCompactionState', () => {
  it('should track compaction count', async () => {
    const session = sessionMod.createSession(SAIVAGE_DIR, 'planner', 'goal-1');

    expect(compaction.getCompactionCount(session.id)).toBe(0);

    for (let i = 0; i < 50; i++) {
      sessionMod.appendMessage(SAIVAGE_DIR, session.id, {
        role: 'user',
        kind: 'text',
        content: 'x'.repeat(200),
      }, { round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0 });
    }
    await compaction.compactSession(SAIVAGE_DIR, session.id, {
      contextLimit: 1000,
      threshold: 0.01,
      maxCompactions: 5,
    }, createTestActiveRuntime());

    expect(compaction.getCompactionCount(session.id)).toBe(1);

    compaction.resetCompactionState(session.id);
    expect(compaction.getCompactionCount(session.id)).toBe(0);
  });
});
