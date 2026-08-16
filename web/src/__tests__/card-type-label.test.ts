import { describe, expect, it } from 'vitest';
import { labelForCardType } from '../utils/status';

describe('card type labels',()=>{
  it('keeps shipped labels and renders custom configured names raw',()=>{
    expect(['project','goal','architecture','code','test','doc','data','research','ops'].map((type)=>labelForCardType(type))).toEqual(['Project','Goal','Architecture','Code','Test','Doc','Data','Research','Ops']);
    expect(labelForCardType('custom-leaf')).toBe('custom-leaf');
    expect(labelForCardType('global')).toBe('global');
  });
});
