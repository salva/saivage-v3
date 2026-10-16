import { afterEach, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { createProviderExchangeRecorder as realRecorder } from '../../src/agents/provider-exchange-recorder.js';
import { selectLlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';
import { controlledResponse } from '../helpers/provider-inactivity.js';
import type { CandidateRequestPlan, LlmCompleteOptions } from '../../src/contracts/index.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';
import { invocationProviderRegistry } from '../helpers/invocation-provider-fixture.js';
import { NO_FRESHNESS_EFFECTS } from '../../src/contracts/index.js';

afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); jest.resetModules(); });

it('retains the exact cancelled owner inside its envelope only after real recorder settlement', async () => {
  let enter!: () => void;
  const recording = new Promise<void>(resolve => { enter = resolve; });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const recordError = jest.fn();
  jest.unstable_mockModule('../../src/agents/provider-exchange-recorder.js', () => ({
    createProviderExchangeRecorder() {
      const recorder = realRecorder();
      return { ...recorder, async beginExchange(meta: Parameters<typeof recorder.beginExchange>[0]) {
        const handle = await recorder.beginExchange(meta);
        return { ...handle, async recordError(...args: Parameters<typeof handle.recordError>) {
          recordError(...args); enter(); await held; await handle.recordError(...args);
        } };
      } };
    },
  }));
  const { executeLlmProviderAttempt } = await import('../../src/agents/llm-provider-attempt.js');
  const candidate = { provider: 'test', account: null, model: 'model' };
  const owner = new AbortController();
  const reason = new Error('urgent owner abort');
  jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { owner.abort(reason); throw reason; });
  const serializedBody = '{}';
  const plan: CandidateRequestPlan = { candidate, capabilities: { transportProtocol: 'openai-chat-completions', imageInput: false, toolsMode: 'native', exclusiveToolChoiceSupport: 'native', quirks: [] }, adapter: selectLlmProtocolAdapter('openai-chat-completions'), request: { body: {}, serializedBody, requestHash: createHash('sha256').update(serializedBody).digest('hex'), imageCount: 0, estimatedWireInputTokens: 1 } };
  const options: LlmCompleteOptions = { signal: owner.signal, providerSessionId: 'synthetic', inputId: 'settlement', temperature: 0, max_tokens: 100, tools: [], tool_choice: 'auto', terminalToolOffered: [], contract_id: 'test.v1', contractName: 'test' };
  let settled = false;
  const pending = executeLlmProviderAttempt({ projectRoot: '.', registry: invocationProviderRegistry([candidate]), plan, options, capabilityRequest: {}, attemptContext: { sourceSessionId: null, invocationSessionId: 'internal:settlement-test', inputId: options.inputId, purpose: 'internal-summary', attemptIndex: 0 } }).catch(error => { settled = true; return error; });
  await recording;
  expect(settled).toBe(false);
  expect(recordError).toHaveBeenCalledTimes(1);
  release();
  const failure = await pending;
  expect(failure.originalFailure).toBe(reason);
  expect(failure.provider_exchanges).toMatchObject([{ status: 'error', error: { name: 'Error', message: reason.message } }]);
});

it.each([0, 1])('actual summary invocation preserves recorder rejection racing abort with %s prior attempts', async prior => {
  jest.useFakeTimers({ now: 0 });
  let enter!: () => void;
  const recording = new Promise<void>(resolve => { enter = resolve; });
  let rejectRecording!: (error: unknown) => void;
  const held = new Promise<never>((_resolve, reject) => { rejectRecording = reject; });
  let errors = 0;
  jest.unstable_mockModule('../../src/agents/provider-exchange-recorder.js', () => ({
    createProviderExchangeRecorder() {
      const recorder = realRecorder();
      return { ...recorder, async beginExchange(meta: Parameters<typeof recorder.beginExchange>[0]) {
        const handle = await recorder.beginExchange(meta);
        return { ...handle, async recordError(...args: Parameters<typeof handle.recordError>) {
          if (++errors > prior) { enter(); await held; }
          await handle.recordError(...args);
        } };
      } };
    },
  }));
  const { InvocationService } = await import('../../src/agents/invocation-service.js');
  const { MemoryCandidateAvailability } = await import('../../src/agents/candidate-availability.js');
  const { invokeSummaryRequest, buildSummaryRequestInput, admitSummaryRequest } = await import('../../src/runtime/actors/compaction/summarizer.js');
  const { ProviderTurnFailure } = await import('../../src/contracts/index.js');
  const candidate = { provider: 'test', account: null, model: 'model' };
  const availability = new MemoryCandidateAvailability();
  const markFailed = jest.spyOn(availability, 'markFailed');
  const service = new InvocationService({ projectRoot: '.', registry: invocationProviderRegistry([candidate]), candidateAvailability: availability, freshness: NO_FRESHNESS_EFFECTS });
  const input = buildSummaryRequestInput({ candidate, sourceSessionId: 'agent:planner:project', instruction: 'summarize', items: [] });
  const admission = service.preparePrimaryRequestAdmission(input);
  if (admission.kind !== 'admitted') throw new Error('Expected admitted request');
  const verdict = admission.candidates[0];
  if (!verdict || verdict.kind !== 'admitted') throw new Error('Expected admission');
  const plan = verdict.plan;
  const packed = admitSummaryRequest({ serialization: { serializedRequest: plan.request.serializedBody, requestSha256: plan.request.requestHash, estimatedInputTokens: plan.request.estimatedWireInputTokens, imageCount: 0 }, contextUtilizationFraction: .8, contextWindowTokens: 100_000, maxOutputTokens: 10_000 });
  if (packed.kind !== 'admitted') throw new Error('Expected summary admission');
  const controller = new AbortController();
  const reason = new Error('same message');
  const actual = new Error(reason.message);
  const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('not JSON', { status: 200 }));
  const project = jest.fn<import('../../src/runtime/actors/compaction/summarizer.js').SummarizerProviderPort['projectProviderExchanges']>();
  const pending = invokeSummaryRequest({ input, admitted: packed, signal: controller.signal, summarizerProvider: { candidate, contextWindowTokens: 100_000, maxOutputTokens: 10_000, materializeImage: async () => { throw new Error('No images'); }, serializeSummaryRequest: () => { throw new Error('Already admitted'); }, completeTurn: () => service.executeSummaryWithRecovery(admission, controller.signal), projectProviderExchanges: project } }).catch(error => error);
  await jest.advanceTimersByTimeAsync(prior * 60_000);
  await recording;
  const mutationsBeforeAbort = markFailed.mock.calls.length;
  controller.abort(reason);
  rejectRecording(actual);
  const failure = await pending;
  if (prior === 0) {
    expect(failure).toBe(actual);
    expect(project).not.toHaveBeenCalled();
  } else {
    expect(failure).toBeInstanceOf(ProviderTurnFailure);
    expect(failure.originalFailure).toBe(actual);
    expect(failure.provider_exchanges).toMatchObject([{ attempt_index: 0, source_input_id: input.inputId }]);
    expect(project).toHaveBeenCalledTimes(1);
    expect(project.mock.calls[0]![3]).toHaveLength(1);
  }
  expect(fetch).toHaveBeenCalledTimes(prior + 1);
  expect(markFailed).toHaveBeenCalledTimes(mutationsBeforeAbort);
  expect(jest.getTimerCount()).toBe(0);
});

it.each([false, true])('runner overload recorder failure keeps exact identity before settled reads (unknown=%s)', async unknown => {
  jest.useFakeTimers();
  const failure = unknown ? new PublicationOutcomeUnknownError(new Error('recording uncertainty')) : new Error('ordinary recorder failure');
  const recordError = jest.fn(async () => { throw failure; });
  const settled = jest.fn(() => []);
  jest.unstable_mockModule('../../src/agents/provider-exchange-recorder.js', () => ({
    createProviderExchangeRecorder: () => ({ beginExchange: async () => ({ recordError }), settledAttempts: settled }),
  }));
  const { executeLlmProviderAttempt } = await import('../../src/agents/llm-provider-attempt.js');
  const candidate = { provider: 'test', account: null, model: 'model' };
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 'server_is_overloaded' } }), { status: 503 }));
  const serializedBody = '{}';
  const plan: CandidateRequestPlan = { candidate,
    capabilities: { transportProtocol: 'openai-chat-completions', imageInput: false, toolsMode: 'native', exclusiveToolChoiceSupport: 'native', quirks: [] },
    adapter: selectLlmProtocolAdapter('openai-chat-completions'),
    request: { body: {}, serializedBody, requestHash: createHash('sha256').update(serializedBody).digest('hex'), imageCount: 0, estimatedWireInputTokens: 1 } };
  const options: LlmCompleteOptions = { providerSessionId: 'synthetic', inputId: 'settlement', temperature: 0, max_tokens: 100, tools: [], tool_choice: 'auto', terminalToolOffered: [], contract_id: 'test.v1', contractName: 'test' };
  await expect(executeLlmProviderAttempt({ projectRoot: '.', registry: invocationProviderRegistry([candidate]), plan, options, capabilityRequest: {}, attemptContext: { sourceSessionId: null, invocationSessionId: 'internal:settlement-test', inputId: options.inputId, purpose: 'primary', attemptIndex: 0 } })).rejects.toBe(failure);
  expect(recordError).toHaveBeenCalledTimes(1);
  expect(settled).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(7_200_000);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

it('keeps valid Codex completion immediately before expiry successful throughout delayed recorder settlement', async () => {
  jest.useFakeTimers();
  let release!: () => void;
  const delay = new Promise<void>(resolve => { release = resolve; });
  let recording = false;
  jest.unstable_mockModule('../../src/agents/provider-exchange-recorder.js', () => ({
    createProviderExchangeRecorder() {
      const recorder = realRecorder();
      return { ...recorder, async beginExchange(meta: Parameters<typeof recorder.beginExchange>[0]) {
        const handle = await recorder.beginExchange(meta);
        return { ...handle, async recordResponse(...args: Parameters<typeof handle.recordResponse>) {
          recording = true;
          await delay;
          await handle.recordResponse(...args);
        } };
      } };
    },
  }));
  const { executeLlmProviderAttempt } = await import('../../src/agents/llm-provider-attempt.js');
  const candidate = { provider: 'test', model: 'model', account: null } as const;
  const adapter = selectLlmProtocolAdapter('openai-codex-backend');
  const serializedBody = '{}';
  const plan: CandidateRequestPlan = {
    candidate, capabilities: { transportProtocol: 'openai-codex-backend', imageInput: false, toolsMode: 'native', exclusiveToolChoiceSupport: 'parallel_off', quirks: [] },
    adapter: { ...adapter, deriveWire: () => ({ endpoint: 'https://test.invalid', headers: {}, requestParams: {}, transport: 'codex' }) },
    request: { body: {}, serializedBody, requestHash: createHash('sha256').update(serializedBody).digest('hex'), imageCount: 0, estimatedWireInputTokens: 1 },
  };
  const account = { name: '_implicit', models: ['model'] };
  const registry = { get: () => ({ implicitAccount: account, apiKey: 'synthetic', baseUrl: 'https://test.invalid', getAllAccounts: () => [] }) } as never;
  const options: LlmCompleteOptions = { providerSessionId: 'synthetic-provider-session', inputId: 'settlement', temperature: 0, max_tokens: 10, tools: [], tool_choice: 'auto', terminalToolOffered: [], contract_id: 'test.v1', contractName: 'test' };
  let stream!: ReturnType<typeof controlledResponse>;
  let effective!: AbortSignal;
  const owner = new AbortController();
  options.signal = owner.signal;
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => { effective = init!.signal!; stream = controlledResponse(effective); return stream.response; });
  const pending = executeLlmProviderAttempt({ projectRoot: '.', registry, plan, options, capabilityRequest: {}, attemptContext: { sourceSessionId: null, invocationSessionId: 'internal:settlement-test', inputId: options.inputId, purpose: 'primary', attemptIndex: 0 } });
  try {
    await jest.advanceTimersByTimeAsync(119999);
    stream.send('data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"complete"}]}}\n\ndata: {"type":"response.completed","response":{"id":"r"}}\n\n');
    await jest.advanceTimersByTimeAsync(0);
    expect(recording).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(240000);
    expect(effective.aborted).toBe(false);
    stream.close(); release();
    expect(await pending).toMatchObject({ result: { kind: 'message', content: 'complete' }, provider_exchanges: [{ status: 'ok', response_status: 200 }] });
  } finally {
    release();
    owner.abort(new Error('test cleanup'));
    stream?.close();
    await pending.catch(() => {});
  }
});
