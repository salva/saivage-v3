import { invokeToolForLlm, type InvocationSurface } from '../../src/tools/invocation.js';
import { testLlmToolInvocationContext } from './llm-test-helpers.js';
import type { ToolResult } from '../../src/contracts/tool-result.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import type { LlmToolInvocationContext } from '../../src/runtime/actors/executing-llm-snapshot.js';

export async function invokeTestTool(surface: InvocationSurface, name: string, args: unknown, signal: AbortSignal = new AbortController().signal, context?: LlmToolInvocationContext): Promise<ToolResult> {
  const settlement = await invokeToolForLlm(surface, name, args, context ?? testLlmToolInvocationContext({ sessionId: `agent:${surface.agentName}:${surface.agentName === 'analyst' || surface.agentName === 'oversight' ? 'global' : 'project'}`, toolName: name }), signal);
  return settleToolActionOutcome(settlement.kind === 'executed' ? settlement.execution.providerOutcome : settlement.providerOutcome).providerResult;
}
