import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startApp } from '../../src/boot/app.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import { redactTextForOutbound } from '../../src/redaction/index.js';
import { EventQueryService } from '../../src/application/event-query-service.js';
import { cardExecutionFile, cardHeadFile, globalAgentConversationVersionIndexFile } from '../../src/persistence/layout.js';
import { productionTestConfig, writeProductionConfig, initializeProject, listen, closeServer,
  appOrigin, readJsonRequest, sendToolCall, sendFinalMessage, waitFor } from '../helpers/production-composition-e2e.js';

const tools = process.env.SAIVAGE_QUALITY_NATIVE_ROOT;
const scratch = process.env.SAIVAGE_QUALITY_TEST_SCRATCH;
if (!tools || !scratch || process.env.NODE_DISABLE_COMPILE_CACHE !== '1') throw new Error('Explicit native prerequisites required.');
const root = mkdtempSync(join(scratch, 'quality-global-'));
const toolName = 'code_quality_javascript_eslint';
const providerRequests: unknown[] = [];
function captureComposition(name: string, value: unknown) {
  const destination = process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE;
  if (!destination) return;
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, `quality-${name}.json`), JSON.stringify(value, null, 2));
}
const provider = createServer(async (request, response) => {
  providerRequests.push(await readJsonRequest(request));
  captureComposition(`internal-analyst-turn-${providerRequests.length}`, providerRequests.at(-1));
  if (providerRequests.length === 1) sendToolCall(response, 'internal-quality', toolName, {});
  else sendFinalMessage(response, 'Native findings are scoped evidence, not acceptance.');
});
const providerPort = await listen(provider);
const reservation = createServer();
const mcpPort = await listen(reservation);
await closeServer(reservation);
const config = productionTestConfig(providerPort, (config) => {
  const analyst = config.agents[config.analyst_agent]!;
  analyst.tools.push(toolName, 'code_quality_python_ruff');
  analyst.quality_tools = { format_version: 1,
    [toolName]: { cwd: 'fixtures', native_config: 'fixtures/eslint.config.mjs', source_paths: ['fixtures/defect.js'],
      exclusions: [], node_binary: process.execPath, eslint_module: 'node_modules/eslint', timeout_ms: 30000, terminate_grace_ms: 100 },
    code_quality_python_ruff: { cwd: 'fixtures', native_config: 'fixtures/ruff.toml', source_paths: ['fixtures/clean.py'],
      exclusions: [], ruff_binary: join(tools, 'venv/bin/ruff'), timeout_ms: 30000, terminate_grace_ms: 100 },
  };
  const other = Object.values(config.agents).find((agent) => agent.session === 'card')!;
  other.tools.push(toolName);
  other.quality_tools = { format_version: 1, [toolName]: { ...analyst.quality_tools[toolName]!, source_paths: ['wrong-policy-agent'] } };
});
cpSync(join(tools, 'node_modules'), join(root, 'node_modules'), { recursive: true });
cpSync(join(tools, 'fixtures'), join(root, 'fixtures'), { recursive: true });
writeProductionConfig(root, config);
initializeProject(root);
const app = await startApp({ projectRoot: root, createRuntime: false, analystMode: 'both',
  analystMcpPort: String(mcpPort), analystMcpPrincipal: 'quality-external', analystMcpTools: toolName,
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', SAIVAGE_HOST: '127.0.0.1', SAIVAGE_PORT: '0',
    SAIVAGE_API_TOKEN: 'quality-rest-token', SAIVAGE_ANALYST_MCP_TOKEN: 'quality-mcp-token' } });
const client = new Client({ name: 'quality-native-test', version: '1' });
let stopped = false;
try {
  const endpoint = app.server.analystMcpEndpoint!;
  const runtime = app.server.runtimeApplication;
  const selectedTool = runtime.externalAnalystOperations!.surface.tools.get(toolName)!;
  const originalExecutor = selectedTool.executor;
  Object.defineProperty(selectedTool, 'executor', { value: async (...args: Parameters<typeof originalExecutor>) => {
    try { return await originalExecutor(...args); }
    catch (error) {
      if (error instanceof PublicationOutcomeUnknownError) throw error;
      console.error(`[quality fixture executor] ${redactTextForOutbound(error instanceof Error ? error.message : String(error)).slice(0, 2000)}`);
      throw error;
    }
  } });
  const runner = runtime.processRunner;
  const spawn = runner.spawnCaptured.bind(runner);
  let launches = 0;
  runner.spawnCaptured = (...args: Parameters<typeof spawn>) => { launches++; return spawn(...args); };
  const head = readFileSync(cardHeadFile(root, 'project'));
  const brief = runtime.cardStore.readRecordCurrent('project', 'brief.md');
  const indexPath = globalAgentConversationVersionIndexFile(root, config.analyst_agent);
  const index = readFileSync(indexPath);
  const executionPath = cardExecutionFile(root, 'project');
  const executionBefore = existsSync(executionPath) ? readFileSync(executionPath) : null;
  for (const token of [undefined, 'quality-rest-token', 'incorrect-token']) {
    const denied = await fetch(endpoint, { method: 'POST', headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: {} } }) });
    assert.equal(denied.status, 401);
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { authorization: 'Bearer quality-mcp-token' } },
  }));
  const externalTools = await client.listTools();
  captureComposition('external-mcp-tools', externalTools);
  assert.deepEqual(externalTools.tools.map((tool) => tool.name), [toolName]);
  for (const args of [{ node_binary: '/other/node' }, { source_paths: ['wrong'] }, { agent: 'other' },
    { output_record: 'brief.md' }, { operation: 'shell.run' }, { native_config: 'other' }])
    await assert.rejects(client.callTool({ name: toolName, arguments: args }));
  await assert.rejects(client.callTool({ name: 'code_quality_python_ruff', arguments: {} }));
  assert.equal(launches, 0, 'Rejected requests/auth/subset must not launch helpers or version probes');
  const external = await client.callTool({ name: toolName, arguments: {} });
  assert.equal(external.isError, false, JSON.stringify(external));
  assert.equal(launches, 1);
  assert(JSON.stringify(external).includes('findings'));
  assert(JSON.stringify(external).includes('work:///quality/'));
  assert.deepEqual(readFileSync(indexPath), index, 'External analysis must not create an internal Analyst turn');
  const receipts = new EventQueryService(root).queryExternalToolCalls();
  assert(receipts.some((row) => row.tool === toolName && row.outcome === 'ok'));
  for (const text of ['defect.js', 'findings.json', 'no-undef', 'source_paths', 'quality-mcp-token'])
    assert(!JSON.stringify(receipts).includes(text), `External receipt must remain body-free: ${text}`);
  const externalCount = receipts.length;
  const internal = await fetch(`${appOrigin(app)}/api/chat`, { method: 'POST', headers: {
    authorization: 'Bearer quality-rest-token', 'content-type': 'application/json',
  }, body: JSON.stringify({ content: 'Run the configured quality analysis once; do not start the project or accept any record.' }) });
  assert.equal(internal.status, 200);
  const internalBody = await internal.json();
  assert(JSON.stringify(internalBody).includes(toolName));
  assert.equal(launches, 2);
  assert.equal(providerRequests.length, 2);
  assert(JSON.stringify(providerRequests[1]).includes('work:///quality/'));
  assert.equal(new EventQueryService(root).queryExternalToolCalls().length, externalCount);
  assert.deepEqual(readFileSync(cardHeadFile(root, 'project')), head);
  assert.deepEqual(existsSync(executionPath) ? readFileSync(executionPath) : null, executionBefore);
  assert.deepEqual(runtime.cardStore.readRecordCurrent('project', 'brief.md'), brief);
  const noReport = runtime.cardStore.readRecordCurrent('project', 'quality-report.md');
  assert.equal(noReport.kind, 'found');
  if (noReport.kind !== 'found') throw new Error('Fixture project unavailable');
  assert.equal(noReport.value.projection, null);
  assert.equal(runtime.runtimeApi.getStatus().status, 'stopped');
  writeFileSync(join(root, 'fixtures/eslint.config.mjs'), `import {writeFileSync} from 'node:fs';
writeFileSync(new URL('./disconnect-entered',import.meta.url),'entered');
await new Promise(resolve=>setTimeout(resolve,500));
export default [{files:['**/*.js'],rules:{'no-undef':'error'}}];\n`);
  const abort = new AbortController();
  const delivered = fetch(endpoint, { method: 'POST', signal: abort.signal, headers: {
    authorization: 'Bearer quality-mcp-token', 'content-type': 'application/json',
    accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: toolName, arguments: {} } }) }).catch(() => null);
  await waitFor(() => existsSync(join(root, 'fixtures/disconnect-entered')), 'external native config entry');
  assert(runner.list().some((record) => record.owner_id === 'external:quality-external'));
  abort.abort(); await delivered;
  await runtime.externalAnalystOperations!.awaitAcceptedOperations();
  assert.equal(new EventQueryService(root).queryExternalToolCalls().filter((row) => row.tool === toolName && row.outcome === 'ok').length, 2);
  assert.deepEqual(runner.list(), []);
  // Owner shutdown, unlike client disconnect, cancels and joins accepted work.
  writeFileSync(join(root, 'fixtures/eslint.config.mjs'), `import {writeFileSync} from 'node:fs';
writeFileSync(new URL('./shutdown-entered',import.meta.url),'entered');
setInterval(()=>{},1000); await new Promise(()=>{}); export default [];\n`);
  const active = runtime.externalAnalystOperations!.invoke(toolName, {});
  const observed = active.then((settlement) => {
    const outcome = settlement.kind === 'executed' ? settlement.execution.providerOutcome : settlement.providerOutcome;
    assert.equal(outcome.kind, 'failed', 'Cancellation cannot become successful quality evidence');
  });
  // Install rejection handling before initiating shutdown, then assert after join.
  const joined = observed.then(() => null, (error: unknown) => ({ error }));
  await waitFor(() => existsSync(join(root, 'fixtures/shutdown-entered')), 'quality owner shutdown entry');
  await app.stop(); stopped = true;
  const shutdownResult = await joined;
  if (shutdownResult) throw shutdownResult.error;
  assert.equal(runner.list().some((record) => record.status === 'running'), false);
  assert.deepEqual(readFileSync(cardHeadFile(root, 'project')), head);
  assert.deepEqual(existsSync(executionPath) ? readFileSync(executionPath) : null, executionBefore);
  console.log('Actual authenticated MCP subset and internal Analyst native quality calls passed; no global card log or acceptance.');
} finally {
  await client.close();
  if (!stopped) await app.stop();
  await closeServer(provider);
  rmSync(root, { recursive: true, force: true });
}
