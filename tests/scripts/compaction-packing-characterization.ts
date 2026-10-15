// Opt-in, offline characterization only. No providers, files, or runtime composition.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpus, platform, release, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as wait } from 'node:timers/promises';
import sharp from 'sharp';

import { buildCandidateRequest } from '../../src/agents/candidate-request.js';
import { selectLlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';
import {
  validateConversation,
  toolContentSucceeded,
  type MaterializedImage,
} from '../../src/contracts/index.js';
import { agentMessageSchema, type AgentMessage } from '../../src/schemas/index.js';
import { createSequentialRefineAccumulator } from '../../src/runtime/actors/compaction/refine-accumulator.js';
import type { SummarizerProviderPort } from '../../src/runtime/actors/compaction/summarizer.js';
import { OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE } from '../../src/tools/invocation.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import {
  ACTIVITY_ROW_POLICY,
  TEXT_ROW_POLICY,
  toolRowPolicies,
} from '../helpers/row-policy-fixtures.js';
import { noCompactionProgress } from '../helpers/executing-llm-snapshot.js';

const SESSION = 'agent:planner:project' as const;
const INPUT = '11111111-1111-4111-8111-111111111111';
const TIMESTAMP = '2026-10-15T00:00:00.000Z';
const CANDIDATE = { provider: 'offline', account: null, model: 'gpt-6.1-sol' } as const;
const PROTOCOLS = ['openai-chat-completions', 'openai-responses', 'openai-codex-backend'] as const;
type Protocol = (typeof PROTOCOLS)[number];
type Input = Parameters<SummarizerProviderPort['serializeSummaryRequest']>[0];

function row(fields: Record<string, unknown>, index: number): AgentMessage {
  return agentMessageSchema.parse({
    session_id: SESSION,
    round_id: `r-user-${'1'.repeat(32)}`,
    message_index: index,
    block_index: 0,
    timestamp: TIMESTAMP,
    ...fields,
  });
}

function activation(): AgentMessage {
  return row(
    {
      id: 'activation',
      role: 'system',
      kind: 'activity',
      context_policy: ACTIVITY_ROW_POLICY,
      content: JSON.stringify({
        event: 'activation_open',
        instructions: { kind: 'unavailable', reason: 'not_recorded' },
        agent_name: 'planner',
        card_id: 'project',
        input_id: INPUT,
        timestamp: TIMESTAMP,
      }),
    },
    0,
  );
}

function text(index: number, content: string): AgentMessage {
  return row(
    {
      id: `text-${index}`,
      role: index % 2 ? 'user' : 'assistant',
      kind: 'text',
      context_policy: TEXT_ROW_POLICY,
      content,
    },
    index,
  );
}

function mixedRows(image: MaterializedImage): AgentMessage[] {
  const rows = [activation()];
  for (let index = 0; index < 36; index++) {
    rows.push(
      text(
        rows.length,
        `Observation ${index}: "quoted" \\ \n\té漢🙂\uD800; `.repeat(1 + (index % 7)),
      ),
    );
    const callId = `call-${index}`;
    const content = settleToolActionOutcome(
      toolContentSucceeded(
        { observation: index, executed: true, detail: 'synthetic evidence only' },
        index % 9 === 0
          ? [
              { type: 'text', text: 'before pixels' },
              { type: 'image', image: image.descriptor },
              { type: 'text', text: 'after pixels' },
            ]
          : [{ type: 'text', text: 'synthetic observation evidence' }],
      ),
    ).settledResultBytes;
    const policies = toolRowPolicies({
      content,
      template: {
        ...OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
        settledAudience: 'primary_and_summarizer',
      },
      evidence: {
        kind: 'observational_query',
        observedSha256: createHash('sha256').update(content).digest('hex'),
      },
    });
    rows.push(
      row(
        {
          id: `${INPUT}:tool-call:${callId}`,
          role: 'assistant',
          kind: 'tool_call',
          tool: 'offline_observation',
          tool_call_id: callId,
          context_policy: policies.call,
          content: JSON.stringify({
            role: 'assistant',
            tool_calls: [
              {
                id: callId,
                type: 'function',
                function: {
                  name: 'offline_observation',
                  arguments: index % 2 ? '{"path":"synthetic.txt"}' : '{}',
                },
              },
            ],
          }),
        },
        rows.length,
      ),
    );
    rows.push(
      row(
        {
          id: `${INPUT}:tool-result:${callId}`,
          role: 'tool',
          kind: 'tool_result',
          tool: 'offline_observation',
          tool_call_id: callId,
          context_policy: policies.result,
          content,
        },
        rows.length,
      ),
    );
  }
  return rows;
}

async function characterize(
  protocol: Protocol,
  shape: string,
  rows: AgentMessage[],
  image: MaterializedImage,
  contextWindowTokens: number,
) {
  let probes = 0;
  let cumulativeSerializedBytes = 0;
  let maxProbeBytes = 0;
  let sentBytes = 0;
  let maxSentBytes = 0;
  let folds = 0;
  let waitWallMs = 0;
  let waitCpuMicros = 0;
  let serializerWallMs = 0;
  let serializerCpuMicros = 0;
  const admissions = new WeakMap<
    Input,
    ReturnType<SummarizerProviderPort['serializeSummaryRequest']>
  >();
  const provider: SummarizerProviderPort = {
    candidate: CANDIDATE,
    contextWindowTokens,
    maxOutputTokens: 10_000,
    materializeImage: async (session, descriptor) => {
      assert.equal(session, SESSION);
      assert.deepEqual(descriptor, image.descriptor);
      return image;
    },
    serializeSummaryRequest(input) {
      const started = performance.now();
      const cpu = process.cpuUsage();
      const capabilities = {
        transportProtocol: protocol,
        imageInput: protocol !== 'openai-chat-completions',
        toolsMode: 'native' as const,
        exclusiveToolChoiceSupport: 'native' as const,
        contextWindowTokens,
        maxOutputTokens: 10_000,
        quirks: [],
      };
      const plan = buildCandidateRequest({
        candidate: CANDIDATE,
        capabilities,
        adapter: selectLlmProtocolAdapter(protocol),
        systemPrompt: input.systemPrompt,
        providerConversation: input.providerConversation,
        options: {
          providerSessionId: 'offline-packing',
          inputId: input.inputId,
          temperature: 0,
          max_tokens: 2000,
          tools: [],
          tool_choice: 'auto',
          contract_id: 'internal-compaction-summary.v1',
          contractName: 'internal-compaction-summary',
          terminalToolOffered: [],
        },
      });
      const serialized = {
        serializedRequest: plan.request.serializedBody,
        requestSha256: plan.request.requestHash,
        estimatedInputTokens: plan.request.estimatedWireInputTokens,
        imageCount: plan.request.imageCount,
      };
      const usage = process.cpuUsage(cpu);
      serializerCpuMicros += usage.user + usage.system;
      serializerWallMs += performance.now() - started;
      const bytes = Buffer.byteLength(serialized.serializedRequest);
      probes++;
      cumulativeSerializedBytes += bytes;
      maxProbeBytes = Math.max(maxProbeBytes, bytes);
      admissions.set(input, serialized);
      return serialized;
    },
    async completeTurn(input, admitted) {
      const winner = admissions.get(input);
      assert.ok(winner);
      assert.equal(admitted.serializedRequest, winner.serializedRequest);
      assert.equal(admitted.requestSha256, winner.requestSha256);
      assert.equal(admitted.contextUtilizationFraction, 0.8);
      const bytes = Buffer.byteLength(admitted.serializedRequest);
      sentBytes += bytes;
      maxSentBytes = Math.max(maxSentBytes, bytes);
      folds++;
      const started = performance.now();
      const cpu = process.cpuUsage();
      await wait(2); // Measured separately; never represents provider latency.
      const usage = process.cpuUsage(cpu);
      waitCpuMicros += usage.user + usage.system;
      waitWallMs += performance.now() - started;
      return {
        result: { kind: 'message', content: `synthetic summary ${folds}` },
        provider_exchanges: [],
      };
    },
    projectProviderExchanges() {},
  };
  const started = performance.now();
  const cpu = process.cpuUsage();
  const conversation = validateConversation(SESSION, rows);
  const accumulator = createSequentialRefineAccumulator({
    conversation,
    inheritedHistory: null,
    preparedBlocks: [
      {
        id: 'offline.orientation',
        role: 'system',
        content: 'Synthetic fixed orientation; no live project.',
        storage: 'activation_local',
        replacement: { kind: 'retain' },
        audience: 'primary_and_summarizer',
        evidence: { kind: 'none' },
      },
    ],
    summarizerProvider: provider,
    budget: { contextUtilizationFraction: 0.8 },
    signal: new AbortController().signal,
    progress: noCompactionProgress,
  });
  await accumulator.materializeThrough(rows.length);
  const usage = process.cpuUsage(cpu);
  const wallMs = performance.now() - started;
  const cpuMicros = usage.user + usage.system;
  if (shape === 'many-small') assert.equal(folds, 1);
  console.log(
    JSON.stringify({
      protocol,
      shape,
      sourceRows: rows.length - 1,
      contextWindowTokens,
      probes,
      cumulativeSerializedBytes,
      maxProbeBytes,
      sentBytes,
      maxSentBytes,
      folds,
      wallMs,
      cpuMicros,
      syntheticWait: { requestedMsPerFold: 2, wallMs: waitWallMs, cpuMicros: waitCpuMicros },
      excludingSyntheticWait: { wallMs: wallMs - waitWallMs, cpuMicros: cpuMicros - waitCpuMicros },
      serializer: { wallMs: serializerWallMs, cpuMicros: serializerCpuMicros },
    }),
  );
}

// One tiny in-memory PNG, never published to a conversation or project directory.
const png = await sharp({ create: { width: 13, height: 7, channels: 3, background: '#abcdef' } })
  .png()
  .toBuffer();
const image: MaterializedImage = {
  descriptor: {
    id: '22222222-2222-4222-8222-222222222222',
    mime_type: 'image/png',
    width: 13,
    height: 7,
    byte_length: png.length,
    sha256: createHash('sha256').update(png).digest('hex'),
  },
  dataUrl: `data:image/png;base64,${png.toString('base64')}`,
};
console.log(
  JSON.stringify({
    context: {
      node: process.version,
      platform: platform(),
      release: release(),
      arch: arch(),
      cpuModel: cpus()[0]?.model,
      logicalCpus: cpus().length,
    },
    limits: { sizes: [250, 500, 1000], mixedGroups: 36, maxRefineInvocations: 16 },
    interpretation:
      'Offline real-adapter costs, synthetic completions; not live latency or a like-for-like comparison with the audit simple serializer.',
  }),
);
for (const protocol of PROTOCOLS) {
  for (const size of [250, 500, 1000])
    await characterize(
      protocol,
      'many-small',
      [
        activation(),
        ...Array.from({ length: size }, (_, index) => text(index + 1, `row ${index}: é🙂 \\"\n`)),
      ],
      image,
      1_000_000,
    );
  if (protocol !== 'openai-chat-completions')
    await characterize(
      protocol,
      'mixed-tool-evidence-unicode-images',
      mixedRows(image),
      image,
      12_000,
    );
}
