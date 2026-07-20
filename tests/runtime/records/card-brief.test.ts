import { describe, expect, it } from '@jest/globals';

import { readLatestBriefRecord } from '../../../src/runtime/records/card-brief.js';
import { AuthoredRecordNotFoundError } from '../../../src/persistence/authored-record-files.js';

describe('card brief authored-record failures', () => {
  it('returns null only for concrete absence', () => {
    const absent = { readRecord: () => { throw new AuthoredRecordNotFoundError(); } };
    expect(readLatestBriefRecord(absent as never, 'project')).toBeNull();

    const hostile = new Error('HOSTILE_STRICT_BRIEF_READ');
    const failed = { readRecord: () => { throw hostile; } };
    expect(() => readLatestBriefRecord(failed as never, 'project')).toThrow(hostile);
  });
});
