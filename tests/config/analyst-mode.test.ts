import { expect, it } from '@jest/globals';
import { resolveAnalystStartup } from '../../src/config/analyst-mode.js';
import { DEFAULT_SAIVAGE_CONFIG } from '../../src/config/system-templates/registry.js';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
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

it('selects the entire compiled default Analyst inventory by exact name', () => {
  const workflows = compileProjectWorkflows(DEFAULT_SAIVAGE_CONFIG);
  const names = workflows.analyst.tools.map(({ name }) => name);
  expect(names.length).toBeGreaterThan(6);
  expect(resolveAnalystStartup({ ...external, analystMcpTools: names.join(',') }, 'synthetic-secret', workflows))
    .toMatchObject({ mode: 'external', tools: names });
});

it('selects a reduced custom inventory and rejects names outside its exact compiled grants', () => {
  const config = structuredClone(DEFAULT_SAIVAGE_CONFIG);
  config.agents[config.analyst_agent]!.skills = false;
  config.agents[config.analyst_agent]!.capabilities.grants = [
    { tools: ['get_card'], resources: [{ kind: 'card', scopes: ['all'] }] },
    { tools: ['read'], resources: [{ kind: 'workspace' }] },
  ];
  const workflows = compileProjectWorkflows(config);
  const names = workflows.analyst.tools.map(({ name }) => name);
  expect(names).toEqual(['get_card', 'read']);
  expect(resolveAnalystStartup({ ...external, analystMcpTools: names.join(',') }, 'synthetic-secret', workflows))
    .toMatchObject({ mode: 'external', tools: names });
  for (const analystMcpTools of [undefined, '', '*', 'unknown_tool', 'write', 'read,read', 'read, get_card', 'read ']) {
    expect(() => resolveAnalystStartup({ ...external, analystMcpTools }, 'synthetic-secret', workflows))
      .toThrow('External Analyst tools must be a nonempty unique list of configured canonical names.');
  }
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
