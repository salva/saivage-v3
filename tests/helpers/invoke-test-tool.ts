import { invokeTool, settlementProviderResult, type InvocationSurface, type ToolResult } from '../../src/tools/invocation.js';
import type { LlmToolInvocationContext } from '../../src/runtime/actors/executing-llm-snapshot.js';

export async function invokeTestTool(surface: InvocationSurface, name: string, args: unknown, signal: AbortSignal = new AbortController().signal, context?: LlmToolInvocationContext): Promise<ToolResult> {
  return settlementProviderResult({ kind: 'executed', execution: await invokeTool(surface, name, args, signal, context) });
}
