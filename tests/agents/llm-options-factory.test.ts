import { describe, expect, it } from '@jest/globals';
import { buildLlmOptions } from '../../src/agents/llm-options-factory.js';

describe('LLM options authority', () => {
  it('builds the exact provider options contract', () => {
    const options = buildLlmOptions('planner', [], [], { temperature: 0.2, max_tokens: 1234 }, undefined, 'input');
    expect(options).toEqual({
      inputId: 'input',
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
