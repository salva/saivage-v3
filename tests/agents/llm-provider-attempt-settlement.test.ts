import { afterEach, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { createProviderExchangeRecorder as realRecorder } from '../../src/agents/provider-exchange-recorder.js';
import { selectLlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';
import { controlledResponse } from '../helpers/provider-inactivity.js';
import type { CandidateRequestPlan, LlmCompleteOptions } from '../../src/contracts/index.js';

afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); jest.resetModules(); });

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
    candidate, capabilities: { transportProtocol: 'openai-codex-backend', toolsMode: 'native', exclusiveToolChoiceSupport: 'parallel_off', quirks: [] },
    adapter: { ...adapter, deriveWire: () => ({ endpoint: 'https://test.invalid', headers: {}, requestParams: {}, transport: 'codex' }) },
    request: { body: {}, serializedBody, requestHash: createHash('sha256').update(serializedBody).digest('hex'), estimatedWireInputTokens: 1 },
  };
  const account = { name: '_implicit', models: ['model'] };
  const registry = { get: () => ({ implicitAccount: account, apiKey: 'synthetic', baseUrl: 'https://test.invalid', getAllAccounts: () => [] }) } as never;
  const options: LlmCompleteOptions = { inputId: 'settlement', temperature: 0, max_tokens: 10, tools: [], tool_choice: 'auto', terminalToolOffered: [], contract_id: 'test.v1', contractName: 'test' };
  let stream!: ReturnType<typeof controlledResponse>;
  let effective!: AbortSignal;
  const owner = new AbortController();
  options.signal = owner.signal;
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => { effective = init!.signal!; stream = controlledResponse(effective); return stream.response; });
  const pending = executeLlmProviderAttempt({ projectRoot: '.', registry, plan, options, capabilityRequest: {} });
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
