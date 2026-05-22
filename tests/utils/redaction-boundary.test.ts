import { describe, expect, it, jest } from '@jest/globals';
import { RedactionBoundary } from '../../src/utils/redaction-boundary.js';
import {
  SECRET_REDACTION_PLACEHOLDER,
  redactCredentialLiterals,
  redactProviderLikeText,
  redactSecrets,
} from '../../src/utils/secret-redaction.js';
import { redactObservabilityText, redactObservabilityValue } from '../../src/utils/observability-redaction.js';
import {
  logOAuthRefreshException,
  logOAuthRefreshHttpFailure,
  logOAuthRefreshMissingAccessToken,
  logOAuthRefreshStart,
} from '../../src/auth/oauth-refresh-logger.js';
import { redactNotificationSummary } from '../../src/utils/notification-triggers.js';
import { TelegramBot } from '../../src/telegram/bot.js';
import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CTX = { sink: 'provider_diagnostic' as const, source: 'redaction-boundary-test' };

function expectNoSyntheticSecret(value: string): void {
  expect(value).not.toContain('SYNTHETIC_PROVIDER_TOKEN');
  expect(value).not.toContain('SYNTHETIC_ACCESS');
  expect(value).not.toContain('SYNTHETIC_REFRESH');
  expect(value).not.toContain('SYNTHETIC_INLINE');
  expect(value).not.toContain('SYNTHETIC_QUERY');
  expect(value).not.toContain('SYNTHETIC_TELEGRAM_TOKEN');
}

describe('RedactionBoundary', () => {
  it('redacts bearer, JSON, escaped JSON, inline assignments, URL query secrets, and Telegram path tokens', () => {
    const escaped = JSON.stringify('{"refresh_token":"SYNTHETIC_REFRESH"}');
    const redacted = RedactionBoundary.text(
      `Bearer SYNTHETIC_PROVIDER_TOKEN {"access_token":"SYNTHETIC_ACCESS"} ${escaped} apiKey=SYNTHETIC_INLINE https://x.test/cb?token=SYNTHETIC_QUERY https://api.telegram.org/botSYNTHETIC_TELEGRAM_TOKEN/sendMessage`,
      CTX,
    );

    expectNoSyntheticSecret(redacted);
    expect(redacted).toContain(SECRET_REDACTION_PLACEHOLDER);
  });

  it('converts unknown values before redaction and truncates only after redaction', () => {
    const redacted = RedactionBoundary.snippet(
      { access_token: 'SYNTHETIC_ACCESS', safe: 'visible-tail' },
      { ...CTX, maxLength: 80 },
    );

    expectNoSyntheticSecret(redacted);
    expect(redacted.length).toBeLessThanOrEqual(80);
    expect(redacted).toContain(SECRET_REDACTION_PLACEHOLDER);
  });

  it('redacts Error messages', () => {
    const redacted = RedactionBoundary.error(new Error('failed with Bearer SYNTHETIC_PROVIDER_TOKEN'), CTX);
    expectNoSyntheticSecret(redacted);
    expect(redacted).toContain('failed with Bearer');
  });

  it('recursively redacts object values with key hints, cycles, depth and entry safeguards', () => {
    const value: Record<string, unknown> = {
      token: 'SYNTHETIC_ACCESS',
      nested: { authorization: 'Bearer SYNTHETIC_PROVIDER_TOKEN', safe: 'visible' },
      list: ['apiKey=SYNTHETIC_INLINE'],
    };
    value.self = value;

    const redacted = RedactionBoundary.object(value, { ...CTX, maxDepth: 4, maxEntries: 10 });
    const serialized = JSON.stringify(redacted);

    expectNoSyntheticSecret(serialized);
    expect(serialized).toContain('[Circular]');
    expect(serialized).toContain('visible');
  });

  it('preserves idempotency_key only on runtime_activation activation records in observability', () => {
    const idempotencyKey = 'run-parent:planner-session:call-a:code-a';
    const activationEvent = RedactionBoundary.object({
      kind: 'runtime_activation',
      activation: {
        activation_id: 'act-1',
        idempotency_key: idempotencyKey,
        idempotency_token: 'SYNTHETIC_IDEMPOTENCY_TOKEN',
        idempotency_secret: 'SYNTHETIC_IDEMPOTENCY_SECRET',
      },
    }, { sink: 'observability', source: 'redaction-boundary-test' });

    expect(activationEvent.activation.idempotency_key).toBe(idempotencyKey);
    expect(activationEvent.activation.idempotency_token).toBe(SECRET_REDACTION_PLACEHOLDER);
    expect(activationEvent.activation.idempotency_secret).toBe(SECRET_REDACTION_PLACEHOLDER);

    const unrelatedObservability = RedactionBoundary.object({
      kind: 'invocation_succeeded',
      activation: { idempotency_key: 'SYNTHETIC_UNRELATED_IDEMPOTENCY_KEY' },
      idempotency_key: 'SYNTHETIC_TOP_LEVEL_IDEMPOTENCY_KEY',
    }, { sink: 'observability', source: 'redaction-boundary-test' });
    expect(unrelatedObservability.activation.idempotency_key).toBe(SECRET_REDACTION_PLACEHOLDER);
    expect(unrelatedObservability.idempotency_key).toBe(SECRET_REDACTION_PLACEHOLDER);

    const nonObservability = RedactionBoundary.object({
      kind: 'runtime_activation',
      activation: { idempotency_key: 'SYNTHETIC_NON_OBSERVABILITY_IDEMPOTENCY_KEY' },
    }, CTX);
    expect(nonObservability.activation.idempotency_key).toBe(SECRET_REDACTION_PLACEHOLDER);
  });

  it('redacts idempotency_key in malformed runtime_activation activation containers', () => {
    const activationArray = RedactionBoundary.object({
      kind: 'runtime_activation',
      activation: [{ idempotency_key: 'SYNTHETIC_ARRAY_IDEMPOTENCY_KEY' }],
    }, { sink: 'observability', source: 'redaction-boundary-test' });
    expect(activationArray.activation[0].idempotency_key).toBe(SECRET_REDACTION_PLACEHOLDER);

    const nestedActivation = RedactionBoundary.object({
      kind: 'runtime_activation',
      activation: { nested: { idempotency_key: 'SYNTHETIC_NESTED_IDEMPOTENCY_KEY' } },
    }, { sink: 'observability', source: 'redaction-boundary-test' });
    expect(nestedActivation.activation.nested.idempotency_key).toBe(SECRET_REDACTION_PLACEHOLDER);

    const nestedArrayActivation = RedactionBoundary.object({
      kind: 'runtime_activation',
      activation: { records: [{ idempotency_key: 'SYNTHETIC_NESTED_ARRAY_IDEMPOTENCY_KEY' }] },
    }, { sink: 'observability', source: 'redaction-boundary-test' });
    expect(nestedArrayActivation.activation.records[0].idempotency_key).toBe(SECRET_REDACTION_PLACEHOLDER);
  });

  it('keeps secret-like key variants redacted in observability objects', () => {
    const redacted = RedactionBoundary.object({
      kind: 'runtime_activation',
      activation: {
        idempotency_key: 'visible-runtime-ledger-key',
        api_key: 'SYNTHETIC_API_KEY',
        access_token: 'SYNTHETIC_ACCESS_TOKEN',
        refresh_token: 'SYNTHETIC_REFRESH_TOKEN',
        authorization: 'Bearer SYNTHETIC_AUTHORIZATION',
        idempotency_token: 'SYNTHETIC_IDEMPOTENCY_TOKEN',
        idempotency_secret: 'SYNTHETIC_IDEMPOTENCY_SECRET',
      },
    }, { sink: 'observability', source: 'redaction-boundary-test' });

    expect(redacted.activation.idempotency_key).toBe('visible-runtime-ledger-key');
    for (const key of ['api_key', 'access_token', 'refresh_token', 'authorization', 'idempotency_token', 'idempotency_secret'] as const) {
      expect(redacted.activation[key]).toBe(SECRET_REDACTION_PLACEHOLDER);
    }
  });

  it('redacts Telegram bot-token URL paths through url()', () => {
    const redacted = RedactionBoundary.url(
      'https://api.telegram.org/botSYNTHETIC_TELEGRAM_TOKEN/getUpdates?token=SYNTHETIC_QUERY',
      { sink: 'telegram_diagnostic', source: 'telegram-bot' },
    );
    expectNoSyntheticSecret(redacted);
    expect(redacted).toContain(`/bot${SECRET_REDACTION_PLACEHOLDER}/getUpdates`);
  });
});

describe('redaction compatibility exports', () => {
  it('keeps secret-redaction exports redacting provider-like content', () => {
    expectNoSyntheticSecret(redactCredentialLiterals('Bearer SYNTHETIC_PROVIDER_TOKEN'));
    expectNoSyntheticSecret(redactSecrets('{"access_token":"SYNTHETIC_ACCESS"}'));
    expectNoSyntheticSecret(redactProviderLikeText('apiKey=SYNTHETIC_INLINE https://api.telegram.org/botSYNTHETIC_TELEGRAM_TOKEN/sendMessage'));
  });

  it('keeps observability wrappers redacting recursively and by key hint', () => {
    const value = redactObservabilityValue({ accessToken: 'SYNTHETIC_ACCESS', detail: 'Bearer SYNTHETIC_PROVIDER_TOKEN', safe: 'visible' });
    const serialized = JSON.stringify(value);
    expectNoSyntheticSecret(serialized);
    expect(serialized).toContain('visible');
    expect(redactObservabilityText('token=SYNTHETIC_QUERY')).not.toContain('SYNTHETIC_QUERY');
  });
});

describe('OAuth refresh logger boundary', () => {
  it('preserves prefixes while redacting dynamic OAuth log values', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    logOAuthRefreshStart({ name: 'profile apiKey=SYNTHETIC_INLINE', tokenEndpoint: 'https://auth.test/token?access_token=SYNTHETIC_ACCESS' });
    logOAuthRefreshHttpFailure({ name: 'profile', status: 401, body: { refresh_token: 'SYNTHETIC_REFRESH' } });
    logOAuthRefreshMissingAccessToken({ name: 'profile', response: '{"access_token":"SYNTHETIC_ACCESS"}' });
    logOAuthRefreshException({ name: 'profile', error: new Error('Bearer SYNTHETIC_PROVIDER_TOKEN') });

    const output = spy.mock.calls.map((call) => String(call[0])).join('\n');
    spy.mockRestore();
    expect(output).toContain('[oauth-profiles]');
    expectNoSyntheticSecret(output);
  });
});

describe('notification payload boundary', () => {
  it('redacts and summarizes payload summaries before persistence/injection', () => {
    const summary = redactNotificationSummary(`Directive includes Bearer SYNTHETIC_PROVIDER_TOKEN and apiKey=SYNTHETIC_INLINE ${'x'.repeat(220)}`);
    expect(summary.length).toBeLessThanOrEqual(160);
    expectNoSyntheticSecret(summary);
    expect(summary).toContain(SECRET_REDACTION_PLACEHOLDER);
  });
});

describe('agent and Telegram diagnostic boundaries', () => {
  it('redacts provider errors through the agent model_issue helper', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-agent-redaction-'));
    try {
      const adapter = new AgentAdapter({
        projectRoot: root,
        saivageDir: join(root, '.saivage'),
        config: { models: { default: ['model'] }, providers: {} },
      } as never);
      const redacted = (adapter as unknown as { redactProviderErrorMessage(message: unknown): string }).redactProviderErrorMessage(
        'Provider failed with Bearer SYNTHETIC_PROVIDER_TOKEN {"access_token":"SYNTHETIC_ACCESS"}',
      );
      expectNoSyntheticSecret(redacted);
      expect(redacted).toContain(SECRET_REDACTION_PLACEHOLDER);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('redacts Telegram token-bearing diagnostics before console output', async () => {
    jest.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), 'saivage-telegram-redaction-'));
    const originalFetch = globalThis.fetch;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let output = '';
    try {
      mkdirSync(join(root, '.saivage', 'agents', 'sessions'), { recursive: true });
      mkdirSync(join(root, '.saivage', 'agents', 'messages'), { recursive: true });
      writeFileSync(join(root, '.saivage', 'saivage.json'), JSON.stringify({ telegram: { botToken: 'SYNTHETIC_TELEGRAM_TOKEN', allowedUserIds: [1] } }));
      globalThis.fetch = jest.fn(() => Promise.reject(new Error('network https://api.telegram.org/botSYNTHETIC_TELEGRAM_TOKEN/getUpdates?token=SYNTHETIC_QUERY'))) as unknown as typeof fetch;
      const bot = new TelegramBot(root);
      const promise = (bot as unknown as { _telegramApiWithRetry<T>(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<T | undefined> })._telegramApiWithRetry('getUpdates', {}, new AbortController().signal);
      const handled = promise.catch((error: unknown) => error);
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(31_000);
      }
      await expect(handled).resolves.toBeInstanceOf(Error);
      output = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
    } finally {
      globalThis.fetch = originalFetch;
      warnSpy.mockRestore();
      jest.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }

    expectNoSyntheticSecret(output);
    expect(output).toContain('/bot[REDACTED]/getUpdates');
  });
});
