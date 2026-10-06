import { describe, expect, it } from '@jest/globals';
import { buildLlmOptions } from '../../src/agents/llm-options-factory.js';
import { sha256Hex } from '../../src/schemas/index.js';

describe('LLM options authority', () => {
  it('builds the exact provider options contract', () => {
    const options = buildLlmOptions('planner', [], [], { temperature: 0.2, max_tokens: 1234 }, undefined, 'input', { projectRoot: '/synthetic/project', sessionId: 'agent:planner:project' });
    expect(options).toEqual({
      inputId: 'input',
      providerSessionId: sha256Hex(JSON.stringify(['saivage-provider-session', '/synthetic/project', 'agent:planner:project'])),
      temperature: 0.2,
      max_tokens: 1234,
      signal: undefined,
      contract_id: 'planner.v1',
      contractName: 'planner',
      terminalToolOffered: [],
      tools: [],
      tool_choice: 'auto',
    });
  });
});
