import { describe, expect, it, jest } from '@jest/globals';

const appendConversationMessage = jest.fn();
const writeCompactedConversationVersion = jest.fn();

jest.unstable_mockModule('../../src/runtime/actors/conversation-store.js', () => ({ appendConversationMessage }));
jest.unstable_mockModule('../../src/runtime/actors/conversation-index.js', () => ({ writeCompactedConversationVersion }));

const { createConversationMutationPort } = await import('../../src/persistence/conversation-mutation-port.js');

describe('ConversationMutationPort persistence delegation', () => {
  it('forwards exactly the factory root and seven replacement fields and returns the exact persistence result', () => {
    const changes = { conversationChanged: jest.fn(), agentsChanged: jest.fn() } as never;
    const port = createConversationMutationPort('/bound/root', changes);
    const args = {
      sessionId: 'planner:project', sourceVersion: 4, content: 'content',
      compactedThrough: { message_id: 'm1', round_id: 'r1', timestamp: '2026-07-13T00:00:00.000Z' },
      summaryIds: ['s1'], compactionGeneration: 2,
      bands: { merge_line: 10, summary_line: 20, trigger: 30, snap: 'compact_straddler' as const },
    };
    const persistenceResult = { index: { marker: 'index' }, versionReplacement: { marker: 'replacement' } };
    writeCompactedConversationVersion.mockReturnValueOnce(persistenceResult);

    const result = port.replaceActiveVersion(args);

    expect(writeCompactedConversationVersion).toHaveBeenCalledWith({ projectRoot: '/bound/root', ...args });
    expect(Object.keys(writeCompactedConversationVersion.mock.calls[0]![0] as object)).toEqual([
      'projectRoot', 'sessionId', 'sourceVersion', 'content', 'compactedThrough', 'summaryIds', 'compactionGeneration', 'bands',
    ]);
    expect(result).toBe(persistenceResult);
  });

  it('propagates the exact persistence error and publishes nothing', () => {
    const error = new Error('replacement failed');
    const changes = { conversationChanged: jest.fn(), agentsChanged: jest.fn() };
    writeCompactedConversationVersion.mockImplementationOnce(() => { throw error; });
    const port = createConversationMutationPort('/bound/root', changes as never);
    let caught: unknown;
    try {
      port.replaceActiveVersion({
        sessionId: 'planner:project', sourceVersion: 1, content: '',
        compactedThrough: { message_id: 'm1', round_id: 'r1', timestamp: '2026-07-13T00:00:00.000Z' },
        summaryIds: [], compactionGeneration: 1,
        bands: { merge_line: 1, summary_line: 2, trigger: 3, snap: 'keep_straddler_verbatim' },
      });
    } catch (failure) { caught = failure; }
    expect(caught).toBe(error);
    expect(changes.conversationChanged).not.toHaveBeenCalled();
    expect(changes.agentsChanged).not.toHaveBeenCalled();
  });
});
