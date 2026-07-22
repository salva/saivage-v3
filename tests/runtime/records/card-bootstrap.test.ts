import { describe,expect,it,jest } from '@jest/globals';

import { cardBootstrapForPrompt } from '../../../src/runtime/records/card-bootstrap.js';

describe('workflow bootstrap prompt projection',()=>{
  it('reads the configured bootstrap record by exact name',()=>{
    const readRecord=jest.fn(()=>({artifact:{content:'Configured bootstrap'}}));
    const store={workflows:{cardTypes:new Map([['research',{bootstrapRecord:{name:'research-question.md'}}]])},readRecord};
    expect(cardBootstrapForPrompt(store as never,{id:'card-a',type:'research'} as never)).toBe('Configured bootstrap');
    expect(readRecord).toHaveBeenCalledWith('card-a','research-question.md','latest');
  });

  it('fails when the card type has no compiled workflow',()=>{
    expect(()=>cardBootstrapForPrompt({workflows:{cardTypes:new Map()},readRecord:jest.fn()} as never,{id:'card-a',type:'research'} as never)).toThrow(/No workflow/);
  });
});
