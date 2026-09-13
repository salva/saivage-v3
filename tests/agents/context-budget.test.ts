import { describe, expect, it } from '@jest/globals';
import { usableInputTokens } from '../../src/agents/context-budget.js';

describe('model-aware usable input arithmetic', () => {
  it('uses the exact configured output request below the utilization window', () => {
    expect(usableInputTokens(1_050_000, 4_096, 0.8)).toBe(835_904);
    expect(usableInputTokens(120_000, 8_192, 0.8)).toBe(87_808);
    expect(usableInputTokens(120_000, 4_096, 0.8)).toBe(91_904);
    expect(usableInputTokens(120_000, 2_000, 0.8)).toBe(94_000);
  });

  it('fails invalid arithmetic inputs without clamping', () => {
    expect(() => usableInputTokens(0, 1, 0.8)).toThrow(/contextWindowTokens/u);
    expect(() => usableInputTokens(100, 0, 0.8)).toThrow(/requestedCompletionTokens/u);
    expect(() => usableInputTokens(100, 1, Number.POSITIVE_INFINITY)).toThrow(/contextUtilizationFraction/u);
  });
});
