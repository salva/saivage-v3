import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLlmExchangeRecorder,
  type LlmExchangeRecorderLogger,
} from '../../src/agents/llm-exchange-recorder.js';
import { exchangePath, readLatestLlmExchange } from '../../src/agents/llm-exchange-log.js';
import { llmExchangeSchema, type LlmExchange } from '../../src/contracts/llm-exchange.js';

let roots: string[] = [];

function makeSaivageDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-llm-exchange-rec-test-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const r of roots) {
    try { rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  roots = [];
});

const sampleRequest = {
  endpoint: 'https://api.example.test/v1/chat',
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: { messages: [{ role: 'user', content: 'hi' }] },
};

const sampleCandidate = { provider: 'openai', model: 'gpt-x', account: 'acct-a' };

describe('llm-exchange-recorder', () => {
  it('records a successful exchange', async () => {
    const saivage = makeSaivageDir();
    const rec = createLlmExchangeRecorder({ saivageDir: saivage, sessionId: 'sess-ok' });
    const handle = await rec.beginExchange({
      transport: 'generic',
      contract_id: 'test.v1',
      candidate: sampleCandidate,
      request: sampleRequest,
      contractName: 'test', terminalToolOffered: [],
    });
    await handle.recordResponse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      bodyRaw: '{"ok":true}',
      bodyParsed: { ok: true },
    }, null);
    await rec.flush();

    const got = await readLatestLlmExchange(saivage, 'sess-ok');
    expect(got).not.toBeNull();
    expect(got!.attempts).toHaveLength(1);
    expect(got!.attempts[0]).toMatchObject({
      attempt: 0,
      status: 'ok',
      response: { status: 200, bodyParsed: { ok: true } },
    });
    expect(got!.attempts[0].completedAt).toEqual(expect.any(String));
  });

  it('records an error exchange with bodyRaw preserved', async () => {
    const saivage = makeSaivageDir();
    const rec = createLlmExchangeRecorder({ saivageDir: saivage, sessionId: 'sess-err' });
    const handle = await rec.beginExchange({
      transport: 'generic',
      contract_id: 'test.v1',
      candidate: sampleCandidate,
      request: sampleRequest,
      contractName: 'test', terminalToolOffered: [],
    });
    await handle.recordError({
      errorName: 'HttpError',
      message: 'boom',
      status: 503,
      bodyRaw: '{"error":"upstream"}',
    });
    await rec.flush();

    const got = await readLatestLlmExchange(saivage, 'sess-err');
    expect(got!.attempts[0]).toMatchObject({
      attempt: 0,
      status: 'error',
      error: { errorName: 'HttpError', message: 'boom', status: 503, bodyRaw: '{"error":"upstream"}' },
    });
  });

  it('records two retries as attempt 0 and attempt 1 in the same file', async () => {
    const saivage = makeSaivageDir();
    const rec = createLlmExchangeRecorder({ saivageDir: saivage, sessionId: 'sess-retry' });

    const h1 = await rec.beginExchange({ transport: 'generic', contract_id: 'test.v1', candidate: sampleCandidate, request: sampleRequest, contractName: 'test', terminalToolOffered: [] });
    await h1.recordError({ errorName: 'HttpError', message: 'first', status: 500, bodyRaw: null });

    const h2 = await rec.beginExchange({ transport: 'generic', contract_id: 'test.v1', candidate: sampleCandidate, request: sampleRequest, contractName: 'test', terminalToolOffered: [] });
    await h2.recordResponse({ status: 200, bodyRaw: 'ok', bodyParsed: null }, null);
    await rec.flush();

    const got = await readLatestLlmExchange(saivage, 'sess-retry');
    expect(got!.attempts).toHaveLength(2);
    expect(got!.attempts[0]).toMatchObject({ attempt: 0, status: 'error' });
    expect(got!.attempts[1]).toMatchObject({ attempt: 1, status: 'ok' });
  });

  it('keeps handle correlation across interleaved concurrent calls', async () => {
    const saivage = makeSaivageDir();
    const rec = createLlmExchangeRecorder({ saivageDir: saivage, sessionId: 'sess-concur' });
    const h1 = await rec.beginExchange({ transport: 'generic', contract_id: 'test.v1', candidate: sampleCandidate, request: sampleRequest, contractName: 'test', terminalToolOffered: [] });
    const h2 = await rec.beginExchange({ transport: 'generic', contract_id: 'test.v1', candidate: sampleCandidate, request: sampleRequest, contractName: 'test', terminalToolOffered: [] });

    await Promise.all([
      h2.recordError({ errorName: 'E', message: 'm', bodyRaw: null }),
      h1.recordResponse({ status: 200, bodyRaw: null, bodyParsed: { ok: 1 } }, null),
    ]);
    await rec.flush();

    const got = await readLatestLlmExchange(saivage, 'sess-concur');
    expect(got!.attempts).toHaveLength(2);
    expect(got!.attempts[0]).toMatchObject({ attempt: 0, status: 'ok' });
    expect(got!.attempts[1]).toMatchObject({ attempt: 1, status: 'error' });
  });

  it('isolates write failures via eventLogger and never rejects', async () => {
    const saivage = makeSaivageDir();
    const calls: Array<Parameters<LlmExchangeRecorderLogger['recordExchangeRecorderError']>[0]> = [];
    const logger: LlmExchangeRecorderLogger = {
      recordExchangeRecorderError: (e) => { calls.push(e); },
    };
    const failingWrite = jest.fn(async () => { throw new Error('disk-failure'); });
    const rec = createLlmExchangeRecorder({
      saivageDir: saivage,
      sessionId: 'sess-fail',
      eventLogger: logger,
      _writeExchange: failingWrite as unknown as (sd: string, e: LlmExchange) => Promise<void>,
    });

    const handle = await rec.beginExchange({ transport: 'generic', contract_id: 'test.v1', candidate: sampleCandidate, request: sampleRequest, contractName: 'test', terminalToolOffered: [] });
    await expect(handle.recordResponse({ status: 200, bodyRaw: null, bodyParsed: null }, null)).resolves.toBeUndefined();
    await rec.flush();

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.every((c) => c.source === 'llm-exchange-recorder' && c.sessionId === 'sess-fail')).toBe(true);
    expect(failingWrite).toHaveBeenCalled();
  });

  it('flush awaits in-flight writes', async () => {
    const saivage = makeSaivageDir();
    const { writeLatestLlmExchange } = await import('../../src/agents/llm-exchange-log.js');
    let pendingResolve!: () => void;
    const pending = new Promise<void>((res) => { pendingResolve = res; });
    let writeCount = 0;
    const slowWrite = async (sd: string, e: LlmExchange): Promise<void> => {
      writeCount++;
      // Only block the second write (the response update); let the initial
      // in-progress write from beginExchange complete normally so the test
      // can reach the recordResponse stage.
      if (writeCount >= 2) await pending;
      await writeLatestLlmExchange(sd, e);
    };
    const rec = createLlmExchangeRecorder({
      saivageDir: saivage,
      sessionId: 'sess-flush',
      _writeExchange: slowWrite,
    });
    const handle = await rec.beginExchange({ transport: 'generic', contract_id: 'test.v1', candidate: sampleCandidate, request: sampleRequest, contractName: 'test', terminalToolOffered: [] });
    void handle.recordResponse({ status: 200, bodyRaw: null, bodyParsed: null }, null);

    let flushDone = false;
    const flushPromise = rec.flush().then(() => { flushDone = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(flushDone).toBe(false);
    pendingResolve();
    await flushPromise;
    expect(flushDone).toBe(true);
    expect(writeCount).toBeGreaterThanOrEqual(2);
  });

  it('redacts authorization bearer tokens from the on-disk file', async () => {
    const saivage = makeSaivageDir();
    const rec = createLlmExchangeRecorder({ saivageDir: saivage, sessionId: 'sess-redact' });
    const handle = await rec.beginExchange({
      transport: 'generic',
      contract_id: 'test.v1',
      candidate: sampleCandidate,
      request: {
        endpoint: 'https://api.example.test/v1/chat',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer sk-super-secret-token-123',
        },
        body: { messages: [] },
      },
      contractName: 'test', terminalToolOffered: [],
    });
    await handle.recordResponse({ status: 200, bodyRaw: null, bodyParsed: null }, null);
    await rec.flush();

    const raw = readFileSync(exchangePath(saivage, 'sess-redact'), 'utf8');
    expect(raw).not.toContain('sk-super-secret-token-123');
  });

  it('keeps the on-disk file schema-valid after many interleaved writes', async () => {
    const saivage = makeSaivageDir();
    const rec = createLlmExchangeRecorder({ saivageDir: saivage, sessionId: 'sess-stress' });
    const handles = await Promise.all(
      Array.from({ length: 25 }, () =>
        rec.beginExchange({ transport: 'generic', contract_id: 'test.v1', candidate: sampleCandidate, request: sampleRequest, contractName: 'test', terminalToolOffered: [] }),
      ),
    );
    const ops: Array<Promise<void>> = [];
    for (let i = 0; i < handles.length; i++) {
      const h = handles[i]!;
      if (i % 2 === 0) ops.push(h.recordResponse({ status: 200, bodyRaw: null, bodyParsed: null }, null));
      else ops.push(h.recordError({ errorName: 'E', message: 'm', bodyRaw: null }));
    }
    await Promise.all(ops);
    await rec.flush();

    const raw = readFileSync(exchangePath(saivage, 'sess-stress'), 'utf8');
    const parsed = JSON.parse(raw);
    const result = llmExchangeSchema.safeParse(parsed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attempts).toHaveLength(25);
      const indices = result.data.attempts.map((a) => a.attempt);
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
    }
  });
});
