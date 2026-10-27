import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { initProjectTree } from '../helpers/canonical-project.js';
import { createTestConfigAuthority } from '../helpers/project-config.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { McpManager } from '../../src/mcp/mcp-manager.js';
import { McpLifecycleIngress } from '../../src/server/composition/mcp-lifecycle-ingress.js';
import { createApplicationFatalPort, PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { createEventLog } from '../../src/observability/index.js';
import { mcpOperatorApiContracts } from '../../src/contracts/operator-api-mcp.js';
import { buildMcpOperatorContractHandlers } from '../../src/server/routes/operator-mcp-handlers.js';

const root = process.argv[2];
if (!root) throw new Error('Expected synthetic fixture root');
initProjectTree(root);
const mark = (value: string) => appendFileSync(join(root, 'marker'), `${value}\n`);
const fatal = createApplicationFatalPort(), groups = new ManagedProcessGroupRegistry();
const runner = new ProcessRunner(root, groups, fatal);
const eventLogger = createEventLog(root);
const manager = new McpManager({ nativeGit: false, configAuthority: createTestConfigAuthority(root), processRunner: runner,
  mcpProcessRootScope: groups.createContainerScope(groups.rootScope, 'mcp'), eventLogger });
const peer = join(root, 'peer.cjs');
writeFileSync(peer, `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line); if(r.id) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:r.method==='initialize'?{}:{tools:'invalid'}})+'\\n');
});`);
manager.registerServer('one', { transport: 'stdio', command: process.execPath, args: [peer] });
const containment = runner.closeAndTerminateDirectScope.bind(runner);
runner.closeAndTerminateDirectScope = async input => {
  await containment(input); // Real synthetic child is gone before the injected failure.
  mark('containment');
  throw new PublicationOutcomeUnknownError(new Error('MCP cleanup uncertain'));
};
const ingress = new McpLifecycleIngress(manager, () => {}, fatal);
const server = Fastify({ logger: false });
server.addHook('onSend', async () => { mark('response'); });
server.addHook('onError', async () => { mark('http-error'); });
new ContractRuntime({ authPolicy: new AuthPolicy({}), eventLogger, fatalPort: fatal }).mount(server,
  mcpOperatorApiContracts, buildMcpOperatorContractHandlers({ mcpLifecycle: ingress, mcpToolsProvider: manager }));
const origin = await server.listen({ host: '127.0.0.1', port: 0 });
mark('request');
await fetch(`${origin}/api/mcp/servers/one/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
mark('client-response');
await server.close();
