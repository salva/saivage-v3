import { appendFileSync, closeSync, fstatSync, fsyncSync, mkdtempSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { createApplicationFatalPort, PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import { withDirectMutationComposition } from '../../src/boot/direct-mutation-composition.js';
import { AnalystWsHandler } from '../../src/server/analyst-ws-handler.js';
import { BaseActor, compileActorDefinition, type ActorLifecycleContext, type ActorTransitionContext } from '../../src/runtime/micro-actor/index.js';
import { ConversationLLMActor } from '../../src/runtime/actors/llm-actor.js';
import { prepareCompaction } from '../../src/runtime/actors/compaction/compactor.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner, type ProcessOutputIo } from '../../src/runtime/process-runner.js';
import { replaceFile, type ReplacementFileIo } from '../../src/persistence/replace-file.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { invokeToolForLlm } from '../../src/tools/invocation.js';
import { resolveLlmTransportConfig } from '../../src/agents/llm-transport.js';
import { appendAppLogEntry } from '../../src/persistence/app-log.js';
import { appLogEntrySchema } from '../../src/contracts/app-log.js';

const mode = process.argv[2];
const path = process.argv[3];
const fatalPort = createApplicationFatalPort();
const diagnosticOnlyBoundary = (action: () => void): void => {
  try { action(); }
  catch (error) { if (error instanceof PublicationOutcomeUnknownError) fatalPort.publicationOutcomeUnknown(error); throw error; }
};

if (mode === 'direct-mutation') {
  if (!path) throw new Error('project root required');
  withDirectMutationComposition(path, 'bound', fatalPort, () => { replaceFile(join(path, '.saivage', 'startup-publication'), Buffer.from('published')); throw new PublicationOutcomeUnknownError(); });
}

if (mode === 'websocket') {
  if (!path) throw new Error('marker path required');
  let submits = 0;
  const handler = new AnalystWsHandler({
    fatalPort,
    projectRoot: '.',
    saivageConfig: {} as never,
    liveSyncSocket: { handleClientFrame: () => false } as never,
    runtimeApplication: { analystRuntime: { submit: async () => { submits += 1; appendFileSync(path, String(submits)); throw new PublicationOutcomeUnknownError(); } } } as never,
    sendToClient: () => { appendFileSync(path, 'frame'); },
  });
  const ws = { OPEN: 1, readyState: 1 } as never;
  void handler.handleRawMessage(ws, Buffer.from(JSON.stringify({ type: 'message', content: { text: 'first' } })));
  void handler.handleRawMessage(ws, Buffer.from(JSON.stringify({ type: 'message', content: { text: 'second' } })));
}

if (mode === 'base-actor-task') {
  class FatalActor extends BaseActor {
    constructor() { super(compileActorDefinition({ initial: 'run', states: { run: {} } })); }
    protected onStateEntered(_context: ActorLifecycleContext): void {
      this.runTask(async () => invokeToolForLlm({ agentName: 'planner', providers: [], tools: new Map([['publish', { name: 'publish', description: 'publication owner', inputSchema: z.object({}), executor: async () => { throw new PublicationOutcomeUnknownError(); } }]]) }, 'publish', {}, {} as never), { onDone() {}, onFailed() { process.stdout.write('failed-task'); } });
    }
    protected onTransition(_context: ActorTransitionContext): void {}
    protected onActorMainFailure(): void { process.stdout.write('main-failed'); }
    protected onFatalTaskError(error: unknown): void { if (error instanceof PublicationOutcomeUnknownError) fatalPort.publicationOutcomeUnknown(error); }
  }
  new FatalActor().start();
}

if (mode === 'llm-conversation') {
  if (!path) throw new Error('marker path required');
  appendFileSync(path, 'entered');
  const root = mkdtempSync(join(tmpdir(), 'publication-llm-owner-'));
  initProjectTree(root);
  const actor = new ConversationLLMActor({
    fatalPort,
    agentId: 'agent:planner:project',
    provider: { completeTurn: async () => { throw new PublicationOutcomeUnknownError(); } },
    conversations: { projectRoot: root },
    compactor: { shouldCompact: () => false, compact: async () => { throw new Error('not reached'); } },
    summarizerProvider: { completeTurn: async () => { throw new Error('not reached'); }, projectProviderExchanges() {} },
  });
  const policy = { input_budget_tokens: 1000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.55, snap: 'compact_straddler' as const };
  void actor.turn({ inputId: '00000000-0000-4000-8000-000000000001', agentId: 'agent:planner:project', agentName: 'planner', sessionId: 'agent:planner:project', systemPrompt: 'system', providerConversation: { sourceSessionId: 'agent:planner:project', messages: [] }, tools: [], terminalToolNames: [], modelParams: {}, preparedCompaction: prepareCompaction(policy, 'system', []), capabilityRequest: {}, episodeContext: {} }, undefined, () => { appendFileSync(path, 'terminal'); }).then(() => appendFileSync(path, 'after'));
}

if (mode === 'process-chunk') {
  if (!path) throw new Error('marker path required');
  appendFileSync(path, 'entered');
  const root = mkdtempSync(join(tmpdir(), 'publication-process-owner-')); initProjectTree(root);
  const registry = new ManagedProcessGroupRegistry();
  const parent = registry.createContainerScope(registry.rootScope, 'runtime');
  const scope = registry.createDirectScope(parent, 'fatal-output', 'runtime_card');
  const output: ProcessOutputIo = { open: openSync, stat: fstatSync, write() { throw new Error('unknown transfer'); }, fsync: fsyncSync, close: closeSync } as never;
  const runner = new ProcessRunner(root, registry, fatalPort, { output });
  runner.spawn({ command: 'printf output', directScope: scope, category: 'runtime_card', ownerId: 'owner', ownerKind: 'agent' });
  setTimeout(() => appendFileSync(path, 'after'), 500);
}

if (mode === 'work-replacement') {
  if (!path) throw new Error('marker path required');
  appendFileSync(path, 'entered');
  const io: ReplacementFileIo = { open() { return 1; }, write(_fd: number, _bytes: Uint8Array, _offset: number, length: number) { return length; }, fsync() {}, close() {}, rename() { throw new Error('rename uncertain'); } } as never;
  diagnosticOnlyBoundary(() => replaceFile('/owner/state', Buffer.from(mode), () => '11111111-1111-4111-8111-111111111111', io));
  appendFileSync(path, 'after');
}

if (mode === 'process-placeholder') {
  if (!path) throw new Error('marker path required');
  appendFileSync(path, 'entered');
  const root = mkdtempSync(join(tmpdir(), 'publication-process-placeholder-')); initProjectTree(root);
  const replacement: ReplacementFileIo = { open() { return 1; }, write(_fd: number, _bytes: Uint8Array, _offset: number, length: number) { return length; }, fsync() {}, close() {}, rename() { throw new Error('rename uncertain'); } } as never;
  const runner = new ProcessRunner(root, { launch() { appendFileSync(path, 'launched'); throw new Error('launch must not run'); } } as never, fatalPort, { replacement });
  diagnosticOnlyBoundary(() => { runner.spawn({ command: 'never', directScope: {} as never, category: 'runtime_card', ownerId: 'owner', ownerKind: 'agent' }); });
}

if (mode === 'auth-projection') {
  if (!path) throw new Error('marker path required');
  appendFileSync(path, 'entered');
  void resolveLlmTransportConfig('.', { get() { throw new PublicationOutcomeUnknownError(); } } as never, { provider: 'test', model: 'model', account: null }, 'openai_responses_api_key').catch((error) => {
    if (error instanceof PublicationOutcomeUnknownError) fatalPort.publicationOutcomeUnknown(error);
    throw error;
  });
}

if (mode === 'contract-runtime') {
  if (!path) throw new Error('marker path required');
  appendFileSync(path, 'entered');
  let route: { handler(request: unknown, reply: unknown): Promise<unknown> } | undefined;
  const runtime = new ContractRuntime({ fatalPort, authPolicy: {} as never, eventLogger: {} as never });
  runtime.mount({ route(value: unknown) { route = value as never; } } as never, { fatal: { operationId: 'fatal', method: 'GET', path: '/fatal', auth: 'public', success: z.unknown() } as never }, { fatal: async () => { throw new PublicationOutcomeUnknownError(); } });
  void route!.handler({ params: {}, query: {}, body: {}, log: { error() { appendFileSync(path, 'logged'); } } }, { raw: { once() {} }, header() {}, status() { return this; }, send() { appendFileSync(path, 'sent'); } });
}

if (mode === 'analyst-card' || mode === 'analyst-config' || mode === 'analyst-app-log') {
  if (!path) throw new Error('marker path required');
  appendFileSync(path, 'entered');
  const root = join(path, '..'); initProjectTree(root);
  const publication = () => {
    if (mode === 'analyst-card') new CardService(root).editCard('project', { title: 'published before unknown outcome' }, 'planner');
    else if (mode === 'analyst-config') replaceFile(join(root, '.saivage', 'saivage.yaml'), Buffer.from('server:\n  port: 8080\n'));
    else appendAppLogEntry(root, 'event', () => appLogEntrySchema.parse({ type: 'event', data: { id: 'analyst-fatal', timestamp: '2026-07-24T00:00:00.000Z', kind: 'runtime_diagnostic', error_message: 'injected' } }) as never);
    throw new PublicationOutcomeUnknownError();
  };
  const handler = new AnalystWsHandler({ fatalPort, projectRoot: root, saivageConfig: {} as never, liveSyncSocket: { handleClientFrame: () => false } as never, runtimeApplication: { analystRuntime: { submit: async () => publication() } } as never, sendToClient: () => { appendFileSync(path, 'frame'); } });
  const ws = { OPEN: 1, readyState: 1 } as never;
  void handler.handleRawMessage(ws, Buffer.from(JSON.stringify({ type: 'message', content: { text: 'publish' } })));
}
