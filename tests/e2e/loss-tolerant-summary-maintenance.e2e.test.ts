import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InvocationService,
  MemoryCandidateAvailability,
  buildCandidateRequest,
  buildLlmOptions,
  selectLlmProtocolAdapter,
} from '../../src/agents/execution-api.js';
import {
  createInvocationServiceProvider,
  executeInternalSummaryTurn,
} from '../../src/application/invocation-service-provider.js';
import { createRuntimeApplication } from '../../src/application/runtime-composition.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { ModelRouter } from '../../src/agents/model-router.js';
import { bindRuntimeWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { CardService } from '../../src/cards/card-service.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { createTestConfigAuthority } from '../helpers/project-config.js';
import { TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import {
  segmentContext,
  foldConversation,
} from '../../src/application/read-models/agent-conversation-read-model.js';
import {
  ConversationLLMActor,
  type CompactorPort,
  type LlmTerminalHandoff,
} from '../../src/runtime/actors/llm-actor.js';
import {
  compact,
  shouldCompact,
  prepareCompaction,
  LOCAL_OMISSION_SUMMARY,
  type AutonomousCompactionPolicy,
} from '../../src/runtime/actors/compaction/compactor.js';
import type { SummarizerProviderPort } from '../../src/runtime/actors/compaction/summarizer.js';
import { buildPreparedInvocationContext } from '../../src/runtime/actors/context/context-blocks.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import type { PreparedLlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { RuntimeGate } from '../../src/runtime/runtime-gate.js';
import {
  appendConversationBatch,
  initializeConversation,
  readConversation,
  readCurrentConversationSegment,
  readHistoricalConversationSegment,
} from '../../src/persistence/conversation-file.js';
import { readProviderExchangeEntries } from '../../src/persistence/provider-exchange-log.js';
import {
  cardConversationVersionFile,
  cardHeadFile,
  cardRecordHeadFile,
} from '../../src/persistence/layout.js';
import { publishFreshFile } from '../../src/persistence/replace-file.js';
import { publishHeadFile } from '../../src/persistence/publish-head.js';
import {
  NO_FRESHNESS_EFFECTS,
  ProviderTurnFailure,
  LlmRequestError,
  PublicationOutcomeUnknownError,
} from '../../src/contracts/index.js';
import {
  agentMessageSchema,
  type AgentMessage,
  type ConversationSessionId,
} from '../../src/schemas/index.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import {
  invocationProviderRegistry,
  chatSuccess,
  contextExhausted,
} from '../helpers/invocation-provider-fixture.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY } from '../helpers/row-policy-fixtures.js';
import { publicationWitness } from '../helpers/segment-publication-io.js';

const PRIMARY = { provider: 'primary-test', account: null, model: 'primary' } as const;
const SUMMARY = { provider: 'summary-test', account: null, model: 'summary' } as const;
const INPUT_ID = '00000000-0000-4000-8000-000000000003';
const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function refusal(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 'cyber_policy',
        type: 'content_policy',
        message: 'synthetic summary/task refusal',
      },
    }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );
}

function row(session: ConversationSessionId, id: string, content: string): AgentMessage {
  return agentMessageSchema.parse({
    id,
    session_id: session,
    role: 'user',
    kind: 'text',
    content,
    context_policy: TEXT_ROW_POLICY,
    timestamp: '2026-10-10T00:00:00.000Z',
    round_id: `r-user-${'1'.repeat(32)}`,
    message_index: 1,
    block_index: 0,
  });
}

function marker(session: ConversationSessionId, ordinal: number): AgentMessage {
  const agentName = session.split(':')[1]!;
  const timestamp = '2026-10-10T00:00:00.000Z';
  return agentMessageSchema.parse({
    ...row(session, `activation-${ordinal}`, ''),
    role: 'system',
    kind: 'activity',
    context_policy: ACTIVITY_ROW_POLICY,
    content: JSON.stringify({
      event: 'activation_open',
      agent_name: agentName,
      ...(session.endsWith(':project') ? { card_id: 'project' } : {}),
      input_id: `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`,
      timestamp,
    }),
  });
}

function fixture(
  args: {
    owner?: 'card' | 'analyst' | 'oversight';
    prefix?: number;
    recent?: number;
    protected?: boolean;
    trigger?: number;
    capacity?: number;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'summary-maintenance-e2e-'));
  roots.push(root);
  initProjectTree(root);
  const session: ConversationSessionId =
    args.owner === 'analyst'
      ? 'agent:analyst:global'
      : args.owner === 'oversight'
        ? 'agent:oversight:global'
        : 'agent:planner:project';
  if (args.owner === 'oversight') initializeConversation(root, session);
  const policy: AutonomousCompactionPolicy = {
    context_utilization_fraction: 0.8,
    trigger_fraction: args.trigger ?? 0.3,
    tail_fraction: 0.25,
    snap: 'compact_straddler',
  };
  const capacity = args.capacity ?? 10_000;
  const registry = invocationProviderRegistry([PRIMARY, SUMMARY], {
    [PRIMARY.provider]: { contextWindowTokens: capacity, maxOutputTokens: 500 },
    [SUMMARY.provider]: { contextWindowTokens: 200_000, maxOutputTokens: 10_000 },
  });
  const freshness = {
    ...NO_FRESHNESS_EFFECTS,
    conversationChanged: jest.fn(),
    llmExchangeChanged: jest.fn(),
  };
  const service = new InvocationService({
    projectRoot: root,
    registry,
    freshness,
    candidateAvailability: new MemoryCandidateAvailability(),
  });
  const summaryProvider: SummarizerProviderPort = {
    candidate: SUMMARY,
    contextWindowTokens: 200_000,
    maxOutputTokens: 10_000,
    materializeImage: async () => {
      throw new Error('This fixture has no images');
    },
    serializeSummaryRequest(input) {
      const capabilities = registry.getEffectiveCapabilities(SUMMARY);
      const plan = buildCandidateRequest({
        candidate: SUMMARY,
        capabilities,
        adapter: selectLlmProtocolAdapter(capabilities.transportProtocol),
        systemPrompt: input.systemPrompt,
        providerConversation: input.providerConversation,
        options: buildLlmOptions(
          input.agentName,
          input.tools,
          input.terminalToolNames,
          { temperature: 0, max_tokens: 2_000 },
          undefined,
          input.inputId,
          { projectRoot: root, sessionId: input.sessionId },
        ),
      });
      return {
        serializedRequest: plan.request.serializedBody,
        requestSha256: plan.request.requestHash,
        estimatedInputTokens: plan.request.estimatedWireInputTokens,
        imageCount: plan.request.imageCount,
      };
    },
    completeTurn: (input, admission, signal) =>
      executeInternalSummaryTurn(service, input, signal, admission),
    projectProviderExchanges: (...values) => service.projectProviderExchanges(...values),
  };
  const prefix = row(session, 'old-narrative', 'P'.repeat(args.prefix ?? 20_000));
  const recent = row(session, 'recent-narrative', 'R'.repeat(args.recent ?? 4_000));
  const rows = args.protected
    ? [
        marker(session, 1),
        agentMessageSchema.parse({
          ...prefix,
          context_policy: { ...TEXT_ROW_POLICY, compactable: false },
        }),
        row(session, 'compactable-tiny', 'tiny'),
        marker(session, 3),
        row(session, 'current-tiny', 'tiny'),
      ]
    : [marker(session, 1), prefix, marker(session, 3), recent];
  appendConversationBatch({ projectRoot: root }, rows);
  const preparedCompaction = prepareCompaction(
    policy,
    'STATIC INSTRUCTIONS',
    [],
    Math.floor(capacity * 0.8) - 500,
    500,
  );
  const blocks = Object.freeze([
    {
      id: 'frozen-brief',
      role: 'system' as const,
      content: '{"brief":"COMPLETE FROZEN BRIEF"}',
      storage: 'activation_local' as const,
      replacement: { kind: 'retain' as const },
      audience: 'primary_and_summarizer' as const,
      evidence: { kind: 'none' as const },
    },
    {
      id: 'frozen-node',
      role: 'system' as const,
      content: 'ACTUAL FULL COMPILED NODE',
      storage: 'activation_local' as const,
      replacement: { kind: 'retain' as const },
      audience: 'primary_and_summarizer' as const,
      evidence: { kind: 'none' as const },
    },
  ]);
  const input: PreparedLlmInvocationInput = {
    inputId: INPUT_ID,
    agentId: session,
    agentName: session.split(':')[1]!,
    sessionId: session,
    systemPrompt: 'STATIC INSTRUCTIONS',
    providerConversation: providerConversationProjection(readConversation(root, session), blocks),
    tools: [],
    compiledToolContracts: [],
    terminalToolNames: [],
    modelParams: { temperature: 0 },
    preparedCompaction,
    preparedContext: buildPreparedInvocationContext({
      instructionText: 'STATIC INSTRUCTIONS',
      terminalToolNames: [],
      compiledTools: [],
      dynamicBlocks: blocks,
      preparedCompaction,
    }),
    capabilityRequest: { requiresTools: false },
    routePass: { kind: 'ordinary', candidateChain: [PRIMARY] },
    episodeContext: {},
  };
  const strategies: Array<{ strategy: string; refusal: { summaryInputId: string } | null }> = [];
  const completedFolds: number[] = [];
  const compactor: CompactorPort = {
    shouldCompact,
    compact: async (values) => {
      strategies.push({ strategy: values.strategy, refusal: values.summaryRefusal });
      return compact(values);
    },
  };
  const fatal = jest.fn((error: PublicationOutcomeUnknownError): never => {
    throw error;
  });
  const common = {
    agentId: session,
    provider: createInvocationServiceProvider(service, root),
    conversations: { projectRoot: root, changes: freshness },
    compactor,
    summarizerProvider: summaryProvider,
    fatalPort: { publicationOutcomeUnknown: fatal },
    runtimeProjectionChanged() {
      const progress = actor?.compactionProgress();
      if (progress) completedFolds.push(progress.foldsDone);
    },
  };
  const actor =
    args.owner && args.owner !== 'card'
      ? new ConversationLLMActor({ ...common, purpose: { kind: 'global-agent' } })
      : new ConversationLLMActor({
          ...common,
          purpose: { kind: 'autonomous-card', cardId: 'project' },
          gate: new RuntimeGate(),
        });
  const terminal = jest.fn<LlmTerminalHandoff>();
  const requests: Array<{ kind: 'summary' | 'primary'; body: string }> = [];
  const script = (
    respond: (kind: 'summary' | 'primary', ordinal: number) => Response | Promise<Response>,
  ) => {
    const counts = { summary: 0, primary: 0 };
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = String(init!.body);
      const kind = JSON.parse(body).model === SUMMARY.model ? 'summary' : 'primary';
      requests.push({ kind, body });
      return respond(kind, ++counts[kind]);
    });
    return counts;
  };
  return {
    root,
    session,
    input,
    actor,
    terminal,
    service,
    summaryProvider,
    compactor,
    strategies,
    completedFolds,
    fatal,
    freshness,
    requests,
    script,
  };
}

describe('loss-tolerant maintenance through production invocation and persistence', () => {
  it('actual AnalystRuntime settles no-candidate refusal and accepts a later explicit submission without immediate automatic retry', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'summary-maintenance-analyst-owner-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const config = effectiveSaivageConfigSchema.parse({
      ...structuredClone(TEST_SAIVAGE_CONFIG),
      providers: {
        test: {
          models: ['test-model'],
          capabilities: {
            transportProtocol: 'openai-chat-completions',
            toolsMode: 'native',
            exclusiveToolChoiceSupport: 'native',
            contextWindowTokens: 200_000,
            maxOutputTokens: 10_000,
          },
        },
        'summary-test': {
          models: ['summary'],
          apiKey: 'synthetic-test-key',
          baseUrl: 'https://summary.example.test',
          capabilities: {
            transportProtocol: 'openai-chat-completions',
            toolsMode: 'native',
            exclusiveToolChoiceSupport: 'native',
            contextWindowTokens: 200_000,
            maxOutputTokens: 10_000,
          },
        },
      },
      compaction: {
        ...TEST_SAIVAGE_CONFIG.compaction,
        trigger_fraction: 0.1,
        tail_fraction: 0,
        summarizer_candidate: SUMMARY,
      },
    });
    const registry = new ProviderRegistry(config);
    const workflows = bindRuntimeWorkflows(
      TEST_WORKFLOWS,
      new ModelRouter(registry),
      registry,
      config.compaction.context_utilization_fraction,
    );
    const processes = new ManagedProcessGroupRegistry();
    const session = 'agent:analyst:global' as const;
    appendConversationBatch({ projectRoot }, [
      marker(session, 1),
      agentMessageSchema.parse({
        ...row(
          session,
          'protected-operator-requirement',
          'EXACT PROTECTED REQUIREMENT '.repeat(800),
        ),
        context_policy: { ...TEXT_ROW_POLICY, compactable: false },
      }),
    ]);
    const sent: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const model = JSON.parse(String(init!.body)).model;
      sent.push(model);
      return refusal();
    });
    const app = createRuntimeApplication({
      projectRoot,
      processIdentity: { pid: 42, startedAt: '2026-10-10T00:00:00.000Z' },
      config,
      workflows,
      providerRegistry: registry,
      configAuthority: createTestConfigAuthority(projectRoot),
      cardStore: new CardService(projectRoot, workflows, NO_FRESHNESS_EFFECTS),
      freshness: NO_FRESHNESS_EFFECTS,
      processRunner: new ProcessRunner(projectRoot, processes, testApplicationFatalPort),
      runtimeProcessRootScope: processes.createContainerScope(processes.rootScope, 'runtime'),
      analystProcessRootScope: processes.createContainerScope(processes.rootScope, 'analyst'),
      mcpToolInvocation: unusedMcpToolInvocation,
      restartCapability: { available: false },
      fatalPort: testApplicationFatalPort,
      onOversightOwnerFailure(error) {
        throw error;
      },
      analystSessionId: session,
    });
    try {
      await app.analystRuntime.submit({ userContent: 'first benign submission' });
      expect(sent).toEqual(['summary']);
      expect(readCurrentConversationSegment(projectRoot, session)!.entry.version).toBe(1);
      await app.analystRuntime.submit({ userContent: 'later explicit benign submission' });
      expect(sent).toEqual(['summary', 'summary']);
      const evidence = readProviderExchangeEntries(projectRoot, session);
      expect(evidence).toHaveLength(2);
      expect(new Set(evidence.map((row) => row.data.source_input_id)).size).toBe(2);
      expect(evidence.every((row) => row.data.session_id.startsWith('internal:'))).toBe(true);
      expect(
        readConversation(projectRoot, session)
          .sourceRows.filter((row) => row.kind === 'text' && row.role === 'user')
          .map((row) => row.content),
      ).toEqual([
        'EXACT PROTECTED REQUIREMENT '.repeat(800),
        'first benign submission',
        'later explicit benign submission',
      ]);
    } finally {
      app.closeAnalystAdmission();
      await app.cleanupAnalystForApplicationStop();
    }
  });

  it.each(['card', 'analyst', 'oversight'] as const)(
    'real generic summary refusal publishes once and returns %s to ordinary primary admission',
    async (owner) => {
      const f = fixture({ owner });
      const source = readCurrentConversationSegment(f.root, f.session)!;
      const sourcePath =
        owner === 'card'
          ? cardConversationVersionFile(f.root, 'project', 'planner', source.entry.filename)
          : join(
              f.root,
              '.saivage',
              'agents',
              'conversations',
              owner,
              'versions',
              source.entry.filename,
            );
      const before = readFileSync(sourcePath);
      const configPath = join(f.root, '.saivage', 'saivage.yaml');
      writeFileSync(configPath, 'compaction:\n  enabled: true\n');
      const preserved = [
        cardHeadFile(f.root, 'project'),
        cardRecordHeadFile(f.root, 'project', { filename: 'brief.md' }),
        configPath,
      ];
      const preservedBytes = preserved.map((path) => readFileSync(path));
      const counts = f.script((kind) =>
        kind === 'summary' ? refusal() : chatSuccess('ordinary benign work continued'),
      );
      const result = await f.actor.turn(f.input, undefined, f.terminal);
      expect(result).toMatchObject({
        type: 'result',
        result: { content: 'ordinary benign work continued' },
      });
      expect(counts).toEqual({ summary: 1, primary: 1 });
      expect(f.terminal).toHaveBeenCalledTimes(1);
      const current = readCurrentConversationSegment(f.root, f.session)!;
      expect(current.entry.version).toBe(2);
      expect(current.index.format_version).toBe(7);
      expect(current.conversation.effectiveCompactedHistory!.summaryText).toBe(
        LOCAL_OMISSION_SUMMARY,
      );
      expect(
        current.conversation.effectiveRequiredModelFacts.latestContentPolicyRefusal,
      ).toBeNull();
      const context = segmentContext(current.genesis)!;
      expect(context.summary_text).toBe(LOCAL_OMISSION_SUMMARY);
      expect(context.source_version).toBe(1);
      expect(
        foldConversation(f.root, f.session).entries.some((row) =>
          row.content.includes('ordinary benign work continued'),
        ),
      ).toBe(true);
      const evidence = readProviderExchangeEntries(f.root, f.session);
      const summaries = evidence.filter((row) => row.data.session_id.startsWith('internal:'));
      const primary = evidence.filter((row) => row.data.session_id === f.session);
      expect(summaries).toHaveLength(1);
      expect(primary).toHaveLength(1);
      expect(summaries[0]!.data).toMatchObject({
        source_input_id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        payload: {
          status: 'error',
          error: {
            name: 'LlmRequestError',
            status: 400,
            message: expect.stringContaining('cyber_policy'),
          },
          terminal_conversation_output_id: null,
        },
      });
      expect(summaries[0]!.data.source_input_id).not.toBe(INPUT_ID);
      expect(f.completedFolds.every((count) => count === 0)).toBe(true);
      expect(f.requests.find((row) => row.kind === 'primary')!.body).toContain(
        LOCAL_OMISSION_SUMMARY,
      );
      expect(readFileSync(sourcePath)).toEqual(before);
      expect(readHistoricalConversationSegment(f.root, f.session, 1).rows).toEqual(source.rows);
      preserved.forEach((path, index) => expect(readFileSync(path)).toEqual(preservedBytes[index]));
    },
  );

  it.each(['card', 'analyst', 'oversight'] as const)(
    'unshrinkable %s refusal settles safely with no successor or primary attempt',
    async (owner) => {
      const f = fixture({ owner, protected: true, prefix: 12_000 });
      const counts = f.script(() => refusal());
      const outcome = await f.actor.turn(f.input, undefined, f.terminal);
      expect(outcome).toMatchObject(
        owner === 'card'
          ? {
              type: 'blocked',
              result: {
                kind: 'compaction-summary-blocked',
                session_id: f.session,
                summary_input_id: expect.any(String),
              },
            }
          : {
              type: 'error',
              error:
                'Internal conversation summarization was blocked by the provider after bounded recovery. No further automatic retry was attempted.',
            },
      );
      expect(counts).toEqual({ summary: 1, primary: 0 });
      expect(f.terminal).toHaveBeenCalledTimes(1);
      expect(f.actor.compactionProgress()).toBeNull();
      expect(readCurrentConversationSegment(f.root, f.session)!.entry.version).toBe(1);
      expect(readProviderExchangeEntries(f.root, f.session)).toHaveLength(1);
      expect(
        readConversation(f.root, f.session).sourceRows.filter(
          (row) => row.kind === 'model_issue' || row.kind === 'content_policy_refusal',
        ),
      ).toEqual([]);
      f.actor.suppressContinuation(new Error('test owner joins failed maintenance'));
      await expect(f.actor.join()).resolves.toEqual({ status: 'joined' });
    },
  );

  it.each([false, true])(
    'authoritative original primary failure is recorded exactly once (terminal=%s)',
    async (terminal) => {
      const f = fixture({
        trigger: 1,
        capacity: 80_000,
        ...(terminal ? { protected: true, prefix: 12_000 } : {}),
      });
      const counts = f.script((kind, ordinal) =>
        kind === 'summary'
          ? refusal()
          : ordinal === 1
            ? contextExhausted()
            : chatSuccess('authoritative recovery completed'),
      );
      const outcome = await f.actor.turn(f.input, undefined, f.terminal);
      expect(outcome).toMatchObject(
        terminal
          ? { type: 'blocked', result: { kind: 'compaction-summary-blocked' } }
          : { type: 'result', result: { content: 'authoritative recovery completed' } },
      );
      expect(counts).toEqual({ summary: 1, primary: terminal ? 1 : 2 });
      const evidence = readProviderExchangeEntries(f.root, f.session);
      const primary = evidence.filter((row) => row.data.session_id === f.session);
      expect(primary).toHaveLength(terminal ? 1 : 2);
      expect(primary.map((row) => row.data.attempt_index)).toEqual(terminal ? [0] : [0, 1]);
      expect(primary[0]!.data).toMatchObject({
        source_input_id: INPUT_ID,
        payload: {
          status: 'error',
          error: {
            name: 'LlmRequestError',
            status: 400,
            message: expect.stringContaining('context_length_exceeded'),
          },
          terminal_conversation_output_id: null,
        },
      });
      expect(evidence.filter((row) => row.data.session_id.startsWith('internal:'))).toHaveLength(1);
    },
  );

  it('successful preventive refusal disables summary calls during later authoritative maintenance in that same invocation', async () => {
    const f = fixture();
    const counts = f.script((kind, ordinal) =>
      kind === 'summary'
        ? refusal()
        : ordinal === 1
          ? contextExhausted()
          : chatSuccess('recovered after two local omissions'),
    );
    await expect(f.actor.turn(f.input, undefined, f.terminal)).resolves.toMatchObject({
      type: 'result',
    });
    expect(counts).toEqual({ summary: 1, primary: 2 });
    expect(f.strategies.map((row) => row.strategy)).toEqual([
      'preventive',
      'authoritative_context_recovery',
    ]);
    expect(f.strategies[0]!.refusal).toBeNull();
    expect(f.strategies[1]!.refusal).toEqual({
      summaryInputId: readProviderExchangeEntries(f.root, f.session).find((row) =>
        row.data.session_id.startsWith('internal:'),
      )!.data.source_input_id,
    });
    expect(readCurrentConversationSegment(f.root, f.session)!.entry.version).toBe(3);
  });

  it('primary refusal after successful omission retains its own sole pinned retry and permanent primary fact', async () => {
    const f = fixture();
    const counts = f.script(() => refusal());
    const outcome = await f.actor.turn(f.input, undefined, f.terminal);
    expect(outcome).toMatchObject({ type: 'blocked', result: { kind: 'content-policy-refusal' } });
    expect(counts).toEqual({ summary: 1, primary: 2 });
    expect(f.strategies.map((row) => row.strategy)).toEqual(['preventive']);
    const current = readConversation(f.root, f.session);
    const primaryMarkers = current.sourceRows.filter(
      (row) => row.kind === 'content_policy_refusal',
    );
    expect(primaryMarkers).toHaveLength(1);
    expect(JSON.parse(primaryMarkers[0]!.content).source_input_id).toBe(INPUT_ID);
    const evidence = readProviderExchangeEntries(f.root, f.session);
    expect(
      evidence
        .filter((row) => row.data.session_id === f.session)
        .map((row) => row.data.attempt_index),
    ).toEqual([0, 1]);
    expect(evidence.filter((row) => row.data.session_id.startsWith('internal:'))).toHaveLength(1);
  });

  it('retains a fully completed fitting summary above 12KB after a later refusal without cosmetic correction or partial coverage', async () => {
    const f = fixture({ prefix: 80_000, recent: 40_000, capacity: 25_000, trigger: 0.6 });
    const text = 'USEFUL FITTING SUMMARY '.repeat(650);
    expect(Buffer.byteLength(text.trim())).toBeGreaterThan(12_000);
    const counts = f.script((kind, ordinal) =>
      kind === 'primary'
        ? chatSuccess('continued with retained summary')
        : ordinal === 1
          ? chatSuccess(text)
          : refusal(),
    );
    await expect(f.actor.turn(f.input, undefined, f.terminal)).resolves.toMatchObject({
      type: 'result',
    });
    expect(counts).toEqual({ summary: 2, primary: 1 });
    const current = readCurrentConversationSegment(f.root, f.session)!;
    expect(current.conversation.effectiveCompactedHistory!.summaryText).toBe(text.trim());
    expect(current.entry.genesis).toMatchObject({ covered_through_message_id: 'activation-3' });
    expect(current.rows.some((row) => row.id === 'recent-narrative')).toBe(true);
    expect(Math.max(...f.completedFolds)).toBe(1);
    expect(
      f.requests
        .filter((row) => row.kind === 'summary')
        .every((row) => !row.body.includes('6000 UTF-8 bytes')),
    ).toBe(true);
  });

  it('misleading typed evidence-publication failure escapes real compactor catches without local fallback or actor safe-refusal settlement', async () => {
    const f = fixture();
    const counts = f.script(() => refusal());
    const misleading = new ProviderTurnFailure({
      failure_phase: 'provider_attempt',
      candidate: SUMMARY,
      provider_exchanges: [],
      originalFailure: new LlmRequestError({
        kind: 'content_policy',
        provider: SUMMARY.provider,
        message: 'misleading evidence error',
        providerResponse: '',
      }),
    });
    jest.spyOn(f.service, 'projectProviderExchanges').mockImplementation(() => {
      throw misleading;
    });
    await expect(f.actor.turn(f.input, undefined, f.terminal)).rejects.toMatchObject({
      name: 'SummaryEvidencePublicationError',
      cause: misleading,
    });
    expect(counts).toEqual({ summary: 1, primary: 0 });
    expect(readCurrentConversationSegment(f.root, f.session)!.entry.version).toBe(1);
    expect(f.terminal).not.toHaveBeenCalled();
  });

  it.each(['segment', 'index'] as const)(
    'local omission %s synchronization uncertainty is fatal before hints, terminal handoff or progress cleanup',
    async (owner) => {
      const f = fixture();
      const counts = f.script(() => refusal());
      const witness = publicationWitness('parent-fsync');
      const trace: string[] = [];
      f.compactor.compact = async (values) =>
        compact({
          ...values,
          publication: {
            io: {
              publishFreshFile: (path, bytes, temporary) => {
                trace.push('segment');
                publishFreshFile(
                  path,
                  bytes,
                  temporary,
                  owner === 'segment' ? witness.io : undefined,
                );
              },
              publishHeadFile: (path, previous, bytes, mode, temporary) => {
                trace.push('index');
                publishHeadFile(path, previous, bytes, mode, temporary, witness.io);
              },
            },
          },
        });
      let delivered!: (error: PublicationOutcomeUnknownError) => void;
      const fatalDelivery = new Promise<PublicationOutcomeUnknownError>((resolve) => {
        delivered = resolve;
      });
      f.fatal.mockImplementation((error): never => {
        delivered(error);
        throw error;
      });
      // A genuine nonreturning fatal port does not settle the public turn. Observe
      // fatal delivery, not an invented ordinary rejection/cleanup outcome.
      void f.actor.turn(f.input, undefined, f.terminal).catch(() => {});
      expect(await fatalDelivery).toBeInstanceOf(PublicationOutcomeUnknownError);
      expect(f.fatal).toHaveBeenCalled();
      expect(trace).toEqual(owner === 'segment' ? ['segment'] : ['segment', 'index']);
      expect(counts).toEqual({ summary: 1, primary: 0 });
      expect(f.terminal).not.toHaveBeenCalled();
      expect(f.actor.compactionProgress()).not.toBeNull();
      expect(f.freshness.conversationChanged).not.toHaveBeenCalled();
    },
  );
});
