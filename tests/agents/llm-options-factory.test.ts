import { describe, expect, it } from '@jest/globals';
import { buildLlmOptions } from '../../src/agents/llm-options-factory.js';
import type { LlmCompleteOptions } from '../../src/agents/llm-contracts.js';

describe('LLM options authority', () => {
  it('does not carry recorder state or create a built request', () => {
    const options = buildLlmOptions('planner', [], [], {}, undefined, 'input');
    expect(options).not.toHaveProperty('recorder');
    expect(options).not.toHaveProperty('builtCandidateRequest');
  });

  it('rejects recorder authority at the type boundary', () => {
    const value: LlmCompleteOptions = {
      inputId: 'input', contract_id: 'planner.v1', contractName: 'planner', terminalToolOffered: [], tools: [], tool_choice: 'auto',
      // @ts-expect-error recorder ownership belongs exclusively to the attempt runner
      recorder: {},
    };
    expect(value).toBeDefined();
  });
});
