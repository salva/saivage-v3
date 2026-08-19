import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import type { SaivageConfig } from '../../src/schemas/saivage-config.js';
import { NO_FRESHNESS_EFFECTS } from '../../src/application/freshness-effects.js';
import { chatSuccess, contextExhausted, invocationProviderRegistry } from '../helpers/invocation-provider-fixture.js';

const first: Candidate = { provider: 'first', account: null, model: 'm1' };
const second: Candidate = { provider: 'second', account: null, model: 'm2' };
const roots: string[] = [];
afterEach(() => { jest.restoreAllMocks(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function refusal(): Response {
  const body = JSON.stringify({ error: { code: 'content_filter', message: 'content policy refusal' } });
  return new Response(body, { status: 400, headers: { 'content-type': 'application/json' } });
}

function service(availability = new MemoryCandidateAvailability(), overrides: Record<string, SaivageConfig['providers'][string]['capabilities']> = {}): InvocationService {
  const projectRoot = mkdtempSync(join(tmpdir(), 'content-policy-route-'));
  roots.push(projectRoot);
  return new InvocationService({ projectRoot, registry: invocationProviderRegistry([first, second], overrides), candidateAvailability: availability, freshness: NO_FRESHNESS_EFFECTS });
}

function request(routePass: InvocationRequest['routePass'], signal?: AbortSignal): InvocationRequest {
  return {
    inputId: '00000000-0000-4000-8000-000000000001', agentName: 'planner', sessionId: 'agent:planner:project', systemPrompt: 'system',
    providerConversation: { sourceSessionId: 'agent:planner:project', messages: [] }, tools: [], terminalToolNames: [],
    modelParams: { temperature: 0, maxTokens: 100 }, capabilityRequest: {}, routePass, abortSignal: signal,
  };
}

describe('content-policy route passes', () => {
  it('terminates ordinary routing at the refusing candidate without availability effects', async () => {
    const availability = new MemoryCandidateAvailability();
    const isAvailable = jest.spyOn(availability, 'isAvailable');
    const markFailed = jest.spyOn(availability, 'markFailed');
    const calls: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => { calls.push(new URL(String(input)).hostname); return refusal(); });
    const svc = service(availability);
    const admission = svc.preparePrimaryRequestAdmission(request({ kind: 'ordinary', candidateChain: [first, second] }));
    if (admission.kind !== 'admitted') throw new Error(`Expected admitted route pass, got ${admission.kind}.`);
    await expect(svc.executeAdmittedWithRecovery(admission)).rejects.toMatchObject({ failure_phase: 'provider_attempt', originalFailure: { failure: { kind: 'content_policy' } }, candidate: first });
    expect(calls).toEqual(['first.example.test']);
    expect(isAvailable).toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('rejects a capability-ineligible pinned candidate before any transport or availability effect', async () => {
    const availability = new MemoryCandidateAvailability();
    const reads = jest.spyOn(availability, 'isAvailable');
    const fetch = jest.spyOn(globalThis, 'fetch');
    const preflight = service(availability, { first: { toolsMode: 'unsupported' } })
      .preflightPinnedContentPolicyRequest({ ...request({ kind: 'pinned-content-policy-retry', candidate: first }), capabilityRequest: { requiresTools: true, requiresExclusiveToolChoice: true }, tools: [{ type: 'function', function: { name: 'x', description: 'x', parameters: {} } }] });
    expect(preflight.kind).toBe('rejected');
    if (preflight.kind !== 'rejected') throw new Error('unreachable');
    expect(preflight.verdict).toMatchObject({ kind: 'candidate_ineligible', reason: { kind: 'capability_mismatch', reasons: ['unsupported_tools_mode'] } });
    expect(fetch).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
  });

  it('rejects an oversized pinned candidate before any transport', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch');
    const preflight = service(new MemoryCandidateAvailability(), { first: { contextWindowTokens: 10 } })
      .preflightPinnedContentPolicyRequest(request({ kind: 'pinned-content-policy-retry', candidate: first }));
    expect(preflight.kind).toBe('rejected');
    if (preflight.kind !== 'rejected') throw new Error('unreachable');
    expect(preflight.verdict.kind).toBe('projection_too_large');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('makes one pinned call without any availability read/write or recovery', async () => {
    const availability = new MemoryCandidateAvailability();
    const reads = jest.spyOn(availability, 'isAvailable');
    const writes = jest.spyOn(availability, 'markFailed');
    const successes = jest.spyOn(availability, 'markSucceeded');
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(refusal());
    const svc = service(availability);
    const preflight = svc.preflightPinnedContentPolicyRequest(request({ kind: 'pinned-content-policy-retry', candidate: first }));
    if (preflight.kind !== 'admitted') throw new Error('Expected admitted pinned preflight.');
    await expect(svc.executePinnedContentPolicyRequest(preflight)).rejects.toMatchObject({ failure_phase: 'provider_attempt', originalFailure: { failure: { kind: 'content_policy' } }, candidate: first, provider_exchanges: [{ attempt_index: 0 }] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(successes).not.toHaveBeenCalled();
  });

  it('returns one pinned success with a single indexed attempt', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(chatSuccess('safe answer'));
    const svc = service();
    const preflight = svc.preflightPinnedContentPolicyRequest(request({ kind: 'pinned-content-policy-retry', candidate: first }));
    if (preflight.kind !== 'admitted') throw new Error('Expected admitted pinned preflight.');
    const completion = await svc.executePinnedContentPolicyRequest(preflight);
    expect(completion.result).toMatchObject({ kind: 'message', content: 'safe answer' });
    expect(completion.provider_exchanges).toHaveLength(1);
    expect(completion.provider_exchanges[0]).toMatchObject({ attempt_index: 0, status: 'ok' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['input context exhaustion', () => contextExhausted()],
    ['rate limit', () => new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429, headers: { 'content-type': 'application/json' } })],
    ['timeout', () => new Response(JSON.stringify({ error: { message: 'upstream timeout' } }), { status: 504, headers: { 'content-type': 'application/json' } })],
  ])('terminates a pinned non-refusal provider failure (%s) after its sole call', async (_name, respond) => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => respond());
    const svc = service();
    const preflight = svc.preflightPinnedContentPolicyRequest(request({ kind: 'pinned-content-policy-retry', candidate: first }));
    if (preflight.kind !== 'admitted') throw new Error('Expected admitted pinned preflight.');
    await expect(svc.executePinnedContentPolicyRequest(preflight)).rejects.toMatchObject({ failure_phase: 'provider_attempt', provider_exchanges: [{ attempt_index: 0, status: 'error' }] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports observed pre-transport cancellation as a final zero-call pinned failure', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancel before transport'));
    const fetch = jest.spyOn(globalThis, 'fetch');
    const svc = service();
    const preflight = svc.preflightPinnedContentPolicyRequest(request({ kind: 'pinned-content-policy-retry', candidate: first }, controller.signal));
    if (preflight.kind !== 'admitted') throw new Error('Expected admitted pinned preflight.');
    await expect(svc.executePinnedContentPolicyRequest(preflight, controller.signal)).rejects.toMatchObject({ failure_phase: 'pre_provider', provider_exchanges: [], candidate: first });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an unconfigured pinned candidate during preflight before transport', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch');
    const invalid = { provider: 'first', account: null, model: 'not-configured' };
    expect(() => service().preflightPinnedContentPolicyRequest(request({ kind: 'pinned-content-policy-retry', candidate: invalid }))).toThrow(/does not identify a configured provider/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
