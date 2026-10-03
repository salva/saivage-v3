import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { replaceAuthProfiles } from '../../src/auth/index.js';
import { NO_FRESHNESS_EFFECTS, type Candidate } from '../../src/contracts/index.js';
import type { SaivageConfig } from '../../src/schemas/saivage-config.js';
import { controlledResponse } from '../helpers/provider-inactivity.js';

const roots: string[] = [];
const stalled: Candidate = { provider: 'openai-codex', account: null, model: 'codex-test' };
const healthy: Candidate = { provider: 'healthy', account: null, model: 'chat-test' };
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-inactivity-')); roots.push(projectRoot);
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url');
  replaceAuthProfiles(projectRoot, { version: 1, profiles: { codex: { type: 'oauth', provider: 'openai-codex', accessToken: `synthetic.${payload}.signature`, expiresAt: Date.now() + 10_000_000 } } });
  const registry = new ProviderRegistry({ providers: {
    'openai-codex': { models: [stalled.model], authProfile: 'codex', baseUrl: 'https://codex.test', capabilities: { transportProtocol: 'openai-codex-backend', contextWindowTokens: 100000, maxOutputTokens: 10000 } },
    healthy: { models: [healthy.model], apiKey: 'synthetic-key', baseUrl: 'https://healthy.test', capabilities: { transportProtocol: 'openai-chat-completions', contextWindowTokens: 100000, maxOutputTokens: 10000 } },
  } } as unknown as SaivageConfig);
  const availability = new MemoryCandidateAvailability();
  const service = new InvocationService({ projectRoot, registry, candidateAvailability: availability, freshness: NO_FRESHNESS_EFFECTS });
  return { service, availability };
}

function request(chain: Candidate[]): InvocationRequest {
  return { inputId: 'inactivity-input', agentName: 'planner', sessionId: 'agent:planner:project', systemPrompt: 'system', providerConversation: { sourceSessionId: 'agent:planner:project', messages: [] }, tools: [], terminalToolNames: [], modelParams: { temperature: 0, maxTokens: 2000 }, capabilityRequest: {}, routePass: { kind: 'ordinary', candidateChain: chain } };
}

describe('Invocation Service provider inactivity recovery', () => {
  it('records comments-only Codex timeout and immediately uses a healthy admitted alternative with standard cooling', async () => {
    jest.useFakeTimers({ now: 1000 });
    const owner = new AbortController();
    const { service, availability } = fixture();
    let stream!: ReturnType<typeof controlledResponse>;
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('codex.test')) { stream = controlledResponse(init!.signal!); return stream.response; }
      expect(jest.getTimerCount()).toBe(1);
      return new Response('{"choices":[{"message":{"content":"healthy"},"finish_reason":"stop"}]}');
    });
    const admission = service.preparePrimaryRequestAdmission(request([stalled, healthy]));
    if (admission.kind !== 'admitted') throw new Error('fixture must admit');
    const pending = service.executeAdmittedWithRecovery(admission, owner.signal);
    try {
      await jest.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 3; i++) { await jest.advanceTimersByTimeAsync(30000); stream.send(': keepalive\n\n'); await jest.advanceTimersByTimeAsync(0); }
      await jest.advanceTimersByTimeAsync(30000);
      const completion = await pending;
      expect(completion.result).toEqual({ kind: 'message', content: 'healthy' });
      expect(completion.provider_exchanges).toHaveLength(2);
      expect(completion.provider_exchanges[0]).toMatchObject({ provider: stalled.provider, attempt_index: 0, status: 'error', error: { name: 'ProviderInactivityTimeoutError', message: 'Provider request inactive for 120000 ms.' } });
      expect(completion.provider_exchanges[1]).toMatchObject({ provider: healthy.provider, attempt_index: 1, status: 'ok' });
      expect(availability.getEntry(stalled)).toMatchObject({ state: 'COOLING', reason: 'timeout', untilMs: 181000 });
      expect(availability.getEntry(healthy)).toMatchObject({ state: 'HEALTHY' });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(Date.now()).toBe(121000);
      expect(stream.response.body!.locked).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      owner.abort(new Error('test cleanup'));
      stream?.close();
      await pending.catch(() => {});
    }
  });

  it('exhausts the existing four-attempt budget, with only ordinary waits and no reopened membership', async () => {
    jest.useFakeTimers({ now: 1000 });
    const owner = new AbortController();
    const { service, availability } = fixture();
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => controlledResponse(init!.signal!).response);
    const admission = service.preparePrimaryRequestAdmission(request([stalled]));
    if (admission.kind !== 'admitted') throw new Error('fixture must admit');
    const pending = service.executeAdmittedWithRecovery(admission, owner.signal).catch(error => error);
    try {
      for (let attempt = 1; attempt <= 4; attempt++) {
        await jest.advanceTimersByTimeAsync(120000);
        expect(fetch).toHaveBeenCalledTimes(attempt);
        if (attempt < 4) { expect(jest.getTimerCount()).toBe(1); await jest.advanceTimersByTimeAsync(60000); }
      }
      const error = await pending;
      expect(error).toMatchObject({ failure_phase: 'provider_attempt', originalFailure: { failure: { kind: 'timeout' } } });
      expect(error.provider_exchanges).toHaveLength(4);
      expect(error.provider_exchanges.map((value: { attempt_index: number; error: { name: string } }) => [value.attempt_index, value.error.name])).toEqual([0, 1, 2, 3].map(index => [index, 'ProviderInactivityTimeoutError']));
      expect(availability.getEntry(stalled)).toMatchObject({ state: 'COOLING', reason: 'timeout' });
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(120000);
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      owner.abort(new Error('test cleanup'));
      await pending;
    }
  });

  it('keeps pinned timeout one-shot, and racing owner cancellation never retries or mutates availability', async () => {
    jest.useFakeTimers();
    const owner = new AbortController(); const reason = new Error('owner stopped');
    let cancelled: Promise<unknown> | undefined;
    const { service, availability } = fixture();
    let stream!: ReturnType<typeof controlledResponse>;
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => { stream = controlledResponse(init!.signal!); return stream.response; });
    const pinned = service.preflightPinnedContentPolicyRequest({ ...request([stalled]), routePass: { kind: 'pinned-content-policy-retry', candidate: stalled } });
    if (pinned.kind !== 'admitted') throw new Error('fixture must admit');
    const pending = service.executePinnedContentPolicyRequest(pinned, owner.signal).catch(error => error);
    try {
      await jest.advanceTimersByTimeAsync(120000);
      expect(await pending).toMatchObject({ originalFailure: { failure: { kind: 'timeout' } }, provider_exchanges: [{ status: 'error', error: { name: 'ProviderInactivityTimeoutError' } }] });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(availability.getEntry(stalled)).toBeUndefined();
      fetch.mockImplementation(async (_url, init) => {
        const signal = init!.signal!;
        stream = controlledResponse(signal);
        signal.addEventListener('abort', () => owner.abort(reason), { once: true });
        return stream.response;
      });
      const ordinary = service.preparePrimaryRequestAdmission(request([stalled, healthy]));
      if (ordinary.kind !== 'admitted') throw new Error('fixture must admit');
      cancelled = service.executeAdmittedWithRecovery(ordinary, owner.signal).catch(error => error);
      await jest.advanceTimersByTimeAsync(120000);
      expect(await cancelled).toMatchObject({ originalFailure: { failure: { kind: 'cancelled' } }, provider_exchanges: [{ status: 'error', error: { name: 'Error', message: 'owner stopped' } }] });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(availability.getEntry(stalled)).toBeUndefined();
      expect(availability.getEntry(healthy)).toBeUndefined();
      expect(stream.response.body!.locked).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      owner.abort(new Error('test cleanup'));
      stream?.close();
      await pending;
      await cancelled;
    }
  });
});
