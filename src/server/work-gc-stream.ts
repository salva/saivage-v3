import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import {
  PublicationOutcomeUnknownError,
  WorkGcFrameSchema,
  WORK_GC_FRAME_MAX_BYTES,
  type ApplicationFatalPort,
  type WorkGcProgressObserver,
  type WorkGcResponse,
} from '../contracts/index.js';

export interface WorkGcStreamOperation {
  result: Promise<WorkGcResponse>;
  observe(observer: WorkGcProgressObserver): void;
  cancel(error: unknown): void;
}

/** Bounded, dropping progress; one nondroppable ordinary result. Never finalize after uncertainty. */
export function createWorkGcStream(
  operation: WorkGcStreamOperation,
  fatal: ApplicationFatalPort,
): PassThrough {
  const stream = new PassThrough({ highWaterMark: WORK_GC_FRAME_MAX_BYTES });
  const closed = new AbortController();
  stream.once('close', () => {
    closed.abort(new Error('Work GC stream closed.'));
    operation.cancel(closed.signal.reason);
  });
  stream.on('error', operation.cancel);
  const encode = (frame: unknown): string => {
    const line = `${JSON.stringify(WorkGcFrameSchema.parse(frame))}\n`;
    if (Buffer.byteLength(line) > WORK_GC_FRAME_MAX_BYTES)
      throw new Error('Work GC frame exceeds protocol bound.');
    return line;
  };
  operation.observe((progress) => {
    if (stream.destroyed) throw new Error('Work GC output closed.');
    if (!stream.writableNeedDrain) stream.write(encode({ type: 'progress', progress }));
  });
  void operation.result
    .then(async (response) => {
      if (stream.destroyed) return;
      if (stream.writableNeedDrain) await once(stream, 'drain', { signal: closed.signal });
      if (!stream.destroyed) stream.end(encode({ type: 'result', response }));
    })
    .catch((error) => {
      if (error instanceof PublicationOutcomeUnknownError) fatal.publicationOutcomeUnknown(error);
      stream.destroy(error instanceof Error ? error : new Error('Work GC stream failed.'));
    });
  return stream;
}
