import type { ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import type { PreparedLlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import type { LLMProviderPort } from '../../src/runtime/actors/llm-actor.js';
import type { ProviderExchangeAttempt, ProviderExchangePublicationContext } from '../../src/contracts/provider-exchange.js';

type CompleteTurn = (input: PreparedLlmInvocationInput, signal: AbortSignal) => Promise<ProviderTurnCompletion>;

export function actorProvider(
  completeTurn: CompleteTurn,
  projectProviderExchanges?: (sessionId: string, sourceInputId: string, attempts: ProviderExchangeAttempt[], context: ProviderExchangePublicationContext) => void,
): LLMProviderPort {
  const signals = new WeakMap<object, AbortSignal>();
  const inputs = new WeakMap<object, PreparedLlmInvocationInput>();
  return {
    preparePrimaryRequest(input, signal) {
      const admission = { kind: 'admitted', request: input } as never;
      signals.set(admission, signal);
      inputs.set(admission, input);
      return admission;
    },
    executeAdmitted(admission) {
      return completeTurn(inputs.get(admission)!, signals.get(admission) ?? new AbortController().signal);
    },
    resumeSuspended(_suspension, input, signal) {
      return completeTurn(input, signal);
    },
    preflightPinned(input, signal) {
      if (input.routePass.kind !== 'pinned-content-policy-retry') throw new Error('Test pinned preflight requires pinned input.');
      const preflight = { kind: 'admitted', request: input, candidate: input.routePass.candidate, plan: { candidate: input.routePass.candidate } } as never;
      signals.set(preflight, signal);
      inputs.set(preflight, input);
      return preflight;
    },
    executePinned(preflight) {
      return completeTurn(inputs.get(preflight)!, signals.get(preflight) ?? new AbortController().signal);
    },
    ...(projectProviderExchanges ? { projectProviderExchanges } : {}),
  };
}

export function successfulActorProvider(content = 'done'): LLMProviderPort {
  return actorProvider(async () => ({ result: { kind: 'message', content }, provider_exchanges: [] }));
}
