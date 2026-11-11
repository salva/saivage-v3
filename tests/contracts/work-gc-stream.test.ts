import { expect, it, jest } from '@jest/globals';
import { WorkGcStreamDecoder } from '../../src/contracts/work-gc-stream.js';
import { WORK_GC_FRAME_MAX_BYTES, FirstGlobalProtectionSchema, WorkGcProgressSchema, WorkGcResponseSchema } from '../../src/contracts/work-gc.js';

const response = { mode: 'dry_run', disposition: 'refused', reason: 'maintenance_refused', restoration: 'not_acquired', failure: { code: 'EIO', syscall: 'read' }, result: null };
const terminal = JSON.stringify({ type: 'result', response }) + '\n';
const observation = JSON.stringify({ type: 'progress', progress: { phase: 'inventory', elapsed_ms: 0, observed_count: 0, first_global_protection: null } }) + '\n';
it('decodes arbitrary chunk boundaries and resolves only at terminal plus EOF', () => {
  const sink = jest.fn();
  const decoder = new WorkGcStreamDecoder('application/x-ndjson; charset=utf-8', sink);
  for (const byte of Buffer.from(observation + terminal)) decoder.push(Uint8Array.of(byte));
  expect(decoder.finish()).toEqual(response);
  expect(sink).toHaveBeenCalledWith({ phase: 'inventory', elapsed_ms: 0, observed_count: 0, first_global_protection: null });
});
it.each([
  ['', false], [observation, false], [terminal.slice(0, -1), false],
  [terminal + terminal, true], [terminal + observation, true],
  ['{}\n', true], ['{"type":"progress","progress":{"phase":"inventory","elapsed_ms":-1}}\n', true],
  ['{"type":"progress","progress":{"phase":"inventory","elapsed_ms":0,"path":"SECRET"}}\n', true],
  ['x'.repeat(WORK_GC_FRAME_MAX_BYTES), true],
  ['\n', true],
] as const)('refuses malformed, oversized, truncated and misordered streams %#', (input, duringPush) => {
  const decoder = new WorkGcStreamDecoder('application/x-ndjson');
  if (duringPush) expect(() => decoder.push(Buffer.from(input))).toThrow();
  else { decoder.push(Buffer.from(input)); expect(() => decoder.finish()).toThrow('incomplete'); }
});
it('uses byte limits, permits the exact limit including newline and rejects invalid UTF-8', () => {
  const decoder = new WorkGcStreamDecoder('application/x-ndjson');
  const padding = ' '.repeat(WORK_GC_FRAME_MAX_BYTES - Buffer.byteLength(terminal));
  decoder.push(Buffer.from(padding + terminal));
  expect(decoder.finish()).toEqual(response);
  const invalid = new WorkGcStreamDecoder('application/x-ndjson');
  expect(() => invalid.push(Uint8Array.of(0xff, 10))).toThrow();
  const multibyte = new WorkGcStreamDecoder('application/x-ndjson');
  // Unicode JSON whitespace is not legal; decoding a split codepoint must still reach JSON validation.
  const bytes = Buffer.from('"é"\n');
  for (const byte of bytes.subarray(0, -1)) multibyte.push(Uint8Array.of(byte));
  expect(() => multibyte.push(Uint8Array.of(10))).toThrow();
});
it('rejects wrong MIME and disables a failing optional observer', () => {
  expect(() => new WorkGcStreamDecoder('application/json')).toThrow('requires');
  const sink = jest.fn(() => { throw new Error('observer'); });
  const decoder = new WorkGcStreamDecoder('application/x-ndjson', sink);
  decoder.push(Buffer.from(observation + observation + terminal));
  expect(decoder.finish()).toEqual(response);
  expect(sink).toHaveBeenCalledTimes(1);
});
it('requires strict enum-only attribution on progress and every non-null result', () => {
  const mark = { reason: 'reference_scope_unknown', source: 'conversation_content' };
  expect(FirstGlobalProtectionSchema.parse(mark)).toEqual(mark);
  const progress = { phase: 'selection', elapsed_ms: 0, first_global_protection: mark };
  expect(WorkGcProgressSchema.parse(progress)).toEqual(progress);
  const result = { mode: 'dry_run', observed_count: 1, observed_logical_bytes: 4, opaque_entries: 0,
    whole_work_size_known: false, first_global_protection: mark,
    retained: { protected: 1, recent: 0, stale: 0, opaque: 0, target: 0 },
    would_delete_count: 0, would_delete_logical_bytes: 0, deleted_count: 0, deleted_logical_bytes: 0,
    expected_accounted_logical_bytes_remaining: 4, accounted_target_shortfall: null };
  const completed = { mode: 'dry_run', disposition: 'completed', reason: 'completed', restoration: 'not_resumed', failure: null, result };
  expect(WorkGcResponseSchema.parse(completed)).toEqual(completed);
  for (const value of [undefined, { ...mark, reason: 'PRIVATE' }, { ...mark, source: 'PRIVATE' }, { ...mark, path: 'PRIVATE' }]) {
    const invalid = { ...progress, first_global_protection: value };
    expect(WorkGcProgressSchema.safeParse(invalid).success).toBe(false);
    expect(WorkGcResponseSchema.safeParse({ ...completed, result: { ...result, first_global_protection: value } }).success).toBe(false);
    const decoder = new WorkGcStreamDecoder('application/x-ndjson');
    expect(() => decoder.push(Buffer.from(JSON.stringify({ type: 'progress', progress: invalid }) + '\n'))).toThrow();
  }
  expect(WorkGcProgressSchema.parse({ ...progress, first_global_protection: null }).first_global_protection).toBeNull();
  expect(WorkGcResponseSchema.parse(response).result).toBeNull();
});
