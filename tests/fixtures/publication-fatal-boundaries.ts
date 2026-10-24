import { appendFileSync, closeSync, fstatSync, fsyncSync, mkdtempSync, openSync, renameSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';

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
import { createSupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import { NodeExecution as AgentNodeExecution } from '../../src/runtime/actors/node-execution.js';
import { ActivationOperationTracker, InvocationLifecycle } from '../../src/runtime/actors/invocation-lifecycle.js';
import { bootstrapContextSupplier } from '../../src/runtime/records/bootstrap-context.js';
import { RuntimeStoppedInterruption } from '../../src/runtime/actors/runtime-stopped-interruption.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import { createTestPromptTemplateRegistry } from '../helpers/prompt-template-registry.js';
import { testAutonomousCompaction } from '../helpers/llm-test-helpers.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { compileProjectWorkflows, bindRuntimeWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { ModelRouter } from '../../src/agents/model-router.js';
import { CardService as ProductionCardService } from '../../src/cards/card-service.js';
import { ExternalAnalystOperations } from '../../src/application/external-analyst-operations.js';

const mode = process.argv[2];
const path = process.argv[3];
const fatalPort = createApplicationFatalPort();
if (mode === 'external-analyst-publication' || mode === 'external-analyst-cleanup-publication') {
  if (!path) throw new Error('marker path required');
  const mark = (label: string) => appendFileSync(path, `${label}\n`);
  const processes=createTestProcessRunner(dirname(path));
  const tool=defineTool({name:'fatal',description:'Synthetic fatal fixture',resultPolicyTemplate:OPERATIONAL_RESULT_POLICY_TEMPLATE,inputSchema:z.object({}),
    executor:async()=>{
      mark('entered');
      if(mode==='external-analyst-cleanup-publication')await new Promise<never>(()=>{});
      throw new PublicationOutcomeUnknownError();
    }});
  const operations=new ExternalAnalystOperations({assertIngressAllowed() {},projectRoot:dirname(path),projectIdentityDigest:'a'.repeat(64),principal:'fixture',
    surface:{agentName:'analyst',tools:new Map([['fatal',tool]]),providers:[]},processRunner:processes.processRunner,
    directScope:processes.processRunner.createDirectScope(processes.registry.rootScope,'external:fixture','operator_session'),fatalPort,
    onOwnerFailure:()=>{mark('ordinary-failure');}});
  if(mode==='external-analyst-cleanup-publication') {
    processes.processRunner.closeAndTerminateDirectScope=async()=>{mark('uncertain-containment');throw new PublicationOutcomeUnknownError();};
    void operations.invoke('fatal',{});
    await operations.cleanupForApplicationStop();mark('followup');
  } else {
    try {await operations.invoke('fatal',{});mark('response');}
    finally {mark('cleanup');await operations.cleanupForApplicationStop();}
  }
}
if (mode === 'action-node-publication' || mode === 'card-hook-publication' || mode === 'stdout-artifact-publication' || mode === 'stdout-head-publication' || mode === 'stdout-short-read') {
  if (!path) throw new Error('marker path required');
  const root = dirname(path);
  const mark = (label: string) => appendFileSync(path, `${label}\n`);
  const config = effectiveSaivageConfigSchema.parse(structuredClone(TEST_SAIVAGE_CONFIG));
  const workflow = config.card_types.project!.workflow;
  workflow.entries.BACKLOG = { node: 'check' };
  workflow.entries.CHANGED = { node: 'check' };
  workflow.entries.BLOCKED = { node: 'plan' };
  workflow.entries.STOPPED = { ...workflow.entries.STOPPED, node: 'plan' };
  workflow.nodes = {
    plan: { ...workflow.nodes.plan!, initialize_records: [], records: {}, edges: { retry: { target: { node: 'check' } } } },
    check: { execution: { kind: 'action', action: 'acme.inspect', contract_version: 1, config: {}, inputs: {} }, records: {},
      edges: { finished: { target: { terminal: 'BLOCKED', promote: 'current', export_records: [] } } } },
  };
  const isHook = mode === 'card-hook-publication';
  const shortRead = mode === 'stdout-short-read';
  const isStdout = mode === 'stdout-artifact-publication' || mode === 'stdout-head-publication' || shortRead;
  if (isStdout) {
    workflow.nodes.check!.execution = { kind: 'action', action: 'shell.run', contract_version: 1,
      config: { script: 'printf "retained report"', timeout_ms: 1000, terminate_grace_ms: 50 }, inputs: { args: { literal: [] } } };
    workflow.nodes.check!.stdout_record = 'status.md';
    workflow.nodes.check!.records = { 'status.md': { mode: 'continue', gate: 'updated' } };
    workflow.nodes.check!.edges = Object.fromEntries(['passed', 'failed', 'signalled', 'timed_out'].map((outcome) =>
      [outcome, { target: { terminal: 'BLOCKED', promote: 'current', export_records: [] } }]));
  }
  if (isHook) {
    workflow.nodes.check!.execution = { kind: 'action', action: 'shell.run', contract_version: 1,
      config: { script: 'exit 0', timeout_ms: 1000, terminate_grace_ms: 50 }, inputs: { args: { literal: [] } } };
    workflow.nodes.check!.edges = Object.fromEntries(['passed', 'failed', 'signalled', 'timed_out'].map((outcome) =>
      [outcome, { target: { terminal: 'BLOCKED', promote: 'current', export_records: [] } }]));
    workflow.after_activation_commit = { statuses: ['blocked'], execution: { kind: 'action', action: 'acme.inspect', contract_version: 1, config: {}, inputs: {} } };
  }
  const compiled = compileProjectWorkflows(config, { operationPlugins: [{ namespace: 'acme', operations: { inspect: {
    id: 'acme.inspect', provider: { kind: 'plugin', name: 'acme' }, contractVersion: 1, bindings: [isHook ? 'after_activation_commit' : 'node'],
    config: z.object({}).strict(), inputs: {}, outcomes: { finished: {} }, retainFields: [],
    async run() {
      if (isHook) {
        processes.processRunner.closeAndTerminateDirectScope = async () => { mark('cleanup'); throw new Error('forbidden cleanup'); };
        ActivationOperationTracker.prototype.trackConsumer = async () => { mark('consumer'); throw new Error('forbidden acknowledgement'); };
      }
      mark('entered');
      if (isHook) publishFreshFile(join(root, 'hook-publication'), Buffer.from('known fixture effect'), undefined, {
        open: openSync, write: writeSync, fsync: fsyncSync, close: closeSync,
        rename(from, to) { renameSync(from, to); throw new Error('hook publication uncertain'); },
      });
      throw new PublicationOutcomeUnknownError();
    },
  } } }] });
  const registry = new ProviderRegistry(config);
  const workflows = bindRuntimeWorkflows(compiled, new ModelRouter(registry), registry, config.compaction.context_utilization_fraction, { internalAnalystEnabled: true });
  initProjectTree(root);
  const processes = createTestProcessRunner(root);
  processes.processRunner = new ProcessRunner(root, processes.registry, fatalPort);
  if (!isHook && !isStdout) {
    processes.processRunner.closeAndTerminateDirectScope = async () => { mark('cleanup'); throw new Error('forbidden cleanup'); };
    ActivationOperationTracker.prototype.trackConsumer = async () => { mark('consumer'); throw new Error('forbidden acknowledgement'); };
  }
  let publishing = false;
  const cards = new ProductionCardService(root, compiled, undefined, isStdout && !shortRead ? {
    open: openSync, write: writeSync, fsync: fsyncSync, close: closeSync,
    rename(from, to) {
      renameSync(from, to);
      if (publishing && (mode === 'stdout-head-publication' ? String(to).endsWith('/record-status.json') : !String(to).endsWith('/record-status.json'))) {
        mark('uncertain'); throw new Error('record publication uncertain');
      }
    },
  } : undefined);
  if (shortRead) {
    cards.acceptRecord('project', 'status.md', 'Prior accepted', { kind: 'agent', agent: 'analyst' });
    const prior = cards.readRecordCurrent('project', 'status.md');
    assert.equal(prior.kind, 'found');
    if (prior.kind !== 'found') throw new Error('Missing fixture card.');
    const before = prior.value.projection;
    let reads = 0;
    let sourceFd: number | undefined;
    let closed = false;
    cards.acceptRecord = () => { throw new Error('Short read must never publish a prefix.'); };
    const closeScope = processes.processRunner.closeAndTerminateDirectScope.bind(processes.processRunner);
    processes.processRunner.closeAndTerminateDirectScope = async (...args) => {
      const report = await closeScope(...args);
      const read = fs.readSync;
      const close = fs.closeSync;
      fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
        if (length !== 1024 * 1024 + 1) return read(fd, buffer, offset, length, position);
        assert.equal(++reads, 1);
        sourceFd = fd;
        const size = read(fd, buffer, offset, 3, position);
        assert.equal(size, 3); mark('short-read'); return size;
      }) as typeof fs.readSync;
      fs.closeSync = (fd) => {
        close(fd);
        if (fd === sourceFd) { closed = true; sourceFd = undefined; mark('closed'); }
      };
      syncBuiltinESMExports();
      return report;
    };
    const commit = cards.commitActivationOutcome.bind(cards);
    cards.commitActivationOutcome = (...args) => {
      assert.equal(reads, 1); assert.equal(closed, true);
      assert.equal(args[1].status, 'failed');
      assert.match(JSON.stringify(args[1]), /capture read is incomplete/u);
      const current = cards.readRecordCurrent('project', 'status.md');
      assert.equal(current.kind, 'found');
      if (current.kind !== 'found') throw new Error('Missing fixture card.');
      assert.deepEqual(current.value.projection, before);
      mark('preserved'); return commit(...args);
    };
  } else if (isStdout) {
    const accept = cards.acceptRecord.bind(cards);
    cards.acceptRecord = (...args) => {
      mark('publishing'); publishing = true;
      processes.processRunner.closeAndTerminateDirectScope = async () => { mark('cleanup'); throw new Error('forbidden cleanup'); };
      cards.commitActivationOutcome = () => { mark('ack'); throw new Error('forbidden acknowledgement'); };
      const result = accept(...args); mark('accepted'); return result;
    };
  }
  const supervisor = createSupervisorRuntimeApi({ ...testAutonomousCompaction, workflows, fatalPort,
    runtimeGate: new RuntimeGate(), projectRoot: root, actorStore: cards,
    provider: scriptedAdmissionProvider(async () => { mark('provider'); throw new Error('forbidden provider'); }),
    conversations: { projectRoot: root }, freshness: { runtimeChanged() {}, agentMembershipChanged() {} },
    processRunner: processes.processRunner, runtimeProcessRootScope: processes.runtimeProcessRootScope,
    promptTemplates: createTestPromptTemplateRegistry(),
  });
  await supervisor.start();
  await supervisor.startProject();
}
async function submitThroughRest(submit: (input: { userContent: string }) => Promise<unknown>): Promise<void> {
  const app = await createFastifyApp({ nodeEnv: 'test', server: { logLevel: 'silent' } } as Environment, fatalPort);
  const runtime = new ContractRuntime({ fatalPort, authPolicy: new AuthPolicy({}), eventLogger: {} as never });
  runtime.mount(app, chatOperatorApiContracts, buildChatOperatorContractHandlers({
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

if (mode === 'llm-bootstrap-preparation') {
  if (!path) throw new Error('marker path required');
  const root = dirname(path);
  initProjectTree(root);
  const store = new CardService(root);
  const mark = (label: string) => appendFileSync(path, `${label}\n`);
  const supplier = bootstrapContextSupplier(store, store.read('project')!, { nodeId: 'plan', recordPrompts: [] });
  const read = store.readRecordCurrent.bind(store);
  store.readRecordCurrent = (...args) => { mark('record-read'); return read(...args); };
  const check = InvocationLifecycle.prototype.assertCurrent;
  InvocationLifecycle.prototype.assertCurrent = function (lease) { mark('lease-check'); return check.call(this, lease); };
  const actor = new ConversationLLMActor({
    purpose: { kind: 'autonomous-card', cardId: 'project' }, gate: new RuntimeGate(),
    agentId: 'agent:planner:project', fatalPort,
    conversations: { projectRoot: root, changes: {
      // Inject the uncertainty sentinel at the actual preparation append surface.
      // Bytes have been published in this synthetic fault; production must not inspect them.
      conversationChanged() { mark('preparation-publication'); throw new PublicationOutcomeUnknownError(); },
      agentMembershipChanged() { mark('membership'); },
    } },
    provider: {
      ...scriptedAdmissionProvider(async () => { mark('provider'); throw new Error('Unexpected provider.'); }),
      async preparePrimaryRequestAdmission() { mark('admission'); throw new Error('Unexpected admission.'); },
    },
    compactor: {
      shouldCompact() { mark('compaction-check'); return false; },
      async compact() { mark('compaction'); throw new Error('Unexpected compaction.'); },
    },
    summarizerProvider: unusedSummarizerProvider,
  });
  const preparedCompaction = prepareCompaction(testCompactionPolicy, 'system', [], 8_000, 2_000);
  void actor.turn({
    inputId: '00000000-0000-4000-8000-000000000001', agentId: 'agent:planner:project', agentName: 'planner',
    sessionId: 'agent:planner:project', systemPrompt: 'system', providerConversation: { sourceSessionId: 'agent:planner:project', messages: [] },
    tools: [], compiledToolContracts: [], terminalToolNames: [], modelParams: { temperature: 0 },
    preparedCompaction, preparedContext: buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: [], stableBlocks: [], preparedCompaction }),
    capabilityRequest: {}, routePass: { kind: 'ordinary', candidateChain: [{ provider: 'test', account: null, model: 'test-model' }] },
  }, undefined, () => mark('terminal'), (args) => { mark('supplier'); return supplier(args); })
    .then(() => mark('after'), () => mark('rejected'));
}

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
        { id: `activation-${ordinal}`, session_id: sessionId, role: 'system', kind: 'activity', context_policy: ACTIVITY_ROW_POLICY, content: JSON.stringify({ event: 'activation_open', instructions: { kind: 'unavailable', reason: 'not_recorded' }, agent_name: 'planner', card_id: 'project', input_id: `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`, timestamp }), round_id: `r-pre-${String(ordinal).padStart(32, '0')}`, message_index: 0, block_index: 0, timestamp },
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
   void actor.turn({ inputId: '00000000-0000-4000-8000-000000000001', agentId: 'agent:planner:project', agentName: 'planner', sessionId: 'agent:planner:project', systemPrompt: 'system', providerConversation: actualPublication ? providerConversationProjection(readConversation(root, sessionId), []) : { sourceSessionId: 'agent:planner:project', messages: [] }, tools: [], compiledToolContracts: [], terminalToolNames: [], modelParams: { temperature: 0 }, preparedCompaction, preparedContext: buildPreparedInvocationContext({ instructionText: 'system', terminalToolNames: [], compiledTools: [], stableBlocks: [], preparedCompaction }), capabilityRequest: {},routePass:{kind:'ordinary',candidateChain:[{provider:'test',account:null,model:'test-model'}]} }, undefined, () => { appendFileSync(path, 'terminal'); }).then(() => appendFileSync(path, 'after'));
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
