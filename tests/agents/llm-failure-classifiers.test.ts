import { describe, expect, it } from '@jest/globals';

import {
  classifyDirectProviderFailure,
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

  it.each([413, 422])('rejects exact context evidence for non-OK HTTP %s outside the exact-400 boundary', (status) => {
    expect(classify('responses', status, JSON.stringify({ error: { code: 'context_length_exceeded' } })).kind).toBe('provider_protocol_error');
  });

  it.each([413, 422])('classifies direct content evidence rather than ambiguity outside the exact-400 boundary for HTTP %s', (status) => {
    expect(classify('responses', status, JSON.stringify({ error: { code: 'context_length_exceeded', message: 'content policy refusal' } })))
      .toMatchObject({ kind: 'content_policy', status });
  });

  it('fails fast when the non-OK HTTP classifier receives an OK response', () => {
    expect(() => classify('responses', 200, JSON.stringify({ error: { code: 'context_length_exceeded' } })))
      .toThrow('classifyHttpFailure requires a non-OK HTTP response.');
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
  it('adds bounded evidence only to an exact opened HTTP-200 prompt-policy rejection', () => {
    const incident = {
      provider: 'openai-codex',
      source: { kind: 'opened_response_terminal' as const, responseStatus: 200, embeddedStatus: undefined },
      allowedContextParams: ['input'],
      message: 'terminal failure',
      providerResponse: '{"incident":true}',
    };
    expect(classifyDirectProviderFailure({
      ...incident,
      error: { code: 'invalid_prompt', message: 'Your prompt was flagged as potentially violating our usage policy.' },
    })).toMatchObject({ kind: 'provider_protocol_error', status: 200, reason: 'prompt_policy_rejection' });
    expect(classifyDirectProviderFailure({ ...incident, error: { code: 'invalid_prompt', message: 'invalid prompt' } })).toBeUndefined();
    expect(classifyDirectProviderFailure({ ...incident, error: { metadata: { code: 'invalid_prompt' }, message: 'Your prompt was flagged as potentially violating our usage policy.' } })).toBeUndefined();
    expect(classifyDirectProviderFailure({ ...incident, source: { kind: 'opened_response_terminal', responseStatus: 201, embeddedStatus: undefined }, error: { code: 'invalid_prompt', message: 'Your prompt was flagged as potentially violating our usage policy.' } })).toBeUndefined();
    expect(classifyDirectProviderFailure({ ...incident, source: { kind: 'non_ok_http_response', responseStatus: 400 }, error: { code: 'invalid_prompt', message: 'Your prompt was flagged as potentially violating our usage policy.' } })).toBeUndefined();
    for (const [type, kind] of [['usage_limit_reached', 'rate_limit'], ['unauthorized', 'auth_permanent'], ['server_error', 'server_transient']] as const) {
      const classified = classifyDirectProviderFailure({ ...incident, error: { code: 'invalid_prompt', type, message: 'Your prompt was flagged as potentially violating our usage policy.' } });
      expect(classified).toMatchObject({ kind });
      expect(classified).not.toHaveProperty('reason');
    }
  });

  it('retains actual opened status and exact evidence when content precedes embedded 403 auth', () => {
    const providerResponse = '{"distinctive":"terminal-content-evidence"}';
    expect(classifyDirectProviderFailure({
      provider: 'openai-codex',
      source: { kind: 'opened_response_terminal', responseStatus: 200, embeddedStatus: 403 },
      error: { code: 'content_filter', message: 'content policy refusal' },
      allowedContextParams: ['input'],
      message: 'terminal failure',
      providerResponse,
    })).toEqual({
      kind: 'content_policy',
      provider: 'openai-codex',
      status: 200,
      message: 'terminal failure',
      providerResponse,
    });
  });

  it.each(['cyber_policy','content_filter'])('classifies direct content code %s and preserves exact response evidence',(code)=>{
    const body=JSON.stringify({error:{code,message:'refused'}});
    expect(classify('responses',400,body)).toMatchObject({kind:'content_policy',providerResponse:body,status:400});
  });

  it.each(['content policy','safety policy','safety refusal','request was blocked for safety','cannot assist with this request'])('classifies bounded direct message phrase %s',(phrase)=>{
    expect(classify('chat',403,JSON.stringify({error:{message:`Provider: ${phrase}.`}})).kind).toBe('content_policy');
  });

  it('applies operational precedence and fails closed on context/content contradiction',()=>{
    const content=JSON.stringify({error:{code:'content_filter',message:'content policy'}});
    expect(classify('chat',401,content).kind).toBe('auth_permanent');
    expect(classify('chat',429,content).kind).toBe('rate_limit');
    expect(classify('chat',503,content).kind).toBe('server_transient');
    expect(classify('chat',400,JSON.stringify({error:{code:'context_length_exceeded',message:'content policy'}})).kind).toBe('provider_protocol_error');
    expect(classify('chat',403,JSON.stringify({error:{message:'generic forbidden'}})).kind).toBe('auth_permanent');
  });
  it('preserves rate-limit metadata and common HTTP classifications', () => {
    const limited = classifyHttpFailure('chat', mockResponse(429, { 'Retry-After': '12' }), '', { provider: 'openai-chat', model: 'm' });
    expect(limited).toMatchObject({ kind: 'rate_limit', retryAfterMs: 12000 });
    expect(classify('chat', 401, '').kind).toBe('auth_permanent');
    expect(classify('chat', 500, '').kind).toBe('server_transient');
    expect(classify('chat', 418, 'teapot').kind).toBe('provider_protocol_error');
  });

  it('declines numeric Retry-After seconds whose millisecond conversion overflows', () => {
    const overflowSeconds = Number.MAX_VALUE.toString();
    const limited = classifyHttpFailure('chat', mockResponse(429, { 'Retry-After': overflowSeconds }), '', { provider: 'openai-chat', model: 'm' });
    expect(limited).toMatchObject({ kind: 'rate_limit' });
    expect(limited).not.toHaveProperty('retryAfterMs');
  });

  it('preserves transport cancellation and timeout classification', () => {
    const ctx = { provider: 'openai-chat', model: 'm' };
    expect(classifyTransportFailure(Object.assign(new Error('aborted'), { name: 'AbortError' }), ctx).kind).toBe('cancelled');
    expect(classifyTransportFailure(Object.assign(new Error('connect failed'), { code: 'ETIMEDOUT' }), ctx).kind).toBe('timeout');
  });
});
