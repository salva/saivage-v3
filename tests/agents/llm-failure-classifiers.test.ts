import { describe, expect, it } from '@jest/globals';

import { classifierFor, defaultHttpClassifier } from '../../src/agents/llm-failure-classifiers.js';

function mockResponse(status: number, headers: Record<string, string> = {}, body = ''): Response {
  return new Response(body, { status, headers });
}

describe('per-provider failure classifiers', () => {
  it('opencode-go: HTTP 400 with response_format/function_call clash → contract_mismatch', () => {
    const body = '{"error":"You cannot specify response format and function call at the same time"}';
    const failure = classifierFor('opencode-go').classifyHttp(mockResponse(400), body, { provider: 'opencode-go', model: 'm' });
    expect(failure?.kind).toBe('contract_mismatch');
    expect(failure?.kind === 'contract_mismatch' && failure.status).toBe(400);
  });

  it('opencode-go: any HTTP 400 → contract_mismatch', () => {
    const failure = classifierFor('opencode-go').classifyHttp(mockResponse(400), '{"error":"random bad request"}', { provider: 'opencode-go', model: 'm' });
    expect(failure?.kind).toBe('contract_mismatch');
  });

  it('openai-chat: 429 with Retry-After: 12 seconds → retryAfterMs 12000', () => {
    const ctx = { provider: 'openai-chat', model: 'gpt-4' };
    const failure = classifierFor('openai-chat').classifyHttp(mockResponse(429, { 'Retry-After': '12' }), '', ctx)
      ?? defaultHttpClassifier(mockResponse(429, { 'Retry-After': '12' }), '', ctx);
    expect(failure.kind).toBe('rate_limit');
    expect(failure.kind === 'rate_limit' && failure.retryAfterMs).toBe(12000);
  });

  it('openai-codex: 429 with x-ratelimit-reset ISO → resetsAt populated', () => {
    const ctx = { provider: 'openai-codex', model: 'gpt-5' };
    const iso = '2030-01-01T00:00:00Z';
    const failure = classifierFor('openai-codex').classifyHttp(mockResponse(429, { 'x-ratelimit-reset': iso }), '', ctx)
      ?? defaultHttpClassifier(mockResponse(429, { 'x-ratelimit-reset': iso }), '', ctx);
    expect(failure.kind).toBe('rate_limit');
    expect(failure.kind === 'rate_limit' && failure.resetsAt).toBe(iso);
  });

  it('HTTP 400 with context_length_exceeded body → token_budget_exceeded', () => {
    const ctx = { provider: 'openai-chat', model: 'gpt-4' };
    const failure = defaultHttpClassifier(mockResponse(400), '{"error":{"code":"context_length_exceeded"}}', ctx);
    expect(failure.kind).toBe('token_budget_exceeded');
  });

  it('unrecognised 4xx → server_transient via default classifier', () => {
    const ctx = { provider: 'openai-chat', model: 'gpt-4' };
    const failure = defaultHttpClassifier(mockResponse(418), 'teapot', ctx);
    expect(failure.kind).toBe('server_transient');
    expect(failure.kind === 'server_transient' && failure.status).toBe(418);
  });

  it('HTTP 401 → auth_permanent', () => {
    const ctx = { provider: 'openai-chat', model: 'gpt-4' };
    const failure = defaultHttpClassifier(mockResponse(401), '', ctx);
    expect(failure.kind).toBe('auth_permanent');
  });

  it('HTTP 500 → server_transient', () => {
    const ctx = { provider: 'openai-chat', model: 'gpt-4' };
    const failure = defaultHttpClassifier(mockResponse(500), '', ctx);
    expect(failure.kind).toBe('server_transient');
  });

  it('transport AbortError → cancelled', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const failure = classifierFor('openai-chat').classifyTransport(err, { provider: 'openai-chat', model: 'm' });
    expect(failure?.kind).toBe('cancelled');
  });

  it('transport ETIMEDOUT → timeout', () => {
    const err = Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' });
    const failure = classifierFor('openai-chat').classifyTransport(err, { provider: 'openai-chat', model: 'm' });
    expect(failure?.kind).toBe('timeout');
  });
});
