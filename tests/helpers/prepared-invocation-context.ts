import { compileInvocationToolContract, prepareInvocationContext, PRIMARY_TOOL_RESULT_POLICY_TEMPLATE } from '../../src/runtime/actors/llm-invocation.js';

export function preparedInvocationContextFixture(instructionText = 'system', terminalToolNames: readonly string[] = []) {
  return prepareInvocationContext({
    instructionText,
    compiledTools: terminalToolNames.map((name) => compileInvocationToolContract({ type: 'function', function: { name, description: `${name} fixture`, parameters: { type: 'object' } } }, PRIMARY_TOOL_RESULT_POLICY_TEMPLATE)),
    terminalToolNames,
    dynamicBlocks: [],
  });
}
