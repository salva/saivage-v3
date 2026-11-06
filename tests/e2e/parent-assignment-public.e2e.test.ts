import { expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// Real native subprocess/evidence work runs in ordinary Node, not Jest's VM.
// Keep both the existing 50s semantic deadline and finite 60s child bound.
it.each([
  ['off', 'lifecycle', 'blocked'], ['off', 'lifecycle', 'failed'],
  ['on', 'lifecycle', 'blocked'], ['on', 'lifecycle', 'failed'],
  ['off', 'lifecycle', 'stopped'], ['on', 'stop-refusal', 'stopped'],
  ['off', 'review', 'status.md'], ['off', 'review', 'evidence.md'],
  ['on', 'review', 'status.md'], ['on', 'review', 'evidence.md'],
  ['on', 'boundary', 'writers-record'], ['on', 'boundary', 'verify-record'], ['on', 'boundary', 'verify-queue'],
  ['on', 'boundary', 'verify-same-text'],
  ['on', 'boundary', 'verify-order'], ['on', 'boundary', 'verify-membership'],
  ['off', 'notifications', 'Planner4-Reviewer4'], ['on', 'notifications', 'Planner4-Reviewer4'],
  ['off', 'pause', 'self'], ['off', 'pause', 'nonself'],
])('%s public %s %s uses actual configured tools and owners', (mode, scenario, detail) => {
  const result = spawnSync(process.execPath, [resolve('dist/tests/scripts/public-parent-assignment-smoke.js'), mode!, scenario!, detail!], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, TMPDIR: resolve('../tmp') },
  });
  if (process.env.SAIVAGE_TEST_STAGE_TIMING === '1') process.stderr.write(result.stderr ?? '');
  if (result.error || result.status !== 0) throw new Error(`${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  expect(JSON.parse(result.stdout.trim())).toEqual({ mode, scenario, detail, passed: true });
}, 60000);
