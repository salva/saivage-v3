import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
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

type RefreshProvider = 'openai-codex' | 'github-copilot';

const roots: string[] = [];

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe.each<RefreshProvider>(['openai-codex', 'github-copilot'])('%s OAuth refresh', (provider) => {
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
    await service.executePinnedContentPolicyRequest(preflight);
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
    const service = new InvocationService({
      projectRoot: fixture.projectRoot,
      registry: fixture.registry,
      candidateAvailability: new MemoryCandidateAvailability(),
      freshness: NO_FRESHNESS_EFFECTS,
    });
    const preflight = service.preflightPinnedContentPolicyRequest(request);
    if (preflight.kind !== 'admitted') throw new Error('Expected pinned transport test request to admit.');

    await expect(service.executePinnedContentPolicyRequest(preflight)).rejects.toMatchObject({
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

  it.each<[string, () => Response]>([
    ['HTTP 4xx', () => new Response('', { status: 401 })],
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

function codexToken(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })).toString('base64url');
  return `synthetic.${payload}.signature`;
}
