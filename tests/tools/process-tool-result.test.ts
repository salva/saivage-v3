import { describe, expect, it } from '@jest/globals';

import type { ProcessToolResult } from '../../src/contracts/operator-api-processes.js';
import { DISCOVERY_RESPONSE_MAX_BYTES } from '../../src/contracts/builtin-tool-inputs.js';
import { validateProcessToolResult } from '../../src/tools/process-tool-result.js';
import { settledSuccessBytes } from '../../src/tools/tool-result-settlement.js';

const ID = 'proc-0123456789ab';

function result(overrides: Partial<ProcessToolResult> = {}, cardId?: string): ProcessToolResult {
  const directory = cardId ? `cards/${cardId}/processes/${ID}` : `processes/${ID}`;
  return {
    process_id: ID,
    exit_code: 0,
    status: 'exited',
    stdout: '',
    stderr: '',
    stdout_complete: true,
    stderr_complete: true,
    stdout_url: `work:///${directory}/stdout.log`,
    stderr_url: `work:///${directory}/stderr.log`,
    stdout_bytes: 0,
    stderr_bytes: 0,
    ...overrides,
  };
}

describe('process tool result semantic acceptance', () => {
  it.each(['stdout', 'stderr'] as const)('enforces the independent %s byte boundary', (stream) => {
    expect(validateProcessToolResult(result({ [stream]: 'x'.repeat(2_048) }))).toEqual(result({ [stream]: 'x'.repeat(2_048) }));
    expect(() => validateProcessToolResult(result({ [stream]: 'x'.repeat(2_049) }))).toThrow(/2048 UTF-8 bytes/u);
  });

  it.each(['stdout', 'stderr'] as const)('enforces the independent %s line boundary', (stream) => {
    expect(validateProcessToolResult(result({ [stream]: 'x\n'.repeat(30) }))).toEqual(result({ [stream]: 'x\n'.repeat(30) }));
    expect(validateProcessToolResult(result({ [stream]: `${'x\n'.repeat(29)}x` }))).toEqual(result({ [stream]: `${'x\n'.repeat(29)}x` }));
    expect(() => validateProcessToolResult(result({ [stream]: 'x\n'.repeat(31) }))).toThrow(/30 lines/u);
  });

  it('rejects unstable heads instead of redacting or repairing them', () => {
    const value = result({ stdout: 'token=synthetic-secret-value' });
    expect(() => validateProcessToolResult(value)).toThrow(/stdout head is not a complete certified/u);
    expect(value.stdout).toBe('token=synthetic-secret-value');
  });

  it.each([
    'sk-synthetic-secret-value',
    'token=synthetic-secret-value',
    'prefix sk-[REDAC',
  ])('rejects nonstable or uncertified head %p without repair', (stdout) => {
    const value = result({ stdout });
    expect(() => validateProcessToolResult(value)).toThrow(/stdout head is not a complete certified/u);
    expect(value.stdout).toBe(stdout);
  });

  it.each([
    result({ process_id: 'process-0123456789ab' }),
    result({ stdout_url: 'work:///processes/proc-aaaaaaaaaaaa/stdout.log' }),
    result({ stderr_url: 'work:///processes/proc-aaaaaaaaaaaa/stderr.log' }),
    result({ stderr_url: `work:///cards/card-a/processes/${ID}/stderr.log` }),
    result({ stdout_url: `work:///cards/card-A/processes/${ID}/stdout.log`, stderr_url: `work:///cards/card-A/processes/${ID}/stderr.log` }),
    result({ stdout_url: `work:///processes/${ID}/stdout.log?raw=1` }),
    result({ stderr_url: `work:///processes/${ID}/stderr.log#fragment` }),
  ])('rejects invalid or untruthful process identity/reference data', (value) => {
    expect(() => validateProcessToolResult(value)).toThrow();
  });

  it('measures the exact canonical settled success and rejects oversized fixed metadata', () => {
    const escapedHeads = { stdout: '\u0000'.repeat(2_048), stderr: '\u0001'.repeat(2_048) };
    let low = 1;
    let high = 20_000;
    while (low < high) {
      const middle = low + Math.ceil((high - low) / 2);
      const candidate = result(escapedHeads, `card-${'a'.repeat(middle)}`);
      if (Buffer.byteLength(settledSuccessBytes(candidate), 'utf8') <= DISCOVERY_RESPONSE_MAX_BYTES) low = middle;
      else high = middle - 1;
    }
    const accepted = result(escapedHeads, `card-${'a'.repeat(low)}`);
    const rejected = result(escapedHeads, `card-${'a'.repeat(low + 1)}`);
    const validated = validateProcessToolResult(accepted);
    const settled = JSON.parse(settledSuccessBytes(validated)) as { success: true; data: unknown };
    expect(settled.data).toEqual(validated);
    expect(Buffer.byteLength(settledSuccessBytes(validated), 'utf8')).toBeLessThanOrEqual(DISCOVERY_RESPONSE_MAX_BYTES);
    expect(Buffer.byteLength(settledSuccessBytes(rejected), 'utf8')).toBeGreaterThan(DISCOVERY_RESPONSE_MAX_BYTES);
    expect(() => validateProcessToolResult(rejected)).toThrow(/provider-envelope byte limit/u);
  });
});
