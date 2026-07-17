import { describe, expect, it } from '@jest/globals';

import {
  classifyHttpFailure,
  classifyTransportFailure,
  type LlmHttpTransport,
} from '../../src/agents/llm-failure-classifiers.js';

function mockResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

function classify(
  transport: LlmHttpTransport,
  status: number,
  body: string,
  provider = transport === 'codex' ? 'openai-codex' : 'openai-chat',
) {
  return classifyHttpFailure(transport, mockResponse(status), body, { provider, model: 'm' });
}

describe('strict HTTP input-context classification', () => {
  it.each<[LlmHttpTransport, Record<string, unknown>]>([
    ['chat', { code: 'context_length_exceeded' }],
    ['chat', { code: 'context_length_exceeded', type: null, param: null }],
    ['chat', { code: 'context_length_exceeded', type: 'invalid_request_error', param: 'messages' }],
    ['chat', { code: 'context_length_exceeded', type: 'context_length_exceeded', param: 'input' }],
    ['chat', { type: 'context_length_exceeded' }],
    ['responses', { code: 'context_length_exceeded', param: 'input' }],
    ['responses', { type: 'context_length_exceeded', code: null, param: null }],
    ['codex', { code: 'context_length_exceeded', type: 'invalid_request_error', param: 'input' }],
  ])('accepts exact %s HTTP-400 error shape %#', (transport, error) => {
    expect(classify(transport, 400, JSON.stringify({ error })).kind).toBe('input_context_exhausted');
  });

  it('recognizes exact opencode-go evidence before its generic HTTP-400 rule', () => {
    expect(classify('chat', 400, JSON.stringify({ error: { code: 'context_length_exceeded', param: 'messages' } }), 'opencode-go').kind)
      .toBe('input_context_exhausted');
    expect(classify('chat', 400, JSON.stringify({ error: { message: 'random bad request' } }), 'opencode-go').kind)
      .toBe('provider_protocol_error');
  });

  it.each<[number, unknown]>([
    [200, { error: { code: 'context_length_exceeded' } }],
    [413, { error: { code: 'context_length_exceeded' } }],
    [422, { error: { code: 'context_length_exceeded' } }],
    [429, { error: { code: 'context_length_exceeded' } }],
    [500, { error: { code: 'context_length_exceeded' } }],
    [400, { error: 'context_length_exceeded' }],
    [400, { error: [{ code: 'context_length_exceeded' }] }],
    [400, { error: { message: 'context_length_exceeded context window input too large token budget' } }],
    [400, { error: { message: 'quoted user: {"code":"context_length_exceeded"}' } }],
    [400, { error: { metadata: { code: 'context_length_exceeded' } } }],
    [400, { error: { code: 'CONTEXT_LENGTH_EXCEEDED' } }],
    [400, { error: { code: ' context_length_exceeded' } }],
    [400, { error: { code: 'context_length_exceeded ' } }],
    [400, { error: { code: 'context_length_exceeded', type: 'server_error' } }],
    [400, { error: { code: 'other', type: 'context_length_exceeded' } }],
    [400, { error: { code: 'context_length_exceeded', param: 'output' } }],
    [400, { error: { code: 'token_budget' } }],
    [400, { error: { code: 'max_tokens' } }],
    [400, { error: { code: 'max_output_tokens' } }],
    [400, { error: { code: 'length' } }],
    [400, { code: 'context_length_exceeded' }],
  ])('rejects non-authoritative HTTP evidence %#', (status, body) => {
    expect(classify('responses', status, JSON.stringify(body)).kind).not.toBe('input_context_exhausted');
  });

  it.each(['', 'null', '[]', '"context_length_exceeded"', '{bad'])('rejects malformed or non-object HTTP body %p', (body) => {
    expect(classify('chat', 400, body).kind).toBe('provider_protocol_error');
  });

  it('allows messages only for Chat transport', () => {
    const body = JSON.stringify({ error: { code: 'context_length_exceeded', param: 'messages' } });
    expect(classify('chat', 400, body).kind).toBe('input_context_exhausted');
    expect(classify('responses', 400, body).kind).toBe('provider_protocol_error');
    expect(classify('codex', 400, body).kind).toBe('provider_protocol_error');
  });
});

describe('common HTTP and transport classification', () => {
  it('preserves rate-limit metadata and common HTTP classifications', () => {
    const limited = classifyHttpFailure('chat', mockResponse(429, { 'Retry-After': '12' }), '', { provider: 'openai-chat', model: 'm' });
    expect(limited).toMatchObject({ kind: 'rate_limit', retryAfterMs: 12000 });
    expect(classify('chat', 401, '').kind).toBe('auth_permanent');
    expect(classify('chat', 500, '').kind).toBe('server_transient');
    expect(classify('chat', 418, 'teapot').kind).toBe('provider_protocol_error');
  });

  it('preserves transport cancellation and timeout classification', () => {
    const ctx = { provider: 'openai-chat', model: 'm' };
    expect(classifyTransportFailure(Object.assign(new Error('aborted'), { name: 'AbortError' }), ctx).kind).toBe('cancelled');
    expect(classifyTransportFailure(Object.assign(new Error('connect failed'), { code: 'ETIMEDOUT' }), ctx).kind).toBe('timeout');
  });
});
