import { describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SECRET_REDACTION_PLACEHOLDER,
  type Redacted,
  makeSecret,
  redactionPort,
  redactForOutbound,
  redactSnippetForOutbound,
  redactTextForOutbound,
} from '../../src/redaction/index.js';
import { EventLogger } from '../../src/observability/event-logger.js';
import { ErrorLogger } from '../../src/observability/error-logger.js';
import { sendToClient } from '../../src/server/websocket.js';
import type { WsEnvelope } from '../../src/contracts/operator-events.js';
import {
  logOAuthRefreshException,
  logOAuthRefreshHttpFailure,
  logOAuthRefreshMissingAccessToken,
  logOAuthRefreshStart,
} from '../../src/auth/oauth-refresh-logger.js';

import { TelegramBot } from '../../src/telegram/bot.js';
import { createTestRuntimeApplication } from '../helpers/test-runtime-application.js';
import { CardStore } from '../../src/cards/card-store.js';

const RAW_TOKEN = 'SYNTHETIC_PROVIDER_TOKEN';
const RAW_ACCESS = 'SYNTHETIC_ACCESS';
const RAW_REFRESH = 'SYNTHETIC_REFRESH';
const RAW_INLINE = 'SYNTHETIC_INLINE';
const RAW_QUERY = 'SYNTHETIC_QUERY';
const RAW_TELEGRAM = 'SYNTHETIC_TELEGRAM_TOKEN';

function expectNoSyntheticSecret(value: string): void {
  expect(value).not.toContain(RAW_TOKEN);
  expect(value).not.toContain(RAW_ACCESS);
  expect(value).not.toContain(RAW_REFRESH);
  expect(value).not.toContain(RAW_INLINE);
  expect(value).not.toContain(RAW_QUERY);
  expect(value).not.toContain(RAW_TELEGRAM);
}

function makeSaivageDir(prefix: string): { root: string; saivageDir: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, saivageDir: join(root, '.saivage') };
}

describe('redaction port policies', () => {
  it('owns named outbound policies and redacts provider-like text patterns', () => {
    expect(redactionPort.policies()).toEqual(expect.arrayContaining([
      'observability.log',
      'error.log',
      'provider.diagnostic',
      'provider.message',
      'operator.websocket',
      'operator.api',
      'notification.transport',
    ]));

    const escaped = JSON.stringify('{"refresh_token":"SYNTHETIC_REFRESH"}');
    const redacted = redactTextForOutbound(
      `Bearer ${RAW_TOKEN} {"access_token":"${RAW_ACCESS}"} ${escaped} apiKey=${RAW_INLINE} https://x.test/cb?token=${RAW_QUERY} https://api.telegram.org/bot${RAW_TELEGRAM}/sendMessage`,
      'provider.diagnostic',
      { source: 'redaction-port-test' },
    );

    expectNoSyntheticSecret(redacted);
    expect(redacted).toContain(SECRET_REDACTION_PLACEHOLDER);
    expect(redactTextForOutbound(`Bearer ${RAW_TOKEN}`, 'provider.diagnostic')).not.toContain(RAW_TOKEN);
    expect(redactTextForOutbound(`{"access_token":"${RAW_ACCESS}"}`, 'provider.diagnostic')).not.toContain(RAW_ACCESS);
    expect(redactTextForOutbound(`apiKey=${RAW_INLINE}`, 'provider.diagnostic')).not.toContain(RAW_INLINE);
  });

  it('recursively redacts object fields while preserving non-secret values and safety limits', () => {
    const value: Record<string, unknown> = {
      token: RAW_ACCESS,
      nested: { authorization: `Bearer ${RAW_TOKEN}`, safe: 'visible' },
      list: [`apiKey=${RAW_INLINE}`],
    };
    value.self = value;

    const redacted = redactForOutbound(value, 'provider.message', { source: 'redaction-port-test', maxDepth: 4, maxEntries: 10 });
    const serialized = JSON.stringify(redacted);

    expectNoSyntheticSecret(serialized);
    expect(serialized).toContain('[Circular]');
    expect(serialized).toContain('visible');
  });

  it('redacts runtime action idempotency_key in outbound payloads', () => {
    const idempotencyKey = 'run-parent:planner-session:call-a:code-a';
    const activationEvent = redactForOutbound({
      kind: 'runtime_actionable_error',
      actionable_error: {
        code: 'test',
        idempotency_key: idempotencyKey,
        idempotency_token: 'SYNTHETIC_IDEMPOTENCY_TOKEN',
        idempotency_secret: 'SYNTHETIC_IDEMPOTENCY_SECRET',
      },
    }, 'observability.log', { source: 'redaction-port-test' });

    expect(activationEvent.actionable_error.idempotency_key).toBe(SECRET_REDACTION_PLACEHOLDER);
    expect(activationEvent.actionable_error.idempotency_token).toBe(SECRET_REDACTION_PLACEHOLDER);
    expect(activationEvent.actionable_error.idempotency_secret).toBe(SECRET_REDACTION_PLACEHOLDER);

    const operatorPayload = redactForOutbound({
      kind: 'runtime_actionable_error',
      actionable_error: { idempotency_key: 'SYNTHETIC_IDEMPOTENCY_KEY' },
    }, 'operator.websocket', { source: 'redaction-port-test' });
    expect(operatorPayload.actionable_error.idempotency_key).toBe(SECRET_REDACTION_PLACEHOLDER);
  });

  it('brands redacted values for compile-time sink APIs and Secret serializes redacted', () => {
    interface TypedSink { write(payload: Redacted<Record<string, unknown>>): void }
    const sink: TypedSink = { write: jest.fn() };
    const raw = { token: RAW_ACCESS, safe: 'visible' };
    // @ts-expect-error raw values must be explicitly passed through the redaction port before sink writes.
    sink.write(raw);
    sink.write(redactForOutbound(raw, 'operator.api', { source: 'redaction-port-test' }));
    expect(sink.write).toHaveBeenCalledTimes(2);

    const secret = makeSecret('raw-secret-value');
    expect(JSON.stringify({ secret })).toContain('[redacted]');
  });
});

describe('redacted outbound sinks', () => {
  it('EventLogger and ErrorLogger persist redacted JSONL records', () => {
    const { root, saivageDir } = makeSaivageDir('saivage-redaction-loggers-');
    const eventLogger = new EventLogger(saivageDir);
    const errorLogger = new ErrorLogger(saivageDir);
    try {
      eventLogger.appendEvent({
        kind: 'runtime_diagnostic',
        id: 'evt-redaction-port',
        timestamp: '2026-05-23T00:00:00.000Z',
        session_id: 'planner:redaction-port-test',
        error_name: 'TestError',
        error_message: `Provider failed Bearer ${RAW_TOKEN}`,
        provider_error: { access_token: RAW_ACCESS, safe: 'visible' },
      });
      errorLogger.appendError({
        message: `Failure body {"access_token":"${RAW_ACCESS}"}`,
        provider_error: { authorization: `Bearer ${RAW_TOKEN}`, safe: 'visible' },
      });

      const [event] = eventLogger.getEvents({ kind: 'runtime_diagnostic' });
      const [error] = errorLogger.getErrors();
      expectNoSyntheticSecret(JSON.stringify(event));
      expectNoSyntheticSecret(JSON.stringify(error));
      expect(JSON.stringify(event)).toContain('visible');
      expect(JSON.stringify(error)).toContain('visible');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('websocket send boundary serializes operator-visible envelopes with redacted content', () => {
    const sent: string[] = [];
    const ws = {
      OPEN: 1,
      readyState: 1,
      send(data: string) { sent.push(data); },
    };
    const envelope: WsEnvelope = {
      type: 'error',
      content: {
        error: 'provider_failed',
        details: `Bearer ${RAW_TOKEN} https://api.telegram.org/bot${RAW_TELEGRAM}/sendMessage?token=${RAW_QUERY}`,
      },
    };

    sendToClient(ws as never, envelope);
    expect(sent).toHaveLength(1);
    expectNoSyntheticSecret(sent[0]!);
    expect(sent[0]).toContain(SECRET_REDACTION_PLACEHOLDER);
  });

  it('OAuth, notification, agent, and Telegram diagnostics call the central port', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    logOAuthRefreshStart({ name: `profile apiKey=${RAW_INLINE}`, tokenEndpoint: `https://auth.test/token?access_token=${RAW_ACCESS}` });
    logOAuthRefreshHttpFailure({ name: 'profile', status: 401, body: { refresh_token: RAW_REFRESH } });
    logOAuthRefreshMissingAccessToken({ name: 'profile', response: `{"access_token":"${RAW_ACCESS}"}` });
    logOAuthRefreshException({ name: 'profile', error: new Error(`Bearer ${RAW_TOKEN}`) });
    const output = spy.mock.calls.map((call) => String(call[0])).join('\n');
    spy.mockRestore();
    expectNoSyntheticSecret(output);

    const summary = redactTextForOutbound(`Directive includes Bearer ${RAW_TOKEN} and apiKey=${RAW_INLINE} ${'x'.repeat(220)}`, 'notification.transport');
    // 2026-Q2 baseline measurement is ~279 bytes; keep modest headroom before re-tripping.
    expect(summary.length).toBeLessThanOrEqual(320);
    expectNoSyntheticSecret(summary);

    const redacted = redactTextForOutbound(
      `Provider failed with Bearer ${RAW_TOKEN} {"access_token":"${RAW_ACCESS}"}`,
      'model.issue',
      { source: 'invocation-service' },
    );
    expectNoSyntheticSecret(redacted);
  });

  it('redacts Telegram token-bearing retry diagnostics before console output', async () => {
    jest.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), 'saivage-telegram-redaction-'));
    const originalFetch = globalThis.fetch;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      mkdirSync(join(root, '.saivage', 'agents', 'sessions'), { recursive: true });
      mkdirSync(join(root, '.saivage', 'agents', 'messages'), { recursive: true });
      writeFileSync(join(root, '.saivage', 'saivage.json'), JSON.stringify({ telegram: { botToken: RAW_TELEGRAM, allowedUserIds: [1] } }));
      globalThis.fetch = jest.fn(() => Promise.reject(new Error(`network https://api.telegram.org/bot${RAW_TELEGRAM}/getUpdates?token=${RAW_QUERY}`))) as unknown as typeof fetch;
      const bot = new TelegramBot(root, createTestRuntimeApplication().analystDeps, { models: { default: ['model'] }, providers: {}, telegram: { botToken: RAW_TELEGRAM, allowedUserIds: [1] } } as never);
      const promise = (bot as unknown as { _telegramApiWithRetry<T>(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<T | undefined> })._telegramApiWithRetry('getUpdates', {}, new AbortController().signal);
      const handled = promise.catch((error: unknown) => error);
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(31_000);
      }
      await expect(handled).resolves.toBeInstanceOf(Error);
      const output = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expectNoSyntheticSecret(output);
      expect(output).toContain('/bot[REDACTED]/getUpdates');
    } finally {
      globalThis.fetch = originalFetch;
      warnSpy.mockRestore();
      jest.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('redacts snippets after applying the selected policy', () => {
    const redacted = redactSnippetForOutbound({ access_token: RAW_ACCESS, safe: 'visible-tail' }, 'provider.diagnostic', 80);
    expectNoSyntheticSecret(redacted);
    expect(redacted.length).toBeLessThanOrEqual(80);
    expect(redacted).toContain(SECRET_REDACTION_PLACEHOLDER);
  });
});
