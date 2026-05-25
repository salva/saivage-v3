import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../../src/server/server.js';
import { getProjectNotificationDeliveryAdapters } from '../../src/notifications/notification-delivery.js';

const roots: string[] = [];

function makeRoot(config: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-telegram-startup-'));
  roots.push(root);
  const saivageDir = join(root, '.saivage');
  mkdirSync(join(saivageDir, 'agents', 'sessions'), { recursive: true });
  mkdirSync(join(saivageDir, 'agents', 'messages'), { recursive: true });
  writeFileSync(join(saivageDir, 'saivage.json'), JSON.stringify({
    models: { default: ['test-model'] },
    server: { host: '127.0.0.1', port: 18080 },
    ...config,
  }, null, 2));
  return root;
}


function mockTelegramLongPoll(): void {
  globalThis.fetch = jest.fn((_url, init) => new Promise((_resolve, reject) => {
    const signal = (init as RequestInit | undefined)?.signal;
    if (signal) signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  })) as unknown as typeof fetch;
}

function operatorLog(root: string): string {
  const path = join(root, '.saivage', 'runtime', 'notifications', 'operator.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}


async function captureProcessOutput<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  const chunks: string[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const capture = (chunk: unknown): void => { chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk)); };
  process.stdout.write = ((chunk: unknown, ...args: unknown[]) => { capture(chunk); return originalStdoutWrite(chunk as never, ...(args as never[])); }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...args: unknown[]) => { capture(chunk); return originalStderrWrite(chunk as never, ...(args as never[])); }) as typeof process.stderr.write;
  try {
    const result = await fn();
    await new Promise((resolve) => setImmediate(resolve));
    return { result, output: chunks.join('') };
  } finally {
    process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
    process.stderr.write = originalStderrWrite as typeof process.stderr.write;
  }
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
  jest.restoreAllMocks();
});

describe('server Telegram startup diagnostics', () => {
  it('persists a secret-safe diagnostic for telegram channel with bot and no recipients', async () => {
    mockTelegramLongPoll();
    const root = makeRoot({ telegram: { botToken: '123456:TEST_TOKEN' }, notifications: { channels: ['telegram'] } });
    const { output } = await captureProcessOutput(async () => {
      const server = await createServer(root, false);
      await server.stop();
    });
    expect(output).toContain('missing_recipients');
    expect(output).not.toContain('123456:TEST_TOKEN');
    expect(operatorLog(root)).toBe('');
  });

  it('persists a secret-safe diagnostic for recipients without a bot and registers no adapter', async () => {
    const root = makeRoot({ telegram: { notificationChatIds: [111111] }, notifications: { channels: ['telegram'] } });
    const { output } = await captureProcessOutput(async () => {
      const server = await createServer(root, false);
      expect(getProjectNotificationDeliveryAdapters(root)).toEqual([]);
      await server.stop();
    });
    expect(output).toContain('missing_bot_token');
    expect(output).toContain('recipients=1');
    expect(output).not.toContain('111111');
    expect(operatorLog(root)).toBe('');
  });

  it('registers a Telegram adapter for valid configured recipients without startup diagnostic', async () => {
    mockTelegramLongPoll();
    const root = makeRoot({ telegram: { botToken: '123456:TEST_TOKEN', notificationChatIds: [111111, 222222, 111111] }, notifications: { channels: ['telegram'] } });
    const server = await createServer(root, false);
    expect(getProjectNotificationDeliveryAdapters(root).map((adapter) => adapter.name)).toEqual(['telegram']);
    await server.stop();
    expect(operatorLog(root)).not.toContain('Telegram notification readiness');
  });
});
