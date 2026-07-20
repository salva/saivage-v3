import { describe, expect, it, jest } from '@jest/globals';

import { AgentNodeExecution } from '../../../src/runtime/actors/agent-node-execution.js';
import { AuthoredRecordNotFoundError } from '../../../src/persistence/authored-record-files.js';

type RecordMethods = {
  captureRecord(filename: string): unknown;
  discardOpenRecord(filename: string, reason: string): void;
};

describe('AgentNodeExecution authored-record absence handling', () => {
  it('treats only the concrete type as an absent candidate or cleanup target', () => {
    const absentStore = { readRecord: jest.fn(() => { throw new AuthoredRecordNotFoundError(); }), discardRecord: jest.fn() };
    const absent = new AgentNodeExecution({ cardId: 'project', store: absentStore } as never, {} as never) as unknown as RecordMethods;
    expect(absent.captureRecord('status.md')).toBeNull();
    expect(() => absent.discardOpenRecord('review.md', 'stale')).not.toThrow();
    expect(absentStore.discardRecord).not.toHaveBeenCalled();

    const hostile = new Error('HOSTILE_AGENT_RECORD_READ');
    const failedStore = { readRecord: jest.fn(() => { throw hostile; }), discardRecord: jest.fn() };
    const failed = new AgentNodeExecution({ cardId: 'project', store: failedStore } as never, {} as never) as unknown as RecordMethods;
    expect(() => failed.captureRecord('status.md')).toThrow(hostile);
    expect(() => failed.discardOpenRecord('review.md', 'stale')).toThrow(hostile);
  });
});
