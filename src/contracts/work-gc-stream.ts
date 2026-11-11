import {
  WORK_GC_FRAME_MAX_BYTES,
  WorkGcFrameSchema,
  type WorkGcProgressObserver,
  type WorkGcResponse,
} from './work-gc.js';
import { PublicationOutcomeUnknownError } from './publication-outcome-error.js';

/** Browser-safe incremental decoder. A terminal frame is not authoritative until EOF. */
export class WorkGcStreamDecoder {
  private readonly line = new Uint8Array(WORK_GC_FRAME_MAX_BYTES);
  private length = 0;
  private result: WorkGcResponse | undefined;
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true });
  constructor(
    contentType: string | null | undefined,
    private observer?: WorkGcProgressObserver,
  ) {
    if (contentType?.split(';')[0]?.trim().toLowerCase() !== 'application/x-ndjson')
      throw new Error('runtime.gcWork requires application/x-ndjson.');
  }
  push(bytes: Uint8Array): void {
    for (const byte of bytes) {
      if (this.result) throw new Error('runtime.gcWork frame after terminal result.');
      if (this.length >= WORK_GC_FRAME_MAX_BYTES - 1 && byte !== 10)
        throw new Error('runtime.gcWork frame exceeds byte limit.');
      if (byte !== 10) {
        this.line[this.length++] = byte;
        continue;
      }
      const frame = WorkGcFrameSchema.parse(
        JSON.parse(this.utf8.decode(this.line.subarray(0, this.length))),
      );
      this.length = 0;
      if (frame.type === 'result') this.result = frame.response;
      else if (this.observer) {
        try {
          this.observer(frame.progress);
        } catch (error) {
          if (error instanceof PublicationOutcomeUnknownError) throw error;
          this.observer = undefined;
        }
      }
    }
  }
  finish(): WorkGcResponse {
    if (this.length !== 0 || !this.result)
      throw new Error('runtime.gcWork incomplete stream: terminal result and EOF required.');
    return this.result;
  }
}
