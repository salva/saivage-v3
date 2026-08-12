import { describe,expect,it,jest } from '@jest/globals';

import { cardBootstrapForPrompt } from '../../../src/runtime/records/card-bootstrap.js';

describe('workflow bootstrap prompt projection',()=>{
  it('reads the configured bootstrap record by exact name',()=>{
    const readCurrentRecord=jest.fn(()=>({artifact:{accepted:{content:'Configured bootstrap'}}}));
    const store={workflows:{cardTypes:new Map([['research',{bootstrapRecord:{name:'research-question.md'}}]])},readCurrentRecord};
    expect(cardBootstrapForPrompt(store as never,{id:'card-a',type:'research'} as never)).toBe('Configured bootstrap');
    expect(readCurrentRecord).toHaveBeenCalledWith('card-a','research-question.md');
  });

  it('fails when the card type has no compiled workflow',()=>{
    expect(()=>cardBootstrapForPrompt({workflows:{cardTypes:new Map()},readCurrentRecord:jest.fn()} as never,{id:'card-a',type:'research'} as never)).toThrow(/No workflow/);
  });
});
