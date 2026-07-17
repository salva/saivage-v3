import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderRegistry } from '../../src/agents/provider.js';
import { resolveLlmTransportConfig } from '../../src/agents/llm-transport.js';
import type { SaivageConfig } from '../../src/agents/config-schema.js';
import { readAuthProfile, replaceAuthProfiles } from '../../src/auth/auth-profile-file.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'saivage-llm-transport-'));
  roots.push(value);
  return value;
}

function codexToken(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url');
  return `header.${payload}.sig`;
}

function writeProfiles(projectRoot: string, profiles: Record<string, Record<string, unknown>>): void {
  mkdirSync(join(projectRoot, '.saivage'), { recursive: true });
  writeFileSync(join(projectRoot, '.saivage', 'auth-profiles.json'), `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`);
}

function config(providers: SaivageConfig['providers']): SaivageConfig {
  return {
    models: { default: ['m1'] }, providers,
    server: { port: 8080, host: '127.0.0.1' },
    runtime: { continuousImprovement: false, processTimeouts: { plannerMs: 1200000, executorMs: 1200000, reviewerMs: 1200000 } },
    security: { injectionScanner: true, maxScanLengthBytes: 102400 },
    compaction: { enabled: true, input_budget_tokens: 100000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.6, snap: 'compact_straddler', summarizer_candidate: { provider: 'test', account: null, model: 'm1' } },
  };
}

afterEach(() => {
  jest.restoreAllMocks();
  for (const value of roots) rmSync(value, { recursive: true, force: true });
  roots.length = 0;
});

describe('resolveLlmTransportConfig direct auth refresh', () => {
  it('resolves an explicit Codex profile by direct strict read', async () => {
    const projectRoot = root();
    writeProfiles(projectRoot, { codex: { type: 'oauth', provider: 'openai-codex', accessToken: codexToken('acct'), refreshToken: 'refresh' } });
    const registry = new ProviderRegistry(config({ 'openai-codex': { models: ['m1'], authProfile: 'codex' } }));
    await expect(resolveLlmTransportConfig(projectRoot, registry, { provider: 'openai-codex', account: null, model: 'm1' }))
      .resolves.toMatchObject({ openAICodexAccountId: 'acct' });
  });

  it('optimistically overwrites the named profile after rereading the latest complete file', async () => {
    const projectRoot = root();
    writeProfiles(projectRoot, { copilot: { type: 'oauth', provider: 'github-copilot', accessToken: 'expired', refreshToken: 'refresh', expiresAt: 0 } });
    const registry = new ProviderRegistry(config({ github: { models: ['m1'], authProfile: 'copilot' } }));
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      replaceAuthProfiles(projectRoot, { version: 1, profiles: {
        copilot: { type: 'oauth', provider: 'github-copilot', accessToken: 'concurrent', refreshToken: 'refresh', expiresAt: 0 },
        other: { type: 'oauth', provider: 'synthetic', accessToken: 'preserved' },
      } });
      return new Response(JSON.stringify({ token: 'last-completed', expires_at: Math.floor(Date.now() / 1000) + 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    await resolveLlmTransportConfig(projectRoot, registry, { provider: 'github', account: null, model: 'm1' });
    expect(readAuthProfile(projectRoot, 'copilot')?.accessToken).toBe('last-completed');
    expect(readAuthProfile(projectRoot, 'other')?.accessToken).toBe('preserved');
  });

  it.each([
    ['openai-codex', 'openai-codex', { access_token: codexToken('refreshed'), expires_in: 3600 }],
    ['github', 'github-copilot', { token: 'refreshed', expires_at: Math.floor(Date.now() / 1000) + 3600 }],
  ])('aborts %s refresh after the response await without replacing auth', async (providerName, profileProvider, body) => {
    const projectRoot = root();
    writeProfiles(projectRoot, { account: { type: 'oauth', provider: profileProvider, accessToken: 'expired', refreshToken: 'refresh', expiresAt: 0 } });
    const before = readFileSync(join(projectRoot, '.saivage', 'auth-profiles.json'), 'utf8');
    const registry = new ProviderRegistry(config({ [providerName]: { models: ['m1'], authProfile: 'account' } }));
    let release!: (response: Response) => void;
    let fetchStarted!: () => void;
    const fetchAwaited = new Promise<void>((resolve) => { fetchStarted = resolve; });
    jest.spyOn(globalThis, 'fetch').mockImplementation(() => { fetchStarted(); return new Promise<Response>((resolve) => { release = resolve; }); });
    const controller = new AbortController();
    const pending = resolveLlmTransportConfig(projectRoot, registry, { provider: providerName, account: null, model: 'm1' }, controller.signal);
    await fetchAwaited;
    controller.abort(new Error('owner stopped'));
    release(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await expect(pending).rejects.toThrow('owner stopped');
    expect(readFileSync(join(projectRoot, '.saivage', 'auth-profiles.json'), 'utf8')).toBe(before);
  });

  it.each([
    ['openai-codex', 'openai-codex', { access_token: codexToken('refreshed'), expires_in: 3600 }],
    ['github', 'github-copilot', { token: 'refreshed', expires_at: Math.floor(Date.now() / 1000) + 3600 }],
  ])('aborts %s refresh after the body await without replacing auth', async (providerName, profileProvider, body) => {
    const projectRoot = root();
    writeProfiles(projectRoot, { account: { type: 'oauth', provider: profileProvider, accessToken: 'expired', refreshToken: 'refresh', expiresAt: 0 } });
    const before = readFileSync(join(projectRoot, '.saivage', 'auth-profiles.json'), 'utf8');
    const registry = new ProviderRegistry(config({ [providerName]: { models: ['m1'], authProfile: 'account' } }));
    let releaseBody!: (value: unknown) => void;
    let bodyStarted!: () => void;
    const bodyAwaited = new Promise<void>((resolve) => { bodyStarted = resolve; });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: () => { bodyStarted(); return new Promise((resolve) => { releaseBody = resolve; }); } } as Response);
    const controller = new AbortController();
    const pending = resolveLlmTransportConfig(projectRoot, registry, { provider: providerName, account: null, model: 'm1' }, controller.signal);
    await bodyAwaited;
    controller.abort(new Error('owner stopped'));
    releaseBody(body);
    await expect(pending).rejects.toThrow('owner stopped');
    expect(readFileSync(join(projectRoot, '.saivage', 'auth-profiles.json'), 'utf8')).toBe(before);
  });
});
