import { describe, expect, it } from '@jest/globals';

import { parseAgentName } from '../../src/schemas/agent-name.js';
import { parseRecordName, recordStreamFilename } from '../../src/schemas/record-name.js';

describe('workflow identity names', () => {
  it('accepts only the strict agent-name grammar', () => {
    expect(parseAgentName('review-agent-2')).toBe('review-agent-2');
    for (const value of ['', 'Reviewer', '-reviewer', 'reviewer_', 'a'.repeat(65), 'reviewer/other']) expect(() => parseAgentName(value)).toThrow();
  });

  it('accepts only exact safe Markdown record filenames', () => {
    const name = parseRecordName('research-findings.md');
    expect(recordStreamFilename(name)).toBe('research-findings.jsonl');
    for (const value of ['', 'brief', 'brief.json', 'Brief.md', '../brief.md', 'nested/brief.md', 'brief.md/other', 'a'.repeat(65) + '.md']) expect(() => parseRecordName(value)).toThrow();
  });
});
