import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe('Supervisor result-settlement invariant process failure', () => {
  it('routes the activateProcessor fulfillment-chain invariant rejection through the runtime halt', () => {
    const fixture = fileURLToPath(new URL('../../fixtures/supervisor-owned-child-settlement.ts', import.meta.url));
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawnSync(process.execPath, ['--import', 'tsx', fixture], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000 });

    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      trigger: 'runtime_failure',
      failureMessage: 'Runtime invariant failed: operation=settle_result card=project card_status=running activation=root-activation child=card-a child_status=running.',
      ownerRetainedOriginalFailure: true,
      childReceivedInterruption: true,
    });
  });

  it('leaves a stale settlement observer effect-free after synthetic run authority removal', () => {
    const fixture = fileURLToPath(new URL('../../fixtures/supervisor-stale-owner-settlement.ts', import.meta.url));
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawnSync(process.execPath, ['--import', 'tsx', fixture], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000 });

    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      injectionRan: true,
      haltAbsent: true,
      stoppedAuthorityRetained: true,
      ownersEmpty: true,
      processTerminations: 0,
      storeWrites: 0,
    });
  });
});
