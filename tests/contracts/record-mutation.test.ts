import { describe, expect, it } from '@jest/globals';

import { ModelRecordTargetWireSchema, RecordMutationFailureSchema, RecordMutationSuccessSchema, parseRecordUrl } from '../../src/contracts/record-mutation.js';

describe('record URL and mutation contracts', () => {
  it('accepts only the shared exact current and numeric-history grammar', () => {
    expect(parseRecordUrl('record:///brief.md?card=card-a')).toEqual({cardId:'card-a',name:'brief.md',version:null,currentUrl:'record:///brief.md?card=card-a'});
    expect(parseRecordUrl('record:///brief.md?card=card-a&v=12')).toMatchObject({version:12,currentUrl:'record:///brief.md?card=card-a'});
    for(const invalid of ['record:///brief.md?card=card-a&expected_head=absent','record:///brief.md?card=card-a&v=next','record:///brief.md?card=card-a&v=01','record:///brief.md?v=1&card=card-a','record:///brief.md?card=card-a&v=1&extra=x','record:///brief.md?card=card-a#fragment','record:///brief.md/?card=card-a'])expect(()=>parseRecordUrl(invalid)).toThrow('Invalid record URL');
  });

  it('enforces metadata-bearing targets without mutation authority URLs',()=>{
    const absent={card_id:'card-a',name:'status.md',format:'markdown',schema:'authored-record.v1',state:'absent',head_version:null,current_url:'record:///status.md?card=card-a',version_url:null};
    expect(ModelRecordTargetWireSchema.parse(absent)).toEqual(absent);
    const populated={...absent,state:'discarded',head_version:3,version_url:'record:///status.md?card=card-a&v=3'};
    expect(ModelRecordTargetWireSchema.parse(populated)).toEqual(populated);
    expect(ModelRecordTargetWireSchema.safeParse({...populated,mutation_url:'legacy'}).success).toBe(false);
    const success={success:true,data:{card_id:'card-a',name:'status.md',state:'open',head_version:3,head_entry_id:'123e4567-e89b-42d3-a456-426614174000',current_url:'record:///status.md?card=card-a',version_url:'record:///status.md?card=card-a&v=3',bytes:1,written:true,surface:'card_agent'}};
    expect(RecordMutationSuccessSchema.parse(success)).toEqual(success);
  });

  it('rejects removed stale/configured-record failures and unknown fields',()=>{
    const multiple={success:false,error:'old_string matched multiple locations; set replace_all to true.',data:{code:'record_edit_old_string_multiple_matches',card_id:'card-a',name:'brief.md',current_head:1,occurrences:2,replace_all_required:true}};
    expect(RecordMutationFailureSchema.parse(multiple)).toEqual(multiple);
    expect(RecordMutationFailureSchema.safeParse({success:false,error:'Record mutation is stale.',data:{code:'record_mutation_stale'}}).success).toBe(false);
    expect(RecordMutationFailureSchema.safeParse({success:false,error:'Record mutation is not authorized.',data:{code:'record_mutation_denied',card_id:'card-a',name:'brief.md',operation:'write',reason:'record_not_configured'}}).success).toBe(false);
  });
});
