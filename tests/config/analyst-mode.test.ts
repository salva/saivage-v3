import { expect, it } from '@jest/globals';
import { resolveAnalystStartup } from '../../src/config/analyst-mode.js';
import { TEST_WORKFLOWS } from '../helpers/canonical-project.js';

const external={analystMode:'external',analystMcpPort:'8090',analystMcpPrincipal:'local-client',analystMcpTools:'read,write'};
it('requires consistent explicit startup selection and never echoes invalid secret/settings',()=>{
  expect(resolveAnalystStartup({},undefined,TEST_WORKFLOWS)).toEqual({mode:'internal'});
  expect(resolveAnalystStartup(external,'synthetic-secret',TEST_WORKFLOWS)).toMatchObject({mode:'external',port:8090,tools:['read','write']});
  for(const [inputs,token] of [
    [{},'synthetic-secret'],[{...external,analystMode:'internal'},undefined],
    [external,undefined],[external,' padded-secret '],
    [{...external,analystMcpTools:'read,read'},'synthetic-secret'],
    [{...external,analystMcpTools:'read, unknown'},'synthetic-secret'],
    [{...external,analystMcpPort:'0'},'synthetic-secret'],
    [{...external,analystMcpPrincipal:'client/unsafe'},'synthetic-secret'],
  ] as const)expect(()=>resolveAnalystStartup(inputs,token,TEST_WORKFLOWS)).toThrow();
});
