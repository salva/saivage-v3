import { describe, expect, it } from '@jest/globals';

import { ModelRecordTargetWireSchema, RecordMutationFailureSchema, buildRecordMutationUrl, parseRecordMutationUrl } from '../../src/contracts/record-mutation.js';

describe('record mutation contracts', () => {
  it('accepts only the exact ordered optimistic mutation grammar', () => {
    expect(parseRecordMutationUrl('record:///brief.md?card=card-a&expected_head=absent')).toEqual({ cardId: 'card-a', name: 'brief.md', expectedHead: 'absent', currentUrl: 'record:///brief.md?card=card-a', mutationUrl: 'record:///brief.md?card=card-a&expected_head=absent' });
    expect(parseRecordMutationUrl(buildRecordMutationUrl('card-a', 'brief.md', 12))).toMatchObject({ expectedHead: 12 });
    for (const invalid of [
      'record:///brief.md?card=card-a',
      'record:///brief.md?card=card-a&v=next',
      'record:///brief.md?card=card-a&expected_head=01',
      'record:///brief.md?expected_head=1&card=card-a',
      'record:///brief.md?card=card-a&expected_head=1&extra=x',
      'record:///brief.md?card=card-a&expected_head=1#fragment',
      'record:///brief.md/?card=card-a&expected_head=1',
    ]) expect(() => parseRecordMutationUrl(invalid)).toThrow('Invalid record mutation URL');
  });

  it('enforces exact model target identity and optimistic authority', () => {
    const absent = { card_id: 'card-a', name: 'status.md', format: 'markdown', schema: 'opaque identity', state: 'absent', head_version: null, current_url: 'record:///status.md?card=card-a', version_url: null, mutation_url: 'record:///status.md?card=card-a&expected_head=absent' };
    expect(ModelRecordTargetWireSchema.parse(absent)).toEqual(absent);
    const populated = { ...absent, state: 'discarded', head_version: 3, version_url: 'record:///status.md?card=card-a&v=3', mutation_url: 'record:///status.md?card=card-a&expected_head=3' };
    expect(ModelRecordTargetWireSchema.parse(populated)).toEqual(populated);
    expect(ModelRecordTargetWireSchema.safeParse({ ...populated, latest: 3 }).success).toBe(false);
    expect(ModelRecordTargetWireSchema.safeParse({ ...populated, mutation_url: 'record:///status.md?card=card-a&expected_head=2' }).success).toBe(false);
  });

  it('rejects unknown fields and invalid exact failure refinements', () => {
    const multiple = { success: false, error: 'old_string matched multiple locations; set replace_all to true.', data: { code: 'record_edit_old_string_multiple_matches', card_id: 'card-a', name: 'brief.md', current_head: 1, occurrences: 2, replace_all_required: true } };
    expect(RecordMutationFailureSchema.parse(multiple)).toEqual(multiple);
    expect(RecordMutationFailureSchema.safeParse({ ...multiple, data: { ...multiple.data, occurrences: 1 } }).success).toBe(false);
    expect(RecordMutationFailureSchema.safeParse({ ...multiple, legacy_reason: 'no' }).success).toBe(false);
  });
});
