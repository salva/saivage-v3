import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { FailedProviderRequestDiagnostics } from '../../src/agents/failed-provider-request-diagnostics.js';

const roots: string[] = [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const context = {
  sourceSessionId: 'agent:planner:project',
  invocationSessionId: 'agent:planner:project',
  inputId: '00000000-0000-4000-8000-000000000001',
  attemptIndex: 0,
  purpose: 'primary' as const,
};
function fixture() {
  const root = mkdtempSync('/home/salva/g/ml/tmp/diagnostic-privacy-');
  roots.push(root);
  mkdirSync(join(root, '.saivage'));
  const activation = randomUUID();
  const owner = new FailedProviderRequestDiagnostics(root, activation);
  const directory = join(root, '.saivage/diagnostics/failed-provider-requests', activation);
  const capture = (
    body: string,
    protocol = 'openai-responses',
    overrides: Partial<Parameters<typeof owner.capture>[0]> = {},
  ) =>
    owner.capture(
      {
        context,
        serializedBody: body,
        contractId: 'summary.v1',
        protocol,
        provider: 'fixture',
        model: 'model',
        submittedAt: '2026-10-09T00:00:00.000Z',
        completedAt: '2026-10-09T00:00:01.000Z',
        observation: 'transport_failure',
        failureKind: 'content_policy',
        providerCode: 'cyber_policy',
        providerCodeTruncated: false,
        finishReason: null,
        httpStatus: 200,
        embeddedStatus: null,
        ...overrides,
      },
      'active-fixture-literal',
    );
  const documents = () =>
    readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({
        text: readFileSync(join(directory, name), 'utf8'),
        path: join(directory, name),
      }))
      .map((value) => ({ ...value, document: JSON.parse(value.text) }));
  return { root, activation, owner, directory, capture, documents };
}
beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('private diagnostic wire-derived projection and finite activation', () => {
  it('bounds/redacts descriptive metadata while keeping validated canonical identity exact', () => {
    const f = fixture();
    const exactSession = 'agent:api-key:card-a';
    f.capture('{"safe":true}', 'openai-responses', {
      context: { ...context, sourceSessionId: exactSession, invocationSessionId: exactSession },
      provider: 'active-fixture-literal',
      model: 'https://private-endpoint.test/model',
      contractId: 'x'.repeat(1000),
      providerCode: 'x'.repeat(1000),
    });
    const [{ text, document }] = f.documents();
    expect(document).toMatchObject({
      source_session_id: exactSession,
      invocation_session_id: exactSession,
      provider: { value: '[REDACTED]', redacted: true },
      model: { value: '[OMITTED_URL]', redacted: true },
      contract_id: { truncated: true },
      provider_code: { truncated: true },
    });
    expect(document.provider_code.value).toHaveLength(512);
    expect(text).not.toContain('private-endpoint.test');
    expect(text).not.toContain('active-fixture-literal');
    f.capture('{"safe":true}', 'openai-responses', {
      context: { ...context, sourceSessionId: 'invalid private session' },
    });
    expect(f.documents()).toHaveLength(1);
    expect((console.error as ReturnType<typeof jest.spyOn>).mock.calls.at(-1)).toEqual([
      'Failed provider diagnostic capture failed.',
    ]);
  });
  it.each(['openai-responses', 'openai-codex-backend', 'openai-chat-completions'])(
    'projects protocol argument JSON, images and private native replay for %s without parsing arbitrary prose',
    (protocol) => {
      const f = fixture();
      const args = {
        auth: { value: 'fixture-credential' },
        cookies: [{ name: 'session', value: 'cookie-fixture-credential' }],
        rows: [
          {
            config: { value: 'array-private-config' },
            label: 'quote " and slash \\',
            values: [3, 1],
          },
          { headers: { neutral: 'array-private-header' } },
        ],
        safe: 'kept',
      };
      const argument = JSON.stringify(args, null, 2);
      const invalid = '{"auth":{"value":"invalid-private-secret"';
      const body =
        protocol === 'openai-chat-completions'
          ? {
              messages: [
                {
                  role: 'assistant',
                  tool_calls: [
                    { function: { name: 'safe', arguments: argument } },
                    { function: { name: 'invalid', arguments: invalid } },
                  ],
                },
                {
                  role: 'user',
                  content: [
                    { type: 'image_url', image_url: { url: 'https://private-image.test/pixels' } },
                    {
                      type: 'text',
                      text: 'active-fixture-literal and data:image/png;base64,UElYRUxT',
                    },
                  ],
                },
              ],
              unrelated: { arguments: '{"neutral":"not parsed"}' },
            }
          : {
              input: [
                {
                  type: 'function_call',
                  id: 'native-private-reference',
                  name: 'safe',
                  arguments: argument,
                },
                { type: 'function_call', name: 'invalid', arguments: invalid },
                { type: 'reasoning', encrypted_content: 'encrypted-private-bytes' },
                { type: 'item_reference', id: 'opaque-private-reference' },
                {
                  type: 'message',
                  id: 'message-private-reference',
                  content: [
                    { type: 'input_image', image_url: 'https://private-image.test/pixels' },
                    {
                      type: 'input_text',
                      text: 'active-fixture-literal and data:image/png;base64,UElYRUxT',
                    },
                  ],
                },
              ],
              previous_response_id: 'response-private-reference',
              unrelated: { arguments: '{"neutral":"not parsed"}' },
            };
      const submitted = JSON.stringify(body);
      f.capture(submitted, protocol);
      const [{ text, document }] = f.documents();
      for (const secret of [
        'fixture-credential',
        'array-private-config',
        'array-private-header',
        'cookie-fixture-credential',
        'invalid-private-secret',
        'private-image.test',
        'active-fixture-literal',
        'UElYRUxT',
        'encrypted-private-bytes',
        'opaque-private-reference',
        'native-private-reference',
        'message-private-reference',
        'response-private-reference',
      ]) {
        expect(text).not.toContain(secret);
        expect(
          JSON.stringify((console.error as ReturnType<typeof jest.spyOn>).mock.calls),
        ).not.toContain(secret);
      }
      expect(document).toMatchObject({
        raw_request_sha256: hash(submitted),
        raw_request_utf8_bytes: Buffer.byteLength(submitted),
        stored_body_sha256: hash(document.stored_body),
        stored_body_utf8_bytes: Buffer.byteLength(document.stored_body),
        body_disposition: 'redacted',
        reencoded: true,
        counts: {
          tool_arguments_reencoded: 1,
          unprojectable_tool_arguments: 1,
          data_urls: 1,
          images: 1,
        },
      });
      const projected = JSON.parse(document.stored_body);
      const calls =
        protocol === 'openai-chat-completions'
          ? projected.messages[0].tool_calls.map((call: { function: unknown }) => call.function)
          : projected.input;
      expect(JSON.parse(calls[0].arguments)).toEqual({
        auth: '[REDACTED]',
        cookies: '[OMITTED_PRIVATE_FIELD]',
        rows: [
          { config: '[OMITTED_PRIVATE_FIELD]', label: args.rows[0]!.label, values: [3, 1] },
          { headers: '[OMITTED_PRIVATE_FIELD]' },
        ],
        safe: 'kept',
      });
      expect(calls[1].arguments).toBe('[OMITTED_TOOL_ARGUMENTS]');
      expect(projected.unrelated.arguments).toBe(body.unrelated.arguments);
      expect(submitted).toBe(JSON.stringify(body));
    },
  );

  it('discloses exact versus JSON/argument reencoding without confusing raw and stored hashes', () => {
    const f = fixture();
    f.capture('{"input":[{"role":"user","content":"ordinary text"}]}');
    f.capture(
      JSON.stringify(
        { input: [{ type: 'function_call', arguments: '{ "safe": [2,1] }' }] },
        null,
        2,
      ),
    );
    const documents = f.documents().map((value) => value.document);
    const exact = documents.find((value) => value.body_disposition === 'exact');
    expect(exact.stored_body_sha256).toBe(exact.raw_request_sha256);
    const changed = documents.find((value) => value.body_disposition === 'redacted');
    expect(changed.reencoded).toBe(true);
    expect(changed.stored_body_sha256).not.toBe(changed.raw_request_sha256);
  });

  it.each(['raw_body_size_limit', 'stored_envelope_size_limit'])(
    'publishes only bounded metadata for %s, never a body prefix',
    (reason) => {
      const f = fixture();
      const raw =
        reason === 'raw_body_size_limit'
          ? JSON.stringify({ text: 'x'.repeat(8 * 1024 * 1024) })
          : JSON.stringify({ text: '"'.repeat(3 * 1024 * 1024) });
      f.capture(raw);
      const [{ text, document }] = f.documents();
      expect(document).toMatchObject({
        size_reason: reason,
        body_disposition: 'omitted',
        stored_body: null,
        stored_body_sha256: null,
        stored_body_utf8_bytes: null,
        raw_request_sha256: hash(raw),
        raw_request_utf8_bytes: Buffer.byteLength(raw),
      });
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16 * 1024);
    },
  );

  it('shares sixteen slots across calls and emits one content-free limit notice', () => {
    const f = fixture();
    for (let index = 0; index < 20; index++) f.capture('{"safe":true}');
    f.capture('invalid JSON must not be projected after the budget');
    expect(f.documents()).toHaveLength(16);
    expect(
      (console.error as ReturnType<typeof jest.spyOn>).mock.calls.filter(
        (call: unknown[]) => call[0] === 'Failed provider diagnostics limit reached.',
      ),
    ).toHaveLength(1);
    expect(f.documents().every((value) => Buffer.byteLength(value.text) <= 8 * 1024 * 1024)).toBe(
      true,
    );
    expect((console.error as ReturnType<typeof jest.spyOn>).mock.calls).toEqual([
      ['Failed provider diagnostics enabled (finite private local capture).'],
      ['Failed provider diagnostics limit reached.'],
    ]);
  });

  it('uses a monotonic one-hour completion deadline with no timers', () => {
    let now = 100;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const timer = jest.spyOn(globalThis, 'setTimeout');
    const f = fixture();
    now += 3_600_000 - 1;
    f.capture('{"safe":true}');
    now++;
    f.capture('{"safe":true}');
    f.capture('{"safe":true}');
    f.capture('invalid JSON must not be projected after expiry');
    expect(f.documents()).toHaveLength(1);
    expect(timer).not.toHaveBeenCalled();
    expect(
      (console.error as ReturnType<typeof jest.spyOn>).mock.calls.filter(
        (call: unknown[]) => call[0] === 'Failed provider diagnostics limit reached.',
      ),
    ).toHaveLength(1);
  });

  it('ignores all session files in a later initialized Git repository and consumes a reused activation without reading it', () => {
    const f = fixture();
    f.capture('{"safe":true}');
    execFileSync('git', ['init', '--quiet', f.root]);
    const tracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: f.root,
      encoding: 'utf8',
    });
    expect(tracked).toBe('');
    writeFileSync(join(f.directory, '.future.saivage-tmp'), 'ignored temporary');
    const check = execFileSync(
      'git',
      [
        'check-ignore',
        join(f.directory, '.gitignore'),
        f.documents()[0]!.path,
        join(f.directory, '.future.saivage-tmp'),
      ],
      { cwd: f.root, encoding: 'utf8' },
    );
    expect(check.trim().split('\n')).toHaveLength(3);
    const reused = new FailedProviderRequestDiagnostics(f.root, f.activation);
    reused.capture(
      {
        context,
        serializedBody: '{"safe":true}',
        contractId: 'x',
        protocol: 'openai-responses',
        provider: 'fixture',
        model: 'model',
        submittedAt: '2026-10-09T00:00:00.000Z',
        completedAt: '2026-10-09T00:00:01.000Z',
        observation: 'transport_failure',
        failureKind: 'unknown',
        providerCode: null,
        providerCodeTruncated: false,
        finishReason: null,
        httpStatus: null,
        embeddedStatus: null,
      },
      undefined,
    );
    expect(f.documents()).toHaveLength(1);
  });
});
