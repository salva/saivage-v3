import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InvocationService } from '../../src/agents/invocation-service.js';
import type { ProviderExchangeAttempt } from '../../src/contracts/provider-exchange.js';
import { providerExchangeLogId } from '../../src/contracts/provider-exchange-log.js';
import { readAppLogEntries } from '../../src/persistence/app-log.js';
import { appLogFile } from '../../src/persistence/layout.js';
import type { FreshnessEffects } from '../../src/application/freshness-effects.js';
import { projectProviderExchangeForPublication } from '../../src/agents/provider-exchange-projection.js';
import { OUTBOUND_IDENTITY, OUTBOUND_RAW_MARKER } from '../helpers/outbound-identity-fixtures.js';

const roots: string[] = [];
const sessionId = 'agent:planner:project';
const sourceInputId = 'source-input-identity';
const startedAt = '2026-07-19T10:00:00.000Z';
const errorCompletedAt = '2026-07-19T10:00:01.000Z';
const successCompletedAt = '2026-07-19T10:00:02.000Z';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('provider exchange publication security projection', () => {
  it('publishes one post-append Agent hint per canonical-session exchange and none for other identities or failure', () => {
    const root = projectRoot();
    const readableCounts: number[] = [];
    const freshness: Pick<FreshnessEffects, 'llmExchangeChanged'> = {
      llmExchangeChanged: jest.fn(() => {
        readableCounts.push(readAppLogEntries(root, 'provider_exchange').length);
      }),
    };
    const service = invocationService(root, freshness);

    service.projectProviderExchanges('agent:planner:project', sourceInputId, providerAttempts(), []);
    expect(readableCounts).toEqual([1, 2]);
    expect(readAppLogEntries(root, 'provider_exchange').map((row) => row.data.attempt_index)).toEqual([0, 1]);

    for (const [ordinal, session] of ['agent:analyst:global', 'agent:reviewer:project', 'agent:executor:project'].entries()) {
      const input = `canonical-${ordinal}`;
      service.projectProviderExchanges(session, input, [attemptFor(input, ordinal)], []);
    }
    expect(readableCounts).toEqual([1, 2, 3, 4, 5]);

    for (const [ordinal, session] of ['summary:round-1', 'summary:merge', 'provider:other'].entries()) {
      const input = `non-agent-${ordinal}`;
      service.projectProviderExchanges(session, input, [attemptFor(input, ordinal)], []);
    }
    expect(readAppLogEntries(root, 'provider_exchange')).toHaveLength(8);
    expect(readableCounts).toEqual([1, 2, 3, 4, 5]);

    service.projectProviderExchanges('agent:planner:project', 'empty', [], []);
    expect(readableCounts).toHaveLength(5);
  });

  it('commits a duplicate canonical exchange before one strict Agent observer failure and stops later attempts', () => {
    const root = projectRoot();
    const llmExchangeChanged = jest.fn(() => {
      readAppLogEntries(root, 'provider_exchange');
    });
    const changes = { llmExchangeChanged };
    const service = invocationService(root, changes);
    service.projectProviderExchanges(sessionId, sourceInputId, [providerAttempts()[0]!], []);

    expect(() => service.projectProviderExchanges(sessionId, sourceInputId, providerAttempts(), [])).toThrow(/duplicate logical id/);
    const rows = rawProviderRows(root);
    expect(rows.map((row) => providerExchangeLogId(row.data))).toEqual([
      providerExchangeLogId({ session_id: sessionId, source_input_id: sourceInputId, attempt_index: 0 }),
      providerExchangeLogId({ session_id: sessionId, source_input_id: sourceInputId, attempt_index: 0 }),
    ]);
    expect(llmExchangeChanged).toHaveBeenCalledTimes(2);
    expect(() => readAppLogEntries(root, 'provider_exchange')).toThrow(/duplicate logical id/);
  });

  it('commits a duplicate noncanonical exchange without an Agent hint and rejects it only on strict read', () => {
    const root = projectRoot();
    const llmExchangeChanged = jest.fn();
    const changes = { llmExchangeChanged };
    const service = invocationService(root, changes);
    const attempt = attemptFor('summary-input', 0);
    service.projectProviderExchanges('summary:round-1', 'summary-input', [attempt], []);
    service.projectProviderExchanges('summary:round-1', 'summary-input', [attempt], []);
    expect(rawProviderRows(root).map((row) => providerExchangeLogId(row.data))).toEqual([
      providerExchangeLogId({ session_id: 'summary:round-1', source_input_id: 'summary-input', attempt_index: 0 }),
      providerExchangeLogId({ session_id: 'summary:round-1', source_input_id: 'summary-input', attempt_index: 0 }),
    ]);
    expect(llmExchangeChanged).not.toHaveBeenCalled();
    expect(() => readAppLogEntries(root, 'provider_exchange')).toThrow(/duplicate logical id/);
  });

  it('redacts classified diagnostic fields before durable append without changing identity or source attempts', () => {
    const root = projectRoot();
    const service = invocationService(root);
    const attempts = providerAttempts();
    const originalAttempts = structuredClone(attempts);
    const assistantOutputIds = ['assistant-output-identity'];

    service.projectProviderExchanges(sessionId, sourceInputId, attempts, assistantOutputIds);

    expect(attempts).toEqual(originalAttempts);
    const rows = readAppLogEntries(root, 'provider_exchange');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.data.attempt_index)).toEqual([0, 1]);
    expect(rows.map((row) => providerExchangeLogId(row.data))).toEqual([
      providerExchangeLogId({ session_id: sessionId, source_input_id: sourceInputId, attempt_index: 0 }),
      providerExchangeLogId({ session_id: sessionId, source_input_id: sourceInputId, attempt_index: 1 }),
    ]);

    for (const [index, row] of rows.entries()) {
      expect(row.data.session_id).toBe(sessionId);
      expect(row.data.source_input_id).toBe(sourceInputId);
      expect(row.data.payload.source_input_id).toBe(sourceInputId);
      expect(row.data.timestamp).toBe(index === 0 ? errorCompletedAt : successCompletedAt);
      expect(row.data.payload.started_at).toBe(startedAt);
      expect(row.data.payload.completed_at).toBe(row.data.timestamp);
      expect(row.data.payload.request_params).toEqual({
        endpoint: 'https://%5BREDACTED%5D:%5BREDACTED%5D@tok-provider.invalid/sk-model?[REDACTED]',
        method: 'POST',
        stream: false,
        offered_tools_count: 2,
        temperature: 0.7,
        max_tokens: 4096,
      });
    }

    const errorPayload = rows[0]!.data.payload;
    expect(errorPayload).toMatchObject({
      status: 'error',
      transport: 'generic',
      response_status: 401,
      latency_ms: 1000,
      terminal_tool_fired: null,
      error: { status: 401 },
    });
    if (errorPayload.status !== 'error') throw new Error('Expected error payload.');
    expect(errorPayload.error.name).toBe('SyntheticError tok_error_name_secret');
    expect(errorPayload.error.message).toContain('[REDACTED]');
    expect(errorPayload.error.message).toContain('provider rejected');

    const successPayload = rows[1]!.data.payload;
    expect(successPayload).toMatchObject({
      status: 'ok',
      contract_id: 'safe-contract.v1',
      contract_name: 'safe-contract',
      provider: 'safe-provider',
      model: 'safe-model',
      account: 'safe-account',
      response_status: 200,
      token_usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      latency_ms: 2000,
      assistant_output_ids: assistantOutputIds,
    });
    if (successPayload.status !== 'ok') throw new Error('Expected success payload.');
    expect(successPayload.finish_reason).toBe('safe-finish tok_finish_secret');
    expect(successPayload.terminal_tool_fired).toBe('safe-tool tok_tool_secret');

    const bytes = readFileSync(appLogFile(root), 'utf8');
    for (const secret of classifiedSecrets) expect(bytes).not.toContain(secret);
    expect(bytes).toContain('[REDACTED]');
    for (const identity of structuralIdentities) expect(bytes).toContain(identity);
  });

  it('projects every transport request variant directly and rejects an unclassified adapter key', () => {
    const common = {
      contract_id: 'tok_contract', contract_name: 'sk-contract', provider: OUTBOUND_IDENTITY, model: 'rt_model',
      account: 'tok_account', source_input_id: 'tok_input', attempt_index: 0, started_at: startedAt,
      completed_at: successCompletedAt, status: 'ok' as const, terminal_tool_fired: 'tok_tool', assistant_output_ids: ['sk-output'],
    };
    const endpoint = `https://user:pass@${OUTBOUND_IDENTITY}.invalid/sk-model?token=${OUTBOUND_RAW_MARKER}#fragment-secret`;
    const cases: ProviderExchangeAttempt[] = [
      { ...common, transport: 'generic', request_params: { endpoint, method: 'POST', stream: false, offered_tools_count: 1, temperature: 0.2, max_tokens: 8 } },
      { ...common, transport: 'codex', request_params: { endpoint, method: 'POST', stream: true, offered_tools_count: 2 } },
      { ...common, transport: 'openai-responses', request_params: { endpoint, method: 'POST', stream: true, offered_tools_count: 3, max_output_tokens: 16, include: ['tok_include'], store: false, reasoning_keys: ['sk-reasoning'] } },
    ];

    for (const [attempt_index, attempt] of cases.entries()) {
      const projected = projectProviderExchangeForPublication({ ...attempt, attempt_index } as ProviderExchangeAttempt & { attempt_index: number }, ['sk-output']);
      expect(projected.request_params.endpoint).toBe(`https://%5BREDACTED%5D:%5BREDACTED%5D@${OUTBOUND_IDENTITY}.invalid/sk-model?[REDACTED]`);
      expect(projected.contract_id).toBe('tok_contract');
      expect(projected.provider).toBe(OUTBOUND_IDENTITY);
      expect(projected.model).toBe('rt_model');
    }
    expect(cases[2]!.request_params).toMatchObject({ include: ['tok_include'], reasoning_keys: ['sk-reasoning'] });
    expect(JSON.stringify(cases.map((attempt, attempt_index) => projectProviderExchangeForPublication({ ...attempt, attempt_index }, [])))).not.toContain(OUTBOUND_RAW_MARKER);

    expect(() => projectProviderExchangeForPublication({
      ...cases[0]!, attempt_index: 4, request_params: { ...cases[0]!.request_params, new_adapter_member: 'unclassified' },
    } as ProviderExchangeAttempt & { attempt_index: number }, [])).toThrow(/unrecognized key/i);
  });

  it('rejects a source-input mismatch before appending that attempt', () => {
    const root = projectRoot();
    const service = invocationService(root);
    const attempt = { ...providerAttempts()[0]!, source_input_id: 'different-source-input' };

    let thrown: unknown;
    try { service.projectProviderExchanges(sessionId, sourceInputId, [attempt], []); } catch (error) { thrown = error; }
    expect(thrown).toEqual(expect.objectContaining({ message: expect.stringMatching(/does not match/) }));
    expect(readAppLogEntries(root)).toEqual([]);
  });
});

const classifiedSecrets = [
  'endpoint-user-secret',
  'endpoint-password-secret',
  'endpoint-query-secret',
  'tok_error_message_secret',
];

const structuralIdentities = ['tok_contract_id_secret', 'tok_contract_name_secret', 'tok_provider_secret', 'tok_model_secret', 'tok_account_secret', 'tok_finish_secret', 'tok_tool_secret', 'tok_error_name_secret'];

function providerAttempts(): ProviderExchangeAttempt[] {
  const requestParams = {
    endpoint: 'https://endpoint-user-secret:endpoint-password-secret@tok-provider.invalid/sk-model?api_key=endpoint-query-secret#fragment-secret',
    method: 'POST',
    stream: false,
    offered_tools_count: 2,
    temperature: 0.7,
    max_tokens: 4096,
  };
  return [
    {
      contract_id: 'diagnostic tok_contract_id_secret',
      contract_name: 'diagnostic tok_contract_name_secret',
      transport: 'generic',
      provider: 'diagnostic tok_provider_secret',
      model: 'diagnostic tok_model_secret',
      account: 'diagnostic tok_account_secret',
      source_input_id: sourceInputId,
      attempt_index: 0,
      request_params: structuredClone(requestParams),
      started_at: startedAt,
      completed_at: errorCompletedAt,
      status: 'error',
      response_status: 401,
      latency_ms: 1000,
      terminal_tool_fired: null,
      error: { name: 'SyntheticError tok_error_name_secret', message: 'provider rejected tok_error_message_secret', status: 401 },
    },
    {
      contract_id: 'safe-contract.v1',
      contract_name: 'safe-contract',
      transport: 'generic',
      provider: 'safe-provider',
      model: 'safe-model',
      account: 'safe-account',
      source_input_id: sourceInputId,
      attempt_index: 1,
      request_params: structuredClone(requestParams),
      started_at: startedAt,
      completed_at: successCompletedAt,
      status: 'ok',
      response_status: 200,
      finish_reason: 'safe-finish tok_finish_secret',
      token_usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      latency_ms: 2000,
      terminal_tool_fired: 'safe-tool tok_tool_secret',
    },
  ];
}

function attemptFor(input: string, attemptIndex: number): ProviderExchangeAttempt {
  return { ...providerAttempts()[1]!, source_input_id: input, attempt_index: attemptIndex, completed_at: `2026-07-19T10:01:${String(attemptIndex).padStart(2, '0')}.000Z` };
}

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-provider-exchange-security-'));
  roots.push(root);
  return root;
}

function rawProviderRows(root: string): Array<{ type: 'provider_exchange'; data: Parameters<typeof providerExchangeLogId>[0] }> {
  return readFileSync(appLogFile(root), 'utf8').trim().split('\n').flatMap((line) => (JSON.parse(line) as { rows: Array<{ type: 'provider_exchange'; data: Parameters<typeof providerExchangeLogId>[0] }> }).rows);
}

function invocationService(
  root: string,
  freshness: Pick<FreshnessEffects, 'llmExchangeChanged'> = { llmExchangeChanged() {} },
): InvocationService {
  return new InvocationService({
    projectRoot: root,
    freshness,
    registry: {} as never,
    router: {} as never,
    candidateAvailability: {} as never,
  });
}
