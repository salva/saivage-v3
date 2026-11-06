import { expect, it } from '@jest/globals';
import { createWorkGcProgress } from '../../src/application/work-gc-progress.js';
import { readWorkGcFrames } from '../../src/application/operator-runtime-http-client.js';
import { WORK_GC_FRAME_MAX_BYTES, type WorkGcProgress } from '../../src/contracts/index.js';

const response = { mode: 'dry_run', disposition: 'refused', reason: 'cancelled', restoration: 'not_acquired', result: null } as const;
const terminal = JSON.stringify({ type: 'result', response }) + '\n';
async function* chunks(text: string | Buffer) {
  const bytes = Buffer.from(text);
  for (const byte of bytes) yield Buffer.from([byte]);
}
it('throttles cumulative snapshots without timers and emits finite phase transitions immediately', () => {
  let time = 0;
  const frames: WorkGcProgress[] = [];
  const report = createWorkGcProgress(value => frames.push(value), () => { throw new Error('unexpected'); }, () => time);
  report({ accounted_files: 0 });
  for (let n = 1; n < 100; n++) report({ accounted_files: n });
  expect(frames).toHaveLength(1);
  time = 1000; report({ accounted_files: 100 });
  report({ phase: 'settling' });
  expect(frames).toHaveLength(3);
  expect(frames[2]).toEqual({ phase: 'settling', elapsed_ms: 1000, accounted_files: 100 });
});
it('observer failure cancels once and never retries the failed sink', () => {
  let calls = 0;
  const abort = new AbortController();
  const report = createWorkGcProgress(() => { calls++; throw new Error('output failed'); }, error => abort.abort(error));
  report({ phase: 'inventory' }); report({ phase: 'selection' });
  expect(calls).toBe(1); expect(abort.signal.aborted).toBe(true);
});
it('incrementally frames split bytes, delivering progress before terminal EOF', async () => {
  const frames: WorkGcProgress[] = [];
  const progress = { phase: 'inventory', elapsed_ms: 0, accounted_files: 1 } as const;
  await expect(readWorkGcFrames(chunks(JSON.stringify({ type: 'progress', progress }) + '\n' + terminal), value => frames.push(value))).resolves.toEqual(response);
  expect(frames).toEqual([progress]);
});
it.each([
  terminal + terminal,
  terminal + JSON.stringify({ type: 'progress', progress: { phase: 'selection', elapsed_ms: 1 } }) + '\n',
  terminal.trimEnd(),
  '{}\n',
  'x'.repeat(WORK_GC_FRAME_MAX_BYTES),
  JSON.stringify({ type: 'progress', progress: { phase: 'inventory', elapsed_ms: 0, '☃': 1 } }) + '\n' + terminal,
])('rejects invalid, oversized, unterminated or post-terminal input %#', async text => {
  await expect(readWorkGcFrames(chunks(text))).rejects.toThrow();
});
it('rejects invalid UTF-8 rather than replacing bytes', async () => {
  await expect(readWorkGcFrames(chunks(Buffer.from([0xff, 10])))).rejects.toThrow();
});
