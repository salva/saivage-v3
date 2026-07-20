import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';

import {
  AgentConversationResponseSchema,
  AgentDetailResponseSchema,
  AgentListResponseSchema,
  AgentLlmExchangeResponseSchema,
  agentOperatorApiContracts,
} from '../../src/contracts/operator-api-agents.js';
import { buildAgentOperatorContractHandlers } from '../../src/server/routes/operator-agent-handlers.js';
import { appendAppLogEntry, appLogEntrySchema } from '../../src/persistence/app-log.js';
import { appLogFile } from '../../src/persistence/layout.js';
import { providerExchangeAppLogEntry } from '../../src/persistence/provider-exchange-log.js';
import { serializeGrowingEnvelope } from '../../src/persistence/growing-file.js';
import type { ProviderExchangePayload } from '../../src/contracts/provider-exchange.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import type { RuntimeApplication } from '../../src/application/runtime-composition.js';
import { EventBus } from '../../src/events/index.js';

const invalid = ['global', 'analyst:test', 'analyst:telegram-42', 'analyst:other'] as const;
const timestamp = '2026-07-17T00:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('operator Agent exact identity contracts and handlers', () => {
  const variants: Array<[string, string, string | null]> = [
    ['analyst:global', 'analyst', null],
    ['planner:project', 'planner', 'project'],
    ['reviewer:project', 'reviewer', 'project'],
    ['executor:card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'executor', 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
  ];
  it.each(variants)('parses correlated success variants for %s', (id, role, cardId) => {
    const session = { id, role, card_id: cardId, status: 'inactive', started_at: timestamp };
    expect(AgentListResponseSchema.parse({ sessions: [session] }).sessions[0]!.id).toBe(id);
    expect(AgentDetailResponseSchema.parse({ session: { ...session, message_count: 1, last_activity_at: timestamp } }).session.id).toBe(id);
    expect(AgentConversationResponseSchema.parse({ session, entries: [entry(id)], activity_status: { status: 'inactive', pending_calls: [] } }).session.id).toBe(id);
    expect(AgentLlmExchangeResponseSchema.parse({ sessionId: id, exchange: exchange() }).sessionId).toBe(id);
  });

  it('rejects role, card ownership, entry, and LLM identity mismatches', () => {
    expect(AgentListResponseSchema.safeParse({ sessions: [{ id: 'planner:project', role: 'reviewer', card_id: 'project', status: 'inactive', started_at: timestamp }] }).success).toBe(false);
    expect(AgentListResponseSchema.safeParse({ sessions: [{ id: 'planner:project', role: 'planner', card_id: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'inactive', started_at: timestamp }] }).success).toBe(false);
    expect(AgentConversationResponseSchema.safeParse({ session: { id: 'planner:project', role: 'planner', card_id: 'project', status: 'inactive', started_at: timestamp }, entries: [entry('reviewer:project')], activity_status: { status: 'inactive', pending_calls: [] } }).success).toBe(false);
    expect(AgentLlmExchangeResponseSchema.safeParse({ sessionId: 'analyst:test', exchange: exchange() }).success).toBe(false);
  });

  it.each(invalid)('rejects every ID-bearing route before handler dependencies are used for %s', async (id) => {
    const snapshots = jest.fn(() => { throw new Error('must not capture'); });
    const fastify = Fastify({ logger: false });
    const handlers = buildAgentOperatorContractHandlers({ projectRoot: '/nonexistent', runtimeApplication: { captureExecutingLlmSnapshots: snapshots } as unknown as RuntimeApplication });
    new ContractRuntime({ authPolicy: new AuthPolicy(), eventBus: new EventBus() }).mount(fastify, agentOperatorApiContracts, handlers);
    try {
      for (const path of [`/api/agents/${encodeURIComponent(id)}`, `/api/agents/${encodeURIComponent(id)}/conversation`, `/api/agents/${encodeURIComponent(id)}/llm-exchange`]) {
        const response = await fastify.inject({ method: 'GET', url: path });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: 'ValidationError' });
      }
      expect(snapshots).not.toHaveBeenCalled();
    } finally {
      await fastify.close();
    }
  });

  it.each(['ok', 'error'] as const)('independently redacts canonical %s exchanges without rewriting persistence', async (status) => {
    const root = projectRoot();
    const payload = sensitiveExchange(status);
    appendAppLogEntry(root, providerExchangeAppLogEntry({
      session_id: 'planner:project',
      source_input_id: payload.source_input_id,
      attempt_index: payload.attempt_index,
      timestamp: payload.completed_at,
      payload,
    }));
    const before = readFileSync(appLogFile(root), 'utf8');
    const request = { log: { error: jest.fn() } };
    const handlers = buildAgentOperatorContractHandlers({ projectRoot: root });

    const result = await handlers['agents.llmExchange']!({ params: { id: 'planner:project' }, request } as never);

    expect(result.statusCode).toBeUndefined();
    const response = AgentLlmExchangeResponseSchema.parse(result.body);
    const serialized = JSON.stringify(response);
    for (const secret of operatorSecrets[status]) expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[REDACTED]');
    expect(response.sessionId).toBe('planner:project');
    expect(response.exchange.source_input_id).toBe('operator-source-identity');
    expect(response.exchange.started_at).toBe(timestamp);
    expect(response.exchange.completed_at).toBe('2026-07-17T00:00:01.000Z');
    expect(response.exchange.attempt_index).toBe(status === 'ok' ? 1 : 0);
    expect(response.exchange.request_params).toMatchObject({ method: 'POST', safe: 'visible', nested: { safe: 'nested-visible', token: '[REDACTED]' } });
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
  });

  it('lets a canonical read failure reach ContractRuntime for one strict non-sensitive response', async () => {
    const secret = 'tok_malformed_duplicate_secret';
    const root = projectRoot('saivage-secret-project-path-');
    const payload = { ...sensitiveExchange('ok'), source_input_id: secret, attempt_index: 0 };
    const entry = providerExchangeAppLogEntry({
      session_id: 'planner:project', source_input_id: payload.source_input_id,
      attempt_index: payload.attempt_index, timestamp: payload.completed_at, payload,
    });
    const line = serializeGrowingEnvelope([entry], appLogEntrySchema);
    mkdirSync(dirname(appLogFile(root)), { recursive: true });
    writeFileSync(appLogFile(root), Buffer.concat([line, line]));
    const handlers = buildAgentOperatorContractHandlers({ projectRoot: root });
    const fastify = Fastify({ logger: false });
    new ContractRuntime({ authPolicy: new AuthPolicy(), eventBus: new EventBus() }).mount(
      fastify,
      { 'agents.llmExchange': agentOperatorApiContracts['agents.llmExchange'] },
      { 'agents.llmExchange': handlers['agents.llmExchange']! },
    );

    try {
      await expect(handlers['agents.llmExchange']!({ params: { id: 'planner:project' } } as never)).rejects.toThrow();
      const response = await fastify.inject({ method: 'GET', url: '/api/agents/planner%3Aproject/llm-exchange' });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'InternalServerError', message: 'Internal server error' });
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

function entry(session_id: string) {
  return { id: 'm1', session_id, role: 'user', kind: 'text', content: 'hello', round_id: 'r-user-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', message_index: 0, block_index: 0, timestamp };
}

function exchange() {
  return { contract_id: 'test.v1', contract_name: 'test', transport: 'generic', provider: 'test', model: 'model', source_input_id: 'input', attempt_index: 0, request_params: {}, started_at: timestamp, completed_at: timestamp, status: 'ok', terminal_tool_fired: null, assistant_output_ids: [] };
}

const operatorSecrets = {
  ok: [
    'tok_operator_contract_id_ok', 'tok_operator_contract_name_ok', 'tok_operator_provider_ok',
    'tok_operator_model_ok', 'tok_operator_account_ok', 'operator-endpoint-ok',
    'operator-nested-token-ok', 'tok_operator_nested_ok', 'tok_operator_finish_ok', 'tok_operator_tool_ok',
  ],
  error: [
    'tok_operator_contract_id_error', 'tok_operator_contract_name_error', 'tok_operator_provider_error',
    'tok_operator_model_error', 'tok_operator_account_error', 'operator-endpoint-error',
    'operator-nested-token-error', 'tok_operator_nested_error', 'tok_operator_error_name', 'tok_operator_error_message',
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
      safe: 'visible',
      nested: { safe: 'nested-visible', token: `operator-nested-token-${suffix}`, text: `metadata tok_operator_nested_${suffix}` },
    },
    started_at: timestamp,
    completed_at: '2026-07-17T00:00:01.000Z',
    response_status: status === 'ok' ? 200 : 401,
    latency_ms: 1000,
  };
  return status === 'ok'
    ? { ...base, status, finish_reason: 'finish tok_operator_finish_ok', token_usage: { total_tokens: 12 }, terminal_tool_fired: 'tool tok_operator_tool_ok', assistant_output_ids: ['assistant-output-identity'] }
    : { ...base, status, terminal_tool_fired: null, error: { name: 'Synthetic tok_operator_error_name', message: 'failure tok_operator_error_message', status: 401 } };
}

function projectRoot(prefix = 'saivage-operator-agent-handler-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
