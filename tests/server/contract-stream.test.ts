import { expect, it } from '@jest/globals';
import { Writable } from 'node:stream';
import { once } from 'node:events';
import { ContractFrameStream } from '../../src/server/contract-stream.js';
import { WorkGcFrameSchema } from '../../src/contracts/index.js';
import { WorkGcStreamDecoder } from '../../src/contracts/work-gc-stream.js';

const response = { mode: 'dry_run', disposition: 'refused', reason: 'maintenance_refused', restoration: 'not_acquired', failure: { code: 'EIO', syscall: 'read' }, result: null };
function pressured() {
  const stream = new ContractFrameStream(WorkGcFrameSchema);
  const chunks: Buffer[] = [];
  const callbacks: Array<() => void> = [];
  let slow = true;
  const sink = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
    chunks.push(Buffer.from(chunk));
    if (slow) callbacks.push(callback); else callback();
  } });
  stream.body.pipe(sink);
  while (!stream.body.writableNeedDrain)
    stream.optional({ type: 'progress', progress: { phase: 'inventory', elapsed_ms: 0, first_global_protection: null } });
  return { stream, chunks, sink, release() { slow = false; for (const callback of callbacks.splice(0)) callback(); } };
}
it('drops under witnessed writable pressure without accumulating snapshots, then sends one terminal', async () => {
  const { stream, chunks, sink, release } = pressured();
  expect(stream.body.writableNeedDrain).toBe(true);
  const length = stream.body.writableLength;
  for (let i = 0; i < 10000; i++) stream.optional({ type: 'progress', progress: { phase: 'selection', elapsed_ms: i, first_global_protection: null } });
  expect(stream.body.writableLength).toBe(length);
  const finished = once(sink, 'finish');
  let complete = false;
  const task = stream.finish({ type: 'result', response }, new AbortController().signal).then(() => { complete = true; });
  await Promise.resolve(); expect(complete).toBe(false);
  release(); await task; await finished;
  const decoder = new WorkGcStreamDecoder('application/x-ndjson');
  for (const chunk of chunks) decoder.push(chunk);
  expect(decoder.finish()).toEqual(response);
  expect(Buffer.concat(chunks).toString().match(/"type":"result"/gu)).toHaveLength(1);
});
it('aborts a blocked terminal wait without resending or making a terminal frame', async () => {
  const { stream, chunks, sink, release } = pressured();
  const abort = new AbortController();
  const task = stream.finish({ type: 'result', response }, abort.signal);
  abort.abort(new Error('disconnected'));
  await expect(task).rejects.toThrow('disconnected');
  stream.body.destroy(); sink.destroy(); release();
  expect(Buffer.concat(chunks).toString()).not.toContain('"type":"result"');
  expect(abort.signal.onabort).toBeNull();
});
