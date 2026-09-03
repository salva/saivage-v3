import { invokeTool, type InvocationSurface } from '../../src/tools/invocation.js';
import type { ToolResult } from '../../src/contracts/tool-result.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import type { LlmToolInvocationContext } from '../../src/runtime/actors/executing-llm-snapshot.js';

export async function invokeTestTool(surface: InvocationSurface, name: string, args: unknown, signal: AbortSignal = new AbortController().signal, context?: LlmToolInvocationContext): Promise<ToolResult> {
  const execution = await invokeTool(surface, name, args, signal, context);
  return settleToolActionOutcome(execution.providerOutcome).providerResult;
}
