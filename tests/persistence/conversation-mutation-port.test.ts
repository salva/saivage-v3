import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import type { ReadModelChanges } from '../../src/application/read-model-changes.js';
import { createConversationMutationPort } from '../../src/persistence/conversation-mutation-port.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import { activeVersionPath } from '../../src/runtime/actors/conversation-index.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'saivage-conversation-port-'));
  roots.push(value);
  return value;
}

function message(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: 'message-1', session_id: 'planner:project', role: 'assistant', kind: 'text', content: 'hello',
    round_id: 'r-assistant-00000000000000000000000000000001', message_index: 0, block_index: 0,
    timestamp: '2026-07-13T00:00:00.000Z', ...overrides,
  };
}

function changes() {
  return {
    runtimeChanged: jest.fn(), cardStateChanged: jest.fn(), agentsChanged: jest.fn(), conversationChanged: jest.fn(),
    subscribe: jest.fn(),
  } as unknown as ReadModelChanges & {
    agentsChanged: jest.Mock;
    conversationChanged: jest.Mock;
  };
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('ConversationMutationPort', () => {
  it('publishes conversation and agents only for a changed append and returns the persistence result', () => {
    const projectRoot = root();
    const readModelChanges = changes();
    const port = createConversationMutationPort(projectRoot, readModelChanges);
    const row = message();

    const changed = port.append(row);
    expect(changed).toEqual({ message: row, appended: true });
    expect(readModelChanges.conversationChanged).toHaveBeenCalledWith(row.session_id);
    expect(readModelChanges.agentsChanged).toHaveBeenCalledTimes(1);

    expect(port.append(row)).toEqual({ message: row, appended: false });
    expect(readModelChanges.conversationChanged).toHaveBeenCalledTimes(1);
    expect(readModelChanges.agentsChanged).toHaveBeenCalledTimes(1);
  });

  it('publishes freshness for a changed provider-private append', () => {
    const readModelChanges = changes();
    const privateRow = message({ id: 'private-1', role: 'system', kind: 'provider_private' });
    expect(createConversationMutationPort(root(), readModelChanges).append(privateRow).appended).toBe(true);
    expect(readModelChanges.conversationChanged).toHaveBeenCalledWith(privateRow.session_id);
    expect(readModelChanges.agentsChanged).toHaveBeenCalledTimes(1);
  });

  it('propagates append errors without publishing', () => {
    const readModelChanges = changes();
    const port = createConversationMutationPort(root(), readModelChanges);
    expect(() => port.append(message({ id: '' }))).toThrow();
    expect(readModelChanges.conversationChanged).not.toHaveBeenCalled();
    expect(readModelChanges.agentsChanged).not.toHaveBeenCalled();
  });

  it('binds both mutations to the factory root and exposes no root-taking method', () => {
    const boundRoot = root();
    const otherRoot = root();
    const port = createConversationMutationPort(boundRoot, changes());
    const row = message();
    port.append(row);

    const args = {
      sessionId: row.session_id,
      sourceVersion: 1,
      content: `${JSON.stringify({ ...row, id: 'summary-1', content: 'summary' })}\n`,
      compactedThrough: { message_id: row.id, round_id: row.round_id, timestamp: row.timestamp },
      summaryIds: ['summary-1'],
      compactionGeneration: 3,
      bands: { merge_line: 10, summary_line: 20, trigger: 30, snap: 'compact_straddler' as const },
    };
    const result = port.replaceActiveVersion(args);

    expect(Object.keys(port).sort()).toEqual(['append', 'replaceActiveVersion']);
    expect(result.index.versions['2']).toMatchObject({ source_version: 1, summary_ids: args.summaryIds, compaction_generation: 3, bands: args.bands, compacted_through: args.compactedThrough });
    expect(result.versionReplacement).toEqual({ sessionId: row.session_id, activeVersion: 2, compactedThrough: args.compactedThrough, compactionGeneration: 3 });
    expect(readFileSync(activeVersionPath(boundRoot, row.session_id, 2), 'utf8')).toBe(args.content);
    expect(() => readFileSync(activeVersionPath(otherRoot, row.session_id, 1), 'utf8')).toThrow();
  });

  it('publishes both targets after replacement success and none when replacement throws', () => {
    const projectRoot = root();
    const readModelChanges = changes();
    const port = createConversationMutationPort(projectRoot, readModelChanges);
    const row = message();
    port.append(row);
    readModelChanges.conversationChanged.mockClear();
    readModelChanges.agentsChanged.mockClear();
    const base = {
      sessionId: row.session_id, sourceVersion: 1, content: `${JSON.stringify(row)}\n`,
      compactedThrough: { message_id: row.id, round_id: row.round_id, timestamp: row.timestamp }, summaryIds: [],
      compactionGeneration: 1, bands: { merge_line: 1, summary_line: 2, trigger: 3, snap: 'keep_straddler_verbatim' as const },
    };
    port.replaceActiveVersion(base);
    expect(readModelChanges.conversationChanged).toHaveBeenCalledWith(row.session_id);
    expect(readModelChanges.agentsChanged).toHaveBeenCalledTimes(1);

    readModelChanges.conversationChanged.mockClear();
    readModelChanges.agentsChanged.mockClear();
    const failure = expect(() => port.replaceActiveVersion(base)).toThrow(/active version changed/);
    expect(failure).toBeUndefined();
    expect(readModelChanges.conversationChanged).not.toHaveBeenCalled();
    expect(readModelChanges.agentsChanged).not.toHaveBeenCalled();
  });
});
