import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

import {
  AgentConversationResponseSchema,
  ConversationVersionContentResponseSchema,
  ConversationVersionListResponseSchema,
  agentOperatorApiContracts,
  type ConversationSegmentContext,
} from '../../src/contracts/operator-api-agents.js';
import { createEventLog } from '../../src/observability/index.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { buildAgentOperatorContractHandlers } from '../../src/server/routes/operator-agent-handlers.js';
import { initProjectTree, TEST_RUNTIME_WORKFLOWS } from '../helpers/canonical-project.js';
import { publishThreeGenerationCompactedConversation, requireCompacted } from '../helpers/compacted-conversation-fixture.js';
import { cardConversationVersionIndexFile, conversationPreviousIndexFile } from '../../src/persistence/layout.js';
import { publishHeadFile } from '../../src/persistence/publish-head.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { executingLlmSnapshots } from '../helpers/executing-llm-snapshot.js';
import { RESPONSES_A, responsesBundle } from '../helpers/responses-producer-fixture.js';
import { responsesProducerAccountId } from '../../src/agents/llm-openai-responses-account.js';
import { appendConversationBatch, readHistoricalConversationSegment } from '../../src/persistence/conversation-file.js';
import { TEXT_ROW_POLICY } from '../helpers/row-policy-fixtures.js';
import { sha256Hex } from '../../src/schemas/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('mounted operator compacted Agent conversations', () => {
  it('projects real current and exact-history tool rows safely while preserving selected source identity and order', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-mounted-tool-egress-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const sessionId = await publishThreeGenerationCompactedConversation(projectRoot, 'fixture summary', {
      first: { content: 'token=old-segment-canary', key: 'old-key' },
      replacement: { content: 'safe replacement', key: 'new-key' },
    });
    const source = '11111111-1111-4111-8111-111111111111';
    const argumentsJson = JSON.stringify({ url: 'https://example.test/path?token=request-canary' });
    const content = JSON.stringify({ success: false, error: 'token=result-canary', data: { partial_effect: 'retained', token: 'structured-canary' } });
    const [privateRow, call, result] = responsesBundle(sessionId, source, RESPONSES_A, content);
    const privateBody = JSON.parse(privateRow!.content);
    privateBody.output.at(-1).name = 'webfetch';
    privateBody.output.at(-1).arguments = argumentsJson;
    const callBody = JSON.parse(call!.content);
    callBody.tool_calls[0].function = { name: 'webfetch', arguments: argumentsJson };
    appendConversationBatch({ projectRoot }, [
      { ...privateRow!, content: JSON.stringify(privateBody) },
      { ...call!, tool: 'webfetch', content: JSON.stringify(callBody), model_spec: 'private-model-canary' },
      { ...call!, id: 'interleaved-correction', kind: 'text', tool: undefined, tool_call_id: undefined, provider_projection: undefined, context_policy: TEXT_ROW_POLICY, content: 'Correction token=prose-canary' },
      { ...result!, tool: 'webfetch' },
    ]);
    const stored = [1, 3].map(version => readHistoricalConversationSegment(projectRoot, sessionId, version));
    const fastify = Fastify({ logger: false });
    new ContractRuntime({
      authPolicy: new AuthPolicy(), eventLogger: createEventLog(projectRoot), fatalPort: testApplicationFatalPort,
    }).mount(fastify, agentOperatorApiContracts, buildAgentOperatorContractHandlers({
      projectRoot, workflows: TEST_RUNTIME_WORKFLOWS, captureExecutingLlmSnapshots: () => executingLlmSnapshots([]),
    }));
    try {
      const base = `/api/agents/${encodeURIComponent(sessionId)}/conversation`;
      const currentResponse = await fastify.inject({ method: 'GET', url: base });
      expect(currentResponse.statusCode).toBe(200);
      const current = AgentConversationResponseSchema.parse(currentResponse.json());
      const history = [];
      for (const segment of stored) {
        const response = await fastify.inject({ method: 'GET', url: `${base}/versions/${segment.entry.version}` });
        expect(response.statusCode).toBe(200);
        const projected = ConversationVersionContentResponseSchema.parse(response.json());
        expect(projected.entry_id).toBe(segment.entry.entry_id);
        expect(projected.entries.map(row => [row.id, row.timestamp, row.round_id, row.message_index, row.block_index]))
          .toEqual(segment.rows.filter(row => row.kind !== 'provider_private').map(row => [row.id, row.timestamp, row.round_id, row.message_index, row.block_index]));
        history.push(projected);
      }
      // Current additionally prepends covered required facts; history keeps exact physical rows.
      // Compare only selected source rows, without changing either consumption contract.
      const selectedIds = new Set(stored[1]!.rows.map(row => row.id));
      expect(current.entries.filter(row => selectedIds.has(row.id))).toEqual(history[1]!.entries);
      for (const projected of [current, ...history]) {
        const serialized = JSON.stringify(projected);
        for (const canary of ['old-segment-canary', 'request-canary', 'result-canary', 'structured-canary', 'prose-canary', 'private-model-canary', 'producer_account_id', 'provider_projection', 'ciphertext-']) {
          expect(serialized).not.toContain(canary);
        }
      }
      const tail = current.entries.slice(-3);
      expect(tail.map(row => row.id)).toEqual([call!.id, 'interleaved-correction', result!.id]);
      expect(JSON.parse(JSON.parse(tail[0]!.content).tool_calls[0].function.arguments)).toEqual({ url: 'https://example.test/path?[REDACTED]' });
      expect(JSON.parse(tail[2]!.content)).toEqual({ success: false, error: 'token=[REDACTED]', data: { partial_effect: 'retained', token: '[REDACTED]' } });
      expect(tail[2]!.context_policy).toMatchObject({ result_content_sha256: sha256Hex(tail[2]!.content) });
      expect(stored.map(segment => readHistoricalConversationSegment(projectRoot, sessionId, segment.entry.version).rows))
        .toEqual(stored.map(segment => segment.rows));
    } finally {
      await fastify.close();
    }
  });

  it('returns strict current and selected ordinary/compacted v1/v2/v3 wire projections', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-mounted-compacted-conversation-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const firstProtected = { content: 'token=first-protected-secret', key: 'api_key=shared-key-secret' };
    const replacementProtected = { content: 'token=replacement-protected-secret', key: 'api_key=shared-key-secret' };
    const sessionId = await publishThreeGenerationCompactedConversation(projectRoot, 'fixture compacted summary', {
      first: firstProtected,
      replacement: replacementProtected,
    }, RESPONSES_A);
    const fastify = Fastify({ logger: false });
    const handlers = buildAgentOperatorContractHandlers({
      projectRoot,
      workflows: TEST_RUNTIME_WORKFLOWS,
      captureExecutingLlmSnapshots: () => executingLlmSnapshots([sessionId]),
    });
    new ContractRuntime({
      authPolicy: new AuthPolicy(),
      eventLogger: createEventLog(projectRoot),
      fatalPort: testApplicationFatalPort,
    }).mount(fastify, agentOperatorApiContracts, handlers);

    try {
      const encodedSessionId = encodeURIComponent(sessionId);
      const catalogResponse = await fastify.inject({
        method: 'GET',
        url: `/api/agents/${encodedSessionId}/conversation/versions`,
      });
      expect(catalogResponse.statusCode).toBe(200);
      const catalog = ConversationVersionListResponseSchema.parse(catalogResponse.json());
      expect(Object.keys(catalog).sort()).toEqual(['session_id', 'total', 'versions']);
      expect(catalog.versions.map((version) => version.version)).toEqual([1, 2, 3]);

      const currentResponse = await fastify.inject({
        method: 'GET',
        url: `/api/agents/${encodedSessionId}/conversation`,
      });
      expect(currentResponse.statusCode).toBe(200);
      const current = AgentConversationResponseSchema.parse(currentResponse.json());
      for (const field of ['source_kind', 'prior_genesis_id', 'prior_history_hash', 'covered_group_count', 'dispositions', 'coverage']) {
        expect(AgentConversationResponseSchema.safeParse({ ...current, segment_context: { ...current.segment_context, [field]: null } }).success).toBe(false);
      }
      expect(Object.keys(current).sort()).toEqual([
        'cursor',
        'entries',
        'segment_context',
        'segment_id',
        'segment_version',
        'session_id',
      ]);
      expect(current.segment_version).toBe(3);
      assertCompactedContext(current.segment_context, true);

      const historical = [];
      for (const version of [1, 2, 3]) {
        const response = await fastify.inject({
          method: 'GET',
          url: `/api/agents/${encodedSessionId}/conversation/versions/${version}`,
        });
        expect(response.statusCode).toBe(200);
        const parsed = ConversationVersionContentResponseSchema.parse(response.json());
        expect(Object.keys(parsed).sort()).toEqual([
          'entries',
          'entry_id',
          'published_at',
          'segment_context',
          'session_id',
          'version',
        ]);
        historical.push(parsed);
      }
      expect(historical[0]!.segment_context).toBeNull();
      assertCompactedContext(historical[1]!.segment_context, false);
      assertCompactedContext(historical[2]!.segment_context, true);
      expect(historical[1]!.segment_context?.protected_prompts).toHaveLength(1);
      expect(historical[2]!.segment_context?.protected_prompts).toHaveLength(1);
      expect(historical[1]!.segment_context?.protected_prompts[0]!.message.id).toBe('protected-1');
      expect(historical[2]!.segment_context?.protected_prompts[0]!.message.id).toBe('protected-2');
      expect(current.segment_context?.protected_prompts).toEqual(historical[2]!.segment_context?.protected_prompts);
      for (const projected of [current, ...historical]) {
        expect(JSON.stringify(projected)).not.toContain('producer_account_id');
        expect(JSON.stringify(projected)).not.toContain(responsesProducerAccountId(RESPONSES_A));
        expect(JSON.stringify(projected)).not.toContain('ciphertext-');
        const serialized = JSON.stringify(projected.segment_context);
        expect(serialized).not.toContain('first-protected-secret');
        expect(serialized).not.toContain('shared-key-secret');
        expect(serialized).not.toContain('replacement-protected-secret');
      }
      expect(JSON.stringify(current.entries)).toContain('retained-tool');
      expect(JSON.stringify(current.entries)).toContain('read_file');
      expect(JSON.stringify(historical[0]!.entries)).toContain('covered-tool');

      // Model an explicit selector rollback without introducing a repair path here.
      // The v2 source already contains the rows retained by both incarnations of v3.
      const indexPath = cardConversationVersionIndexFile(projectRoot, 'project', 'planner');
      const index = JSON.parse(readFileSync(indexPath, 'utf8'));
      const predecessor = index.versions[1];
      publishHeadFile(indexPath, conversationPreviousIndexFile(indexPath), Buffer.from(JSON.stringify({
        ...index, versions: index.versions.slice(0, 2), current_version: 2, current_filename: predecessor.filename,
      }) + '\n'), 'replacement');
      const rollback = await fastify.inject({ method: 'GET', url: `/api/agents/${encodedSessionId}/conversation` });
      expect(rollback.json().segment_version).toBe(2);
      await requireCompacted(projectRoot, 'local_exact_admission', 'fixture compacted summary');
      const recompacted = AgentConversationResponseSchema.parse((await fastify.inject({
        method: 'GET', url: `/api/agents/${encodedSessionId}/conversation`,
      })).json());
      expect(recompacted.segment_version).toBe(current.segment_version);
      expect(recompacted.segment_id).not.toBe(current.segment_id);
      // Select a cursor demonstrably retained in both generations, not a missing-row false positive.
      const retainedCursor = current.entries.find(row => recompacted.entries.some(next => next.id === row.id))!.id;
      for (const since of [retainedCursor, 'cursor-not-present']) {
        const stale = await fastify.inject({ method: 'GET', url: `/api/agents/${encodedSessionId}/conversation`, query: {
          segment_id: current.segment_id, segment_version: String(current.segment_version), since,
        } });
        expect(stale.statusCode).toBe(409);
        expect(stale.json()).toEqual({
          error: 'conversation_segment_changed', session_id: sessionId,
          requested_segment_id: current.segment_id, requested_segment_version: 3,
          current_segment_id: recompacted.segment_id, current_segment_version: 3,
        });
      }
      const tail = await fastify.inject({ method: 'GET', url: `/api/agents/${encodedSessionId}/conversation`, query: {
        segment_id: recompacted.segment_id, segment_version: '3', since: retainedCursor,
      } });
      expect(tail.statusCode).toBe(200);
      expect(tail.json().segment_id).toBe(recompacted.segment_id);
      const newCatalog = ConversationVersionListResponseSchema.parse((await fastify.inject({
        method: 'GET', url: `/api/agents/${encodedSessionId}/conversation/versions`,
      })).json());
      expect(newCatalog.versions[2]!.entry_id).toBe(recompacted.segment_id);
      expect(newCatalog.versions.some(entry => entry.entry_id === current.segment_id)).toBe(false);
    } finally {
      await fastify.close();
    }
  });
});

function assertCompactedContext(
  context: ConversationSegmentContext,
  expectLaterGeneration: boolean,
): asserts context is Exclude<ConversationSegmentContext, null> {
  expect(context).not.toBeNull();
  if (context === null) throw new Error('Expected compacted segment context.');
  expect(Object.keys(context).sort()).toEqual([
    'continuation',
    'covered_through_message_id',
    'kind',
    'protected_prompts',
    'required_model_facts',
    'source_version',
    'summary_text',
  ]);
  for (const entry of context.protected_prompts) {
    expect(entry.message.content).toContain('[REDACTED]');
    if (entry.message.context_policy.kind !== 'content') throw new Error('Expected protected content policy.');
    expect(entry.message.context_policy.compactable).toBe(false);
    expect(entry.message.context_policy.compaction_key).toContain('[REDACTED]');
  }
  expect(Object.keys(context.required_model_facts).sort()).toEqual([
    'latestContentPolicyRefusal',
    'latestRecovery',
  ]);
  expect(context.required_model_facts.latestRecovery).not.toBeNull();
  expect(Object.keys(context.required_model_facts.latestRecovery!).sort()).toEqual([
    'activationInputId',
    'sourceMessageId',
  ]);
  expect(context.required_model_facts.latestContentPolicyRefusal).not.toBeNull();
  expect(Object.keys(context.required_model_facts.latestContentPolicyRefusal!).sort()).toEqual([
    'activationInputId',
    'markerId',
  ]);
  expect(context.continuation.kind).toBe('inherited_open_round');
  if (context.continuation.kind !== 'inherited_open_round')
    throw new Error('Expected inherited open-round continuation.');
  expect(Object.keys(context.continuation).sort()).toEqual([
    'activation',
    'active_segment_kind',
    'kind',
  ]);
  expect(Object.keys(context.continuation.activation).sort()).toEqual(['input_id', 'marker_id']);
  expect(context.continuation.activation).not.toHaveProperty('inputId');
  expect(context.continuation.activation).not.toHaveProperty('markerId');
  if (expectLaterGeneration) {
    expect(context.source_version).toBeGreaterThan(1);
  } else {
    expect(context.source_version).toBe(1);
  }
}
