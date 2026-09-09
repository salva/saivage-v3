import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { publishThreeGenerationCompactedConversation } from '../helpers/compacted-conversation-fixture.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { executingLlmSnapshots } from '../helpers/executing-llm-snapshot.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('mounted operator compacted Agent conversations', () => {
  it('returns strict current and selected ordinary/compacted v1/v2/v3 wire projections', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-mounted-compacted-conversation-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const sessionId = await publishThreeGenerationCompactedConversation(projectRoot);
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
      expect(Object.keys(current).sort()).toEqual([
        'cursor',
        'entries',
        'segment_context',
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
    'coverage',
    'covered_group_count',
    'covered_through_message_id',
    'dispositions',
    'kind',
    'prior_genesis_id',
    'prior_history_hash',
    'required_model_facts',
    'source_kind',
    'source_version',
    'summary_text',
  ]);
  expect(Object.keys(context.dispositions).sort()).toEqual([
    'count',
    'evidence_only',
    'sha256',
    'summarized',
    'superseded',
  ]);
  expect(context.dispositions).not.toHaveProperty('evidenceOnly');
  expect(Object.keys(context.coverage).sort()).toEqual([
    'accumulated_summary_sha256',
    'covered_source_groups_sha256',
    'covered_through_message_id',
    'source_session_id',
    'source_version',
  ]);
  for (const domainKey of [
    'accumulatedSummarySha256',
    'coveredSourceGroupsSha256',
    'coveredThroughMessageId',
    'sourceSessionId',
    'sourceVersion',
  ]) expect(context.coverage).not.toHaveProperty(domainKey);
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
    expect(context.source_kind).toBe('prior_genesis_plus_current_rows');
    expect(context.prior_genesis_id).not.toBeNull();
    expect(context.prior_history_hash).not.toBeNull();
  } else {
    expect(context.source_kind).toBe('current_rows');
    expect(context.prior_genesis_id).toBeNull();
    expect(context.prior_history_hash).toBeNull();
  }
}
