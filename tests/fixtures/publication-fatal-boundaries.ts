import { appendFileSync, closeSync, fstatSync, fsyncSync, mkdtempSync, openSync, renameSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { createApplicationFatalPort, PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import { withDirectMutationComposition } from '../../src/boot/direct-mutation-composition.js';
import { createFastifyApp } from '../../src/server/composition/fastify-app.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { chatOperatorApiContracts } from '../../src/contracts/operator-api-chats.js';
import { buildChatOperatorContractHandlers } from '../../src/server/routes/operator-chat-handlers.js';
import type { Environment } from '../../src/config/environment.js';
import { ConversationLLMActor } from '../../src/runtime/actors/llm-actor.js';
import { compact, prepareCompaction } from '../../src/runtime/actors/compaction/compactor.js';
import { appendConversationBatch, readConversation } from '../../src/persistence/conversation-file.js';
import { publishFreshFile } from '../../src/persistence/replace-file.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY } from '../helpers/row-policy-fixtures.js';
import { deterministicSummarySerialization } from '../helpers/summary-serialization.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import { buildPreparedInvocationContext } from '../../src/runtime/actors/context/context-blocks.js';
import { RuntimeGate } from '../../src/runtime/runtime-gate.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner, type ProcessOutputIo } from '../../src/runtime/process-runner.js';
import { replaceFile, type ReplacementFileIo } from '../../src/persistence/replace-file.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { defineTool, executedToolOutcome, OPERATIONAL_RESULT_POLICY_TEMPLATE, type InvocationSurface } from '../../src/tools/invocation.js';
import { toolSucceeded } from '../../src/contracts/tool-result.js';
import { resolveLlmTransportConfig } from '../../src/agents/llm-transport.js';
import { appendAppLogEntry } from '../../src/persistence/app-log.js';
import { appLogEntrySchema } from '../../src/contracts/app-log.js';
import { AnalystSession } from '../../src/runtime/actors/analyst-session.js';
import { scriptedAdmissionProvider, testCompactionPolicy, unusedSummarizerProvider } from '../helpers/llm-test-helpers.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { createSupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import { AgentNodeExecution } from '../../src/runtime/actors/agent-node-execution.js';
import { ActivationOperationTracker } from '../../src/runtime/actors/invocation-lifecycle.js';
import { RuntimeStoppedInterruption } from '../../src/runtime/actors/runtime-stopped-interruption.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import { createTestPromptTemplateRegistry } from '../helpers/prompt-template-registry.js';
import { testAutonomousCompaction } from '../helpers/llm-test-helpers.js';

const mode = process.argv[2];
const path = process.argv[3];
const fatalPort = createApplicationFatalPort();
async function submitThroughRest(submit: (input: { userContent: string }) => Promise<unknown>): Promise<void> {
  const app = await createFastifyApp({ nodeEnv: 'test', server: { logLevel: 'silent' } } as Environment, fatalPort);
  const runtime = new ContractRuntime({ fatalPort, authPolicy: new AuthPolicy({}), eventLogger: {} as never });
  runtime.mount(app, chatOperatorApiContracts, buildChatOperatorContractHandlers({
    projectRoot: path ? dirname(path) : '.', saivageConfig: TEST_SAIVAGE_CONFIG,
    restartCapability: { available: false },
    runtimeApplication: { analystSessionId: 'agent:analyst:global', analystRuntime: { submit } } as never,
  }));
  await app.inject({ method: 'POST', url: '/api/chat', payload: { content: 'publish' } });
  if (path) appendFileSync(path, 'response');
  await app.close();
}
const diagnosticOnlyBoundary = (action: () => void): void => {
  try { action(); }
  catch (error) { if (error instanceof PublicationOutcomeUnknownError) fatalPort.publicationOutcomeUnknown(error); throw error; }
};

if (mode === 'direct-mutation') {
  if (!path) throw new Error('project root required');
  withDirectMutationComposition(path, 'bound', fatalPort, () => { replaceFile(join(path, '.saivage', 'startup-publication'), Buffer.from('published')); throw new PublicationOutcomeUnknownError(); });
}

if (mode === 'rest-chat') {
  if (!path) throw new Error('marker path required');
  let submits = 0;
  void submitThroughRest(async () => { submits += 1; appendFileSync(path, String(submits)); throw new PublicationOutcomeUnknownError(); });
}

if (mode === 'card-node-task' || mode === 'card-node-task-late') {
  if (!path) throw new Error('marker path required');
  const root = dirname(path);
  initProjectTree(root);
  const processes = createTestProcessRunner(root);
  let failRaw!: (error: unknown) => void;
  let entered!: () => void;
  const rawEntered = new Promise<void>((resolve) => { entered = resolve; });
  let wrapper!: Promise<unknown>;
  let uncertain = false;
  const mark = (label: string) => appendFileSync(path, `${label}\n`);
  const originalRun = ActivationOperationTracker.prototype.run;
  ActivationOperationTracker.prototype.run = function <T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const result = originalRun.call(this, signal, run) as Promise<T>;
    wrapper = result;
    return result;
  };
  AgentNodeExecution.prototype.execute = async function () {
    mark('entered');
    entered();
    if (mode === 'card-node-task') {
      uncertain = true;
      throw new PublicationOutcomeUnknownError();
    }
    return await new Promise<never>((_resolve, reject) => { failRaw = reject; });
  };
  const supervisor = createSupervisorRuntimeApi({
    fatalPort, ...testAutonomousCompaction, runtimeGate: new RuntimeGate(),
    projectRoot: root, actorStore: new CardService(root),
    provider: scriptedAdmissionProvider(async () => { mark('provider'); throw new Error('must not enter provider'); }),
    conversations: { projectRoot: root },
    freshness: { runtimeChanged() { if (uncertain) mark('projection-after-uncertainty'); }, agentMembershipChanged() { if (uncertain) mark('membership-after-uncertainty'); } },
    processRunner: processes.processRunner, runtimeProcessRootScope: processes.runtimeProcessRootScope,
    promptTemplates: createTestPromptTemplateRegistry(),
  });
  await supervisor.start();
  await supervisor.startProject();
  await rawEntered;
  if (mode === 'card-node-task-late') {
    const stopped = supervisor.stopProject();
    await wrapper.then(
      () => { throw new Error('Node wrapper succeeded while raw execution was still held.'); },
      (error: unknown) => { if (!(error instanceof RuntimeStoppedInterruption)) throw error; },
    );
    mark('wrapper-cancelled');
    // Cancellation delivery/containment may finish normally before the abandoned raw dependency rejects.
    await stopped;
    mark('stopped');
    uncertain = true;
    failRaw(new PublicationOutcomeUnknownError());
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  mark('after-uncertainty');
}

if (mode === 'llm-conversation' || mode === 'llm-segment-compaction') {
  if (!path) throw new Error('marker path required');
  appendFileSync(path, 'entered');
  const root = mode === 'llm-segment-compaction' ? dirname(path) : mkdtempSync(join(tmpdir(), 'publication-llm-owner-'));
  initProjectTree(root);
  const sessionId = 'agent:planner:project' as const;
  const actualPublication = mode === 'llm-segment-compaction';
  let uncertain = false;
  if (actualPublication) {
    const rows: AgentMessage[] = [1, 2, 3].flatMap((ordinal) => {
      const timestamp = `2026-08-18T00:0${ordinal}:00.000Z`;
      return [
        { id: `activation-${ordinal}`, session_id: sessionId, role: 'system', kind: 'activity', context_policy: ACTIVITY_ROW_POLICY, content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`, timestamp }), round_id: `r-pre-${String(ordinal).padStart(32, '0')}`, message_index: 0, block_index: 0, timestamp },
        { id: `text-${ordinal}`, session_id: sessionId, role: 'user', kind: 'text', context_policy: TEXT_ROW_POLICY, content: 'x'.repeat(12_000), round_id: `r-user-${String(ordinal).padStart(32, '0')}`, message_index: 1, block_index: 0, timestamp },
      ] as AgentMessage[];
    });
    appendConversationBatch({ projectRoot: root }, rows);
  }
  const replacement: ReplacementFileIo = {
    open: openSync, write: writeSync, fsync: fsyncSync, close: closeSync,
    rename(from, to) {
      renameSync(from, to); // Model a syscall whose effect commits before it throws.
      uncertain = true;
      appendFileSync(path, 'rename');
      throw new Error('segment rename uncertain');
    },
  };
  const actor = new ConversationLLMActor({
    purpose:{kind:'autonomous-card',cardId:'project'},
    gate: new RuntimeGate(),
    fatalPort,
    agentId: 'agent:planner:project',
    provider: scriptedAdmissionProvider(async () => { if (actualPublication) appendFileSync(path, 'provider'); throw new PublicationOutcomeUnknownError(); }),
    conversations: { projectRoot: root, changes: { conversationChanged() { if (uncertain) appendFileSync(path, 'hint'); }, agentMembershipChanged() { if (uncertain) appendFileSync(path, 'membership'); } } },
    runtimeProjectionChanged() { if (uncertain) appendFileSync(path, 'progress-clear'); },
    compactor: {
      shouldCompact: () => actualPublication,
      compact: async (args) => compact({ ...args, publication: { io: {
        publishFreshFile: (target, bytes, temporary) => publishFreshFile(target, bytes, temporary, replacement),
        publishHeadFile: () => { appendFileSync(path, 'index'); throw new Error('not reached'); },
      } } }),
    },
    summarizerProvider: { materializeImage: async () => { throw new Error('Unexpected image.'); }, candidate:{provider:'test',account:null,model:'test-model'},contextWindowTokens:100_000,maxOutputTokens:10_000,serializeSummaryRequest: deterministicSummarySerialization, completeTurn: async () => ({ result: { kind: 'message', content: 'summary' }, provider_exchanges: [] }), projectProviderExchanges() { if (uncertain) appendFileSync(path, 'summary'); } },
  });
  const policy = { context_utilization_fraction: 0.8, trigger_fraction: 0.8, tail_fraction: 0.25, snap: 'compact_straddler' as const };
  const preparedCompaction = prepareCompaction(policy, 'system', [], 8_000, 2_000);
   void actor.turn({ inputId: '00000000-0000-4000-8000-000000000001', agentId: 'agent:planner:project', agentName: 'planner', sessionId: 'agent:planner:project', systemPrompt: 'system', providerConversation: actualPublication ? providerConversationProjection(readConversation(root, sessionId), []) : { sourceSessionId: 'agent:planner:project', messages: [] }, tools: [], compiledToolContracts: [], terminalToolNames: [], modelParams: { temperature: 0 }, preparedCompaction, preparedContext: buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: [], dynamicBlocks: [], preparedCompaction }), capabilityRequest: {},routePass:{kind:'ordinary',candidateChain:[{provider:'test',account:null,model:'test-model'}]}, episodeContext: {} }, undefined, () => { appendFileSync(path, 'terminal'); }).then(() => appendFileSync(path, 'after'));
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
      return executedToolOutcome('none', toolSucceeded(null));
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
      routeUsableInputTokens: 80_000,
    promptTemplates: { render: () => { mark('prompt'); return 'rendered prompt'; } },
    restartCapability: { available: false },
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
  void submitThroughRest(runtimeApplication.analystRuntime.submit);
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
  void submitThroughRest(async () => publication());
}
