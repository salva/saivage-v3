import { createHash } from 'node:crypto';

import type { ValidatedConversation } from '../../src/contracts/conversation-validation.js';
import { appendConversationBatch, readConversation } from '../../src/persistence/conversation-file.js';
import {
  MODEL_RECOVERY_NOTICE_TEXT,
  STRUCTURAL_ROW_POLICY,
  type AgentMessage,
  type ConversationSessionId,
} from '../../src/schemas/index.js';
import { buildContentPolicyRefusalMessage } from '../../src/runtime/actors/content-policy-messages.js';
import { compact, prepareCompaction, type AutonomousCompactionPolicy } from '../../src/runtime/actors/compaction/compactor.js';
import { buildPreparedInvocationContext } from '../../src/runtime/actors/context/context-blocks.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import type { PreparedLlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE } from '../../src/tools/invocation.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY, toolRowPolicies } from './row-policy-fixtures.js';
import { deterministicSummarySerialization } from './summary-serialization.js';
import { noCompactionProgress } from './executing-llm-snapshot.js';

const SESSION = 'agent:planner:project' as const;
const CANDIDATE = { provider: 'test', account: null, model: 'test' } as const;
const POLICY: AutonomousCompactionPolicy = {
  input_budget_tokens: 10_000,
  trigger_fraction: 0.8,
  completion_reserve_fraction: 0.2,
  tail_fraction: 0.25,
  snap: 'compact_straddler',
};
const BIG = 'x'.repeat(12_000);

export async function publishThreeGenerationCompactedConversation(
  projectRoot: string,
): Promise<ConversationSessionId> {
  appendConversationBatch({ projectRoot }, [
    activation(1),
    text('text-1', BIG),
    recoveryNotice(1),
    activation(2),
    ...summarizerOnlyBundle(2, 'fact-bundle'.concat('-fact'.repeat(4_000))),
    refusalMarker(2),
    activation(3),
    text('text-3', BIG),
    ...summarizerOnlyBundle(3, 'initial-open-round'.concat('-open'.repeat(400))),
  ]);
  await requireCompacted(projectRoot, 'local_exact_admission');

  appendConversationBatch({ projectRoot }, [
    repair('small repair'),
    activation(4),
    text('text-4', BIG),
    ...summarizerOnlyBundle(4, 'second-open-round'.concat('-open'.repeat(400))),
  ]);
  await requireCompacted(projectRoot, 'local_exact_admission');
  return SESSION;
}

async function requireCompacted(
  projectRoot: string,
  strategy: 'preventive' | 'authoritative_context_recovery' | 'local_exact_admission',
): Promise<void> {
  const conversation = readConversation(projectRoot, SESSION);
  const result = await compact({
    strategy,
    conversations: { projectRoot },
    input: invocation(conversation),
    summarizerProvider: {
      candidate: CANDIDATE,
      contextWindowTokens: 100_000,
      maxOutputTokens: 10_000,
      serializeSummaryRequest: deterministicSummarySerialization,
      completeTurn: async () => ({
        result: { kind: 'message' as const, content: 'fixture compacted summary' },
        provider_exchanges: [],
      }),
      projectProviderExchanges: () => [],
    },
    signal: new AbortController().signal,
    progress: noCompactionProgress,
  });
  if (result.kind !== 'compacted') throw new Error(`Expected fixture compaction, got ${result.kind}.`);
}

function invocation(conversation: ValidatedConversation): PreparedLlmInvocationInput {
  const preparedCompaction = prepareCompaction(POLICY, 'system', []);
  return {
    inputId: '00000000-0000-4000-8000-000000000099',
    agentId: SESSION,
    agentName: 'planner',
    sessionId: SESSION,
    systemPrompt: 'system',
    providerConversation: providerConversationProjection(conversation, []),
    tools: [],
    compiledToolContracts: [],
    terminalToolNames: [],
    modelParams: { temperature: 0 },
    preparedCompaction,
    preparedContext: buildPreparedInvocationContext({
      instructionText: 'system',
      terminalToolNames: [],
      compiledTools: [],
      dynamicBlocks: [],
      preparedCompaction,
    }),
    capabilityRequest: {},
    routePass: { kind: 'ordinary', candidateChain: [CANDIDATE] },
    episodeContext: {},
  };
}

function activation(ordinal: number): AgentMessage {
  const inputId = inputIdFor(ordinal);
  const timestamp = `2026-09-07T00:${String(ordinal).padStart(2, '0')}:00.000Z`;
  return {
    id: `activation-${ordinal}`,
    session_id: SESSION,
    role: 'system',
    kind: 'activity',
    context_policy: ACTIVITY_ROW_POLICY,
    content: JSON.stringify({
      event: 'activation_open',
      agent_name: 'planner',
      card_id: 'project',
      input_id: inputId,
      timestamp,
    }),
    round_id: `r-pre-${String(ordinal).padStart(32, '0')}`,
    message_index: 0,
    block_index: 0,
    timestamp,
  };
}

function text(id: string, content: string): AgentMessage {
  return {
    id,
    session_id: SESSION,
    role: 'user',
    kind: 'text',
    context_policy: TEXT_ROW_POLICY,
    content,
    round_id: `r-user-${'2'.repeat(32)}`,
    message_index: 1,
    block_index: 0,
    timestamp: '2026-09-07T00:00:01.000Z',
  };
}

function summarizerOnlyBundle(ordinal: number, body: string, messageIndex = 2): AgentMessage[] {
  const inputId = inputIdFor(ordinal);
  const callId = `call-${ordinal}`;
  const result = JSON.stringify({ success: true, data: { content: body } });
  const policies = toolRowPolicies({
    content: result,
    template: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
    evidence: {
      kind: 'observational_query',
      observedSha256: createHash('sha256').update(result, 'utf8').digest('hex'),
    },
  });
  return [
    {
      id: `${inputId}:tool-call:${callId}`,
      session_id: SESSION,
      role: 'assistant',
      kind: 'tool_call',
      tool: 'read',
      tool_call_id: callId,
      content: JSON.stringify({
        role: 'assistant',
        tool_calls: [{ id: callId, type: 'function', function: { name: 'read', arguments: '{}' } }],
      }),
      context_policy: policies.call,
      round_id: `r-assistant-${String(ordinal).padStart(32, '0')}`,
      message_index: messageIndex,
      block_index: 0,
      timestamp: '2026-09-07T00:00:02.000Z',
    },
    {
      id: `${inputId}:tool-result:${callId}`,
      session_id: SESSION,
      role: 'tool',
      kind: 'tool_result',
      tool: 'read',
      tool_call_id: callId,
      content: result,
      context_policy: policies.result,
      round_id: `r-assistant-${String(ordinal).padStart(32, '0')}`,
      message_index: messageIndex + 1,
      block_index: 0,
      timestamp: '2026-09-07T00:00:03.000Z',
    },
  ];
}

function recoveryNotice(ordinal: number): AgentMessage {
  const inputId = inputIdFor(ordinal);
  return {
    id: `${inputId}:model-recovered`,
    session_id: SESSION,
    role: 'system',
    kind: 'model_recovered',
    context_policy: STRUCTURAL_ROW_POLICY.model_recovery_notice,
    content: MODEL_RECOVERY_NOTICE_TEXT,
    round_id: `r-pre-${String(ordinal).padStart(32, '0')}`,
    message_index: 0,
    block_index: 1,
    timestamp: '2026-09-07T00:00:04.000Z',
  };
}

function refusalMarker(ordinal: number): AgentMessage {
  return {
    ...buildContentPolicyRefusalMessage({
      sessionId: SESSION,
      sourceInputId: inputIdFor(ordinal),
      candidate: CANDIDATE,
      providerResponse: `fixture refusal ${ordinal}`,
    }),
    timestamp: '2026-09-07T00:00:05.000Z',
  };
}

function repair(content: string): AgentMessage {
  return {
    id: '00000000-0000-4000-8000-000000000004:model-repair',
    session_id: SESSION,
    role: 'user',
    kind: 'model_repair',
    context_policy: TEXT_ROW_POLICY,
    content,
    round_id: `r-user-${'5'.repeat(32)}`,
    message_index: 2,
    block_index: 0,
    timestamp: '2026-09-07T00:00:06.000Z',
  };
}

function inputIdFor(ordinal: number): string {
  return `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
}
