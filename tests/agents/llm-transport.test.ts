import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { InvocationService, type InvocationRequest } from '../../src/agents/invocation-service.js';
import { resolveLlmTransportConfig } from '../../src/agents/llm-transport.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { readAuthProfiles, replaceAuthProfiles, type AuthProfile } from '../../src/auth/index.js';
import { NO_FRESHNESS_EFFECTS } from '../../src/contracts/index.js';
import type { Candidate } from '../../src/contracts/provider-candidate.js';
import type { SaivageConfig } from '../../src/schemas/saivage-config.js';
import { controlledResponse, pendingHeaders } from '../helpers/provider-inactivity.js';

type RefreshProvider = 'openai-codex' | 'github-copilot';

const roots: string[] = [];

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe.each<RefreshProvider>(['openai-codex', 'github-copilot'])('%s OAuth refresh', (provider) => {
  it('retains malformed-response fallback for an ordinary body failure, including independent AbortError', async () => {
    const fixture = setup(provider);
    const response = new Response(new ReadableStream({ start(controller) { controller.error(new DOMException('independent read failure', 'AbortError')); } }));
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const transport = await resolveLlmTransportConfig(fixture.projectRoot, fixture.registry, fixture.candidate, 'standard');
    expect(transport.apiKey).toBe(fixture.profile.accessToken);
    expect(readAuthProfiles(fixture.projectRoot)).toEqual(fixture.authFile);
    expect(response.body!.locked).toBe(false);
  });
  it.each(['headers', 'body'] as const)('treats %s inactivity as a pre-provider transient with no send, exchange, or auth write', async phase => {
    jest.useFakeTimers();
    const owner = new AbortController();
    const fixture = setup(provider);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const signal = init!.signal!;
      if (phase === 'headers') return pendingHeaders(signal);
      const stream = controlledResponse(signal); stream.send('{'); return Promise.resolve(stream.response);
    });
    const service = new InvocationService({ projectRoot: fixture.projectRoot, registry: fixture.registry, candidateAvailability: new MemoryCandidateAvailability(), freshness: NO_FRESHNESS_EFFECTS });
    const admission = service.preflightPinnedContentPolicyRequest(invocationRequest(fixture.candidate));
    if (admission.kind !== 'admitted') throw new Error('fixture must admit');
    const pending = service.executePinnedContentPolicyRequest(admission, { attemptIndex: 0 }, owner.signal).catch(error => error);
    try {
      await jest.advanceTimersByTimeAsync(120000);
      expect(await pending).toMatchObject({ failure_phase: 'pre_provider', provider_exchanges: [], originalFailure: { failure: { kind: 'server_transient', provider, status: 0 } } });
      expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([refreshUrl(provider)]);
      expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
      expect(readAuthProfiles(fixture.projectRoot)).toEqual(fixture.authFile);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      owner.abort(new Error('test cleanup'));
      await pending;
    }
  });

  it('clears the completed refresh window before starting a fresh provider window', async () => {
    jest.useFakeTimers();
    const owner = new AbortController();
    const fixture = setup(provider);
    const replacement = provider === 'openai-codex' ? codexToken('fresh-account') : 'synthetic-fresh-access';
    let refreshStream!: ReturnType<typeof controlledResponse>;
    let refreshSignal!: AbortSignal;
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const signal = init!.signal!;
      if (!refreshStream) { refreshSignal = signal; refreshStream = controlledResponse(signal); return Promise.resolve(refreshStream.response); }
      expect(jest.getTimerCount()).toBe(1);
      return pendingHeaders(signal);
    });
    const service = new InvocationService({ projectRoot: fixture.projectRoot, registry: fixture.registry, candidateAvailability: new MemoryCandidateAvailability(), freshness: NO_FRESHNESS_EFFECTS });
    const admission = service.preflightPinnedContentPolicyRequest(invocationRequest(fixture.candidate));
    if (admission.kind !== 'admitted') throw new Error('fixture must admit');
    const pending = service.executePinnedContentPolicyRequest(admission, { attemptIndex: 0 }, owner.signal).catch(error => error);
    try {
      await jest.advanceTimersByTimeAsync(119000);
      refreshStream.send(await refreshSuccess(provider, replacement).text()); refreshStream.close();
      await jest.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(119999);
      expect(fetch.mock.calls[1]![1]!.signal!.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ failure_phase: 'provider_attempt', provider_exchanges: [{ status: 'error', error: { name: 'ProviderInactivityTimeoutError' } }], originalFailure: { failure: { kind: 'timeout' } } });
      expect(refreshSignal.aborted).toBe(false);
      expect(readAuthProfiles(fixture.projectRoot)?.profiles.profile?.accessToken).toBe(replacement);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      owner.abort(new Error('test cleanup'));
      refreshStream?.close();
      await pending;
    }
  });
  it('rejects pinned refresh 429 safely without consuming the body, sending a stale token or replacing auth', async () => {
    const fixture = setup(provider);
    const response = new Response('synthetic-secret-marked-oauth-body', { status: 429 });
    const json = jest.spyOn(response, 'json');
    const text = jest.spyOn(response, 'text');
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const service = new InvocationService({ projectRoot: fixture.projectRoot, registry: fixture.registry, candidateAvailability: new MemoryCandidateAvailability(), freshness: NO_FRESHNESS_EFFECTS });
    const admission = service.preflightPinnedContentPolicyRequest(invocationRequest(fixture.candidate));
    if (admission.kind !== 'admitted') throw new Error('fixture must admit');
    await expect(service.executePinnedContentPolicyRequest(admission, { attemptIndex: 0 })).rejects.toMatchObject({
      failure_phase: 'pre_provider',
      provider_exchanges: [],
      originalFailure: { failure: {
        kind: 'rate_limit', provider, status: 429,
        message: `OAuth credential refresh for provider '${provider}' was rate limited before provider request.`,
      } },
    });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([refreshUrl(provider)]);
    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(response.bodyUsed).toBe(false);
    expect(readAuthProfiles(fixture.projectRoot)).toEqual(fixture.authFile);
  });

  it.each<[string, string | undefined, number]>([
    ['seconds', '2', 3000],
    ['HTTP date', new Date(5000).toUTCString(), 5000],
    ['absent', undefined, 61000],
    ['invalid', 'not-a-retry-time', 61000],
    ['zero', '0', 61000],
  ])('fails over immediately after refresh 429 with %s Retry-After and candidate-local blocking', async (_label, retryAfter, untilMs) => {
    jest.useFakeTimers({ now: 1000 });
    const alternate: Candidate = { provider: 'healthy', account: null, model: 'healthy-model' };
    const fixture = setup(provider, alternate);
    const availability = new MemoryCandidateAvailability();
    const fetch = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('unread refresh body', { status: 429, headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'healthy secondary' }, finish_reason: 'stop' }] }), { status: 200 }));
    const service = new InvocationService({ projectRoot: fixture.projectRoot, registry: fixture.registry, candidateAvailability: availability, freshness: NO_FRESHNESS_EFFECTS });
    const request: InvocationRequest = { ...invocationRequest(fixture.candidate), routePass: { kind: 'ordinary', candidateChain: [fixture.candidate, alternate] } };
    const admission = service.preparePrimaryRequestAdmission(request);
    if (admission.kind !== 'admitted') throw new Error('fixture must admit');
    let settled = false;
    const pending = service.executeAdmittedWithRecovery(admission).then((completion) => { settled = true; return completion; });
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    const completion = await pending;
    expect(completion.result).toEqual({ kind: 'message', content: 'healthy secondary' });
    expect(completion.provider_exchanges).toHaveLength(1);
    expect(completion.provider_exchanges[0]).toMatchObject({ provider: 'healthy', model: alternate.model, source_input_id: request.inputId, attempt_index: 0, status: 'ok', response_status: 200 });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([refreshUrl(provider), 'https://healthy.example.test/v1/chat/completions']);
    expect(availability.getEntry(fixture.candidate)).toMatchObject({ state: 'BLOCKED_UNTIL', reason: 'rate_limit', untilMs });
    expect(availability.getEntry(alternate)).toMatchObject({ state: 'HEALTHY', untilMs: 0 });
    expect(readAuthProfiles(fixture.projectRoot)).toEqual(fixture.authFile);
    expect(Date.now()).toBe(1000);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('waits between four admitted refresh 429 failures and terminates without reopening exhausted membership', async () => {
    jest.useFakeTimers({ now: 1000 });
    const fixture = setup(provider);
    const availability = new MemoryCandidateAvailability();
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 429, headers: { 'Retry-After': '1' } }));
    const service = new InvocationService({ projectRoot: fixture.projectRoot, registry: fixture.registry, candidateAvailability: availability, freshness: NO_FRESHNESS_EFFECTS });
    const admission = service.preparePrimaryRequestAdmission({ ...invocationRequest(fixture.candidate), routePass: { kind: 'ordinary', candidateChain: [fixture.candidate] } });
    if (admission.kind !== 'admitted') throw new Error('fixture must admit');
    let settled = false;
    const pending = service.executeAdmittedWithRecovery(admission).then(
      () => { throw new Error('Expected exhausted refresh attempts to reject'); },
      (error: unknown) => { settled = true; return error; },
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    for (let attempt = 2; attempt <= 4; attempt++) {
      await jest.advanceTimersByTimeAsync(999);
      expect(fetch).toHaveBeenCalledTimes(attempt - 1);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(attempt);
    }
    expect(await pending).toMatchObject({ failure_phase: 'pre_provider', provider_exchanges: [], originalFailure: { failure: { kind: 'rate_limit', provider, status: 429, retryAfterMs: 1000 } } });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(Array(4).fill(refreshUrl(provider)));
    expect(Date.now()).toBe(4000);
    expect(availability.getEntry(fixture.candidate)).toMatchObject({ state: 'BLOCKED_UNTIL', reason: 'rate_limit', untilMs: 5000 });
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(60000);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(readAuthProfiles(fixture.projectRoot)).toEqual(fixture.authFile);
  });

  it.each([400, 403])('keeps refresh %s null fallback and the subsequent real provider 401 terminal', async (status) => {
    jest.useFakeTimers({ now: 1000 });
    const alternate: Candidate = { provider: 'healthy', account: null, model: 'healthy-model' };
    const fixture = setup(provider, alternate);
    const availability = new MemoryCandidateAvailability();
    const fetch = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), { status, headers: { 'Retry-After': '2' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'synthetic unauthorized' } }), { status: 401 }));
    const service = new InvocationService({ projectRoot: fixture.projectRoot, registry: fixture.registry, candidateAvailability: availability, freshness: NO_FRESHNESS_EFFECTS });
    const request: InvocationRequest = { ...invocationRequest(fixture.candidate), routePass: { kind: 'ordinary', candidateChain: [fixture.candidate, alternate] } };
    const admission = service.preparePrimaryRequestAdmission(request);
    if (admission.kind !== 'admitted') throw new Error('fixture must admit');
    await expect(service.executeAdmittedWithRecovery(admission)).rejects.toMatchObject({
      failure_phase: 'provider_attempt',
      provider_exchanges: [{ provider, source_input_id: request.inputId, attempt_index: 0, status: 'error', response_status: 401 }],
      originalFailure: { failure: { kind: 'auth_permanent', provider, status: 401 } },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0]![0])).toBe(refreshUrl(provider));
    expect(String(fetch.mock.calls[1]![0])).toContain('https://provider.example.test/');
    expect(new Headers(fetch.mock.calls[1]![1]!.headers).get('Authorization')).toBe(`Bearer ${fixture.profile.accessToken}`);
    expect(availability.getEntry(fixture.candidate)).toMatchObject({ state: 'BLOCKED_UNTIL', reason: 'auth_permanent', untilMs: 3601000 });
    expect(availability.getEntry(alternate)).toBeUndefined();
    expect(readAuthProfiles(fixture.projectRoot)).toEqual(fixture.authFile);
  });

  it('prioritizes the exact owner abort reason over a resolved refresh 429', async () => {
    const fixture = setup(provider);
    const controller = new AbortController();
    const reason = new Error('synthetic owner stopped during 429');
    const response = new Response('unread body', { status: 429 });
    const headers = jest.spyOn(response.headers, 'get');
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      controller.abort(reason);
      return response;
    });
    await expect(resolveLlmTransportConfig(fixture.projectRoot, fixture.registry, fixture.candidate, 'standard', controller.signal)).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1]!.signal).not.toBe(controller.signal);
    expect(fetch.mock.calls[0]![1]!.signal!.reason).toBe(reason);
    expect(headers).not.toHaveBeenCalled();
    expect(response.bodyUsed).toBe(false);
    expect(readAuthProfiles(fixture.projectRoot)).toEqual(fixture.authFile);
  });

  it('overlaps independent successful refreshes and keeps the last-completed replacement', async () => {
    jest.useFakeTimers({ now: 1000 });
    const fixture = setup(provider);
    const first = deferredResponse();
    const second = deferredResponse();
    const fetch = jest.spyOn(globalThis, 'fetch').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const pendingFirst = resolveLlmTransportConfig(fixture.projectRoot, fixture.registry, fixture.candidate, 'standard');
    const pendingSecond = resolveLlmTransportConfig(fixture.projectRoot, fixture.registry, fixture.candidate, 'standard');
    await jest.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    const firstToken = provider === 'openai-codex' ? codexToken('first') : 'synthetic-first';
    const secondToken = provider === 'openai-codex' ? codexToken('second') : 'synthetic-second';
    second.resolve(refreshSuccess(provider, secondToken));
    expect((await pendingSecond).apiKey).toBe(secondToken);
    expect(readAuthProfiles(fixture.projectRoot)?.profiles.profile?.accessToken).toBe(secondToken);
    first.resolve(refreshSuccess(provider, firstToken));
    expect((await pendingFirst).apiKey).toBe(firstToken);
    expect(readAuthProfiles(fixture.projectRoot)?.profiles.profile?.accessToken).toBe(firstToken);
  });

  it('does not let an overlapping refresh 429 undo a successful replacement', async () => {
    jest.useFakeTimers({ now: 1000 });
    const fixture = setup(provider);
    const limited = deferredResponse();
    const successful = deferredResponse();
    const fetch = jest.spyOn(globalThis, 'fetch').mockReturnValueOnce(limited.promise).mockReturnValueOnce(successful.promise);
    const pendingLimited = resolveLlmTransportConfig(fixture.projectRoot, fixture.registry, fixture.candidate, 'standard');
    const pendingSuccess = resolveLlmTransportConfig(fixture.projectRoot, fixture.registry, fixture.candidate, 'standard');
    await jest.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    const token = provider === 'openai-codex' ? codexToken('successful') : 'synthetic-successful';
    successful.resolve(refreshSuccess(provider, token));
    expect((await pendingSuccess).apiKey).toBe(token);
    const replaced = readAuthProfiles(fixture.projectRoot);
    expect(replaced?.profiles.profile?.accessToken).toBe(token);
    const rejection = expect(pendingLimited).rejects.toMatchObject({ failure: { kind: 'rate_limit', provider, status: 429 } });
    limited.resolve(new Response('', { status: 429 }));
    await rejection;
    expect(readAuthProfiles(fixture.projectRoot)).toEqual(replaced);
  });

  it.each<[string, () => Promise<Response>]>([
    ['network rejection', () => Promise.reject(new Error('synthetic refresh network failure'))],
    ['HTTP 503', () => Promise.resolve(new Response('', { status: 503 }))],
  ])('fails over immediately after a real pre-provider refresh %s without inventing an exchange', async (_label, refreshResult) => {
    jest.useFakeTimers({ now: 1000 });
    const alternate: Candidate = { provider: 'healthy', account: null, model: 'healthy-model' };
    const fixture = setup(provider, alternate);
    const availability = new MemoryCandidateAvailability();
    const fetch = jest.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(refreshResult)
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'healthy secondary' }, finish_reason: 'stop' }] }), { status: 200 }));
    const service = new InvocationService({ projectRoot: fixture.projectRoot, registry: fixture.registry, candidateAvailability: availability, freshness: NO_FRESHNESS_EFFECTS });
    const request: InvocationRequest = { ...invocationRequest(fixture.candidate), routePass: { kind: 'ordinary', candidateChain: [fixture.candidate, alternate] } };
    const admission = service.preparePrimaryRequestAdmission(request);
    if (admission.kind !== 'admitted') throw new Error('fixture must admit');
    let settled = false;
    const pending = service.executeAdmittedWithRecovery(admission).then((completion) => { settled = true; return completion; });
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    const completion = await pending;
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([refreshUrl(provider), 'https://healthy.example.test/v1/chat/completions']);
    expect(completion.result).toEqual({ kind: 'message', content: 'healthy secondary' });
    expect(completion.provider_exchanges).toHaveLength(1);
    expect(completion.provider_exchanges[0]).toMatchObject({ provider: 'healthy', model: 'healthy-model', source_input_id: request.inputId, attempt_index: 0, status: 'ok', response_status: 200 });
    expect(availability.getEntry(fixture.candidate)).toMatchObject({ state: 'COOLING', reason: 'server_transient', untilMs: 61000 });
    expect(readAuthProfiles(fixture.projectRoot)).toEqual(fixture.authFile);
    expect(Date.now()).toBe(1000);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('preserves the shared Copilot identity on refresh and provider dispatch', async () => {
    if (provider !== 'github-copilot') return;
    const fixture = setup(provider);
    const headers: Headers[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      headers.push(new Headers(init!.headers));
      return String(url) === refreshUrl(provider)
        ? new Response(JSON.stringify({ token: 'synthetic-refreshed-token', expires_at: Math.floor(Date.now() / 1000) + 3600 }), { status: 200 })
        : new Response(JSON.stringify({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] }), { status: 200 });
    });
    const service = new InvocationService({ projectRoot: fixture.projectRoot, registry: fixture.registry, candidateAvailability: new MemoryCandidateAvailability(), freshness: NO_FRESHNESS_EFFECTS });
    const preflight = service.preflightPinnedContentPolicyRequest(invocationRequest(fixture.candidate));
    if (preflight.kind !== 'admitted') throw new Error('fixture must admit');
    await service.executePinnedContentPolicyRequest(preflight, { attemptIndex: 0 });
    expect(headers).toHaveLength(2);
    const identity = { 'User-Agent': 'GitHubCopilotChat/0.35.0', 'Editor-Version': 'vscode/1.107.0', 'Editor-Plugin-Version': 'copilot-chat/0.35.0', 'Copilot-Integration-Id': 'vscode-chat' };
    for (const [key, value] of Object.entries(identity)) {
      expect(headers[0]!.get(key)).toBe(value);
      expect(headers[1]!.get(key)).toBe(value);
    }
  });
  it.each<[string, () => Promise<Response>, number]>([
    ['network rejection', () => Promise.reject(new Error('synthetic network failure')), 0],
    ['HTTP 5xx', () => Promise.resolve(new Response('', { status: 503 })), 503],
  ])('classifies %s before provider exchange or stale-token dispatch', async (_label, refreshResult, status) => {
    const fixture = setup(provider);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(refreshResult);
    const request = invocationRequest(fixture.candidate);
    const activation = randomUUID();
    const service = new InvocationService({
      failedProviderDiagnostics: activation,
      projectRoot: fixture.projectRoot,
      registry: fixture.registry,
      candidateAvailability: new MemoryCandidateAvailability(),
      freshness: NO_FRESHNESS_EFFECTS,
    });
    const preflight = service.preflightPinnedContentPolicyRequest(request);
    if (preflight.kind !== 'admitted') throw new Error('Expected pinned transport test request to admit.');

    await expect(service.executePinnedContentPolicyRequest(preflight, { attemptIndex: 0 })).rejects.toMatchObject({
      failure_phase: 'pre_provider',
      provider_exchanges: [],
      originalFailure: {
        failure: { kind: 'server_transient', provider, status },
      },
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toBe(refreshUrl(provider));
    expect(fetch.mock.calls.some(([input]) => String(input).startsWith('https://provider.example.test'))).toBe(false);
    expect(readAuthProfiles(fixture.projectRoot)).toEqual(fixture.authFile);
    expect(readdirSync(join(fixture.projectRoot, '.saivage/diagnostics/failed-provider-requests', activation))).toEqual(['.gitignore']);
  });

  it('passes owner cancellation through by identity', async () => {
    const fixture = setup(provider);
    const controller = new AbortController();
    const reason = new Error('synthetic owner cancellation');
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      controller.abort(reason);
      throw reason;
    });

    await expect(resolveLlmTransportConfig(
      fixture.projectRoot,
      fixture.registry,
      fixture.candidate,
      'standard',
      controller.signal,
    )).rejects.toBe(reason);
    expect(readAuthProfiles(fixture.projectRoot)).toEqual(fixture.authFile);
  });

  it('preserves owner cancellation during successful response body handling before replacement', async () => {
    const fixture = setup(provider);
    const controller = new AbortController();
    const reason = new Error('synthetic owner cancellation during body');
    jest.useFakeTimers();
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => controlledResponse(init!.signal!).response);
    const pending = resolveLlmTransportConfig(fixture.projectRoot, fixture.registry, fixture.candidate, 'standard', controller.signal).catch(error => error);
    try {
      await jest.advanceTimersByTimeAsync(0);
      controller.abort(reason);
      expect(await pending).toBe(reason);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]![1]!.signal).not.toBe(controller.signal);
      expect(fetch.mock.calls[0]![1]!.signal!.reason).toBe(reason);
      expect(readAuthProfiles(fixture.projectRoot)).toEqual(fixture.authFile);
    } finally {
      controller.abort(new Error('test cleanup'));
      await pending;
    }
  });

  it.each<[string, () => Response]>([
    ['HTTP 400', () => new Response('', { status: 400 })],
    ['HTTP 401', () => new Response('', { status: 401 })],
    ['HTTP 403 with misleading rate-limit metadata', () => new Response('{"error":{"code":"rate_limit_exceeded"}}', { status: 403, headers: { 'Retry-After': '2' } })],
    ['HTTP 418 (other 4xx, not 429)', () => new Response('', { status: 418 })],
    ['malformed HTTP 2xx', () => new Response('{not-json', { status: 200 })],
    ['HTTP 2xx without a token', () => new Response('{}', { status: 200 })],
  ])('retains the existing null-refresh behavior for %s', async (_label, response) => {
    const fixture = setup(provider);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(response());

    const transport = await resolveLlmTransportConfig(
      fixture.projectRoot,
      fixture.registry,
      fixture.candidate,
      'standard',
    );

    expect(transport.apiKey).toBe(fixture.profile.accessToken);
    expect(readAuthProfiles(fixture.projectRoot)).toEqual(fixture.authFile);
  });

  it('publishes and returns a valid replacement token', async () => {
    const fixture = setup(provider);
    const replacementToken = provider === 'openai-codex' ? codexToken('fresh-account') : 'synthetic-fresh-access';
    const responseBody = provider === 'openai-codex'
      ? { access_token: replacementToken, refresh_token: 'synthetic-fresh-refresh', expires_in: 3_600 }
      : { token: replacementToken, expires_at: Math.floor(Date.now() / 1000) + 3_600 };
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(responseBody), { status: 200 }));

    const transport = await resolveLlmTransportConfig(
      fixture.projectRoot,
      fixture.registry,
      fixture.candidate,
      'standard',
    );

    expect(transport.apiKey).toBe(replacementToken);
    const replaced = readAuthProfiles(fixture.projectRoot)?.profiles.profile;
    expect(replaced?.accessToken).toBe(replacementToken);
    expect(replaced?.refreshToken).toBe(provider === 'openai-codex' ? 'synthetic-fresh-refresh' : fixture.profile.refreshToken);
  });
});

function setup(provider: RefreshProvider, alternate?: Candidate): {
  projectRoot: string;
  candidate: Candidate;
  registry: ProviderRegistry;
  profile: AuthProfile;
  authFile: { version: number; profiles: Record<string, AuthProfile> };
} {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-llm-transport-'));
  roots.push(projectRoot);
  const candidate: Candidate = { provider, account: null, model: 'synthetic-model' };
  const profile: AuthProfile = {
    type: 'oauth',
    provider,
    accessToken: provider === 'openai-codex' ? codexToken('stale-account') : 'synthetic-stale-access',
    refreshToken: 'synthetic-refresh',
    expiresAt: Date.now() - 1,
  };
  const authFile = { version: 1, profiles: { profile } };
  replaceAuthProfiles(projectRoot, authFile);
  const registry = new ProviderRegistry({
    providers: {
      ...(alternate ? { [alternate.provider]: { models: [alternate.model], baseUrl: 'https://healthy.example.test', apiKey: 'synthetic-healthy-key', capabilities: { transportProtocol: 'openai-chat-completions', contextWindowTokens: 100_000, maxOutputTokens: 10_000 } } } : {}),
      [provider]: {
        models: [candidate.model],
        authProfile: 'profile',
        baseUrl: 'https://provider.example.test',
        capabilities: {
          contextWindowTokens: 100_000,
          maxOutputTokens: 10_000,
        },
      },
    },
  } as SaivageConfig);
  return { projectRoot, candidate, registry, profile, authFile };
}

function invocationRequest(candidate: Candidate): InvocationRequest {
  return {
    inputId: 'agent:planner:card:1',
    agentName: 'planner',
    sessionId: 'agent:planner:card',
    systemPrompt: 'system',
    providerConversation: { sourceSessionId: 'agent:planner:card', messages: [] },
    tools: [],
    terminalToolNames: [],
    modelParams: { temperature: 0, maxTokens: 2_000 },
    capabilityRequest: {},
    routePass: { kind: 'pinned-content-policy-retry', candidate },
  };
}

function refreshUrl(provider: RefreshProvider): string {
  return provider === 'openai-codex'
    ? 'https://auth.openai.com/oauth/token'
    : 'https://api.github.com/copilot_internal/v2/token';
}

function deferredResponse(): { promise: Promise<Response>; resolve: (response: Response) => void } {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function refreshSuccess(provider: RefreshProvider, token: string): Response {
  return new Response(JSON.stringify(provider === 'openai-codex'
    ? { access_token: token, refresh_token: 'synthetic-replacement-refresh', expires_in: 3600 }
    : { token, expires_at: Math.floor(Date.now() / 1000) + 3600 }), { status: 200 });
}

function codexToken(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })).toString('base64url');
  return `synthetic.${payload}.signature`;
}
