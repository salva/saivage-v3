import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';

import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { appLogFile } from '../../../src/persistence/layout.js';
import { readAppLogEntries } from '../../../src/persistence/app-log.js';
import { readLatestProviderExchangePayload } from '../../../src/persistence/provider-exchange-log.js';
import { appendLlmProviderExchangeEntries } from '../../../src/runtime/actors/llm-delivery-log.js';
import { readConversationMessages } from '../../../src/runtime/actors/conversation-store.js';
import type { ProviderExchangePayload } from '../../../src/contracts/provider-exchange.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'saivage-provider-exchange-test-'));
  initProjectTree(dir);
  return dir;
}

function payload(overrides: Partial<ProviderExchangePayload> = {}): ProviderExchangePayload {
  return {
    contract_id: 'planner.v1',
    contract_name: 'planner',
    transport: 'generic',
    provider: 'test-provider',
    model: 'test-model',
    source_input_id: 'planner:card:1',
    attempt_index: 0,
    request_params: { temperature: 0 },
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:01.000Z',
    status: 'ok',
    response_status: 200,
    terminal_tool_fired: null,
    assistant_output_ids: ['planner:card:1:message'],
    ...overrides,
  } as ProviderExchangePayload;
}

function input(): LlmInvocationInput {
  return {
    inputId: 'planner:card:1',
    agentId: 'planner:card',
    role: 'planner',
    sessionId: 'planner:card',
    systemPrompt: 'prompt',
    contextMessages: [],
    tools: [],
    terminalToolNames: [],
    modelParams: {},
    capabilityRequest: {},
    episodeContext: {},
  };
}

describe('provider_exchange app-log entries', () => {
  it('stores metadata-only provider exchanges in the app log instead of conversations', () => {
    const projectRoot = root();
    appendLlmProviderExchangeEntries(projectRoot, input(), [payload()], ['planner:card:1:message']);

    expect(readConversationMessages(projectRoot, 'planner:card')).toEqual([]);

    const [entry] = readAppLogEntries(projectRoot, 'provider_exchange');
    expect(entry).toMatchObject({ type: 'provider_exchange' });
    expect(entry!.data).toMatchObject({
      session_id: 'planner:card',
      source_input_id: 'planner:card:1',
      attempt_index: 0,
      payload: { source_input_id: 'planner:card:1', assistant_output_ids: ['planner:card:1:message'] },
    });
    expect(readLatestProviderExchangePayload(projectRoot, 'planner:card')).toMatchObject({ model: 'test-model', source_input_id: 'planner:card:1' });

    const rawLog = readFileSync(appLogFile(projectRoot), 'utf-8');
    expect(rawLog).not.toContain('request_body');
    expect(rawLog).not.toContain('response_body');
    expect(rawLog).not.toContain('bodyRaw');
  });

  it('preserves attempt ordering validation and reads the latest attempt by timestamp', () => {
    const projectRoot = root();
    appendLlmProviderExchangeEntries(projectRoot, input(), [
      payload({ model: 'attempt-0', attempt_index: 0, completed_at: '2026-01-01T00:00:01.000Z' }),
      payload({ model: 'attempt-1', attempt_index: 1, completed_at: '2026-01-01T00:00:02.000Z' }),
    ], ['planner:card:1:message']);

    expect(readLatestProviderExchangePayload(projectRoot, 'planner:card')?.model).toBe('attempt-1');
    expect(() => appendLlmProviderExchangeEntries(projectRoot, input(), [payload({ attempt_index: 2 })], [])).toThrow(/consecutive/);
  });
});
