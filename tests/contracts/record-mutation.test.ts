import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { ModelRecordTargetWireSchema, RecordMutationFailureSchema, RecordMutationSuccessSchema, RecordUrlInputError, parseRecordUrl } from '../../src/contracts/record-mutation.js';
import { CardRecordContentResponseSchema } from '../../src/contracts/operator-api-runtime-cards.js';
import { recordAuthorSchema } from '../../src/schemas/index.js';
import { operationAuthorSchema } from '../../src/schemas/operation-author.js';

afterEach(() => { jest.restoreAllMocks(); });

describe('record URL and mutation contracts', () => {
  it('requires closed accepted selection and propagation on card acceptance without weakening self draft invariants',()=>{
    const data={card_id:'card-a',name:'design-plan.md',state:'closed',version:2,target_version:null,revision:5,head_id:'11111111-1111-4111-8111-111111111111',current_url:'record:///design-plan.md?card=card-a',accepted_version_url:'record:///design-plan.md?card=card-a&v=2',bytes:12,written:true,surface:'card_acceptance',propagation:{ok:true}};
    expect(RecordMutationSuccessSchema.parse({kind:'applied',data}).data).toEqual(data);
    for(const delta of [{state:'open'},{target_version:2},{accepted_version_url:null},{accepted_version_url:'record:///design-plan.md?card=card-a&v=1'},{propagation:undefined},{head_id:'not-a-uuid'},{surface:'parent'},{surface:'card_agent'}])
      expect(RecordMutationSuccessSchema.safeParse({kind:'applied',data:{...data,...delta}}).success).toBe(false);
    expect(RecordMutationSuccessSchema.parse({kind:'applied',data:{...data,propagation:{ok:false,partial:true,error:'known effect failed'}}}).data.propagation).toEqual({ok:false,partial:true,error:'known effect failed'});
  });

  it('keeps actual card-agent origin record-local and historical agent origins factual',()=>{
    const author={kind:'card-agent',agent:'planner',card_id:'project'};
    expect(recordAuthorSchema.parse(author)).toEqual(author);
    expect(recordAuthorSchema.parse({kind:'agent',agent:'planner'})).toEqual({kind:'agent',agent:'planner'});
    expect(operationAuthorSchema.safeParse(author).success).toBe(false);
    for(const delta of [{card_id:undefined},{card_id:'card-1'},{agent:''},{parent:'project'}])expect(recordAuthorSchema.safeParse({...author,...delta}).success).toBe(false);
  });
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
    const absent={card_id:'card-a',name:'status.md',format:'markdown',schema:'authored-record.v1',state:'absent',revision:null,head_id:null,current_url:'record:///status.md?card=card-a',accepted_version_url:null};
    expect(ModelRecordTargetWireSchema.parse(absent)).toEqual(absent);
    const populated={...absent,state:'open',revision:3,head_id:'11111111-1111-4111-8111-111111111111',accepted_version_url:'record:///status.md?card=card-a&v=1'};
    expect(ModelRecordTargetWireSchema.parse(populated)).toEqual(populated);
    expect(ModelRecordTargetWireSchema.safeParse({...populated,mutation_url:'legacy'}).success).toBe(false);
    const success={kind:'applied' as const,data:{card_id:'card-a',name:'status.md',state:'open',version:1,target_version:1,revision:3,head_id:'11111111-1111-4111-8111-111111111111',current_url:'record:///status.md?card=card-a',accepted_version_url:null,bytes:1,written:true,surface:'card_agent'}};
    expect(RecordMutationSuccessSchema.parse(success)).toEqual(success);
    const baseline = { card_id: 'card-a', record: { head_id: populated.head_id, name: 'status.md', revision: 1, current_url: populated.current_url, accepted_version_url: null,
      state: 'baseline', baseline: { version: 0, created_at: '2026-10-18T00:00:00.000Z', content: 'starter', content_sha256: 'a'.repeat(64) }, draft: null, accepted: null, effective_content_source: 'baseline' } };
    expect(CardRecordContentResponseSchema.parse(baseline)).toEqual(baseline);
    expect(() => CardRecordContentResponseSchema.parse({ ...baseline, record: { ...baseline.record, revision: null } })).toThrow();
    expect(() => CardRecordContentResponseSchema.parse({ ...baseline, record: { ...baseline.record, head_id: null } })).toThrow();
    expect(() => ModelRecordTargetWireSchema.parse({ ...populated, state: 'baseline', revision: null, head_id: null })).toThrow();
  });

  it('rejects removed stale/configured-record failures and unknown fields',()=>{
    const multiple={kind:'rejected' as const,error:'old_string matched multiple locations; set replace_all to true.',data:{code:'record_edit_old_string_multiple_matches',card_id:'card-a',name:'brief.md',current_head:1,occurrences:2,replace_all_required:true}};
    expect(RecordMutationFailureSchema.parse(multiple)).toEqual(multiple);
    expect(RecordMutationFailureSchema.safeParse({success:false,error:'Record mutation is stale.',data:{code:'record_mutation_stale'}}).success).toBe(false);
    expect(RecordMutationFailureSchema.safeParse({success:false,error:'Record mutation is not authorized.',data:{code:'record_mutation_denied',card_id:'card-a',name:'brief.md',operation:'write',reason:'record_not_configured'}}).success).toBe(false);
  });
});
