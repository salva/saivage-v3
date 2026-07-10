import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initProjectTree } from '../../src/persistence/file-tree.js';
import { appendProviderExchangeLogEntry } from '../../src/persistence/provider-exchange-log.js';
import { buildAgentOperatorContractHandlers } from '../../src/server/routes/operator-agent-handlers.js';

describe('agents.llmExchange handler', () => {
  it('returns the latest app-log-backed provider exchange payload without changing response shape', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-agent-llm-exchange-'));
    initProjectTree(projectRoot);
    appendProviderExchangeLogEntry(projectRoot, {
      session_id: 'planner:project',
      source_input_id: 'planner:project:1',
      attempt_index: 0,
      timestamp: '2026-01-01T00:00:01.000Z',
      payload: {
        contract_id: 'planner.v1',
        contract_name: 'planner',
        transport: 'generic',
        provider: 'test-provider',
        model: 'test-model',
        source_input_id: 'planner:project:1',
        attempt_index: 0,
        request_params: { temperature: 0 },
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:00:01.000Z',
        status: 'ok',
        terminal_tool_fired: null,
        assistant_output_ids: ['planner:project:1:message'],
      },
    });
    const handler = buildAgentOperatorContractHandlers({ projectRoot })['agents.llmExchange']!;

    const result = await handler({
      params: { id: 'planner:project' },
      query: {},
      body: {},
      request: { log: { error: jest.fn() } },
      reply: {},
      contract: {} as never,
    } as never);

    expect(result).toEqual({ body: { exchange: expect.objectContaining({ source_input_id: 'planner:project:1', model: 'test-model' }) } });
  });
});
