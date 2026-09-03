import { toolSucceeded, type ToolActionOutcome, type ToolResult } from '../../src/contracts/tool-result.js';

declare const result: ToolResult;
// @ts-expect-error A settled wire result is not action success data.
toolSucceeded(result);

const valid: ToolActionOutcome = toolSucceeded({ value: 1 });
void valid;

// @ts-expect-error Action outcomes are constructor-only and cannot contain a wire result literal.
const executor: () => Promise<ToolActionOutcome> = async () => {
  return { kind: 'succeeded', data: result };
};
void executor;
