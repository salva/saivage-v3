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

it.each(['external', 'both'])('resolves dedicated concrete IPs and independent port in %s mode', (analystMode) => {
  for (const [analystMcpHost, host] of [
    [undefined, '127.0.0.1'], ['192.0.2.7', '192.0.2.7'], ['::1', '::1'],
    ['2001:0DB8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
    ['2001:db8::1', '2001:db8::1'],
    ['::ffff:0:0:1', '::ffff:0:0:1'],
  ]) expect(resolveAnalystStartup({...external, analystMode, analystMcpHost}, 'synthetic-secret', TEST_WORKFLOWS))
    .toMatchObject({mode: analystMode, host, port: 8090});
});

it.each([
  '', ' ', ' 127.0.0.1', '127.0.0.1 ', 'localhost', 'example.test', '127.1', '01.2.3.4',
  '127.0.0.1:8090', 'http://127.0.0.1', '[::1]', '[::1]:8090', '::1%lo',
  '127.0.0.1/path', '127.0.0.1?q=1', '127.0.0.1#x', 'user@127.0.0.1',
  '::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1', '0.0.0.0', '::', '0:0:0:0:0:0:0:0',
])('rejects invalid or nonconcrete MCP host %j', (analystMcpHost) => {
  expect(() => resolveAnalystStartup({...external, analystMcpHost}, 'synthetic-secret', TEST_WORKFLOWS)).toThrow('External Analyst host');
});

it('rejects explicit MCP host in internal mode, including the default address', () => {
  expect(() => resolveAnalystStartup({analystMcpHost:'127.0.0.1'}, undefined, TEST_WORKFLOWS)).toThrow('require external or both');
});
