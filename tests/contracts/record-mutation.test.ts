import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { ModelRecordTargetWireSchema, RecordMutationFailureSchema, RecordMutationSuccessSchema, RecordUrlInputError, parseRecordUrl } from '../../src/contracts/record-mutation.js';

afterEach(() => { jest.restoreAllMocks(); });

describe('record URL and mutation contracts', () => {
  it.each([
    'record:///status.md', 'record:///%ZZ?card=project',
    'record:///%2562rief.md?card=project', 'record:///brief.md?card=card-1',
    'record:///brief.md?card=project&card=project', 'record:///brief.md?card=project&extra=x',
    'record:///brief.md?card=project#fragment', 'record:///brief.md?card=project&v=0',
    'record:///brief.md?card=project&v=9007199254740992',
  ])('rejects authored invalid URL with the precise input type: %s', (path) => {
    expect(() => parseRecordUrl(path)).toThrow(RecordUrlInputError);
  });

  it('does not classify unexpected decoding errors as authored input', () => {
    const fault = new Error('decoder fault');
    jest.spyOn(globalThis, 'decodeURIComponent').mockImplementation(() => { throw fault; });
    let caught: unknown;
    try { parseRecordUrl('record:///brief.md?card=project'); } catch (error) { caught = error; }
    expect(caught).toBe(fault);
  });

  it('accepts invalid-target failures without fabricated identity and rejects extra data', () => {
    const result = { kind: 'rejected', error: 'Invalid record URL.', data: { code: 'record_mutation_invalid_target', operation: 'write' } };
    expect(RecordMutationFailureSchema.parse(result)).toEqual(result);
    expect(RecordMutationFailureSchema.safeParse({ ...result, data: { ...result.data, card_id: 'project' } }).success).toBe(false);
  });
  it('accepts only the shared exact current and numeric-history grammar', () => {
    expect(parseRecordUrl('record:///brief.md?card=card-a')).toEqual({cardId:'card-a',name:'brief.md',version:null,currentUrl:'record:///brief.md?card=card-a'});
    expect(parseRecordUrl('record:///brief.md?card=card-a&v=12')).toMatchObject({version:12,currentUrl:'record:///brief.md?card=card-a'});
    for(const invalid of ['record:///brief.md?card=card-a&expected_head=absent','record:///brief.md?card=card-a&v=next','record:///brief.md?card=card-a&v=01','record:///brief.md?v=1&card=card-a','record:///brief.md?card=card-a&v=1&extra=x','record:///brief.md?card=card-a#fragment','record:///brief.md/?card=card-a'])expect(()=>parseRecordUrl(invalid)).toThrow(RecordUrlInputError);
  });

  it('enforces metadata-bearing targets without mutation authority URLs',()=>{
    const absent={card_id:'card-a',name:'status.md',format:'markdown',schema:'authored-record.v1',state:'absent',revision:null,current_url:'record:///status.md?card=card-a',accepted_version_url:null};
    expect(ModelRecordTargetWireSchema.parse(absent)).toEqual(absent);
    const populated={...absent,state:'open',revision:3,accepted_version_url:'record:///status.md?card=card-a&v=1'};
    expect(ModelRecordTargetWireSchema.parse(populated)).toEqual(populated);
    expect(ModelRecordTargetWireSchema.safeParse({...populated,mutation_url:'legacy'}).success).toBe(false);
    const success={kind:'applied' as const,data:{card_id:'card-a',name:'status.md',state:'open',revision:3,current_url:'record:///status.md?card=card-a',accepted_version_url:null,bytes:1,written:true,surface:'card_agent'}};
    expect(RecordMutationSuccessSchema.parse(success)).toEqual(success);
  });

  it('rejects removed stale/configured-record failures and unknown fields',()=>{
    const multiple={kind:'rejected' as const,error:'old_string matched multiple locations; set replace_all to true.',data:{code:'record_edit_old_string_multiple_matches',card_id:'card-a',name:'brief.md',current_head:1,occurrences:2,replace_all_required:true}};
    expect(RecordMutationFailureSchema.parse(multiple)).toEqual(multiple);
    expect(RecordMutationFailureSchema.safeParse({success:false,error:'Record mutation is stale.',data:{code:'record_mutation_stale'}}).success).toBe(false);
    expect(RecordMutationFailureSchema.safeParse({success:false,error:'Record mutation is not authorized.',data:{code:'record_mutation_denied',card_id:'card-a',name:'brief.md',operation:'write',reason:'record_not_configured'}}).success).toBe(false);
  });
});
