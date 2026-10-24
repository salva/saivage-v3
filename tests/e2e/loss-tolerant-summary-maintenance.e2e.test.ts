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
  type InvocationRequest,
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
import { AgentOperatorReadModelService } from '../../src/application/read-models/agent-operator-read-model.js';
import { unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import {
  segmentContext,
  foldConversation,
  foldHistoricalConversationRows,
  ConversationSegmentChangedError,
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
import { estimateMessageTokens } from '../../src/runtime/actors/compaction/round-classifier.js';
import type { SummarizerProviderPort } from '../../src/runtime/actors/compaction/summarizer.js';
import { buildPreparedInvocationContext } from '../../src/runtime/actors/context/context-blocks.js';
import {
  appendActivationMarker,
  buildUserContextMessage,
  providerConversationProjection,
} from '../../src/runtime/actors/conversation-session.js';
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
  type CandidateRequestPlan,
  type LlmCompleteOptions,
} from '../../src/contracts/index.js';
import {
  agentMessageSchema,
  parseActivationOpenPayload,
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
import { executingLlmSnapshots } from '../helpers/executing-llm-snapshot.js';

const PRIMARY = { provider: 'primary-test', account: null, model: 'primary' } as const;
const SUMMARY = { provider: 'summary-test', account: null, model: 'summary' } as const;
const INPUT_ID = '00000000-0000-4000-8000-000000000003';
const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
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

function assertDecorationNeutralRequest(
  request: InvocationRequest,
  plan: CandidateRequestPlan,
  options: LlmCompleteOptions,
): void {
  const projection = request.providerConversation;
  const baseline = buildCandidateRequest({
    candidate: plan.candidate,
    capabilities: plan.capabilities,
    adapter: plan.adapter,
    systemPrompt: request.systemPrompt,
    providerConversation:
      projection.sourceSessionId === null
        ? projection
        : {
            sourceSessionId: projection.sourceSessionId,
            messages: projection.messages.map((message) => {
              if (message.kind === 'synthetic_context') return message;
              const { instruction_origin: _origin, ...ordinary } = message;
              expect(estimateMessageTokens(message)).toBe(estimateMessageTokens(ordinary));
              return ordinary;
            }),
          },
    options,
  });
  expect(plan.request.serializedBody).toBe(baseline.request.serializedBody);
  expect(plan.request.requestHash).toBe(baseline.request.requestHash);
  expect(plan.request.estimatedWireInputTokens).toBe(baseline.request.estimatedWireInputTokens);
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
      instructions: { kind: 'unavailable', reason: 'not_recorded' },
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
    instructionEvidence?: boolean;
    recentContent?: string;
    roleText?: string;
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
  const candidateAvailability = new MemoryCandidateAvailability();
  const service = new InvocationService({
    projectRoot: root,
    registry,
    freshness,
    candidateAvailability,
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
  const recent = row(
    session,
    'recent-narrative',
    args.recentContent ?? 'R'.repeat(args.recent ?? 4_000),
  );
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
  if (args.instructionEvidence) {
    if (session !== 'agent:planner:project')
      throw new Error('Instruction-evidence fixture is card-owned.');
    for (const [ordinal, content] of [
      [1, prefix.content],
      [3, recent.content],
    ] as const) {
      const inputId = `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
      appendActivationMarker({ projectRoot: root }, session, {
        event: 'activation_open',
        agent_name: 'planner',
        card_id: 'project',
        input_id: inputId,
        instructions: {
          kind: 'prepared',
          activation_id: inputId,
          caller: { kind: 'root' },
          card: { cardId: 'project', cardType: 'project', title: 'Synthetic project' },
          parent_direction: null,
          role_text:
            ordinal === 1
              ? 'HISTORICAL-ROLE-EVIDENCE-ONLY'
              : (args.roleText ?? 'STATIC INSTRUCTIONS'),
          node: {
            node_id: ordinal === 1 ? 'prior' : 'work',
            text: ordinal === 1 ? 'HISTORICAL-NODE-EVIDENCE-ONLY' : 'ACTUAL FULL COMPILED NODE',
          },
        },
      });
      appendConversationBatch({ projectRoot: root }, [
        buildUserContextMessage(session, inputId, 'process_transition', 0, {
          role: 'user',
          content,
          instruction_origin: 'workflow_prompt',
        }),
      ]);
    }
  } else appendConversationBatch({ projectRoot: root }, rows);
  const preparedCompaction = prepareCompaction(
    policy,
    args.roleText ?? 'STATIC INSTRUCTIONS',
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
    systemPrompt: args.roleText ?? 'STATIC INSTRUCTIONS',
    providerConversation: providerConversationProjection(readConversation(root, session), blocks),
    tools: [],
    compiledToolContracts: [],
    terminalToolNames: [],
    modelParams: { temperature: 0 },
    preparedCompaction,
    preparedContext: buildPreparedInvocationContext({
      instructionText: args.roleText ?? 'STATIC INSTRUCTIONS',
      terminalToolNames: [],
      compiledTools: [],
      stableBlocks: blocks,
      preparedCompaction,
    }),
    capabilityRequest: { requiresTools: false },
    routePass: { kind: 'ordinary', candidateChain: [PRIMARY] },
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
    candidateAvailability,
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
  it('keeps prepared ingress evidence when real exact admission rejects oversized static instructions before transport', async () => {
    const f = fixture({
      instructionEvidence: true,
      prefix: 100,
      recent: 100,
      roleText: '\\'.repeat(16_000),
      trigger: 0.99,
    });
    const before = readHistoricalConversationSegment(f.root, f.session, 1).rows;
    const counts = f.script((kind) => {
      if (kind === 'primary')
        throw new Error('Exact admission must reject before primary transport.');
      return chatSuccess('small summary');
    });
    const frozen = structuredClone(f.input.preparedContext);
    await expect(f.actor.turn(f.input, undefined, f.terminal)).rejects.toMatchObject({
      name: 'LocalExactAdmissionError',
      source: 'primary_local',
    });
    expect(counts.primary).toBe(0);
    expect(f.input.preparedContext).toEqual(frozen);
    expect(readHistoricalConversationSegment(f.root, f.session, 1).rows).toEqual(before);
    const marker = before.filter((row) => row.kind === 'activity').at(-1)!;
    expect(
      parseActivationOpenPayload(marker.content, f.session, marker.timestamp)?.instructions,
    ).toEqual({
      kind: 'prepared',
      activation_id: '00000000-0000-4000-8000-000000000003', caller: { kind: 'root' },
      card: { cardId: 'project', cardType: 'project', title: 'Synthetic project' }, parent_direction: null,
      role_text: f.input.systemPrompt,
      node: { node_id: 'work', text: f.input.preparedContext.stableBlocks[1]!.content },
    });
    expect(
      readProviderExchangeEntries(f.root, f.session).filter(
        (row) => row.data.session_id === f.session,
      ),
    ).toEqual([]);
  });
  it.each([
    'provider_error',
    'pinned_refusal_retry',
    'routing_unavailable',
    'summary_then_provider_error',
  ] as const)(
    'retains source prepared evidence and frozen context through %s without claiming primary success',
    async (scenario) => {
      const f = fixture({
        instructionEvidence: true,
        ...(scenario === 'summary_then_provider_error'
          ? { prefix: 1_000, recent: 24_000 }
          : { prefix: 100, recent: 100, trigger: 0.99 }),
      });
      const source = readHistoricalConversationSegment(f.root, f.session, 1);
      const originalMarkers = source.rows.filter(
        (row) =>
          row.kind === 'activity' &&
          parseActivationOpenPayload(row.content, row.session_id, row.timestamp),
      );
      const frozen = structuredClone(f.input.preparedContext);
      if (scenario === 'routing_unavailable')
        f.candidateAvailability.markFailed(PRIMARY, {
          state: 'BLOCKED_UNTIL',
          untilMs: Date.now() + 60_000,
          reason: 'synthetic route unavailable',
        });
      const originalAdmission = f.service.preparePrimaryRequestAdmission.bind(f.service);
      jest.spyOn(f.service, 'preparePrimaryRequestAdmission').mockImplementation((request) => {
        const admission = originalAdmission(request);
        if (admission.kind === 'admitted')
          for (const candidate of admission.candidates)
            if (candidate.kind === 'admitted')
              assertDecorationNeutralRequest(request, candidate.plan, admission.execution.options);
        return admission;
      });
      const originalPinned = f.service.preflightPinnedContentPolicyRequest.bind(f.service);
      const pinnedAdmission = jest
        .spyOn(f.service, 'preflightPinnedContentPolicyRequest')
        .mockImplementation((request) => {
          const admission = originalPinned(request);
          if (admission.kind === 'admitted')
            assertDecorationNeutralRequest(request, admission.plan, admission.options);
          return admission;
        });
      const counts = f.script((kind) =>
        kind === 'summary'
          ? chatSuccess('SUMMARY-WITHOUT-PRIMARY-SUCCESS')
          : scenario === 'pinned_refusal_retry'
            ? refusal()
            : new Response(
                JSON.stringify({
                  error: {
                    code: 'invalid_request_error',
                    type: 'invalid_request_error',
                    message: 'synthetic provider rejected this request',
                  },
                }),
                { status: 400, headers: { 'content-type': 'application/json' } },
              ),
      );
      if (scenario === 'pinned_refusal_retry') {
        await expect(f.actor.turn(f.input, undefined, f.terminal)).resolves.toMatchObject({
          type: 'blocked',
          result: { kind: 'content-policy-refusal' },
        });
        expect(counts).toEqual({ summary: 0, primary: 2 });
        expect(pinnedAdmission).toHaveBeenCalledTimes(1);
      } else if (scenario === 'provider_error' || scenario === 'summary_then_provider_error') {
        await expect(f.actor.turn(f.input, undefined, f.terminal)).resolves.toMatchObject({
          type: 'error',
          error: expect.stringContaining('synthetic provider rejected this request'),
        });
        expect(counts).toEqual({
          summary: scenario === 'summary_then_provider_error' ? 2 : 0,
          primary: 1,
        });
        expect(pinnedAdmission).not.toHaveBeenCalled();
      } else {
        await expect(f.actor.turn(f.input, undefined, f.terminal)).resolves.toMatchObject({
          type: 'error',
        });
        expect(counts).toEqual({ summary: 0, primary: 0 });
        expect(pinnedAdmission).not.toHaveBeenCalled();
      }
      expect(f.input.preparedContext).toEqual(frozen);
      const retained = readHistoricalConversationSegment(f.root, f.session, 1).rows.filter(
        (row) =>
          row.kind === 'activity' &&
          parseActivationOpenPayload(row.content, row.session_id, row.timestamp),
      );
      expect(retained).toEqual(originalMarkers);
      expect(
        parseActivationOpenPayload(retained[1]!.content, f.session, retained[1]!.timestamp)
          ?.instructions,
      ).toEqual({
        kind: 'prepared',
        activation_id: '00000000-0000-4000-8000-000000000003', caller: { kind: 'root' },
        card: { cardId: 'project', cardType: 'project', title: 'Synthetic project' }, parent_direction: null,
        role_text: f.input.preparedContext.prefix.instructionText,
        node: { node_id: 'work', text: f.input.preparedContext.stableBlocks[1]!.content },
      });
      for (const { body, kind } of f.requests) {
        const messages = JSON.parse(body).messages as Array<{ content: string }>;
        if (kind === 'primary') {
          expect(
            messages.filter((message) => message.content === f.input.systemPrompt),
          ).toHaveLength(1);
          expect(
            messages.filter(
              (message) => message.content === f.input.preparedContext.stableBlocks[1]!.content,
            ),
          ).toHaveLength(1);
        }
        for (const excluded of [
          'activation_open',
          'instruction_origin',
          'HISTORICAL-ROLE-EVIDENCE-ONLY',
          'HISTORICAL-NODE-EVIDENCE-ONLY',
          'Prepared instructions',
          'Recorded workflow instruction',
        ])
          expect(body).not.toContain(excluded);
      }
      const allExchanges = readProviderExchangeEntries(f.root, f.session);
      const exchanges = allExchanges.filter((row) => row.data.session_id === f.session);
      expect(exchanges.map((row) => row.data.attempt_index)).toEqual(
        scenario === 'pinned_refusal_retry'
          ? [0, 1]
          : scenario === 'routing_unavailable'
            ? []
            : [0],
      );
      expect(
        exchanges.every(
          (row) => row.data.session_id === f.session && row.data.source_input_id === INPUT_ID,
        ),
      ).toBe(true);
      expect(exchanges.every((row) => row.data.payload.status === 'error')).toBe(true);
      const summaries = allExchanges.filter((row) =>
        row.data.session_id.startsWith('internal:compaction-summary:'),
      );
      expect(summaries).toHaveLength(scenario === 'summary_then_provider_error' ? 2 : 0);
      expect(summaries.every((row) => row.data.payload.status === 'ok')).toBe(true);
    },
  );
  it.each(['preventive', 'local_exact_admission'] as const)(
    'covers the source activation before any primary request through %s without exporting evidence as context',
    async (strategy) => {
      const f = fixture({
        instructionEvidence: true,
        prefix: 1_000,
        recent: 24_000,
        ...(strategy === 'local_exact_admission'
          ? { trigger: 0.99, recentContent: '\\'.repeat(16_000) }
          : {}),
      });
      expect(shouldCompact(f.input)).toBe(strategy === 'preventive');
      const before = foldConversation(f.root, f.session);
      const publicReader = new AgentOperatorReadModelService(
        f.root,
        TEST_WORKFLOWS,
        () => new Map(),
      );
      const beforeApi = publicReader.getConversation(f.session);
      const markerRows = before.entries.filter(
        (row) =>
          row.kind === 'activity' &&
          parseActivationOpenPayload(row.content, row.session_id, row.timestamp),
      );
      expect(markerRows).toHaveLength(2);
      expect(markerRows.map((row) => estimateMessageTokens(agentMessageSchema.parse(row)))).toEqual([0, 0]);
      const sourceMarker = markerRows[1]!;
      const sourceInstructions = parseActivationOpenPayload(
        sourceMarker.content,
        f.session,
        sourceMarker.timestamp,
      )!.instructions;
      const prompt = before.entries.at(-1)!;
      expect(prompt.instruction_origin).toBe('workflow_prompt');
      const tail = foldConversation(f.root, f.session, { lastN: 1 });
      expect(tail.entries).toEqual([prompt]);
      const overviewTail = publicReader.readCurrentSegmentTail(f.session, 1);
      expect(overviewTail.kind).toBe('populated');
      if (overviewTail.kind !== 'populated') throw new Error('Missing overview tail.');
      expect(overviewTail.conversation.entries).toEqual([prompt]);
      const incremental = foldConversation(f.root, f.session, {
        segmentId: before.segmentId,
        segmentVersion: before.segmentVersion,
        since: sourceMarker.id,
      });
      expect(incremental.entries).toEqual([prompt]);
      const frozen = structuredClone(f.input.preparedContext);
      const admittedBodies: string[] = [];
      const originalAdmission = f.service.preparePrimaryRequestAdmission.bind(f.service);
      jest.spyOn(f.service, 'preparePrimaryRequestAdmission').mockImplementation((request) => {
        const admission = originalAdmission(request);
        if (admission.kind === 'admitted')
          for (const candidate of admission.candidates) {
            if (candidate.kind !== 'admitted') continue;
            assertDecorationNeutralRequest(request, candidate.plan, admission.execution.options);
            if (candidate.plan.candidate.model === PRIMARY.model)
              admittedBodies.push(candidate.plan.request.serializedBody);
          }
        return admission;
      });
      const counts = f.script((kind) => {
        if (kind === 'primary') {
          const current = readCurrentConversationSegment(f.root, f.session)!;
          expect(current.entry.version).toBeGreaterThan(1);
          expect(current.genesis.kind).toBe('compacted_segment_genesis');
          if (current.genesis.kind === 'compacted_segment_genesis')
            expect(current.genesis.source.covered_through_message_id).toBe(prompt.id);
        }
        return chatSuccess(kind === 'summary' ? 'SUMMARY-SENTINEL' : 'primary complete');
      });
      await expect(f.actor.turn(f.input, undefined, f.terminal)).resolves.toMatchObject({
        type: 'result',
      });
      expect(counts).toEqual({ summary: 2, primary: 1 });
      expect(f.strategies.map((value) => value.strategy)).toEqual([strategy]);
      expect(f.input.preparedContext).toEqual(frozen);
      expect(f.input.preparedContext.prefix.instructionText).toBe(f.input.systemPrompt);
      const primary = f.requests.find((request) => request.kind === 'primary')!.body;
      expect(admittedBodies).toContain(primary);
      const body = JSON.parse(primary);
      expect(
        body.messages.filter(
          (message: { content: string }) => message.content === 'STATIC INSTRUCTIONS',
        ),
      ).toHaveLength(1);
      expect(
        body.messages.filter(
          (message: { content: string }) => message.content === 'ACTUAL FULL COMPILED NODE',
        ),
      ).toHaveLength(1);
      for (const request of f.requests)
        for (const excluded of [
          'HISTORICAL-ROLE-EVIDENCE-ONLY',
          'HISTORICAL-NODE-EVIDENCE-ONLY',
          'instruction_origin',
          'activation_open',
          'Prepared instructions',
          'Recorded workflow instruction',
        ])
          expect(request.body).not.toContain(excluded);
      const history = readHistoricalConversationSegment(f.root, f.session, 1);
      expect(
        JSON.parse(
          foldHistoricalConversationRows(history.rows).find((row) => row.id === sourceMarker.id)!
            .content,
        ).instructions,
      ).toEqual(sourceInstructions);
      expect(
        foldHistoricalConversationRows(history.rows).find((row) => row.id === prompt.id)
          ?.instruction_origin,
      ).toBe('workflow_prompt');
      expect(() =>
        foldConversation(f.root, f.session, {
          segmentId: before.segmentId,
          segmentVersion: before.segmentVersion,
          since: prompt.id,
        }),
      ).toThrow(ConversationSegmentChangedError);
      expect(() =>
        publicReader.getConversation(f.session, {
          segment_id: beforeApi.segment_id,
          segment_version: beforeApi.segment_version,
          since: prompt.id,
        }),
      ).toThrow(ConversationSegmentChangedError);
      const replacement = publicReader.getConversation(f.session);
      expect(replacement.segment_id).not.toBe(beforeApi.segment_id);
      expect(
        replacement.entries.some((row) => row.id === sourceMarker.id || row.id === prompt.id),
      ).toBe(false);
      const historicalApi = publicReader.getConversationVersion(f.session, 1);
      expect(
        JSON.parse(historicalApi.entries.find((row) => row.id === sourceMarker.id)!.content)
          .instructions,
      ).toEqual(sourceInstructions);
      expect(historicalApi.entries.find((row) => row.id === prompt.id)?.instruction_origin).toBe(
        'workflow_prompt',
      );
      expect(
        foldConversation(f.root, f.session).entries.some((row) => row.id === sourceMarker.id),
      ).toBe(false);
    },
  );
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
      config.compaction.context_utilization_fraction, { internalAnalystEnabled: true },
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
    const app = createRuntimeApplication({ assertWorkGcEntryIdle() {}, assertWorkGcReady() {}, analystStartup: { mode: 'internal' }, externalProjectIdentityDigest: null, onExternalAnalystOwnerFailure(error) { throw error; },
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
      expect(current.index.format_version).toBe(12);
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

  it.each(['success', 'refusal', 'auth', 'protocol', 'finite'] as const)(
    'real summary composition exceeds 64 overload wires then %s without false fold progress or omission authority',
    async (outcome) => {
      jest.useFakeTimers();
      const f = fixture({ trigger: 1, capacity: 80_000 });
      const counts = f.script((kind, ordinal) => {
        if (kind === 'primary')
          return ordinal === 1 ? contextExhausted() : chatSuccess('continued');
        if (ordinal <= 65)
          return new Response(JSON.stringify({ error: { code: 'server_is_overloaded' } }), {
            status: 503,
          });
        if (outcome === 'success') return chatSuccess('small useful summary');
        if (outcome === 'refusal') return refusal();
        return new Response(JSON.stringify({ error: { message: 'terminal synthetic failure' } }), {
          status: outcome === 'auth' ? 401 : outcome === 'finite' ? 500 : 400,
        });
      });
      const pending = f.actor.turn(f.input, undefined, f.terminal).catch((error) => error);
      await jest.advanceTimersByTimeAsync(1);
      expect(counts).toEqual({ summary: 1, primary: 1 });
      expect(f.actor.compactionProgress()).toMatchObject({ foldsDone: 0, foldInFlight: true });
      const readModel = new AgentOperatorReadModelService(f.root, TEST_WORKFLOWS, () =>
        executingLlmSnapshots([f.session], f.actor.compactionProgress()),
      );
      expect(readModel.getSession(f.session).session).toMatchObject({
        status: 'active',
        activity: 'busy',
        compaction: { folds_done: 0, fold_in_flight: true },
      });
      expect(f.completedFolds.every((folds) => folds === 0)).toBe(true);
      expect(f.terminal).not.toHaveBeenCalled();
      expect(readProviderExchangeEntries(f.root, f.session)).toHaveLength(0);
      expect(
        readConversation(f.root, f.session).sourceRows.filter((row) => row.kind === 'model_issue'),
      ).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(930_000 + 60 * 600_000 + 180_000);
      const result = await pending;
      const eligible = outcome === 'success' || outcome === 'refusal';
      if (eligible) expect(result.type).toBe('result');
      else
        expect(result).toMatchObject({
          name: 'LastChanceSummaryProviderUnavailableError',
          cause: expect.any(ProviderTurnFailure),
        });
      expect(counts).toEqual({ summary: 66, primary: eligible ? 2 : 1 });
      const summaries = f.requests.filter((request) => request.kind === 'summary');
      expect(new Set(summaries.map((request) => request.body)).size).toBe(1);
      const evidence = readProviderExchangeEntries(f.root, f.session);
      const summaryEvidence = evidence.filter((entry) =>
        entry.data.session_id.startsWith('internal:'),
      );
      expect(summaryEvidence).toHaveLength(counts.summary);
      expect(new Set(summaryEvidence.map((entry) => entry.data.source_input_id)).size).toBe(1);
      expect(summaryEvidence.map((entry) => entry.data.attempt_index)).toEqual(
        Array.from({ length: counts.summary }, (_, i) => i),
      );
      expect(evidence.filter((entry) => entry.data.session_id === f.session)).toHaveLength(
        counts.primary,
      );
      expect(Math.max(...f.completedFolds)).toBe(outcome === 'success' ? 1 : 0);
      const current = readCurrentConversationSegment(f.root, f.session)!;
      expect(current.entry.version).toBe(eligible ? 2 : 1);
      if (outcome === 'refusal')
        expect(current.conversation.effectiveCompactedHistory!.summaryText).toContain(
          LOCAL_OMISSION_SUMMARY,
        );
      expect(jest.getTimerCount()).toBe(0);
    },
  );

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

  it.each([0, 65])(
    'retains a fully completed fitting summary above 12KB after a later refusal without cosmetic correction or partial coverage (overload wires=%s)',
    async (overloadWires) => {
      jest.useFakeTimers();
      const f = fixture({ prefix: 80_000, recent: 40_000, capacity: 25_000, trigger: 0.6 });
      const text = 'USEFUL FITTING SUMMARY '.repeat(650);
      expect(Buffer.byteLength(text.trim())).toBeGreaterThan(12_000);
      const counts = f.script((kind, ordinal) =>
        kind === 'primary'
          ? chatSuccess('continued with retained summary')
          : ordinal <= overloadWires
            ? new Response(JSON.stringify({ error: { code: 'overloaded' } }), { status: 503 })
            : ordinal === overloadWires + 1
              ? chatSuccess(text)
              : refusal(),
      );
      const pending = f.actor.turn(f.input, undefined, f.terminal);
      await jest.advanceTimersByTimeAsync(overloadWires ? 930_000 + 60 * 600_000 : 0);
      await expect(pending).resolves.toMatchObject({
        type: 'result',
      });
      expect(counts).toEqual({ summary: overloadWires + 2, primary: 1 });
      expect(
        new Set(
          f.requests
            .filter((request) => request.kind === 'summary')
            .slice(0, overloadWires + 1)
            .map((request) => request.body),
        ).size,
      ).toBe(1);
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
    },
  );

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

  it('summary publication uncertainty after actual overload escapes unchanged before fallback or progress cleanup', async () => {
    jest.useFakeTimers();
    const f = fixture();
    const counts = f.script((_kind, ordinal) =>
      ordinal === 1
        ? new Response(JSON.stringify({ error: { code: 'overloaded' } }), { status: 503 })
        : refusal(),
    );
    const uncertainty = new PublicationOutcomeUnknownError(
      new Error('summary evidence publication'),
    );
    const publish = jest.spyOn(f.service, 'projectProviderExchanges').mockImplementation(() => {
      throw uncertainty;
    });
    let settled = false;
    void f.actor.turn(f.input, undefined, f.terminal).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await jest.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);
    expect(f.fatal).toHaveBeenCalledWith(uncertainty);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(counts).toEqual({ summary: 2, primary: 0 });
    expect(f.actor.compactionProgress()).toMatchObject({ foldsDone: 0, foldInFlight: true });
    expect(f.terminal).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(7_200_000);
    expect(counts).toEqual({ summary: 2, primary: 0 });
    expect(jest.getTimerCount()).toBe(0);
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
