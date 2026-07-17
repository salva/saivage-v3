import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import type { EffectiveProviderCapabilities } from '../../src/agents/provider-capabilities.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import { prepareCompaction, type CompactionConfig } from '../../src/runtime/actors/compaction/compactor.js';
import { testAppLogs } from '../helpers/app-logs.js';
import type { LlmCallFn } from '../../src/agents/llm-contracts.js';

const candidate: Candidate = { provider: 'test', account: null, model: 'model' };
const config: CompactionConfig = { enabled: true, input_budget_tokens: 1000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.55, snap: 'compact_straddler', summarizer_model: 'test/_/summary' };
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('singular invocation completion authority', () => {
  it.each([
    { transportProtocol: 'openai-chat-completions' as const, outputField: 'max_tokens' as const },
    { transportProtocol: 'openai-responses' as const, outputField: 'max_output_tokens' as const },
    { transportProtocol: 'openai-codex-backend' as const, outputField: null },
  ])('uses prepared completion for $transportProtocol admission and transport', async ({ transportProtocol, outputField }) => {
    let observedOptions: Parameters<LlmCallFn>[4] | undefined;
    const observed: LlmCallFn = async (_candidate, _prompt, _providerConversation, _session, options) => { observedOptions = options; return { result: { kind: 'message', content: 'ok' }, provider_exchanges: [] }; };
    const service = invocationService(capabilities(transportProtocol), observed);
    const request = preparedRequest();

    await service.invokeCall(request, candidate);

    const options = observedOptions!;
    expect(options.max_tokens).toBe(200);
    expect(options.builtCandidateRequest).toBeDefined();
    expect(options.builtCandidateRequest!.body[outputField ?? 'max_output_tokens']).toBe(outputField ? 200 : undefined);
    if (!outputField) expect(options.builtCandidateRequest!.body).not.toHaveProperty('max_tokens');
  });

  it('rejects prepared candidates by the prepared output value alone', async () => {
    const call = jest.fn();
    const service = invocationService({ ...capabilities('openai-chat-completions'), maxOutputTokens: 199 }, call as never);
    await expect(service.invokeCall(preparedRequest(), candidate)).rejects.toThrow(/max_output_too_small/);
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'analyst', maxTokens: 777 },
    { label: 'summarizer', maxTokens: 2000 },
    { label: 'disabled autonomous', maxTokens: undefined },
  ])('keeps $label on ordinary maxTokens without compacted admission', async ({ maxTokens }) => {
    let observedOptions: Parameters<LlmCallFn>[4] | undefined;
    const observed: LlmCallFn = async (_candidate, _prompt, _providerConversation, _session, options) => { observedOptions = options; return { result: { kind: 'message', content: 'ok' }, provider_exchanges: [] }; };
    const service = invocationService({ ...capabilities('openai-responses'), contextWindowTokens: undefined, maxOutputTokens: undefined }, observed);
    const request: InvocationRequest = { inputId: '00000000-0000-4000-8000-000000000001', role: 'analyst', sessionId: 'analyst:test', systemPrompt: 'system', providerConversation: { sourceSessionId: 'analyst:test', messages: [] }, tools: [], terminalToolNames: [], modelParams: maxTokens === undefined ? {} : { maxTokens }, capabilityRequest: {} };
    await service.invokeCall(request, candidate);
    const options = observedOptions!;
    expect(options.max_tokens).toBe(maxTokens);
    expect(options.builtCandidateRequest).toBeUndefined();
  });
});

function preparedRequest(): InvocationRequest {
  return { inputId: '00000000-0000-4000-8000-000000000001', role: 'planner', sessionId: 'planner:project', systemPrompt: 'system', providerConversation: { sourceSessionId: 'planner:project', messages: [] }, tools: [], terminalToolNames: [], modelParams: {}, preparedCompaction: prepareCompaction(config, 'system', []), capabilityRequest: {} };
}

function capabilities(transportProtocol: EffectiveProviderCapabilities['transportProtocol']): EffectiveProviderCapabilities {
  return { transportProtocol, toolsMode: 'native', exclusiveToolChoiceSupport: 'native', streaming: false, contextWindowTokens: 10000, maxOutputTokens: 1000, quirks: [] };
}

function invocationService(effective: EffectiveProviderCapabilities, llmCallFn: LlmCallFn): InvocationService {
  const root = mkdtempSync(join(tmpdir(), 'saivage-compaction-authority-'));
  roots.push(root);
  const service = new InvocationService({ projectRoot: root, saivageDir: root, appLogs: testAppLogs(root), registry: { getEffectiveCapabilities: () => effective } as never, router: {} as never, candidateAvailability: {} as never, llmCallFn });
  return service;
}
