import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';

// Patch real syscalls before loading their owners; no production test seam.
const mode = process.argv[2];
const marker = process.argv[3]!;
const root = dirname(marker);
const receiptMode = mode === 'external-analyst-receipt-publication';
let receiptArmed = false;
if (receiptMode) {
  const originalWrite = fs.writeSync as (...args: unknown[]) => number;
  fs.writeSync = ((...args: unknown[]) => {
    const bytes = args[1];
    if (receiptArmed && ArrayBuffer.isView(bytes) && Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes('"type":"external_tool_call"')) {
      fs.appendFileSync(marker, 'receipt-write\n');
      originalWrite(...args);
      throw new Error('external receipt append uncertain');
    }
    return originalWrite(...args);
  }) as typeof fs.writeSync;
}
const originalTruncate = fs.ftruncateSync;
fs.ftruncateSync = (fd, length) => {
  fs.appendFileSync(marker, 'entered');
  originalTruncate(fd, length);
  throw new Error('truncate uncertain');
};
syncBuiltinESMExports();

const { initProjectTree, CardService } = await import('../helpers/canonical-project.js');
const { createApplicationFatalPort } = await import('../../src/contracts/publication-outcome.js');
const { createFastifyApp } = await import('../../src/server/composition/fastify-app.js');
const { ContractRuntime } = await import('../../src/server/contract-runtime.js');
const { AuthPolicy } = await import('../../src/server/auth-policy.js');
const { z } = await import('zod');
const { appendAppLogEntry, readAppLogEntries } = await import('../../src/persistence/app-log.js');
const { appLogFile, cardConversationVersionFile, providerExchangeFile } = await import('../../src/persistence/layout.js');
const { appendConversationBatch, readCurrentConversationSegment } = await import('../../src/persistence/conversation-file.js');
const { agentMessageSchema } = await import('../../src/schemas/index.js');
const { AgentOperatorReadModelService } = await import('../../src/application/read-models/agent-operator-read-model.js');
const { appendProviderExchangeEntry, readLatestProviderExchangePayload } = await import('../../src/persistence/provider-exchange-log.js');
initProjectTree(root);
if (receiptMode) {
  const { ExternalAnalystOperations } = await import('../../src/application/external-analyst-operations.js');
  const { createAnalystMcpServer } = await import('../../src/server/analyst-mcp-server.js');
  const { defineTool, executedToolOutcome, OPERATIONAL_RESULT_POLICY_TEMPLATE } = await import('../../src/tools/invocation.js');
  const { toolSucceeded } = await import('../../src/contracts/tool-result.js');
  const { createTestProcessRunner } = await import('../helpers/test-process-runner.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { createServer, ServerResponse } = await import('node:http');
  const { listen, closeServer } = await import('../helpers/production-composition-e2e.js');
  const mark = (label: string) => fs.appendFileSync(marker, `${label}\n`);
  // Establish the canonical log so this fault is append uncertainty, not first publication.
  appendAppLogEntry(root, 'event', () => ({ type: 'event', data: { id: 'seed', timestamp: '2026-10-20T00:00:00.000Z', kind: 'runtime_diagnostic', error_message: 'synthetic seed' } }));
  const fatalPort = createApplicationFatalPort();
  const processes = createTestProcessRunner(root);
  let operationEntered = false;
  const tool = defineTool({ name: 'settled', description: 'Synthetic settled operation', inputSchema: z.object({}).strict(), resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
    executor: async () => { operationEntered = true; mark('entered'); return executedToolOutcome('none', toolSucceeded(null)); } });
  const operations = new ExternalAnalystOperations({ projectRoot: root, projectIdentityDigest: 'a'.repeat(64), principal: 'fixture',
    surface: { agentName: 'analyst', tools: new Map([[tool.name, tool]]), providers: [] }, processRunner: processes.processRunner,
    directScope: processes.processRunner.createDirectScope(processes.registry.rootScope, 'external:fixture', 'operator_session'), fatalPort,
    onOwnerFailure: () => mark('followup-audit') });
  const reservation = createServer(); const port = await listen(reservation); await closeServer(reservation);
  const listener = createAnalystMcpServer({ startup: { mode: 'external', port, principal: 'fixture', token: 'synthetic-receipt-token', tools: ['settled'] },
    binding: { project_identity_digest: 'a'.repeat(64), project_name: 'Synthetic receipt', analyst_policy: 'analyst', principal: 'fixture' },
    operations, context: () => ({}), fatalPort, onOwnerFailure: () => mark('followup-audit') });
  await listener.listen();
  const client = new Client({ name: 'synthetic-receipt-client', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(listener.endpoint), { requestInit: { headers: { authorization: 'Bearer synthetic-receipt-token' } } }));
  // Initialization has finished. Observe the actual request-local SDK disposal and HTTP response boundary.
  const close = Server.prototype.close;
  Server.prototype.close = async function () { if (operationEntered) mark('sdk-disposal'); return close.call(this); };
  const end = ServerResponse.prototype.end;
  ServerResponse.prototype.end = function (this: InstanceType<typeof ServerResponse>, ...args: Parameters<typeof end>) { if (operationEntered) mark('response'); return end.apply(this, args); } as typeof end;
  receiptArmed = true;
  try { await client.callTool({ name: 'settled', arguments: {} }); mark('client-result'); }
  finally { mark('cleanup'); await client.close(); await operations.cleanupForApplicationStop(); await listener.cleanupForApplicationStop(); }
} else {
const store = new CardService(root);
const model = new AgentOperatorReadModelService(root, store.workflows, () => new Map());
let consume: () => unknown;
if (mode === 'read-owned-provider') {
  const owner = 'agent:planner:project' as const; const timestamp = '2026-08-11T00:00:00.000Z';
  appendProviderExchangeEntry(root, owner, { type: 'provider_exchange', data: { session_id: owner, source_input_id: 'first', attempt_index: 0, timestamp, payload: { contract_id: 'test.v1', contract_name: 'test', transport: 'generic', provider: 'test', model: 'test', source_input_id: 'first', attempt_index: 0, request_params: {}, started_at: timestamp, completed_at: timestamp, status: 'ok', terminal_tool_fired: null, assistant_output_ids: [] } } });
  fs.appendFileSync(providerExchangeFile(root, owner), 'suffix');
  consume = () => readLatestProviderExchangePayload(root, owner);
} else if (mode === 'read-owned-conversation') {
  const session = 'agent:planner:project' as const;
  appendConversationBatch({ projectRoot: root }, [agentMessageSchema.parse({ id: 'user-first', session_id: session, role: 'user', kind: 'text', content: 'first', context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' }, compactable: true }, round_id: `r-user-${'0'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-08-11T00:00:00.000Z' })]);
  const segment = readCurrentConversationSegment(root, session)!;
  fs.appendFileSync(cardConversationVersionFile(root, 'project', 'planner', segment.entry.filename), 'suffix');
  consume = () => model.getConversationVersion(session, 1);
} else {
  const entry = { type: 'event' as const, data: { id: 'first', timestamp: '2026-08-11T00:00:00.000Z', kind: 'runtime_diagnostic' as const, error_message: 'first' } };
  appendAppLogEntry(root, 'event', () => entry);
  fs.appendFileSync(appLogFile(root), 'suffix');
  consume = mode === 'log-append-torn' ? () => appendAppLogEntry(root, 'event', () => ({ ...entry, data: { ...entry.data, id: 'later' } })) : () => readAppLogEntries(root);
}
const fatalPort = createApplicationFatalPort();
const app = await createFastifyApp({ nodeEnv: 'test', server: { logLevel: 'silent' } } as never, fatalPort);
const runtime = new ContractRuntime({ fatalPort, authPolicy: new AuthPolicy({}), eventLogger: { appendEvent() { fs.appendFileSync(marker, 'logged'); } } as never });
runtime.mount(app, { read: { operationId: 'read', method: 'GET', path: '/read', auth: 'public', success: z.unknown() } } as never, { read: () => ({ body: consume() }) } as never);
await app.inject({ method: 'GET', url: '/read' });
fs.appendFileSync(marker, 'response');
await app.close();
}
