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
  it.each(['openai-responses', 'openai-codex-backend', 'openai-chat-completions'])(
    'separates native positions from lookalike application data for %s',
    (protocol) => {
      const f = fixture();
      const application = {
        type: 'reasoning',
        id: 'row-7',
        file_id: 'document-3',
        conversation: 'ordinary',
        previous_response_id: 'ordinary-prior',
        encrypted_content: 'ordinary-label',
        content: [{ type: 'image', label: 'diagram' }],
        nested: '{"auth":{"value":"encoded prose"}}',
      };
      const prose = JSON.stringify(application);
      const args = JSON.stringify({
        application,
        auth: { value: 'hidden-auth' },
        config: { value: 'hidden-config' },
        image_data: 'hidden-pixels',
        label: 'active-fixture-literal',
        nested: [{ auth: { value: 'hidden-nested' } }],
        prose,
      });
      const isChat = protocol === 'openai-chat-completions';
      const body = {
        instructions: prose,
        tools: [{ description: prose, parameters: application }],
        ...(isChat
          ? {
              messages: [
                {
                  role: 'assistant',
                  content: [
                    {
                      type: 'text',
                      text: 'visible',
                      annotations: [{ file_id: 'hidden-citation' }],
                      'hidden-extension-name': { value: 'hidden-extension' },
                    },
                    { type: 'future-content', private: 'hidden-unknown' },
                    { type: 'image_url', image_url: { url: 'hidden-image' } },
                  ],
                  tool_calls: [
                    {
                      id: 'call-7',
                      type: 'function',
                      function: {
                        name: 'lookup',
                        arguments: args,
                        'hidden-function-key': 'hidden-function',
                      },
                    },
                  ],
                },
                { role: 'tool', tool_call_id: 'call-7', content: prose },
              ],
            }
          : {
              previous_response_id: 'hidden-prior',
              conversation: { id: 'hidden-conversation' },
              input: [
                {
                  type: 'message',
                  id: 'hidden-message-id',
                  role: 'assistant',
                  status: 'completed',
                  content: [
                    {
                      type: 'output_text',
                      text: 'visible',
                      annotations: [{ file_id: 'hidden-citation' }],
                      'hidden-extension-name': { value: 'hidden-extension' },
                    },
                    { type: 'future-content', private: 'hidden-unknown' },
                    { type: 'input_image', image_url: 'hidden-image' },
                  ],
                },
                { type: 'file_search_call', 'hidden-opaque-key': 'hidden-opaque' },
                {
                  type: 'function_call',
                  id: 'hidden-call-id',
                  call_id: 'call-7',
                  name: 'lookup',
                  arguments: args,
                },
                { type: 'function_call_output', call_id: 'call-7', output: prose },
                { type: 'output_text', text: 'tail', logprobs: { secret: 'hidden-logprobs' } },
                {
                  type: 'refusal',
                  refusal: 'visible refusal',
                  'hidden-refusal-key': 'hidden-refusal',
                },
              ],
            }),
      };
      const submitted = JSON.stringify(body);
      f.capture(submitted, protocol);
      const [{ document }] = f.documents();
      const stored = JSON.parse(document.stored_body);
      expect(document).toMatchObject({
        format_version: 2,
        privacy_policy: 'failed-provider-request-privacy-2',
        body_disposition: 'redacted',
        raw_request_sha256: hash(submitted),
        raw_request_utf8_bytes: Buffer.byteLength(submitted),
        stored_body_sha256: hash(document.stored_body),
        stored_body_utf8_bytes: Buffer.byteLength(document.stored_body),
        counts: {
          private_replay: isChat ? 4 : 10,
          images: 2,
          structured_private: 3,
          structured_redactions: 2,
          text_redactions: 1,
          tool_arguments_reencoded: 1,
          unprojectable_tool_arguments: 0,
          data_urls: 0,
        },
      });
      expect(stored.instructions).toBe(prose);
      expect(stored.tools).toEqual(body.tools);
      const call = isChat ? stored.messages[0].tool_calls[0].function : stored.input[2];
      expect(call.name).toBe('lookup');
      expect(JSON.parse(call.arguments)).toEqual({
        application,
        auth: '[REDACTED]',
        config: '[OMITTED_PRIVATE_FIELD]',
        image_data: '[OMITTED_IMAGE]',
        label: '[REDACTED]',
        nested: [{ auth: '[REDACTED]' }],
        prose,
      });
      const parts = isChat ? stored.messages[0].content : stored.input[0].content;
      expect(parts).toEqual([
        {
          type: isChat ? 'text' : 'output_text',
          text: 'visible',
          _diagnostic_omitted_extensions: '[OMITTED_PRIVATE_REPLAY]',
        },
        '[OMITTED_PRIVATE_REPLAY]',
        '[OMITTED_IMAGE]',
      ]);
      if (isChat) {
        expect(stored.messages[0].tool_calls[0].id).toBe('call-7');
        expect(stored.messages[1]).toEqual({
          role: 'tool',
          tool_call_id: 'call-7',
          content: prose,
        });
      } else {
        expect(stored.input).toHaveLength(6);
        expect(stored.input[1]).toBe('[OMITTED_PRIVATE_REPLAY]');
        expect(stored.input[2].call_id).toBe('call-7');
        expect(stored.input[3]).toEqual({
          type: 'function_call_output',
          call_id: 'call-7',
          output: prose,
        });
        expect(stored.input[4].text).toBe('tail');
        expect(stored.input[5].refusal).toBe('visible refusal');
      }
      expect(document.stored_body).not.toContain('hidden-');
      expect(document.stored_body).not.toContain('active-fixture-literal');
    },
  );

  it('omits unexpected native scalar subtrees and invalid/non-string arguments without raw fallback', () => {
    const f = fixture();
    f.capture(
      JSON.stringify({
        input: [
          {
            type: 'function_call',
            name: { 'private-name': 'hidden' },
            arguments: { auth: 'hidden' },
            call_id: ['hidden'],
          },
          { type: 'function_call', arguments: 'invalid hidden JSON' },
          { role: 'user', content: { 'private-content': 'hidden' } },
          { type: 'output_text', text: { 'private-text': 'hidden' } },
        ],
      }),
    );
    const [{ document }] = f.documents();
    expect(document.counts).toMatchObject({
      private_replay: 4,
      unprojectable_tool_arguments: 2,
      tool_arguments_reencoded: 0,
    });
    expect(document.stored_body).not.toContain('hidden');
    expect(document.stored_body).not.toContain('private-');
  });

  it.each(['openai-responses', 'openai-codex-backend'])(
    'retains ordered protocol tool-result content and correlates its call for %s',
    (protocol) => {
      const f = fixture();
      const prose =
        '{"type":"reasoning","file_id":"ordinary-result","auth":{"value":"encoded prose"}}';
      f.capture(
        JSON.stringify({
          input: [
            {
              type: 'function_call_output',
              id: 'hidden-native-id',
              status: 'completed',
              call_id: 'call-result',
              output: [
                { type: 'input_text', text: prose, annotations: { private: 'hidden-annotation' } },
                { type: 'input_image', image_url: 'hidden-pixels', file_id: 'hidden-image' },
                { type: 'future-result', 'hidden-extension': 'hidden-value' },
              ],
            },
            {
              type: 'function_call_output',
              call_id: 'call-structured',
              output: { 'hidden-output-key': 'hidden-output' },
            },
          ],
        }),
        protocol,
      );
      const [{ document }] = f.documents();
      expect(document.counts).toEqual({
        structured_private: 0,
        structured_redactions: 0,
        images: 1,
        private_replay: 4,
        data_urls: 0,
        tool_arguments_reencoded: 0,
        unprojectable_tool_arguments: 0,
        text_redactions: 0,
      });
      expect(JSON.parse(document.stored_body).input).toEqual([
        {
          type: 'function_call_output',
          _diagnostic_omitted_extensions: '[OMITTED_PRIVATE_REPLAY]',
          status: 'completed',
          call_id: 'call-result',
          output: [
            {
              type: 'input_text',
              text: prose,
              _diagnostic_omitted_extensions: '[OMITTED_PRIVATE_REPLAY]',
            },
            '[OMITTED_IMAGE]',
            '[OMITTED_PRIVATE_REPLAY]',
          ],
        },
        {
          type: 'function_call_output',
          call_id: 'call-structured',
          output: '[OMITTED_PRIVATE_REPLAY]',
        },
      ]);
      expect(document.stored_body).not.toContain('hidden-');
    },
  );

  it('omits unknown Chat call kinds without echoing their discriminators', () => {
    const f = fixture();
    f.capture(
      JSON.stringify({
        messages: [
          {
            role: 'assistant',
            content: 'visible',
            tool_calls: [
              {
                type: 'hidden-future-kind',
                id: 'hidden-native-id',
                function: { name: 'hidden-name', arguments: '{}' },
              },
            ],
          },
        ],
      }),
      'openai-chat-completions',
    );
    const [{ document }] = f.documents();
    expect(JSON.parse(document.stored_body).messages).toEqual([
      { role: 'assistant', content: 'visible', tool_calls: ['[OMITTED_PRIVATE_REPLAY]'] },
    ]);
    expect(document.counts.private_replay).toBe(1);
    expect(document.counts.tool_arguments_reencoded).toBe(0);
    expect(document.stored_body).not.toContain('hidden-');
  });

  it('fails unsupported protocols with the fixed capture-failed notice, never a Responses fallback', () => {
    const f = fixture();
    f.capture('{"input":[{"type":"output_text","text":"hidden"}]}', 'unknown-protocol');
    expect(f.documents()).toEqual([]);
    expect((console.error as ReturnType<typeof jest.spyOn>).mock.calls.at(-1)).toEqual([
      'Failed provider diagnostic capture failed.',
    ]);
  });
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
