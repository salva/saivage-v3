import { expect, it, jest } from '@jest/globals';
import { createWorkGcProgress } from '../../src/application/work-gc-progress.js';
import { PublicationOutcomeUnknownError, WorkGcProgressSchema } from '../../src/contracts/index.js';

it('emits transitions immediately, throttles counts, preserves omitted versus zero, without timers', () => {
  let time = 42;
  const sink = jest.fn();
  const reporter = createWorkGcProgress(sink, () => time)!;
  reporter.phase('inventory', { observed_count: 0 });
  reporter.update({ observed_count: 2 });
  time += 999; reporter.update({ observed_logical_bytes: 5 });
  expect(sink).toHaveBeenCalledTimes(1);
  time++; reporter.update({ observed_count: 3 });
  reporter.phase('settling');
  reporter.phase('validation_marking', { validated_cards: 0 });
  reporter.increment('validated_cards');
  reporter.phase('selection', { candidates_processed: 0 });
  expect(sink.mock.calls.map(([value]) => value)).toEqual([
    { phase: 'inventory', elapsed_ms: 0, observed_count: 0 },
    { phase: 'inventory', elapsed_ms: 1000, observed_count: 3, observed_logical_bytes: 5 },
    { phase: 'settling', elapsed_ms: 1000, observed_count: 3, observed_logical_bytes: 5 },
    { phase: 'validation_marking', elapsed_ms: 1000, observed_count: 3, observed_logical_bytes: 5, validated_cards: 0 },
    { phase: 'selection', elapsed_ms: 1000, observed_count: 3, observed_logical_bytes: 5, validated_cards: 1, candidates_processed: 0 },
  ]);
  for (const [value] of sink.mock.calls) expect(WorkGcProgressSchema.parse(value)).toEqual(value);
});
it('does not construct/read the clock without an observer; ordinary sink failure disables only the observer', () => {
  const clock = jest.fn(() => 0);
  expect(createWorkGcProgress(undefined, clock)).toBeUndefined();
  expect(clock).not.toHaveBeenCalled();
  const sink = jest.fn(() => { throw new Error('broken stderr'); });
  const reporter = createWorkGcProgress(sink, clock)!;
  reporter.phase('inventory'); reporter.phase('selection');
  expect(sink).toHaveBeenCalledTimes(1);
});
it('does not absorb publication uncertainty as an observer error', () => {
  const error = new PublicationOutcomeUnknownError();
  const reporter = createWorkGcProgress(() => { throw error; })!;
  expect(() => reporter.phase('inventory')).toThrow(error);
});
