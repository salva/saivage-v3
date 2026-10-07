import { afterEach, expect, it, jest } from '@jest/globals';
import type { InvocationService } from '../../src/agents/invocation-service.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import type { ProviderConversationProjection } from '../../src/contracts/index.js';

const materialize = jest.fn<(root: string, projection: ProviderConversationProjection, signal?: AbortSignal) => Promise<ProviderConversationProjection>>();
jest.unstable_mockModule('../../src/application/conversation-image-materialization.js', () => ({ materializeProviderConversation: materialize }));
const { createInvocationServiceProvider } = await import('../../src/application/invocation-service-provider.js');
afterEach(() => { materialize.mockReset(); });

it.each(['primary', 'recovery', 'pinned'] as const)('checks cancellation after %s image preparation before candidate admission', async mode => {
  let release!: (projection: ProviderConversationProjection) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  materialize.mockImplementation(() => new Promise(resolve => { release = resolve; entered(); }));
  const preparePrimaryRequestAdmission = jest.fn();
  const prepareAdmittedRecovery = jest.fn();
  const preflightPinnedContentPolicyRequest = jest.fn();
  const service = { preparePrimaryRequestAdmission, prepareAdmittedRecovery, preflightPinnedContentPolicyRequest } as unknown as InvocationService;
  const provider = createInvocationServiceProvider(service, '/test-owned-project');
  const projection: ProviderConversationProjection = { sourceSessionId: 'agent:analyst:global', messages: [] };
  const input = { providerConversation: projection } as LlmInvocationInput;
  const controller = new AbortController();
  const operation = mode === 'primary'
    ? provider.preparePrimaryRequestAdmission(input as never, controller.signal)
    : mode === 'recovery'
      ? provider.prepareAdmittedRecovery({ suspension: {} as never, input: input as never, signal: controller.signal })
      : provider.preflightPinnedContentPolicyRequest(input, controller.signal);
  await started;
  const reason = new Error('cancelled during materialization');
  controller.abort(reason);
  release(projection);
  await expect(operation).rejects.toBe(reason);
  expect(materialize).toHaveBeenCalledWith('/test-owned-project', projection, controller.signal);
  expect(preparePrimaryRequestAdmission).not.toHaveBeenCalled();
  expect(prepareAdmittedRecovery).not.toHaveBeenCalled();
  expect(preflightPinnedContentPolicyRequest).not.toHaveBeenCalled();
});
