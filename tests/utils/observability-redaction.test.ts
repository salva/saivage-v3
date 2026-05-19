import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from '@jest/globals';
import { EventLogger } from '../../src/utils/event-logger.js';

const roots: string[] = [];
const RAW_TOKEN = 'synthetic-token-value-49';
const RAW_API_KEY = 'synthetic-api-key-value-49';
const RAW_AUTH = 'Bearer synthetic-authorization-value-49';

function makeSaivageDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'saivage-observability-redaction-'));
  roots.push(root);
  return join(root, '.saivage');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('observability event redaction', () => {
  it('persists invocation_failed provider-error JSON with token/api_key/authorization values redacted', () => {
    const logger = new EventLogger(makeSaivageDir());
    logger.appendEvent({
      kind: 'invocation_failed',
      session_id: 'planner:redaction-test',
      role: 'planner',
      attempt: 1,
      error_message: `Provider failed: {"token":"${RAW_TOKEN}","api_key":"${RAW_API_KEY}","authorization":"${RAW_AUTH}","safe":"visible"}`,
      provider_error: {
        detail: 'Synthetic provider error',
        token: RAW_TOKEN,
        api_key: RAW_API_KEY,
        authorization: RAW_AUTH,
        nested: { accessToken: RAW_TOKEN, safe: 'visible' },
      },
    });

    const [event] = logger.getEvents({ kind: 'invocation_failed' });
    logger.close();

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(RAW_TOKEN);
    expect(serialized).not.toContain(RAW_API_KEY);
    expect(serialized).not.toContain(RAW_AUTH);
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('visible');
  });
});
