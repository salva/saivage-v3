import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';

// Patch real syscalls before loading their owners; no production test seam.
const mode = process.argv[2];
const marker = process.argv[3]!;
const root = dirname(marker);
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
const { appLogFile, cardStreamFile, cardRecordStreamFile, cardConversationVersionFile, providerExchangeFile } = await import('../../src/persistence/layout.js');
const { appendConversationBatch, readCurrentConversationSegment } = await import('../../src/persistence/conversation-file.js');
const { agentMessageSchema } = await import('../../src/schemas/index.js');
const { AgentOperatorReadModelService } = await import('../../src/application/read-models/agent-operator-read-model.js');
const { preflightAnalystRecordWrite } = await import('../../src/application/record-mutation-service.js');
const { testRecordDefinition } = await import('../helpers/record-definitions.js');
const { appendProviderExchangeEntry, readLatestProviderExchangePayload } = await import('../../src/persistence/provider-exchange-log.js');
initProjectTree(root);
const store = new CardService(root);
const model = new AgentOperatorReadModelService(root, store.workflows, () => new Map());
let consume: () => unknown;
if (mode === 'read-owned-card') {
  fs.appendFileSync(cardStreamFile(root, 'project'), 'suffix');
  consume = () => model.getSession('agent:planner:project');
} else if (mode === 'read-owned-record') {
  fs.appendFileSync(cardRecordStreamFile(root, 'project', testRecordDefinition('brief.md', 'project')), 'suffix');
  consume = () => preflightAnalystRecordWrite(store, { path: 'record:///brief.md?card=project', operation: 'write', surface: 'analyst', agentName: 'analyst', requiredTools: ['write'] });
} else if (mode === 'read-owned-provider') {
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
