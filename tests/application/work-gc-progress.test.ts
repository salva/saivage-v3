import { expect, it, jest } from '@jest/globals';
import { createObservedWorkGcProgress, createWorkGcProgress } from '../../src/application/work-gc-progress.js';
import { PublicationOutcomeUnknownError, WorkGcProgressSchema, WorkGcStatusSchema, type WorkGcProgress } from '../../src/contracts/index.js';

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
  reporter.phase('retention_marking', { inspected_cards: 0 });
  reporter.increment('inspected_cards');
  reporter.phase('selection', { candidates_processed: 0 });
  expect(sink.mock.calls.map(([value]) => value)).toEqual([
    { phase: 'inventory', elapsed_ms: 0, observed_count: 0, first_global_protection: null },
    { phase: 'inventory', elapsed_ms: 1000, observed_count: 3, observed_logical_bytes: 5, first_global_protection: null },
    { phase: 'settling', elapsed_ms: 1000, observed_count: 3, observed_logical_bytes: 5, first_global_protection: null },
    { phase: 'retention_marking', elapsed_ms: 1000, observed_count: 3, observed_logical_bytes: 5, inspected_cards: 0, first_global_protection: null },
    { phase: 'selection', elapsed_ms: 1000, observed_count: 3, observed_logical_bytes: 5, inspected_cards: 1, candidates_processed: 0, first_global_protection: null },
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
it.each(['phase', 'attribution'] as const)('does not absorb publication uncertainty from %s as an observer error', operation => {
  const error = new PublicationOutcomeUnknownError();
  let time = 0;
  const reporter = createWorkGcProgress(value => { if (operation === 'phase' || value.first_global_protection) throw error; }, () => time)!;
  if (operation === 'attribution') { reporter.phase('inventory'); time = 1000; }
  expect(() => operation === 'phase' ? reporter.phase('inventory') : reporter.update({ first_global_protection: {
    reason: 'process_owner_uncertain', source: 'process_owner' } })).toThrow(error);
});
it('keeps the first mark sticky through throttled numeric updates and phase changes', () => {
  let time = 0;
  const sink = jest.fn();
  const reporter = createWorkGcProgress(sink, () => time)!;
  const first = { reason: 'operational_root', source: 'operational_input' } as const;
  reporter.phase('retention_marking', { inspected_cards: 0 });
  reporter.update({ first_global_protection: first });
  reporter.increment('inspected_cards');
  reporter.update({ first_global_protection: { reason: 'process_owner_uncertain', source: 'process_owner' } });
  expect(sink).toHaveBeenCalledTimes(1);
  time = 1000;
  reporter.increment('inspected_cards');
  reporter.phase('selection');
  expect(sink.mock.calls.map(([value]) => value)).toEqual([
    { phase: 'retention_marking', elapsed_ms: 0, inspected_cards: 0, first_global_protection: null },
    { phase: 'retention_marking', elapsed_ms: 1000, inspected_cards: 2, first_global_protection: first },
    { phase: 'selection', elapsed_ms: 1000, inspected_cards: 2, first_global_protection: first },
  ]);
});

it('reads detached bounded reservation data with one clock and no polling checkpoints', () => {
  let time = 42;
  const { progress, read } = createObservedWorkGcProgress('delete', undefined, () => time);
  expect(WorkGcStatusSchema.parse({ active: read() })).toEqual({ active: {
    mode: 'delete', phase: 'inventory', substep: 'starting', elapsed_ms: 0,
    step_elapsed_ms: 0, last_checkpoint_elapsed_ms: 0, counters: {}, first_global_protection: null,
  } });
  time = 50;
  expect(read()).toMatchObject({ elapsed_ms: 8, step_elapsed_ms: 8, last_checkpoint_elapsed_ms: 0 });
  progress.phase('inventory', { observed_count: 0 });
  time = 56;
  expect(read()).toMatchObject({ substep: 'enumerating', elapsed_ms: 14, step_elapsed_ms: 6,
    last_checkpoint_elapsed_ms: 8, counters: { observed_count: 0 } });
  progress.phase('settling');
  expect(read()).toMatchObject({ substep: 'waiting_for_hold', step_elapsed_ms: 0 });
  progress.phase('retention_marking');
  expect(read().substep).toBe('operational_inputs');
  progress.retentionSource!('record_projection');
  time = 60;
  progress.referenceVisits!(256);
  progress.retentionSource!('record_projection');
  expect(read()).toMatchObject({ step_elapsed_ms: 4, last_checkpoint_elapsed_ms: 18,
    counters: { reference_visits: 256 } });
  progress.retentionSource!('conversation_projection');
  time = 63;
  progress.retentionSource!('record_projection');
  expect(read()).toMatchObject({ substep: 'record_projection', step_elapsed_ms: 0 });
  progress.update({ first_global_protection: { reason: 'operational_root', source: 'operational_input' } });
  const sampled = read();
  sampled.counters.reference_visits = 1;
  sampled.first_global_protection!.source = 'process_owner';
  progress.phase('selection');
  expect(read()).toMatchObject({ substep: 'classifying', counters: { reference_visits: 256 },
    first_global_protection: { reason: 'operational_root', source: 'operational_input' } });
});

it('does not emit or reset the stream throttle for diagnostic events, and survives a throwing sink', () => {
  let time = 0;
  const sink = jest.fn<(frame: WorkGcProgress) => void>().mockImplementationOnce(() => {
    // Simulate a sink dropping the first optional frame.
  }).mockImplementationOnce(() => { throw new Error('broken stream'); });
  const { progress, read } = createObservedWorkGcProgress('dry_run', sink, () => time);
  progress.phase('retention_marking', { inspected_records: 0 });
  time = 999;
  progress.retentionSource!('record_projection');
  progress.referenceVisits!(256);
  expect(sink).toHaveBeenCalledTimes(1);
  expect(read()).toMatchObject({ last_checkpoint_elapsed_ms: 999, counters: { reference_visits: 256, inspected_records: 0 } });
  time = 1000;
  progress.increment('inspected_records');
  expect(sink).toHaveBeenLastCalledWith({ phase: 'retention_marking', elapsed_ms: 1000,
    first_global_protection: null, inspected_records: 1 });
  expect(WorkGcProgressSchema.parse(sink.mock.calls[1]![0])).toEqual(sink.mock.calls[1]![0]);
  time = 1001;
  progress.referenceVisits!(512);
  expect(read()).toMatchObject({ last_checkpoint_elapsed_ms: 1001, counters: { reference_visits: 512, inspected_records: 1 } });
  progress.phase('selection');
  expect(sink).toHaveBeenCalledTimes(2);
  expect(read().substep).toBe('classifying');
});
