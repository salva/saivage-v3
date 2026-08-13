import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe('Supervisor result-settlement invariant process failure', () => {
  it('fails the process through the discarded activateProcessor fulfillment chain', () => {
    const fixture = fileURLToPath(new URL('../../fixtures/supervisor-owned-child-settlement.ts', import.meta.url));
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawnSync(process.execPath, ['--import', 'tsx', fixture], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 10_000 });

    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain('Runtime invariant failed: operation=settle_result card=project card_status=running activation=root-activation child=card-a child_status=running.');
  });
});
