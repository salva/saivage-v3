import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  exchangePath,
  LlmExchangeCorruptedError,
  readLatestLlmExchange,
  writeLatestLlmExchange,
} from '../../src/agents/llm-exchange-log.js';
import type { LlmExchange } from '../../src/contracts/llm-exchange.js';

let roots: string[] = [];

function makeSaivageDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-llm-exchange-log-test-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const r of roots) {
    try { rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  roots = [];
});

function sampleExchange(sessionId = 'sess-1'): LlmExchange {
  return {
    sessionId,
    contract_id: 'test.v1',
    capturedAt: '2026-05-23T00:00:00.000Z',
    transport: 'generic',
    candidate: { provider: 'openai', model: 'gpt-x', account: 'acct-a' },
    attempts: [
      {
        attempt: 0,
        startedAt: '2026-05-23T00:00:00.000Z',
        completedAt: '2026-05-23T00:00:01.000Z',
        status: 'ok',
        terminalTool: null,
        request: {
          endpoint: 'https://api.example.test/v1/chat',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: { model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] },
        },
        response: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          bodyRaw: '{"id":"r1"}',
          bodyParsed: { id: 'r1' },
        },
      },
    ],
  };
}

describe('llm-exchange-log', () => {
  it('exchangePath joins saivageDir/agents/llm-exchanges/<session>.json', () => {
    const p = exchangePath('/tmp/sv', 'sess-42');
    expect(p).toBe('/tmp/sv/agents/llm-exchanges/sess-42.json');
  });

  it('round-trips a write then read', async () => {
    const saivage = makeSaivageDir();
    const exch = sampleExchange();
    await writeLatestLlmExchange(saivage, exch);
    const got = await readLatestLlmExchange(saivage, exch.sessionId);
    expect(got).toEqual(exch);
  });

  it('returns null when the file does not exist', async () => {
    const saivage = makeSaivageDir();
    const got = await readLatestLlmExchange(saivage, 'nope');
    expect(got).toBeNull();
  });

  it('throws LlmExchangeCorruptedError with cause on invalid JSON', async () => {
    const saivage = makeSaivageDir();
    const sessionId = 'broken-json';
    const p = exchangePath(saivage, sessionId);
    mkdirSync(join(saivage, 'agents', 'llm-exchanges'), { recursive: true });
    writeFileSync(p, '{not json');
    await expect(readLatestLlmExchange(saivage, sessionId)).rejects.toMatchObject({
      name: 'LlmExchangeCorruptedError',
    });
    try {
      await readLatestLlmExchange(saivage, sessionId);
    } catch (err) {
      expect(err).toBeInstanceOf(LlmExchangeCorruptedError);
      expect((err as LlmExchangeCorruptedError).cause).toBeDefined();
    }
  });

  it('throws LlmExchangeCorruptedError on schema-invalid JSON', async () => {
    const saivage = makeSaivageDir();
    const sessionId = 'bad-schema';
    const p = exchangePath(saivage, sessionId);
    mkdirSync(join(saivage, 'agents', 'llm-exchanges'), { recursive: true });
    writeFileSync(p, JSON.stringify({ sessionId, attempts: [] }));
    await expect(readLatestLlmExchange(saivage, sessionId)).rejects.toBeInstanceOf(
      LlmExchangeCorruptedError,
    );
  });

  it('rejects writes that fail Zod validation', async () => {
    const saivage = makeSaivageDir();
    const bad = { sessionId: 'x', attempts: [] } as unknown as LlmExchange;
    await expect(writeLatestLlmExchange(saivage, bad)).rejects.toThrow();
  });

  it('persists JSON that contains the redacted fields verbatim on disk', async () => {
    const saivage = makeSaivageDir();
    const exch = sampleExchange('sess-disk');
    await writeLatestLlmExchange(saivage, exch);
    const raw = readFileSync(exchangePath(saivage, 'sess-disk'), 'utf8');
    expect(JSON.parse(raw)).toEqual(exch);
  });
});
