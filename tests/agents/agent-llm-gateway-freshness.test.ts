import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLlmInvocationGateway } from '../../src/agents/agent-llm-gateway.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { buildLlmOptions } from '../../src/agents/llm-options-factory.js';
import type { SaivageConfig } from '../../src/agents/config-schema.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import { testAuthProfiles, testCompositionAuthority } from '../helpers/canonical-project.js';

let roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'saivage-agent-gateway-test-'));
  roots.push(value);
  return value;
}

function codexToken(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url');
  return `header.${payload}.sig`;
}

function writeProfiles(projectRoot: string, accountId: string): void {
  mkdirSync(join(projectRoot, '.saivage'), { recursive: true });
  writeFileSync(join(projectRoot, '.saivage', 'auth-profiles.json'), JSON.stringify({
    version: 1,
    profiles: { codex: { type: 'oauth', provider: 'openai-codex', accessToken: codexToken(accountId) } },
  }));
}

function config(): SaivageConfig {
  return {
    models: { default: ['gpt-5'] },
    providers: { 'openai-codex': { models: ['gpt-5'], authProfile: 'codex' } },
    server: { port: 8080, host: '127.0.0.1' },
    runtime: { candidateAvailabilityCompactBytes: 262144, continuousImprovement: false, maxReviewRetries: 3, processTimeouts: { plannerMs: 1200000, executorMs: 1200000, reviewerMs: 1200000 } },
    security: { injectionScanner: true, maxScanLengthBytes: 102400 },
  };
}

afterEach(() => {
  jest.restoreAllMocks();
  for (const value of roots) rmSync(value, { recursive: true, force: true });
  roots = [];
});

describe('AgentLlmInvocationGateway transport freshness', () => {
  it('resolves credentials and Codex account id fresh for each call without a cache path', async () => {
    const projectRoot = root();
    writeProfiles(projectRoot, 'acct_a');
    const registry = new ProviderRegistry(config());
    const gateway = new AgentLlmInvocationGateway({ projectRoot, saivageDir: join(projectRoot, '.saivage'), registry, authProfiles: testAuthProfiles(projectRoot) });
    expect('llmClientCache' in gateway).toBe(false);

    const seenAccounts: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      seenAccounts.push(headers['chatgpt-account-id']);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"ok"}\n\n'));
          controller.close();
        },
      }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });

    const call = gateway.createLlmCallFn();
    const candidate = { provider: 'openai-codex', account: null, model: 'gpt-5' };
    const messages: AgentMessage[] = [];
    const opts = buildLlmOptions('analyst', [], [], { temperature: 0, max_tokens: 16 }, undefined, 'input-1', undefined);
    await call(candidate, 'system', messages, 'session-1', opts, undefined, testCompositionAuthority(projectRoot));
    writeProfiles(projectRoot, 'acct_b');
    await call(candidate, 'system', messages, 'session-1', { ...opts, inputId: 'input-2' }, undefined, testCompositionAuthority(projectRoot));

    expect(seenAccounts).toEqual(['acct_a', 'acct_b']);
    expect(JSON.stringify(seenAccounts)).not.toContain(codexToken('acct_a'));
  });
});
