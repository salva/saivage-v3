import { expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

it('runs all pinned native semantic assertions in the built standalone Node harness', () => {
  if (!process.env.SAIVAGE_QUALITY_NATIVE_ROOT)
    throw new Error('Provision tests/tools/quality-native and set SAIVAGE_QUALITY_NATIVE_ROOT.');
  // A matching build is required. Native package imports must use Node's actual
  // resolver, not Jest's VM resolver. Missing build/prerequisites fail, never skip.
  const script = fileURLToPath(new URL('../../dist/tests/scripts/quality-native-engines.js', import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' },
    encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Native semantic harness failed (${result.status}, ${result.signal}):\n${result.stdout}\n${result.stderr}`);
  expect(result.stdout).toContain('Pinned JS, typed TS and Ruff semantic assertions passed.');
}, 130000);
