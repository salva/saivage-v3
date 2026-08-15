import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';

import {
  AgentConversationResponseSchema,
  AgentDetailResponseSchema,
  AgentListResponseSchema,
  AgentLlmExchangeResponseSchema,
  agentOperatorApiContracts,
  AgentSessionSummarySchema,
} from '../../src/contracts/operator-api-agents.js';
import { buildAgentOperatorContractHandlers } from '../../src/server/routes/operator-agent-handlers.js';
import { appLogEntrySchema } from '../../src/contracts/app-log.js';
import { appendAppLogEntry } from '../../src/persistence/app-log.js';
import { appLogFile } from '../../src/persistence/layout.js';
import { serializeGrowingEnvelope } from '../../src/persistence/growing-file.js';
import type { ProviderExchangePayload } from '../../src/contracts/provider-exchange.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { createEventLog } from '../../src/observability/index.js';
import { initProjectTree, TEST_RUNTIME_WORKFLOWS } from '../helpers/canonical-project.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import { readCurrentConversationSegment } from '../../src/persistence/conversation-file.js';
import { cardConversationVersionFile } from '../../src/persistence/layout.js';

const invalid = ['global', 'analyst:test', 'analyst:telegram-42', 'analyst:other'] as const;
const timestamp = '2026-07-17T00:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('operator Agent exact identity contracts and handlers', () => {
  const variants: Array<[string, string, string | null]> = [
    ['agent:analyst:global', 'analyst', null],
    ['agent:planner:project', 'planner', 'project'],
    ['agent:reviewer:project', 'reviewer', 'project'],
    [
      'agent:executor:card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'executor',
      'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ],
  ];
  it('keeps the checked-in agent session fixture on the strict current public vocabulary', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../../fixtures/valid/agent-session.json', import.meta.url), 'utf8'),
    );
    expect(AgentSessionSummarySchema.parse(fixture)).toEqual(fixture);
    expect(fixture).not.toHaveProperty('completed_at');
  });

  it('projects the same exact live session through list and detail handlers', async () => {
    const root = projectRoot();
    initProjectTree(root);
    populatePlannerConversation(root);
    const handlers = buildAgentOperatorContractHandlers({ projectRoot: root, workflows: TEST_RUNTIME_WORKFLOWS, captureExecutingLlmSessionIds: () => new Set(['agent:planner:project']) });
    const list = await handlers['agents.list']!({} as never);
    const detail = await handlers['agents.detail']!({ params: { id: 'agent:planner:project' } } as never);
    expect(AgentListResponseSchema.parse(list.body).sessions).toContainEqual(expect.objectContaining({ id: 'agent:planner:project', status: 'active', activity: 'busy' }));
    expect(AgentDetailResponseSchema.parse(detail.body)).toEqual({ session: expect.objectContaining({ id: 'agent:planner:project', status: 'active', activity: 'busy' }) });
  });

  it.each(variants)('parses correlated success variants for %s', (id, agentName, cardId) => {
    const session = {
      id,
      agent_name: agentName,
      session_scope: cardId === null ? 'global' : 'card',
      card_id: cardId,
      started_at: timestamp,
      status: 'inactive',
      activity: 'idle',
    };
    expect(AgentListResponseSchema.parse({ sessions: [session] }).sessions[0]!.id).toBe(id);
    expect(AgentDetailResponseSchema.parse({ session }).session.id).toBe(id);
    expect(
      AgentConversationResponseSchema.parse({ session_id: id, segment_version: 1, segment_context: null, entries: [entry(id)], cursor: { segment_version: 1, message_id: 'm1' } })
        .session_id,
    ).toBe(id);
    expect(
      AgentLlmExchangeResponseSchema.parse({ session_id: id, exchange: exchange() }).session_id,
    ).toBe(id);
  });

  it('rejects role, card ownership, entry, and LLM identity mismatches', () => {
    expect(
      AgentListResponseSchema.safeParse({
        sessions: [
          {
            id: 'agent:planner:project',
            agent_name: 'reviewer',
            session_scope: 'card',
            card_id: 'project',
            started_at: timestamp,
            status: 'inactive', activity: 'idle',
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      AgentListResponseSchema.safeParse({
        sessions: [
          {
            id: 'agent:planner:project',
            agent_name: 'planner',
            session_scope: 'card',
            card_id: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            started_at: timestamp,
            status: 'inactive', activity: 'idle',
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      AgentConversationResponseSchema.safeParse({
        session_id: 'agent:planner:project',
        entries: [entry('agent:reviewer:project')],
        cursor: 'm1',
      }).success,
    ).toBe(false);
    expect(
      AgentLlmExchangeResponseSchema.safeParse({ session_id: 'analyst:test', exchange: exchange() })
        .success,
    ).toBe(false);
    expect(
      AgentLlmExchangeResponseSchema.safeParse({
        sessionId: 'agent:planner:project',
        exchange: exchange(),
      }).success,
    ).toBe(false);
  });

  it('returns the exact contract-valid card-not-found body for absent card membership', async () => {
    const root = projectRoot();
    initProjectTree(root);
    const handlers = buildAgentOperatorContractHandlers({
      projectRoot: root,
      workflows: TEST_RUNTIME_WORKFLOWS,
      captureExecutingLlmSessionIds: () => new Set(),
    });

    const result = await handlers['agents.cardSessions']!({ params: { id: 'card-a' } } as never);

    expect(result).toEqual({
      statusCode: 404,
      body: { error: 'Card not found', cardId: 'card-a' },
    });
    expect(agentOperatorApiContracts['agents.cardSessions'].response[404].parse(result.body))
      .toEqual(result.body);
  });

  it('declares exact runtime, cursor, and route-owned Agent 400/404 bodies', () => {
    const runtimeValidation = {
      error: 'ValidationError',
      message: 'agents.conversation query did not match the operator API contract',
      issues: [{ path: 'since', message: 'Required' }],
    };
    const cursorValidation = { error: 'conversation_cursor_not_found', session_id: 'agent:planner:project', segment_version: 1, since: 'missing' };
    const sessionNotFound = { error: 'Agent session not found' };
    const exchangeNotFound = { error: 'No LLM exchange recorded for this session yet.' };

    expect(agentOperatorApiContracts['agents.detail'].response[400].parse(runtimeValidation)).toEqual(runtimeValidation);
    expect(agentOperatorApiContracts['agents.conversation'].response[400].parse(runtimeValidation)).toEqual(runtimeValidation);
    expect(agentOperatorApiContracts['agents.conversation'].response[400].parse(cursorValidation)).toEqual(cursorValidation);
    expect(agentOperatorApiContracts['agents.detail'].response[404].parse(sessionNotFound)).toEqual(sessionNotFound);
    expect(agentOperatorApiContracts['agents.conversation'].response[404].parse(sessionNotFound)).toEqual(sessionNotFound);
    expect(agentOperatorApiContracts['agents.llmExchange'].response[404].parse(exchangeNotFound)).toEqual(exchangeNotFound);

    for (const invalid of [
      { ...runtimeValidation, error: 'Request validation failed' },
      { error: 'ValidationError', issues: [] },
      { ...cursorValidation, since: '' },
      { ...cursorValidation, unexpected: true },
    ]) expect(agentOperatorApiContracts['agents.conversation'].response[400].safeParse(invalid).success).toBe(false);
    for (const invalid of [
      { error: 'missing' },
      { ...sessionNotFound, unexpected: true },
    ]) expect(agentOperatorApiContracts['agents.detail'].response[404].safeParse(invalid).success).toBe(false);
    expect(agentOperatorApiContracts['agents.llmExchange'].response[404].parse(sessionNotFound)).toEqual(sessionNotFound);
    expect(agentOperatorApiContracts['agents.llmExchange'].response[404].safeParse({ ...exchangeNotFound, unexpected: true }).success).toBe(false);
  });

  it.each(invalid)(
    'rejects every ID-bearing route before handler dependencies are used for %s',
    async (id) => {
      const fastify = Fastify({ logger: false });
      const handlers = buildAgentOperatorContractHandlers({
        projectRoot: '/nonexistent',
        workflows: TEST_RUNTIME_WORKFLOWS,
        captureExecutingLlmSessionIds: () => new Set(),
      });
      new ContractRuntime({
        authPolicy: new AuthPolicy(),
        eventLogger: createEventLog('/nonexistent'),
        fatalPort: testApplicationFatalPort,
      }).mount(fastify, agentOperatorApiContracts, handlers);
      try {
        for (const path of [
          `/api/agents/${encodeURIComponent(id)}`,
          `/api/agents/${encodeURIComponent(id)}/conversation`,
          `/api/agents/${encodeURIComponent(id)}/llm-exchange`,
        ]) {
          const response = await fastify.inject({ method: 'GET', url: path });
          expect(response.statusCode).toBe(400);
          expect(response.json()).toMatchObject({ error: 'ValidationError' });
        }
      } finally {
        await fastify.close();
      }
    },
  );

  it.each(['ok', 'error'] as const)(
    'independently redacts canonical %s exchanges without rewriting persistence',
    async (status) => {
      const root = projectRoot();
      initProjectTree(root);
      populatePlannerConversation(root);
      const payload = sensitiveExchange(status);
      appendAppLogEntry(root, 'provider_exchange', () =>
        providerExchangeEntry({
          session_id: 'agent:planner:project',
          source_input_id: payload.source_input_id,
          attempt_index: payload.attempt_index,
          timestamp: payload.completed_at,
          payload,
        }),
      );
      const before = readFileSync(appLogFile(root), 'utf8');
      const request = { log: { error: jest.fn() } };
      const handlers = buildAgentOperatorContractHandlers({
        projectRoot: root,
        workflows: TEST_RUNTIME_WORKFLOWS,
        captureExecutingLlmSessionIds: () => new Set(['agent:planner:project']),
      });

      const result = await handlers['agents.llmExchange']!({
        params: { id: 'agent:planner:project' },
        request,
      } as never);

      expect(result.statusCode).toBeUndefined();
      const response = AgentLlmExchangeResponseSchema.parse(result.body);
      const serialized = JSON.stringify(response);
      for (const secret of operatorClassifiedSecrets[status])
        expect(serialized).not.toContain(secret);
      for (const identity of operatorStructuralIdentities[status])
        expect(serialized).toContain(identity);
      expect(serialized).toContain('[REDACTED]');
      expect(result.body).toEqual({
        session_id: 'agent:planner:project',
        exchange: response.exchange,
      });
      expect(response.session_id).toBe('agent:planner:project');
      expect(response.exchange.source_input_id).toBe('operator-source-identity');
      expect(response.exchange.started_at).toBe(timestamp);
      expect(response.exchange.completed_at).toBe('2026-07-17T00:00:01.000Z');
      expect(response.exchange.attempt_index).toBe(status === 'ok' ? 1 : 0);
      expect(response.exchange.request_params).toEqual({
        endpoint: 'https://provider.invalid/v1?[REDACTED]',
        method: 'POST',
        stream: false,
        offered_tools_count: 1,
        temperature: 0.7,
        max_tokens: 4096,
      });
      expect(response.exchange.response_status).toBe(status === 'ok' ? 200 : 401);
      if (status === 'ok') {
        expect(response.exchange.status).toBe('ok');
        if (response.exchange.status !== 'ok') throw new Error('Expected success response.');
        expect(response.exchange.assistant_output_ids).toEqual(['assistant-output-identity']);
        expect(response.exchange.token_usage).toEqual({ total_tokens: 12 });
      } else {
        expect(response.exchange.status).toBe('error');
        if (response.exchange.status !== 'error') throw new Error('Expected error response.');
        expect(response.exchange.error.status).toBe(401);
      }
      expect(readFileSync(appLogFile(root), 'utf8')).toBe(before);
      expect(request.log.error).not.toHaveBeenCalled();
    },
  );

  it('returns only the exact no-exchange 404 for an absent latest exchange', async () => {
    const root = projectRoot();
    initProjectTree(root);
    populatePlannerConversation(root);
    const handlers = buildAgentOperatorContractHandlers({
      projectRoot: root,
      workflows: TEST_RUNTIME_WORKFLOWS,
      captureExecutingLlmSessionIds: () => new Set(),
    });

    await expect(
      handlers['agents.llmExchange']!({
        params: { id: 'agent:planner:project' },
      } as never),
    ).resolves.toEqual({
      statusCode: 404,
      body: { error: 'No LLM exchange recorded for this session yet.' },
    });
  });

  it('returns the exact classified Agent conversation history unavailability body', () => {
    const root = projectRoot();
    initProjectTree(root);
    populatePlannerConversation(root);
    const segment = readCurrentConversationSegment(root, 'agent:planner:project')!;
    unlinkSync(cardConversationVersionFile(root, 'project', 'planner', segment.entry.filename));
    const handlers = buildAgentOperatorContractHandlers({ projectRoot: root, workflows: TEST_RUNTIME_WORKFLOWS, captureExecutingLlmSessionIds: () => new Set() });

    expect(handlers['agents.conversationVersions.get']!({ params: { id: 'agent:planner:project', version: 1 } } as never)).toEqual({
      statusCode: 404,
      body: { error: 'historical_version_content_unavailable', resource: 'conversation', owner_id: 'agent:planner:project', version: 1, reason: 'missing' },
    });
  });

  it('lets a canonical read failure reach ContractRuntime for one strict non-sensitive response', async () => {
    const secret = 'tok_malformed_duplicate_secret';
    const root = projectRoot('saivage-secret-project-path-');
    initProjectTree(root);
    populatePlannerConversation(root);
    const payload = { ...sensitiveExchange('ok'), source_input_id: secret, attempt_index: 0 };
    const entry = providerExchangeEntry({
      session_id: 'agent:planner:project',
      source_input_id: payload.source_input_id,
      attempt_index: payload.attempt_index,
      timestamp: payload.completed_at,
      payload,
    });
    const line = serializeGrowingEnvelope([entry], appLogEntrySchema);
    mkdirSync(dirname(appLogFile(root)), { recursive: true });
    writeFileSync(appLogFile(root), Buffer.concat([line, line]));
    const handlers = buildAgentOperatorContractHandlers({
      projectRoot: root,
      workflows: TEST_RUNTIME_WORKFLOWS,
      captureExecutingLlmSessionIds: () => new Set(),
    });
    const fastify = Fastify({ logger: false });
    new ContractRuntime({
      authPolicy: new AuthPolicy(),
      eventLogger: createEventLog(root),
      fatalPort: testApplicationFatalPort,
    }).mount(
      fastify,
      { 'agents.llmExchange': agentOperatorApiContracts['agents.llmExchange'] },
      { 'agents.llmExchange': handlers['agents.llmExchange']! },
    );

    try {
      await expect(handlers['agents.llmExchange']!({ params: { id: 'agent:planner:project' } } as never)).resolves.toEqual({ statusCode: 503, body: { error: 'current_state_unavailable', resource: 'provider_exchange_log', owner_id: 'agent:planner:project', restart_required: true } });
      const response = await fastify.inject({
        method: 'GET',
        url: '/api/agents/agent%3Aplanner%3Aproject/llm-exchange',
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: 'current_state_unavailable',
        resource: 'provider_exchange_log',
        owner_id: 'agent:planner:project',
        restart_required: true,
      });
      const output = response.body;
      expect(output).not.toContain(secret);
      expect(output).not.toContain(root);
      expect(output).not.toContain('duplicate');
      expect(output).not.toContain('stack');
    } finally {
      await fastify.close();
    }
  });
});

function providerExchangeEntry(data: {
  session_id: string;
  source_input_id: string;
  attempt_index: number;
  timestamp: string;
  payload: ProviderExchangePayload;
}) {
  return { type: 'provider_exchange' as const, data };
}

function entry(session_id: string) {
  return {
    id: 'm1',
    session_id,
    role: 'user',
    kind: 'text',
    content: 'hello',
    round_id: 'r-user-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    message_index: 0,
    block_index: 0,
    timestamp,
  };
}

function exchange() {
  return {
    contract_id: 'test.v1',
    contract_name: 'test',
    transport: 'generic',
    provider: 'test',
    model: 'model',
    source_input_id: 'input',
    attempt_index: 0,
    request_params: {},
    started_at: timestamp,
    completed_at: timestamp,
    status: 'ok',
    terminal_tool_fired: null,
    assistant_output_ids: [],
  };
}

const operatorClassifiedSecrets = {
  ok: ['operator-endpoint-ok'],
  error: ['operator-endpoint-error', 'tok_operator_error_message'],
};

const operatorStructuralIdentities = {
  ok: [
    'tok_operator_contract_id_ok',
    'tok_operator_contract_name_ok',
    'tok_operator_provider_ok',
    'tok_operator_model_ok',
    'tok_operator_account_ok',
    'tok_operator_finish_ok',
    'tok_operator_tool_ok',
  ],
  error: [
    'tok_operator_contract_id_error',
    'tok_operator_contract_name_error',
    'tok_operator_provider_error',
    'tok_operator_model_error',
    'tok_operator_account_error',
    'tok_operator_error_name',
  ],
};

function sensitiveExchange(status: 'ok' | 'error'): ProviderExchangePayload {
  const suffix = status;
  const base = {
    contract_id: `contract tok_operator_contract_id_${suffix}`,
    contract_name: `contract tok_operator_contract_name_${suffix}`,
    transport: 'generic' as const,
    provider: `provider tok_operator_provider_${suffix}`,
    model: `model tok_operator_model_${suffix}`,
    account: `account tok_operator_account_${suffix}`,
    source_input_id: 'operator-source-identity',
    attempt_index: status === 'ok' ? 1 : 0,
    request_params: {
      endpoint: `https://provider.invalid/v1?api_key=operator-endpoint-${suffix}`,
      method: 'POST',
      stream: false,
      offered_tools_count: 1,
      temperature: 0.7,
      max_tokens: 4096,
    },
    started_at: timestamp,
    completed_at: '2026-07-17T00:00:01.000Z',
    response_status: status === 'ok' ? 200 : 401,
    latency_ms: 1000,
  };
  return status === 'ok'
    ? {
        ...base,
        status,
        finish_reason: 'finish tok_operator_finish_ok',
        token_usage: { total_tokens: 12 },
        terminal_tool_fired: 'tool tok_operator_tool_ok',
        assistant_output_ids: ['assistant-output-identity'],
      }
    : {
        ...base,
        status,
        terminal_tool_fired: null,
        terminal_conversation_output_id: null,
        error: {
          name: 'Synthetic tok_operator_error_name',
          message: 'failure tok_operator_error_message',
          status: 401,
        },
      };
}

function projectRoot(prefix = 'saivage-operator-agent-handler-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function populatePlannerConversation(root: string): void {
  appendConversationBatch({ projectRoot: root }, [entry('agent:planner:project') as never]);
}
