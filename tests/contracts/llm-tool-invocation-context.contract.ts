import type { InvocationSurface } from '../../src/tools/invocation.js';
import { invokeToolForLlm } from '../../src/tools/invocation.js';
import type { LlmToolInvocationContext } from '../../src/runtime/actors/executing-llm-snapshot.js';

export function llmToolInvocationCompileContract(surface: InvocationSurface, context: LlmToolInvocationContext, signal: AbortSignal): void {
  void invokeToolForLlm(surface, 'tool', {}, context);
  void invokeToolForLlm(surface, 'tool', {}, context, signal);
  // @ts-expect-error LLM invocation context is mandatory.
  void invokeToolForLlm(surface, 'tool', {});
  // @ts-expect-error The abort signal follows the complete invocation context.
  void invokeToolForLlm(surface, 'tool', {}, signal, context);
  // @ts-expect-error Child reservation is mandatory on the singular context.
  const incomplete: LlmToolInvocationContext = { sessionId: context.sessionId, sourceInputId: context.sourceInputId, toolCallId: context.toolCallId, toolName: context.toolName, waits: context.waits };
  void incomplete;
}
