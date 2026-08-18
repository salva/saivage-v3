import { appendFileSync, closeSync, fstatSync, fsyncSync, mkdtempSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { createApplicationFatalPort, PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import { withDirectMutationComposition } from '../../src/boot/direct-mutation-composition.js';
import { AnalystWsHandler } from '../../src/server/analyst-ws-handler.js';
import { BaseActor, compileActorDefinition, type ActorLifecycleContext, type ActorTransitionContext } from '../../src/runtime/micro-actor/index.js';
import { ConversationLLMActor } from '../../src/runtime/actors/llm-actor.js';
import { prepareCompaction } from '../../src/runtime/actors/compaction/compactor.js';
import { buildPreparedInvocationContext } from '../../src/runtime/actors/context/context-blocks.js';
import { RuntimeGate } from '../../src/runtime/runtime-gate.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner, type ProcessOutputIo } from '../../src/runtime/process-runner.js';
import { replaceFile, type ReplacementFileIo } from '../../src/persistence/replace-file.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { defineTool, executedProviderResult, invokeToolForLlm, OPERATIONAL_RESULT_POLICY_TEMPLATE, type InvocationSurface } from '../../src/tools/invocation.js';
import { resolveLlmTransportConfig } from '../../src/agents/llm-transport.js';
import { appendAppLogEntry } from '../../src/persistence/app-log.js';
import { appLogEntrySchema } from '../../src/contracts/app-log.js';
import { AnalystSession } from '../../src/agents/analyst-handler.js';
import { scriptedAdmissionProvider, testCompactionPolicy, unusedSummarizerProvider } from '../helpers/llm-test-helpers.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

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
    liveSyncSocket: { handleClientFrame: () => false } as never,
    runtimeApplication: { analystRuntime: { submit: async () => { submits += 1; appendFileSync(path, String(submits)); throw new PublicationOutcomeUnknownError(); } } } as never,
    sendToClient: () => { appendFileSync(path, 'frame'); },
  });
  const ws = { OPEN: 1, readyState: 1 } as never;
  void handler.handleRawMessage(ws, Buffer.from(JSON.stringify({ type: 'message', content: { text: 'first' } })));
}

if (mode === 'base-actor-task') {
  class FatalActor extends BaseActor {
    constructor() { const definition=compileActorDefinition({ initial: 'run', states: { run: {} } });super(definition.initial,definition.states); }
    protected onStateEntered(_context: ActorLifecycleContext): void {
      this.runTask(async () => invokeToolForLlm({ agentName: 'planner', providers: [], tools: new Map([['publish', { name: 'publish', description: 'publication owner', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: z.object({}), executor: async (): Promise<never> => { throw new PublicationOutcomeUnknownError(); } }]]) }, 'publish', {}, {} as never), { onDone() {}, onFailed() { process.stdout.write('failed-task'); } });
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
    purpose:{kind:'autonomous-card',cardId:'project'},
    gate: new RuntimeGate(),
    fatalPort,
    agentId: 'agent:planner:project',
    provider: scriptedAdmissionProvider(async () => { throw new PublicationOutcomeUnknownError(); }),
    conversations: { projectRoot: root },
    compactor: { shouldCompact: () => false, compact: async () => { throw new Error('not reached'); } },
    summarizerProvider: { candidate:{provider:'test',account:null,model:'test-model'},serializeSummaryRequest: () => { throw new Error('not reached'); },completeTurn: async () => { throw new Error('not reached'); }, projectProviderExchanges() {} },
  });
  const policy = { input_budget_tokens: 1000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.55, snap: 'compact_straddler' as const };
  const preparedCompaction = prepareCompaction(policy, 'system', []);
  void actor.turn({ inputId: '00000000-0000-4000-8000-000000000001', agentId: 'agent:planner:project', agentName: 'planner', sessionId: 'agent:planner:project', systemPrompt: 'system', providerConversation: { sourceSessionId: 'agent:planner:project', messages: [] }, tools: [], compiledToolContracts: [], terminalToolNames: [], modelParams: { temperature: 0 }, preparedCompaction, preparedContext: buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: [], dynamicBlocks: [], preparedCompaction }), capabilityRequest: {},routePass:{kind:'ordinary',candidateChain:[{provider:'test',account:null,model:'test-model'}]}, episodeContext: {} }, undefined, () => { appendFileSync(path, 'terminal'); }).then(() => appendFileSync(path, 'after'));
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

if (mode === 'analyst-project-context') {
  if (!path) throw new Error('marker path required');
  const root = dirname(path);
  initProjectTree(root);
  const mark = (label: string): void => { appendFileSync(path, `${label}\n`); };
  const contextFailure = new PublicationOutcomeUnknownError();
  const cardStore = new Proxy({}, {
    get(_target, property) {
      if (property === 'list') return () => { throw contextFailure; };
      return () => {
        mark(`card-other:${String(property)}`);
        throw new Error(`Unexpected card operation '${String(property)}'.`);
      };
    },
  }) as unknown as CardService;
  const tool = defineTool({
    name: 'forbidden_tool',
    description: 'Must not run after failed project-context construction.',
    resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
    inputSchema: z.object({}).strict(),
    executor: async () => {
      mark('tool');
      return executedProviderResult('none', { success: true, data: null });
    },
  });
  const surface: InvocationSurface = {
    agentName: 'analyst',
    tools: new Map([[tool.name, tool]]),
    providers: [],
  };
  const session = new AnalystSession({
    cardTypeVocabulary: ['project','goal','architecture','code','test','doc','data','research','ops'],
    sessionId: 'agent:analyst:global',
    agentName: 'analyst', modelParams: { temperature: 0, maxTokens: 1000 }, capabilityRequest: { requiresTools: true, requiresExclusiveToolChoice: true },
    candidateChain: [{ provider: 'test', account: null, model: 'test-model' }],
    promptTemplates: { render: () => { mark('prompt'); return 'rendered prompt'; } },
    restartServerAvailable: false,
    provider: scriptedAdmissionProvider(async () => { mark('provider'); throw new Error('Provider must not run.'); }),
    conversations: { projectRoot: root },
    compactionPolicy: testCompactionPolicy,
    compactor: { shouldCompact: () => false, compact: async () => { throw new Error('Compaction must not run.'); } },
    summarizerProvider: unusedSummarizerProvider,
    cardStore,
    runtimeCurrent: () => { throw new Error('runtime observation must not run'); },
    runtimeProjectionChanged() {},
    createInvocationSurface: () => surface,
    shutdownProcesses: async () => {},
    fatalPort,
  });
  const runtimeApplication = {
    analystSessionId: 'agent:analyst:global',
    analystRuntime: {
      submit(input: { userContent: string }) {
        const submission = session.submit(input);
        void submission.then(
          () => mark('caller-resolve'),
          () => mark('caller-reject'),
        );
        return submission;
      },
    },
  };
  const handler = new AnalystWsHandler({
    fatalPort,
    liveSyncSocket: { handleClientFrame: () => false } as never,
    runtimeApplication: runtimeApplication as never,
    sendToClient: () => { mark('transport-send'); },
  });
  const ws = { OPEN: 1, readyState: 1 } as never;
  void handler.handleRawMessage(
    ws,
    Buffer.from(JSON.stringify({ type: 'message', content: { text: 'inspect project' } })),
  ).then(
    () => mark('handler-resolve'),
    () => mark('handler-reject'),
  );
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
  const handler = new AnalystWsHandler({ fatalPort, liveSyncSocket: { handleClientFrame: () => false } as never, runtimeApplication: { analystRuntime: { submit: async () => publication() } } as never, sendToClient: () => { appendFileSync(path, 'frame'); } });
  const ws = { OPEN: 1, readyState: 1 } as never;
  void handler.handleRawMessage(ws, Buffer.from(JSON.stringify({ type: 'message', content: { text: 'publish' } })));
}
