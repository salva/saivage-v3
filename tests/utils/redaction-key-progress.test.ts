import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe('finite actual-owner redaction progress', () => {
  it.each(['fresh', 'warm'])('completes the %s group in an interruptible subprocess', (condition) => {
    const child = spawnSync(process.execPath, [
      '--no-compilation-cache', '--import', 'tsx',
      fileURLToPath(new URL('../fixtures/redaction-key-progress-child.ts', import.meta.url)),
      condition,
    ], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, TSX_DISABLE_CACHE: '1', NODE_OPTIONS: '' },
    });
    expect({ error: child.error?.message, signal: child.signal, status: child.status, stderr: child.stderr })
      .toEqual({ error: undefined, signal: null, status: 0, stderr: '' });
    expect(JSON.parse(child.stdout)).toMatchObject({ condition });
  }, 20000);
});
