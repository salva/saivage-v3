import { describe, expect, it } from '@jest/globals';

import { ServerAvailabilitySchema } from '../../src/contracts/index.js';
import { buildServerAvailability, type ServerAvailabilityInputs } from '../../src/server/availability.js';

describe('buildServerAvailability', () => {
  it('publishes a bounded normalized redacted runtime failure diagnostic', () => {
    const secret = 'synthetic_availability_status_secret';
    const failure = new Error(`  runtime status failed\nwith    repeated whitespace apiKey=${secret} ${'safe-detail-'.repeat(30)}  `);
    failure.name = 'RuntimeAvailabilityStatusReadFailure';
    const runtimeApplication = {
      runtimeApi: {
        getStatus: () => { throw failure; },
      },
    } as unknown as ServerAvailabilityInputs['runtimeApplication'];
    const mcpManager = {
      getStatus: () => [{ status: 'running' }],
    } as unknown as ServerAvailabilityInputs['mcpManager'];

    const availability = buildServerAvailability({ projectRoot: '/workspace/project', runtimeApplication, mcpManager });
    const parsed = ServerAvailabilitySchema.parse(availability);
    const runtime = parsed.components.runtime;

    expect(runtime).toMatchObject({
      state: 'degraded',
      source: 'runtime-application',
      diagnostic: { code: 'runtime-status-read-failed' },
    });
    const summary = runtime.diagnostic?.summary ?? '';
    expect(summary.startsWith('RuntimeAvailabilityStatusReadFailure: runtime status failed with repeated whitespace apiKey=[REDACTED]')).toBe(true);
    expect(summary).not.toContain(secret);
    expect(summary).not.toMatch(/\s{2,}|[\r\n]/);
    expect(summary).toBe(summary.trim());
    expect(summary.length).toBeLessThanOrEqual(180);
    expect(summary).toHaveLength(180);
    expect(summary.endsWith('...')).toBe(true);
    expect(parsed.components.mcp).toMatchObject({ state: 'available', source: 'mcp-manager' });
  });
});
